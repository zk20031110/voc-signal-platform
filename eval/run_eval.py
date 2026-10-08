#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VOC 评测脚本

用法：
  python eval/run_eval.py              # 跑 30 条评测集，输出分层指标
  python eval/run_eval.py --export-md  # 由 JSON 生成可读版 testset-30.md

Agent1 有两种输入形态（与 prototype/pipeline.js 的 VOC_CONFIG.agent1Mode 对齐）：
  --agent1-mode single（默认）逐条调用，一条失败只影响一条
  --agent1-mode batch  整批调用，省调用次数；输出条数/index 对不齐时自动回退逐条
Agent2 始终逐条调用。脚本用并发池（默认 6 路）压缩总耗时。
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = ROOT / "eval"
PROMPT_DIR = ROOT / "prompts"
RESULT_DIR = EVAL_DIR / "results"
DATA_JS = ROOT / "prototype" / "data.js"

CONCURRENCY = 6
DEFAULT_BATCH_SIZE = 10
BUCKETS = [
    ("retrieval", "检索问题"),
    ("model", "模型问题"),
    ("prompt", "Prompt 问题"),
    ("data", "数据问题"),
    ("product", "产品设计问题"),
]


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_history():
    """从 prototype/data.js 里抽出 history7d 与 recent24hNegative。

    浏览器端需要一个可直接 <script> 引入的全局变量，所以数据放在 JS 里。
    这里做一次轻量解析，避免把同一份数据维护两遍。
    """
    text = DATA_JS.read_text(encoding="utf-8")
    out = {}
    for key in ("history7d", "recent24hNegative"):
        m = re.search(key + r"\s*:\s*\{", text)
        if not m:
            raise SystemExit("无法从 data.js 解析 %s" % key)
        start = text.index("{", m.start())
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    block = text[start:i + 1]
                    break
        # 把 total: 14 这类裸键补上引号，中间用负向断言避开中文键
        block = re.sub(r'(?<![."\w])([A-Za-z_][A-Za-z0-9_]*)\s*:', r'"\1":', block)
        out[key] = json.loads(block)
    return out


def chat(messages, temperature=0.2, max_tokens=8000):
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("未配置 DEEPSEEK_API_KEY，请检查项目根目录的 .env")
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    payload = {
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-flash"),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError("DeepSeek 返回 %s: %s" % (exc.code, exc.read().decode("utf-8", "replace")[:300]))
    return data["choices"][0]["message"]["content"]


def extract_json(text):
    s = text.strip()
    if s.startswith("```"):
        s = s.split("```")[1]
        s = s[4:] if s.lower().startswith("json") else s
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("输出中找不到 JSON 对象")
    return json.loads(s[start:end + 1])


def call_agent_json(prompt_name, user_content, system_extra="", counter=None):
    """system_extra 追加在 System Prompt 末尾，用于批量模式等输入形态适配；
    counter['calls'] 记录真实模型调用次数（含 JSON 纠错重试）。"""
    system = (PROMPT_DIR / (prompt_name + ".md")).read_text(encoding="utf-8")
    if system_extra:
        system = system + "\n\n" + system_extra
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]
    last = None
    for _ in range(2):
        if counter is not None:
            counter["calls"] = counter.get("calls", 0) + 1
        content = chat(messages)
        try:
            return extract_json(content)
        except Exception as exc:  # noqa: BLE001
            last = exc
            messages.append({"role": "assistant", "content": content[:1200]})
            messages.append({"role": "user", "content": "上一条不是合法 JSON（常见原因是字符串内部出现了未转义的英文双引号）。请只输出一个 JSON 对象，不要代码围栏；字符串内部的引号统一改用中文引号「」。"})
    raise RuntimeError("Agent 输出无法解析为 JSON：%s" % last)


def agent1_user_content(case):
    return ("渠道：%s\n商品：%s\n用户标识：%s\n时间：%s\n\n反馈原文：\n%s"
            % (case["channel"], case.get("product", "-"), case.get("customer_ref", "-"),
               case.get("time", "-"), case["text"]))


def annotate_one(case, counter):
    """单条标注，输出外层挂 feedback_id / customer_ref"""
    data = call_agent_json("agent1-collector", agent1_user_content(case), counter=counter)
    data["feedback_id"] = case["id"]
    data["customer_ref"] = case.get("customer_ref")
    return data


def align_batch_results(data, n):
    """批量结果对齐校验：条数必须一致；带 index 时必须恰好覆盖 1..N 且不重复。
    任一条件不满足就抛错，由调用方回退逐条重跑——批量输出不能静默丢用例。"""
    items = data if isinstance(data, list) else (data or {}).get("results")
    if not isinstance(items, list):
        raise ValueError("批量输出里没有 results 数组")
    if len(items) != n:
        raise ValueError("批量输出条数不匹配：输入 %d 条，输出 %d 条" % (n, len(items)))
    if not any(isinstance(x, dict) and x.get("index") is not None for x in items):
        return list(items)
    ordered = [None] * n
    seen = set()
    for item in items:
        try:
            idx = int(item.get("index"))
        except (AttributeError, TypeError, ValueError):
            raise ValueError("批量输出的 index 非法：%r" % (item.get("index") if isinstance(item, dict) else item))
        if not (1 <= idx <= n):
            raise ValueError("批量输出的 index 越界：%d" % idx)
        if idx in seen:
            raise ValueError("批量输出的 index 重复：%d" % idx)
        seen.add(idx)
        ordered[idx - 1] = item
    if len(seen) != n:
        raise ValueError("批量输出的 index 不完整：%d/%d" % (len(seen), n))
    return ordered


def annotate(cases, history, mode="single", batch_size=DEFAULT_BATCH_SIZE, counter=None):
    """Agent1：single=逐条调用；batch=按 batch_size 切块整批调用。
    batch 输出对不齐时自动回退该块逐条重跑，并在 counter['fallbacks'] 计数。"""
    counter = counter if counter is not None else {}

    def one(case):
        return annotate_one(case, counter)

    if mode != "batch":
        return resilient_map(one, cases)

    adapter = (PROMPT_DIR / "agent1-batch-adapter.md").read_text(encoding="utf-8")
    size = max(1, batch_size)
    cards = []
    for start in range(0, len(cases), size):
        chunk = cases[start:start + size]
        try:
            user = ("本次共 %d 条反馈，请逐条标注，并按批量模式的 JSON 格式输出。\n" % len(chunk)
                    + "".join("\n【反馈 %d】\n%s" % (i + 1, agent1_user_content(c)) for i, c in enumerate(chunk)))
            data = call_agent_json("agent1-collector", user, system_extra=adapter, counter=counter)
            ordered = align_batch_results(data, len(chunk))
            for case, item in zip(chunk, ordered):
                item = dict(item)
                item["feedback_id"] = case["id"]
                item["customer_ref"] = case.get("customer_ref")
                cards.append(item)
        except Exception as exc:  # noqa: BLE001
            counter["fallbacks"] = counter.get("fallbacks", 0) + 1
            print("  [回退] 第 %d 批（%s 起）批量输出不可用：%s。改为逐条重跑 %d 条。"
                  % (start // size + 1, chunk[0]["id"], exc, len(chunk)))
            cards.extend(resilient_map(one, chunk))
    return cards


def judge(cards, cases, history, counter=None):
    """Agent2：逐条风险判断，输入注入 7 天历史信号库与该用户其他渠道记录"""
    case_by_id = {c["id"]: c for c in cases}
    text_by_id = {c["id"]: c for c in cases}

    def one(card):
        labels = card.get("labels") or []
        relevant = {}
        for label in labels:
            base = history["history7d"].get(label)
            if not base:
                continue
            item = dict(base)
            item["negative_24h"] = history["recent24hNegative"].get(label, 0)
            relevant[label] = item
        same_user = [
            {"feedback_id": c["feedback_id"], "channel": c["channel"], "summary": c.get("summary"),
             "labels": c.get("labels"), "text": text_by_id.get(c["feedback_id"], {}).get("text")}
            for c in cards
            if c.get("customer_ref") and c["customer_ref"] == card.get("customer_ref")
            and c["feedback_id"] != card["feedback_id"]
        ]
        user = (
            "【反馈卡】\n" + json.dumps(card, ensure_ascii=False, indent=2)
            + "\n\n【历史信号库】\n" + json.dumps({
                "history_7d": relevant,
                "negative_24h_total": sum(history["recent24hNegative"].get(l, 0) for l in labels),
            }, ensure_ascii=False, indent=2)
            + "\n\n【该用户在其他渠道的历史反馈记录】\n" + json.dumps(same_user, ensure_ascii=False, indent=2)
        )
        data = call_agent_json("agent2-risk", user, counter=counter)
        data["feedback_id"] = card["feedback_id"]
        return data

    return resilient_map(one, cards)


def resilient_map(fn, items):
    """单条失败不中断全量：失败项记录为 {'feedback_id': ..., '_error': True}，在报告里单独列出。"""
    def guarded(item):
        try:
            return fn(item)
        except Exception as exc:  # noqa: BLE001
            return {"feedback_id": item.get("feedback_id") or item.get("id"), "_error": True, "_message": str(exc)[:200]}
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        return list(ex.map(guarded, items))


def match(actual, expect):
    if isinstance(expect, list):
        return actual in expect
    return actual == expect


def suggest_bucket(case, row):
    exp = case.get("expect", {})
    if row["actual_risk"] == "缺失":
        return "model"
    if case.get("debatable"):
        return "product"
    if exp.get("risk_level") == "高" and case.get("cross_channel"):
        return "retrieval"
    if row["label_ok"] and row["sent_ok"] and row["new_ok"]:
        return "prompt"
    if case.get("category") in ("歧义反馈", "对抗与边界"):
        return "data"
    if row["label_ok"] and not row["sent_ok"]:
        return "prompt"
    return "model"


def evaluate(testset, cards, risks):
    card_by_id = {c["feedback_id"]: c for c in cards}
    risk_by_id = {r["feedback_id"]: r for r in risks}

    rows = []
    label_ok = sent_ok = 0
    tp = fp = fn = 0
    new_total = new_ok = 0
    high_total = high_hit = 0
    normal_total = false_hit = 0

    for case in testset["cases"]:
        exp = case.get("expect", {})
        card = card_by_id.get(case["id"])
        risk = risk_by_id.get(case["id"])
        actual_labels = (card or {}).get("labels") or []
        actual_sent = (card or {}).get("sentiment", "缺失")
        actual_new = bool((card or {}).get("is_new_signal"))
        actual_risk = (risk or {}).get("risk_level", "缺失")

        req_labels = exp.get("labels", [])
        any_labels = exp.get("labels_any", [])
        l_ok = (
            bool(card)
            and all(l in actual_labels for l in req_labels)
            and (not any_labels or any(l in actual_labels for l in any_labels))
        )
        s_ok = bool(card) and match(actual_sent, exp.get("sentiment"))
        n_ok = actual_new == bool(exp.get("is_new_signal"))

        label_ok += 1 if l_ok else 0
        sent_ok += 1 if s_ok else 0

        if isinstance(exp.get("sentiment"), str):
            exp_neg = exp["sentiment"] == "负面"
            act_neg = actual_sent == "负面"
            if exp_neg and act_neg:
                tp += 1
            elif not exp_neg and act_neg:
                fp += 1
            elif exp_neg and not act_neg:
                fn += 1

        if exp.get("is_new_signal"):
            new_total += 1
            new_ok += 1 if actual_new else 0

        risk_ok = True
        want = exp.get("risk_level")
        if want == "高":
            high_total += 1
            if actual_risk == "高":
                high_hit += 1
            else:
                risk_ok = False
        elif want == "常规":
            normal_total += 1
            if actual_risk in ("高", "观察"):
                false_hit += 1
                risk_ok = False

        row = {
            "id": case["id"], "category": case["category"],
            "expected_labels": exp.get("labels"), "actual_labels": actual_labels,
            "expected_sentiment": exp.get("sentiment"), "actual_sentiment": actual_sent,
            "expected_risk": want, "actual_risk": actual_risk,
            "label_ok": l_ok, "sent_ok": s_ok, "new_ok": n_ok, "risk_ok": risk_ok,
            "pass": l_ok and s_ok and n_ok and risk_ok,
        }
        if not row["pass"]:
            row["suggested_bucket"] = suggest_bucket(case, row)
        rows.append(row)

    total = len(testset["cases"])
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    metrics = {
        "标签命中率": label_ok / total,
        "情感判断F1": f1,
        "新信号召回率": (new_ok / new_total) if new_total else None,
        "高风险召回率": (high_hit / high_total) if high_total else None,
        "误报率": (false_hit / normal_total) if normal_total else None,
        "用例通过率": sum(1 for r in rows if r["pass"]) / total,
    }
    return metrics, rows


def print_report(metrics, rows):
    def pct(v):
        return "—" if v is None else "%.1f%%" % (v * 100)

    print("\n" + "=" * 58)
    print("VOC 评测报告 · %d 条" % len(rows))
    print("=" * 58)
    print("模型层   标签命中率        %s" % pct(metrics["标签命中率"]))
    print("模型层   情感判断 F1       %.3f" % metrics["情感判断F1"])
    print("模型层   新信号召回率      %s" % pct(metrics["新信号召回率"]))
    print("业务层   高风险召回率      %s" % pct(metrics["高风险召回率"]))
    print("业务层   误报率            %s   (常规用例被升级为高/观察)" % pct(metrics["误报率"]))
    print("综合     用例通过率        %s" % pct(metrics["用例通过率"]))

    failed = [r for r in rows if not r["pass"]]
    print("\nBadcase %d 条" % len(failed))
    names = dict(BUCKETS)
    grouped = {k: [] for k, _ in BUCKETS}
    for r in failed:
        grouped[r.get("suggested_bucket", "model")].append(r)
    for key, _ in BUCKETS:
        items = grouped[key]
        if not items:
            continue
        print("  [%s] %d 条" % (names[key], len(items)))
        for r in items:
            exp_l = "/".join(r["expected_labels"] or [])
            act_l = "/".join(r["actual_labels"]) or "缺失"
            print("    %s  %s  标签 期望 %s / 实际 %s  风险 期望 %s / 实际 %s"
                  % (r["id"], r["category"], exp_l, act_l, r["expected_risk"] or "不限", r["actual_risk"]))


def export_md(testset, path):
    lines = [
        "# VOC 评测集 30 条",
        "",
        "> 本文件由 `eval/testset-30.json` 自动生成，请勿手工编辑。",
        "> 重新生成：`python eval/run_eval.py --export-md`",
        "",
        "## 标签体系（与 Agent1 Prompt 一致）",
        "",
        "、".join(testset.get("preset_labels", [])),
        "",
        "## 计分口径",
        "",
        "| 字段 | 含义 |",
        "| --- | --- |",
        "| expect.labels | 预测标签必须完整包含这些标签才算命中 |",
        "| expect.labels_any | 二选一：预测标签命中其中之一即可，用于标注本身有重叠的场景 |",
        "| expect.risk_level = 高 | 应被判为高优先级；判低即漏报 |",
        "| expect.risk_level = 常规 | 应为常规；被判为高或观察即误报 |",
        "| risk_level 缺省 | 两种处理都可接受，不参与召回与误报统计 |",
        "| debatable = true | 标注存在争议，失败时优先归因为产品设计问题 |",
        "",
        "## 场景分布",
        "",
        "| 场景 | 条数 |",
        "| --- | --- |",
    ]
    counts = {}
    for c in testset["cases"]:
        counts[c["category"]] = counts.get(c["category"], 0) + 1
    for name, n in counts.items():
        lines.append("| %s | %d |" % (name, n))

    lines += ["", "## 用例明细", ""]
    for c in testset["cases"]:
        exp = c["expect"]
        labels = "、".join(exp.get("labels", []))
        sent = exp["sentiment"]
        sent = "/".join(sent) if isinstance(sent, list) else sent
        lines += [
            "### %s · %s" % (c["id"], c["category"]),
            "",
            "- 渠道：%s    用户：%s    商品：%s    时间：%s" % (
                c["channel"], c.get("customer_ref", "-"), c.get("product", "-"), c.get("time", "-")),
            "- 原文：%s" % c["text"],
            "- 期望：标签 %s · 情感 %s · 新信号 %s · 风险等级 %s" % (
                labels, sent, exp.get("is_new_signal"), exp.get("risk_level", "不限")),
            "- 考查点：%s" % c.get("checkpoint", ""),
        ]
        if c.get("debatable"):
            lines.append("- 备注：标注存在争议，失败时优先归因为产品设计问题。")
        lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("已导出 %s" % path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--export-md", action="store_true", help="由 JSON 生成可读版 testset-30.md")
    parser.add_argument("--testset", default="testset-30.json", help="评测集文件名，默认 testset-30.json；可用 testset-holdout.json 跑留出集")
    parser.add_argument("--agent1-mode", choices=["single", "batch"], default="single",
                        help="Agent1 输入形态：single=逐条（默认，鲁棒性优先）；batch=整批调用（省调用次数）")
    parser.add_argument("--agent1-batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                        help="batch 模式每批条数，默认 %d" % DEFAULT_BATCH_SIZE)
    args = parser.parse_args()

    load_env()
    testset = json.loads((EVAL_DIR / args.testset).read_text(encoding="utf-8"))

    if args.export_md:
        export_md(testset, EVAL_DIR / "testset-30.md")
        return

    history = load_history()
    cases = testset["cases"]
    print("历史信号库已载入：%d 个标签" % len(history["history7d"]))

    a1 = {"calls": 0, "fallbacks": 0}
    a2 = {"calls": 0}

    if args.agent1_mode == "batch":
        print("Agent1 批量标注中（%d 条，每批 %d 条）…" % (len(cases), args.agent1_batch_size))
    else:
        print("Agent1 逐条标注中（%d 条，并发 %d）…" % (len(cases), CONCURRENCY))
    cards = annotate(cases, history, args.agent1_mode, args.agent1_batch_size, a1)
    print("  已标注 %d 条，模型调用 %d 次%s"
          % (len(cards), a1["calls"], "，批量回退 %d 批" % a1["fallbacks"] if a1["fallbacks"] else ""))

    print("Agent2 逐条风险判断中（%d 次调用，并发 %d）…" % (len(cards), CONCURRENCY))
    risks = judge(cards, cases, history, a2)
    print("  已判断 %d 条，模型调用 %d 次" % (len(risks), a2["calls"]))
    print("  合计模型调用 %d 次" % (a1["calls"] + a2["calls"]))

    failed_calls = [x for x in (cards + risks) if x.get("_error")]
    if failed_calls:
        print("\n[警告] %d 次模型调用失败，这些用例按未命中计入：" % len(failed_calls))
        for x in failed_calls[:8]:
            print("   %s  %s" % (x.get("feedback_id"), x.get("_message")))

    metrics, rows = evaluate(testset, cards, risks)
    print_report(metrics, rows)

    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULT_DIR / "latest.json"
    out.write_text(json.dumps({
        "metrics": metrics, "rows": rows, "cards": cards, "risks": risks,
        "config": {
            "testset": args.testset,
            "agent1_mode": args.agent1_mode,
            "agent1_batch_size": args.agent1_batch_size,
            "agent1_calls": a1["calls"],
            "agent1_fallbacks": a1["fallbacks"],
            "agent2_calls": a2["calls"],
        },
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n结果已写入 %s" % out)


if __name__ == "__main__":
    main()






