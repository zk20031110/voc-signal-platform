#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
链路冒烟测试：通过本地服务把一批反馈跑完三个 Agent，校验契约。

比评测集更快、更便宜，用于确认环境是否可用（密钥、模型、Prompt、代理）。
先启动服务，再运行：

  python server.py
  python tools/smoke_test.py
"""

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPT_DIR = ROOT / "prompts"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"

# 刻意放了一条跨渠道矛盾样本：U2043 的退款理由与客服记录互相矛盾
BATCH = [
    ("F001", "评价", "U2043", "便携榨汁杯", "用了两天充电口就松了，根本没法用"),
    ("F002", "客服对话", "U2043", "便携榨汁杯", "插上充电线一点反应都没有，这算质量问题吧"),
    ("F003", "退款说明", "U2043", "便携榨汁杯", "不喜欢"),
    ("F004", "评价", "U2091", "便携榨汁杯", "快递太慢了，等了六天才到，东西还没拆"),
]

HISTORY = {
    "history_7d": {
        "质量问题": {"total": 14, "negative": 11, "trend": "上升", "negative_24h": 6},
        "物流问题": {"total": 9, "negative": 5, "trend": "平稳", "negative_24h": 2},
        "其他": {"total": 11, "negative": 3, "trend": "平稳", "negative_24h": 0},
    },
    "negative_24h_total": 8,
}

PRESET = ["质量问题", "物流问题", "服务问题", "尺寸问题", "色差问题", "包装问题", "价格问题", "其他"]


def chat(messages):
    payload = json.dumps({"messages": messages, "temperature": 0.2, "max_tokens": 8000},
                         ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + "/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))["content"]
    except urllib.error.HTTPError as exc:
        raise SystemExit("请求失败 HTTP %s: %s" % (exc.code, exc.read().decode("utf-8", "replace")[:400]))
    except urllib.error.URLError as exc:
        raise SystemExit("连不上本地服务 %s（%s）。请先运行 python server.py" % (BASE, exc.reason))


def extract_json(text):
    s = text.strip()
    if s.startswith("```"):
        s = s.split("```")[1]
        s = s[4:] if s.lower().startswith("json") else s
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("输出中找不到 JSON 对象：%s" % s[:160])
    return json.loads(s[start:end + 1])


def call_json(prompt_file, user_content):
    """单条 Prompt 偶尔会在字符串里用未转义的英文引号，导致 JSON 不合法。
    Prompt 不改，改由调用层纠错重试一次。"""
    system = (PROMPT_DIR / prompt_file).read_text(encoding="utf-8")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user_content}]
    last = None
    for _ in range(2):
        content = chat(messages)
        try:
            return extract_json(content)
        except Exception as exc:  # noqa: BLE001
            last = exc
            messages.append({"role": "assistant", "content": content[:1200]})
            messages.append({"role": "user", "content": "上一条不是合法 JSON（常见原因是字符串内部出现了未转义的英文双引号）。请只输出一个 JSON 对象，不要代码围栏；字符串内部的引号统一改用中文引号「」。"})
    raise SystemExit("JSON 重试后仍然失败：%s" % last)


def call_text(prompt_file, user_content):
    system = (PROMPT_DIR / prompt_file).read_text(encoding="utf-8")
    return chat([{"role": "system", "content": system}, {"role": "user", "content": user_content}])


def check(cond, msg):
    if not cond:
        raise SystemExit("契约校验失败：" + msg)


def main():
    print("目标服务：%s" % BASE)

    print("\n[1/3] Agent1 逐条标注 …")
    cards = []
    for fid, channel, ref, product, text in BATCH:
        user = "渠道：%s\n商品：%s\n用户标识：%s\n时间：2026-10-01\n\n反馈原文：\n%s" % (channel, product, ref, text)
        data = call_json("agent1-collector.md", user)
        data["feedback_id"] = fid
        data["customer_ref"] = ref
        cards.append(data)
        bad = [l for l in data.get("labels", []) if l not in PRESET]
        check(not bad, "%s 输出了预设外的标签 %s（应为新信号 + suggested_label）" % (fid, bad))
        check("sentiment" in data, "%s 缺少 sentiment" % fid)
        print("      %s %s | %s | %s | 新信号=%s" % (
            fid, channel, "/".join(data.get("labels", [])), data.get("sentiment"), data.get("is_new_signal")))
    check(len(cards) == len(BATCH), "标注条数不一致")

    print("\n[2/3] Agent2 逐条风险判断 …")
    risks = []
    for card in cards:
        same_user = [
            {"feedback_id": c["feedback_id"], "channel": c["channel"], "summary": c.get("summary"), "labels": c.get("labels")}
            for c in cards if c.get("customer_ref") == card.get("customer_ref") and c["feedback_id"] != card["feedback_id"]
        ]
        user = ("【反馈卡】\n" + json.dumps(card, ensure_ascii=False, indent=2)
                + "\n\n【历史信号库】\n" + json.dumps(HISTORY, ensure_ascii=False, indent=2)
                + "\n\n【该用户在其他渠道的历史反馈记录】\n" + json.dumps(same_user, ensure_ascii=False, indent=2))
        data = call_json("agent2-risk.md", user)
        check(data.get("risk_level") in ("高", "观察", "常规"), "%s 的风险等级不合法：%s" % (card["feedback_id"], data.get("risk_level")))
        check(isinstance(data.get("need_human_review"), bool), "%s 缺少 need_human_review" % card["feedback_id"])
        data["feedback_id"] = card["feedback_id"]
        data["labels"] = card.get("labels") or []
        data["channel"] = card.get("channel")
        risks.append(data)
        print("      %s [%s] 人审=%s | %s" % (
            card["feedback_id"], data.get("risk_level"), data.get("need_human_review"),
            (data.get("risk_reason") or "")[:48]))

    print("\n[3/3] Agent3 生成洞察报告（按等级+主标签归组后逐组调用）…")
    groups = {}
    for r in risks:
        key = (r["risk_level"], (r["labels"] or ["其他"])[0])
        g = groups.setdefault(key, {"ids": [], "channels": set(), "reasons": [], "attributions": [], "review": False})
        g["ids"].append(r["feedback_id"])
        g["channels"].add(r["channel"])
        g["reasons"].append(r.get("risk_reason") or "")
        g["attributions"].append(r.get("attribution") or "")
        g["review"] = g["review"] or bool(r.get("need_human_review"))

    rank = {"高": 0, "观察": 1, "常规": 2}
    targets = [(k, v) for k, v in groups.items() if k[0] in ("高", "观察")]
    targets.sort(key=lambda kv: rank.get(kv[0][0], 3))
    print("      聚合出 %d 组，其中需要生成报告 %d 组" % (len(groups), len(targets)))

    for (level, label), g in targets:
        risk_result = {
            "risk_level": level,
            "risk_reason": "；".join(filter(None, g["reasons"])),
            "attribution": "；".join(filter(None, g["attributions"])),
            "need_human_review": g["review"],
            "review_reason": "含高风险信号" if g["review"] else None,
        }
        evidence = {"语料数量": len(g["ids"]), "来源渠道": sorted(g["channels"]), "语料编号": g["ids"]}
        user = ("【风险识别结果】\n" + json.dumps(risk_result, ensure_ascii=False, indent=2)
                + "\n\n【证据材料】\n" + json.dumps(evidence, ensure_ascii=False, indent=2)
                + "\n\n【过去7天历史信号统计】\n" + json.dumps(HISTORY["history_7d"], ensure_ascii=False, indent=2))
        md = call_text("agent3-insight.md", user)
        ids = re.findall(r"语料编号[：:]\s*([^\n]+)", md)
        parsed = [x.strip() for x in re.split(r"[，,、;；\s]+", ids[0])] if ids else []
        check(any(k in md for k in ("核心发现", "洞察报告")), "[%s/%s] 报告缺少核心发现段" % (level, label))
        check("行动建议" in md, "[%s/%s] 报告缺少行动建议段" % (level, label))
        print("      [%s] %s | 语料编号行：%s" % (level, label, "、".join(parsed) or "缺失"))

    print("\n链路冒烟测试通过：三个 Agent 输出合法、标签在预设范围内、风险等级合规、报告结构完整。")


if __name__ == "__main__":
    main()


