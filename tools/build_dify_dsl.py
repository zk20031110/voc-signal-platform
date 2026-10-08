#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 prompts/*.md 生成 Dify Chatflow DSL。

为什么用脚本生成而不是手写 YAML：
  Prompt 是唯一事实来源。手写 YAML 会让 Prompt 和 DSL 两份内容逐渐漂移。

形态说明：
  三个 Agent 的 Prompt 都是「单条输入」设计，因此这里生成的是单条演示版
  Chatflow——用户一次粘一条反馈，走完标注 → 归因 → 建议。
  要处理一批反馈，需要在 Dify 里加一个迭代节点，见 README。

用法：
  python tools/build_dify_dsl.py
输出：
  dify/voc-chatflow.yml
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROMPT_DIR = ROOT / "prompts"
OUT_PATH = ROOT / "dify" / "voc-chatflow.yml"

# 官方当前版本为 0.7.0。这里写 0.6.0 是兼容策略：
#   Dify 0.7.0 导入 0.6.0 -> COMPLETED_WITH_WARNINGS（正常导入）
#   Dify 0.6.0 导入 0.6.0 -> COMPLETED
#   Dify 0.5.0 导入 0.6.0 -> PENDING（进入迁移流程，仍可导入）
DSL_VERSION = "0.6.0"

MODEL = {
    "provider": "deepseek",
    "name": "deepseek-chat",
    "mode": "chat",
    "completion_params": {"temperature": 0.2},
}

S = "b1f2c3d4-0001-4000-8000-000000000001"
A1 = "b1f2c3d4-0002-4000-8000-000000000002"
A2 = "b1f2c3d4-0003-4000-8000-000000000003"
A3 = "b1f2c3d4-0004-4000-8000-000000000004"
ANS = "b1f2c3d4-0005-4000-8000-000000000005"


class Dumper(yaml.SafeDumper):
    """让多行字符串以块状 | 输出，便于人工审阅 Prompt。"""


def _str_representer(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


Dumper.add_representer(str, _str_representer)


def load_prompt(name):
    return (PROMPT_DIR / name).read_text(encoding="utf-8").strip() + "\n"


def ref(node_id, field):
    return "{{#" + node_id + "." + field + "#}}"


def llm_node(node_id, title, desc, system_prompt, user_prompt, x, y):
    return {
        "data": {
            "context": {"enabled": False, "variable_selector": []},
            "desc": desc,
            "model": MODEL,
            "prompt_template": [
                {"id": node_id + "-sys", "role": "system", "text": system_prompt},
                {"id": node_id + "-usr", "role": "user", "text": user_prompt},
            ],
            "selected": False,
            "title": title,
            "type": "llm",
            "variables": [],
            "vision": {"enabled": False},
        },
        "height": 98,
        "id": node_id,
        "position": {"x": x, "y": y},
        "positionAbsolute": {"x": x, "y": y},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    }


def edge(edge_id, source, target, source_type, target_type):
    return {
        "data": {"isInIteration": False, "sourceType": source_type, "targetType": target_type},
        "id": edge_id,
        "source": source,
        "sourceHandle": "source",
        "target": target,
        "targetHandle": "target",
        "type": "custom",
        "zIndex": 0,
    }


def build():
    start_node = {
        "data": {
            "desc": "一次粘一条用户反馈。历史信号库与跨渠道记录选填，格式见 README。",
            "selected": False,
            "title": "开始",
            "type": "start",
            "variables": [
                {
                    "label": "用户反馈",
                    "max_length": 2048,
                    "options": [],
                    "required": True,
                    "type": "paragraph",
                    "variable": "feedback_text",
                },
                {
                    "label": "历史信号库（选填 JSON）",
                    "max_length": 4096,
                    "options": [],
                    "required": False,
                    "type": "paragraph",
                    "variable": "history_json",
                },
                {
                    "label": "同一用户其他渠道记录（选填 JSON 数组）",
                    "max_length": 2048,
                    "options": [],
                    "required": False,
                    "type": "paragraph",
                    "variable": "cross_channel_json",
                },
            ],
        },
        "height": 160,
        "id": S,
        "position": {"x": 40, "y": 300},
        "positionAbsolute": {"x": 40, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    }

    agent1 = llm_node(
        A1, "01 信号采集与标注",
        "单条反馈 → 标签 / 情感 / 实体 / 新信号标记",
        load_prompt("agent1-collector.md"),
        ref(S, "feedback_text"),
        340, 300,
    )

    agent2 = llm_node(
        A2, "02 风险识别与归因",
        "结合历史信号库与跨渠道记录，判断风险等级并归因",
        load_prompt("agent2-risk.md"),
        "【反馈卡】\n" + ref(A1, "text")
        + "\n\n【历史信号库】\n" + ref(S, "history_json")
        + "\n\n【该用户在其他渠道的历史反馈记录】\n" + ref(S, "cross_channel_json"),
        640, 300,
    )

    agent3 = llm_node(
        A3, "03 洞察生成与行动建议",
        "生成 Markdown 洞察报告与行动建议，证据链带语料编号",
        load_prompt("agent3-insight.md"),
        "【风险识别结果】\n" + ref(A2, "text")
        + "\n\n【过去7天历史信号统计】\n" + ref(S, "history_json"),
        940, 300,
    )

    answer_node = {
        "data": {
            "answer": ref(A3, "text"),
            "desc": "",
            "selected": False,
            "title": "输出报告",
            "type": "answer",
            "variables": [],
        },
        "height": 98,
        "id": ANS,
        "position": {"x": 1240, "y": 300},
        "positionAbsolute": {"x": 1240, "y": 300},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    }

    return {
        "app": {
            "description": "客户声音三 Agent 协作：采集标注 → 风险归因 → 洞察建议。单条反馈演示版。",
            "icon": "🛰",
            "icon_background": "#FFEAD5",
            "mode": "advanced-chat",
            "name": "VOC 信号台",
            "use_icon_as_answer_icon": False,
        },
        "kind": "app",
        "version": DSL_VERSION,
        "workflow": {
            "conversation_variables": [],
            "environment_variables": [],
            "features": {
                "file_upload": {
                    "allowed_file_extensions": [],
                    "allowed_file_types": ["image", "document"],
                    "allowed_file_upload_methods": ["local_file", "remote_url"],
                    "enabled": False,
                    "number_limits": 3,
                    "transfer_methods": ["local_file", "remote_url"],
                },
                "opening_statement": "把一条用户反馈粘进来，我会依次完成标签标注、风险判断与洞察报告。也可以补上历史信号库 JSON，判断会更准。",
                "retriever_resource": {"enabled": False},
                "sensitive_word_avoidance": {"enabled": False},
                "speech_to_text": {"enabled": False},
                "suggested_questions": [
                    "用了两天充电口就松了，根本没法用",
                    "退款原因写的是不喜欢，其实用了两天就坏了",
                ],
                "suggested_questions_after_answer": {"enabled": False},
                "text_to_speech": {"enabled": False, "language": "", "voice": ""},
            },
            "graph": {
                "edges": [
                    edge("e-start-agent1", S, A1, "start", "llm"),
                    edge("e-agent1-agent2", A1, A2, "llm", "llm"),
                    edge("e-agent2-agent3", A2, A3, "llm", "llm"),
                    edge("e-agent3-answer", A3, ANS, "llm", "answer"),
                ],
                "nodes": [start_node, agent1, agent2, agent3, answer_node],
                "viewport": {"x": 0, "y": 0, "zoom": 0.7},
            },
        },
    }


def self_check(dsl):
    """导入前自检：节点 id 唯一、连线合法、变量引用可解析。"""
    nodes = dsl["workflow"]["graph"]["nodes"]
    ids = [n["id"] for n in nodes]
    assert len(ids) == len(set(ids)), "节点 id 重复"

    known = set(ids)
    start_vars = set()
    for n in nodes:
        if n["data"]["type"] == "start":
            start_vars = {v["variable"] for v in n["data"]["variables"]}

    for e in dsl["workflow"]["graph"]["edges"]:
        assert e["source"] in known, "连线起点不存在: %s" % e["source"]
        assert e["target"] in known, "连线终点不存在: %s" % e["target"]

    refs = []
    for n in nodes:
        if n["data"]["type"] != "llm":
            continue
        assert n["data"]["model"]["provider"], "LLM 节点缺少模型提供商"
        assert n["data"]["prompt_template"], "LLM 节点缺少提示词"
        for item in n["data"]["prompt_template"]:
            for found in re.findall(r"\{\{#([^#}]+)#\}\}", item["text"]):
                refs.append(found)
                node_id, _, field = found.partition(".")
                assert node_id in known, "引用了不存在的节点：%s" % found
                if node_id == S:
                    assert field in start_vars, "start 节点不存在变量：%s" % field
    return len(nodes), len(dsl["workflow"]["graph"]["edges"]), refs


def main():
    dsl = build()
    n_nodes, n_edges, refs = self_check(dsl)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.dump(dsl, Dumper=Dumper, allow_unicode=True, sort_keys=False,
                     default_flow_style=False, width=100000)
    OUT_PATH.write_text(text, encoding="utf-8")

    # 回读校验
    reloaded = yaml.safe_load(OUT_PATH.read_text(encoding="utf-8"))
    assert reloaded["version"] == DSL_VERSION
    assert len(reloaded["workflow"]["graph"]["nodes"]) == n_nodes
    assert reloaded["workflow"]["graph"]["nodes"][1]["data"]["prompt_template"][0]["text"].startswith("# 角色")

    print("已生成 %s" % OUT_PATH)
    print("  DSL 版本：%s" % DSL_VERSION)
    print("  节点 %d 个，连线 %d 条，变量引用 %d 处" % (n_nodes, n_edges, len(refs)))
    print("  引用清单：%s" % ", ".join(sorted(set(refs))))
    for n in reloaded["workflow"]["graph"]["nodes"]:
        print("    - %s (%s)" % (n["data"]["title"], n["data"]["type"]))


if __name__ == "__main__":
    main()
