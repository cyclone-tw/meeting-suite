"""假的本機 ASR worker：和 asr_worker.py 同樣的 stdin／stdout 協定，不載模型。

每則請求回一個段落「第N段」（N 從 1 起），時間是整段長度。FAKE_ASR=halluc → 回字幕站口白；
repeat → 回段內重複；error → 回 error；slow → 每段慢 0.3 秒；hang → 讀了不回；stuck → 完全不讀 stdin。回覆帶 pid 讓測試看有沒有重開。
"""
import base64
import json
import os
import sys
import time

mode = os.environ.get("FAKE_ASR", "")
if mode == "stuck":
    time.sleep(60)
n = 0
for line in sys.stdin:
    req = json.loads(line)
    n += 1
    if mode == "hang":
        continue
    if mode == "slow":
        time.sleep(0.3)
    if mode == "error":
        print(json.dumps({"id": req["id"], "error": "ValueError"}), flush=True)
        continue
    dur = len(base64.b64decode(req["pcm_b64"])) / 32000
    text = {"halluc": "謝謝觀看", "repeat": "好的好的好的好的"}.get(mode, f"第{n}段")
    segs = [{"start": 0.0, "end": dur, "text": text}, {"start": dur / 2, "end": dur, "text": f"{req['model']}|{req.get('prompt', '')}|{os.getpid()}"}]
    print(json.dumps({"id": req["id"], "segments": segs, "ms": 5}, ensure_ascii=False), flush=True)
