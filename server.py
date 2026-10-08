#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VOC 平台本地服务：静态托管 + DeepSeek 代理

设计取舍：
  密钥不放进前端。浏览器只请求 /api/chat，由本进程持有密钥后转发给 DeepSeek。
  好处是页面可以被截图、被分享、被审查，而不会连带泄露凭据。

启动：
  python server.py
  然后打开 http://localhost:8000
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROTOTYPE_DIR = ROOT / "prototype"
LABELS_FILE = ROOT / "data" / "labels.json"
REVIEWS_FILE = ROOT / "data" / "reviews.json"


def load_env():
    """读取项目根目录的 .env，已存在的系统环境变量优先。"""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_env()

API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")


class VocServer(ThreadingHTTPServer):
    """Windows 上 threading 服务器的默认 allow_reuse_address=1 会让多个进程绑同一端口，
    连接被随机分给其中任意一个，表现为「改了代码却不生效」。
    这里显式关掉端口复用，让重复启动时直接报错，而不是静默抢占。"""
    allow_reuse_address = False
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    server_version = "VOCPrototype/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROTOTYPE_DIR), **kwargs)

    # ---------- 工具 ----------

    def _safe_join(self, base, rel):
        """把相对路径解析到 base 之下，越界返回 None。"""
        target = (base / rel).resolve()
        try:
            target.relative_to(base.resolve())
        except ValueError:
            return None
        return target

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[voc] %s - %s\n" % (self.address_string(), fmt % args))

    # ---------- 路由 ----------

    # ---------- 标签体系演化：候选新标签与已确认标签的持久化 ----------

    def _load_labels(self):
        """读取标签状态。文件不存在时返回空结构，不报错。"""
        default = {"confirmed": [], "candidates": []}
        if not LABELS_FILE.exists():
            return default
        try:
            data = json.loads(LABELS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return default
        if not isinstance(data, dict):
            return default
        data.setdefault("confirmed", [])
        data.setdefault("candidates", [])
        return data

    def _save_labels(self, data):
        LABELS_FILE.parent.mkdir(parents=True, exist_ok=True)
        LABELS_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _load_reviews(self):
        """复核记录。pending 是待人工判定的，confirmed / rejected 是已判定的历史。"""
        default = {"items": []}
        if not REVIEWS_FILE.exists():
            return default
        try:
            data = json.loads(REVIEWS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return default
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return default
        return data

    def _save_reviews(self, data):
        REVIEWS_FILE.parent.mkdir(parents=True, exist_ok=True)
        REVIEWS_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/labels":
            return self._send_json(200, self._load_labels())

        if path == "/api/reviews":
            return self._send_json(200, self._load_reviews())

        if path in ("/", "/index.html"):
            self.path = "/index.html"
            return super().do_GET()

        # 让前端能直接抓取 Prompt 文件与评测集
        for prefix, base in (("/prompts/", ROOT / "prompts"), ("/eval/", ROOT / "eval"), ("/docs/", ROOT / "docs")):
            if path.startswith(prefix):
                target = self._safe_join(base, path[len(prefix):])
                if target is None or not target.is_file():
                    return self._send_json(404, {"error": "not found"})
                data = target.read_bytes()
                ctype = "text/markdown; charset=utf-8" if target.suffix == ".md" else "application/octet-stream"
                if target.suffix == ".json":
                    ctype = "application/json; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return

        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/labels":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as exc:
                return self._send_json(400, {"error": "请求体不是合法 JSON: %s" % exc})
            if not isinstance(payload, dict) or "confirmed" not in payload or "candidates" not in payload:
                return self._send_json(400, {"error": "缺少 confirmed 或 candidates 字段"})
            self._save_labels({"confirmed": payload["confirmed"], "candidates": payload["candidates"]})
            return self._send_json(200, {"ok": True})

        if path == "/api/reviews":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as exc:
                return self._send_json(400, {"error": "请求体不是合法 JSON: %s" % exc})
            if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
                return self._send_json(400, {"error": "缺少 items 字段"})
            self._save_reviews({"items": payload["items"]})
            return self._send_json(200, {"ok": True})

        if path != "/api/chat":
            return self._send_json(404, {"error": "not found"})

        if not API_KEY:
            return self._send_json(500, {"error": "未配置 DEEPSEEK_API_KEY，请检查项目根目录的 .env"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            return self._send_json(400, {"error": "请求体不是合法 JSON: %s" % exc})

        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._send_json(400, {"error": "缺少 messages 字段"})

        upstream = {
            "model": payload.get("model") or MODEL,
            "messages": messages,
            "temperature": payload.get("temperature", 0.2),
            "max_tokens": payload.get("max_tokens", 4000),
            "stream": False,
        }

        req = urllib.request.Request(
            BASE_URL + "/chat/completions",
            data=json.dumps(upstream, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + API_KEY,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            return self._send_json(exc.code, {"error": "DeepSeek 返回 %s: %s" % (exc.code, detail)})
        except Exception as exc:
            return self._send_json(502, {"error": "调用 DeepSeek 失败: %s" % exc})

        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            return self._send_json(502, {"error": "DeepSeek 返回结构异常: %s" % json.dumps(data, ensure_ascii=False)[:300]})

        return self._send_json(200, {"content": content, "usage": data.get("usage"), "model": data.get("model")})


def main():
    port = int(os.environ.get("PORT", "8000"))
    if len(sys.argv) > 1:
        port = int(sys.argv[1])

    if not API_KEY:
        print("[warn] 未检测到 DEEPSEEK_API_KEY，/api/chat 将不可用（页面仍可打开）")

    try:
        httpd = VocServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        print("[错误] 端口 %d 无法绑定：%s" % (port, exc))
        print("可能已经有另一个服务占着它（比如你之前启动的 server.py 没关）。")
        print("换个端口重试：python server.py 8010")
        raise SystemExit(1)

    print("VOC 原型已启动：http://localhost:%d" % port)
    print("模型：%s    上游：%s" % (MODEL, BASE_URL))
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()



