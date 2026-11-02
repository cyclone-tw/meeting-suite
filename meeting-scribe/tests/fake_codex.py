"""假的 Codex CLI（`codex exec --json … -`）：從 stdin 讀整份 prompt，照真的 codex 印 JSONL 事件。給備援測試用（#108）。

FAKE_CODEX_MODE=fail → turn.failed、結束碼 1；hang → 讀完不回。
FAKE_CODEX_LOG=<檔案> → 每次呼叫追加一行 JSON：參數、工作目錄、prompt、有沒有拿到不該拿的環境變數。
"""
import json
import os
import sys
import time

prompt = sys.stdin.read()
mode = os.environ.get("FAKE_CODEX_MODE", "")
log = os.environ.get("FAKE_CODEX_LOG")
if log:
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "argv": sys.argv[1:], "cwd": os.getcwd(), "files": os.listdir("."), "prompt": prompt,
            "leaked": sorted(k for k in os.environ if k in ("CLAUDE_CODE_OAUTH_TOKEN", "SONIOX_API_KEY") or k.startswith("ANTHROPIC_")),
        }, ensure_ascii=False) + "\n")


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


emit({"type": "thread.started", "thread_id": "fake"})
emit({"type": "turn.started"})
if mode == "hang":
    time.sleep(60)
if mode == "fail":
    emit({"type": "error", "message": "boom"})
    emit({"type": "turn.failed", "error": {"message": "boom"}})
    sys.exit(1)
# 這一題在最後面：前文裡也有 <transcript>，取最後一個
if "<transcript>" in prompt and "段逐字稿" in prompt.rsplit("</assistant>", 1)[-1]:
    text = prompt.rsplit("<transcript>\n", 1)[1].split("\n</transcript>", 1)[0]
    reply = json.dumps({"corrected": f"codex:{text}", "new_topic": True, "summary": "codex 重點"}, ensure_ascii=False)
elif "目前為止重點" in prompt.rsplit("</assistant>", 1)[-1]:
    reply = "## 大綱\n- codex 即時摘要"
elif "會後總結包" in prompt.rsplit("</assistant>", 1)[-1]:
    reply = json.dumps({"intro": "codex 導言", "chapters": [{"t": "00:00:00", "title": "開場"}], "full": "## 核心結論\ncodex", "short": "codex 短總結"},
                       ensure_ascii=False)
else:
    reply = "{}"
emit({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": reply}})
emit({"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 10}})
