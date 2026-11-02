"""本機 ASR worker：server.py 用 mlx-whisper 的 venv 啟動它，stdin／stdout 一行一個 JSON。

請求 {"id", "model": 模型資料夾, "pcm_b64": 16 kHz 單聲道 s16le, "prompt"}；
回覆 {"id", "segments": [{"start", "end", "text"}], "ms"}，失敗回 {"id", "error"}。
音訊只在記憶體裡，不寫檔、不印內容；模型只讀本機快取（HF_HUB_OFFLINE）。
"""
import base64
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import mlx_whisper  # noqa: E402
import numpy as np  # noqa: E402

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        audio = np.frombuffer(base64.b64decode(req["pcm_b64"]), dtype="<i2").astype(np.float32) / 32768.0
        t0 = time.time()
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=req["model"],
            language="zh",
            # 每段獨立辨識：不接上一段的文字，避免一錯就重複同一句
            condition_on_previous_text=False,
            initial_prompt=req.get("prompt") or None,
            temperature=(0.0, 0.2, 0.4),
            verbose=None,
        )
        segments = [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in result.get("segments", [])]
        out = {"id": req.get("id"), "segments": segments, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001
        out = {"id": req.get("id"), "error": type(e).__name__}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
