"""匯入錄好的檔案（#90）：上傳 → ffmpeg 轉 m4a 進暫存 → 本機 Whisper 或 Soniox 非即時轉錄，事件走 /api/local/events。"""
import http.client
import json
import math
import subprocess
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from fake_soniox import KEY, FakeSoniox  # noqa: E402
from test_local_asr import FAKE, make_hub  # noqa: E402

MID = "0123456789abcdef0123456789abcdef"
DRAFT = "fedcba9876543210fedcba9876543210"
HAVE_FFMPEG = bool(server.media_tool("ffmpeg") and server.media_tool("ffprobe"))


def wav_bytes(secs, rate=44100):
    """立體聲 44.1 kHz 的正弦波（跟一般錄音檔一樣，要經過 ffmpeg 轉成 16 kHz 單聲道）。"""
    path = Path(tempfile.mkdtemp()) / "t.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(secs * rate)):
            v = int(8000 * math.sin(2 * math.pi * 440 * i / rate)) if (i // rate) % 7 != 6 else 0   # 每 7 秒停 1 秒
            frames += v.to_bytes(2, "little", signed=True) * 2
        w.writeframes(bytes(frames))
    data = path.read_bytes()
    path.unlink()
    return data


class SttEventsTest(unittest.TestCase):
    def test_pauses_batches_and_speakers(self):
        tokens = [{"text": "甲", "start_ms": 0, "end_ms": 300, "speaker": 1}, {"text": "乙", "start_ms": 300, "end_ms": 600, "speaker": 1},
                  {"text": "譯", "start_ms": 600, "end_ms": 900, "translation_status": "translation"},
                  {"text": "丙", "start_ms": 2000, "end_ms": 2400, "speaker": 2}, {"text": "丁", "start_ms": 65000, "end_ms": 65500},
                  "壞掉的", {"start_ms": 1}]
        batches = server.stt_events(tokens, batch_ms=30000)
        self.assertEqual(len(batches), 2, "超過 30 秒的另起一批")
        # 停頓 1 秒以上補 <end>（跨批時收在上一批結尾，那一段才會先送 AI）；翻譯 token 不收
        self.assertEqual([t["text"] for t in batches[0]], ["甲", "乙", "<end>", "丙", "<end>"])
        self.assertEqual(batches[0][0], {"text": "甲", "speaker": "1", "start": 0})
        self.assertEqual([t["text"] for t in batches[1]], ["丁"])
        self.assertIsNone(batches[1][0]["speaker"])
        self.assertEqual(server.stt_events([]), [])


class ImportBase(unittest.TestCase):
    """真的開 server、假的 Soniox 與本機辨識；config 預設 server 模式（client=True 的子類別改成 client 模式）。"""
    client = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.worker = server.AsrWorker(command=FAKE)
        self.addCleanup(self.worker._stop)
        self.asr_hub = server.AgentHub(factory=lambda mid: server.LocalAsrSession(mid, worker=self.worker))
        self.drafts = server.DraftStore(Path(self.tmp.name) / "drafts")
        self.drafts.put_meta(DRAFT, {"title": "匯入測試", "state": "recording"})
        self.soniox = FakeSoniox().start()
        self.addCleanup(self.soniox.stop)
        patches = [
            mock.patch.object(server.Handler, "asr_hub", self.asr_hub),
            mock.patch.object(server.Handler, "hf_hub", make_hub(Path(self.tmp.name) / "hf")),
            mock.patch.object(server.Handler, "api_key", KEY),
            mock.patch.object(server.Handler, "drafts", self.drafts),
            mock.patch.object(server, "asr_python", lambda: Path(sys.executable)),
            mock.patch.object(server, "SONIOX_API", self.soniox.url),
            mock.patch.object(server, "SONIOX_POLL_S", 0.05),
            mock.patch.dict(server.IMPORTS, {}, clear=True),
            mock.patch.dict(os.environ, {"FAKE_ASR": ""}),
        ]
        cfg = Path(self.tmp.name) / "config.json"
        cfg.write_text(json.dumps({"asr_key_mode": "client"} if self.client else {}), encoding="utf-8")
        patches.append(mock.patch.object(server.Handler, "config_file", cfg))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [j.stop() for j in list(server.IMPORTS.values())])
        self.addCleanup(lambda: [s.close() for s in self.asr_hub.sessions.values()])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def req(self, path, body=None, raw=None, binary=False):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET",
                                   headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, (resp.read() if binary else json.loads(resp.read()))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def start(self, engine, terms=("資源教室", "IEP")):
        return self.req("/api/import/start", {"meeting": MID, "draft": DRAFT, "engine": engine, "terms": list(terms)})

    def events(self, timeout=40):
        """收事件直到 done；總時間超過 timeout 就失敗（伺服器每 15 秒送 keepalive，不會一直卡在讀取）。"""
        got, deadline = [], time.time() + timeout
        with urllib.request.urlopen(f"{self.base}/api/local/events?meeting={MID}", timeout=timeout) as r:
            for raw in r:
                line = raw.decode().strip()
                if line.startswith("data: "):
                    got.append(json.loads(line[6:]))
                    if got[-1]["type"] == "done":
                        return got
                if time.time() > deadline:
                    break
        raise AssertionError(f"等不到 done：{[e['type'] for e in got]}")

    def assert_audio_saved(self):
        meta = self.drafts.load(DRAFT)["meta"]
        self.assertEqual(meta["audio"]["1"]["ext"], "m4a")
        parts = self.drafts.audio_parts(DRAFT)
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0][1].stat().st_mode & 0o777, 0o600)
        self.assertGreater(server.probe_duration_ms(parts[0][1]), 10000, "存的是轉好的 m4a，長度跟原檔一樣")
        self.assertFalse((parts[0][1].parent / "import-src").exists(), "原檔轉完就刪")


@unittest.skipUnless(HAVE_FFMPEG, "沒有 ffmpeg")
class ImportHttpTest(ImportBase):
    def test_whisper_import_streams_tokens_and_keeps_audio(self):
        self.assertEqual(self.start("whisper")[0], 200)
        self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(14)), (200, {"ok": True}))
        events = self.events()
        kinds = [e["type"] for e in events]
        self.assertEqual(kinds[-1], "done")
        self.assertIn("import", kinds)
        self.assertGreaterEqual(kinds.count("tokens"), 2, "14 秒切成幾段辨識")
        stages = [e["stage"] for e in events if e["type"] == "import"]
        self.assertEqual(stages[0], "convert")
        self.assertIn(next(e for e in events if e["type"] == "import")["total_ms"] // 1000, (13, 14))
        texts = " ".join(t["text"] for e in events if e["type"] == "tokens" for t in e["tokens"])
        self.assertIn("資源教室、IEP", texts, "專有名詞當 Whisper 提示詞")
        starts = [t["start"] for e in events if e["type"] == "tokens" for t in e["tokens"]]
        self.assertEqual(starts, sorted(starts))
        self.assert_audio_saved()
        self.assertEqual(self.req(f"/api/import/status?meeting={MID}")[1]["running"], False)

    def test_whisper_feed_waits_for_recognition(self):
        # 辨識慢的時候不會一口氣把整個檔塞進記憶體：最多先塞 IMPORT_FEED_AHEAD_S 秒（再加一次讀的 1 秒）；
        # 設得比一段辨識還短也不會卡死（自動放寬到 MAX_WINDOW_MS＋2 秒）
        peak = [0]

        class Watched(server.LocalAsrSession):
            def add_audio(inner, data):
                super().add_audio(data)
                peak[0] = max(peak[0], len(inner.pcm))

        self.asr_hub.factory = lambda mid: Watched(mid, worker=self.worker)
        with mock.patch.object(server, "IMPORT_FEED_AHEAD_S", 2), mock.patch.dict(os.environ, {"FAKE_ASR": "slow"}):
            self.start("whisper")
            self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(45))
            self.assertEqual(self.events(timeout=60)[-1]["type"], "done")
        limit = (server.MAX_WINDOW_MS + 3000) * server.SAMPLE_RATE // 1000
        self.assertLessEqual(peak[0], limit, f"緩衝最多 {peak[0] / server.SAMPLE_RATE:.1f} 秒")
        self.assertGreater(peak[0], 0)

    def test_soniox_import_batches_speakers_and_cleans_up(self):
        self.assertEqual(self.start("soniox")[0], 200)
        self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(12))[0], 200)
        events = self.events()
        self.assertEqual(events[-1]["type"], "done")
        stages = [e["stage"] for e in events if e["type"] == "import"]
        for s in ("convert", "upload_stt", "queued", "transcribing"):
            self.assertIn(s, stages)
        batches = [e["tokens"] for e in events if e["type"] == "stt"]
        self.assertEqual(len(batches), 2)
        self.assertEqual([t["text"] for t in batches[0]], ["今天", "討論 IEP。", "<end>", "好的", "，下週再談。", "<end>"])
        self.assertEqual(batches[0][3]["speaker"], "2")
        create = next(p for m, path, p in self.soniox.requests if m == "POST" and path == "/v1/transcriptions")
        self.assertEqual(create["model"], "stt-async-v5")
        self.assertTrue(create["enable_speaker_diarization"])
        self.assertEqual(create["context"]["terms"], ["資源教室", "IEP"])
        upload = next(p for m, path, p in self.soniox.requests if path == "/v1/files")
        self.assertIn(b'filename="meeting.m4a"', upload)
        self.assertEqual((self.soniox.files, self.soniox.jobs), ({}, {}), "Soniox 上的檔案與轉錄用完就刪")
        self.assert_audio_saved()

    def test_file_without_duration_header(self):
        # 瀏覽器錄的 webm 常沒寫長度：照樣匯入，長度改用轉好的 m4a 算
        src = Path(self.tmp.name) / "in.wav"
        src.write_bytes(wav_bytes(12))
        live = Path(self.tmp.name) / "live.webm"
        subprocess.run([server.media_tool("ffmpeg"), "-loglevel", "error", "-y", "-i", str(src), "-c:a", "libopus", "-f", "webm", "-live", "1", str(live)], check=True)
        self.assertEqual(server.probe_duration_ms(live), 0, "這個檔案確實沒有長度")
        self.start("whisper")
        self.req(f"/api/import/file?meeting={MID}", raw=live.read_bytes())
        events = self.events()
        self.assertFalse(any(e["type"] == "error" for e in events), events)
        self.assertIn(max(e["total_ms"] for e in events if e["type"] == "import") // 1000, (11, 12))
        self.assertTrue(any(e["type"] == "tokens" for e in events))

    def test_soniox_cleanup_survives_unexpected_errors(self):
        # 刪轉錄時丟出 _api 沒包到的例外：不能蓋掉結果，也要接著刪檔案
        orig = server.ImportJob._api

        def flaky(job, method, path, *a, **k):
            if method == "DELETE" and "/v1/transcriptions/" in path:
                raise http.client.IncompleteRead(b"")
            return orig(job, method, path, *a, **k)

        with mock.patch.object(server.ImportJob, "_api", flaky):
            self.start("soniox")
            self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(2))
            events = self.events()
        self.assertFalse(any(e["type"] == "error" for e in events), events)
        self.assertTrue(any(e["type"] == "stt" for e in events))
        self.assertEqual(self.soniox.files, {}, "轉錄刪不掉也要接著刪檔案")

    def test_soniox_errors_are_reported(self):
        self.soniox.fail[("POST", "/v1/transcriptions")] = 402
        self.assertEqual(self.start("soniox")[0], 200)
        self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(2))[0], 200)
        events = self.events()
        err = next(e for e in events if e["type"] == "error")
        self.assertTrue(err["fatal"])
        self.assertIn("餘額不足", err["error"])
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(self.soniox.files, {}, "失敗也要刪掉已上傳的檔案")

    def test_soniox_failed_status(self):
        self.soniox.final_status = "error"
        self.start("soniox")
        self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(2))
        err = next(e for e in self.events() if e["type"] == "error")
        self.assertIn("bad audio", err["error"])

    def test_unreadable_file_and_too_long(self):
        self.start("whisper")
        self.req(f"/api/import/file?meeting={MID}", raw="這不是音檔".encode() * 100)
        events = self.events()
        self.assertIn("看不懂", next(e for e in events if e["type"] == "error")["error"])
        self.assertEqual(events[-1]["type"], "done")
        self.assertNotIn("1", self.drafts.load(DRAFT)["meta"]["audio"])
        self.asr_hub.sessions.clear()
        with mock.patch.object(server, "MAX_IMPORT_MS", 1000):
            self.start("soniox")
            self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(3))
            self.assertIn("太長", next(e for e in self.events() if e["type"] == "error")["error"])
        # 檔頭沒寫長度的太長檔案：轉檔最多轉到上限＋1 分鐘就停，接著擋下
        self.asr_hub.sessions.clear()
        src = Path(self.tmp.name) / "long.wav"
        src.write_bytes(wav_bytes(5))
        live = Path(self.tmp.name) / "long.webm"
        subprocess.run([server.media_tool("ffmpeg"), "-loglevel", "error", "-y", "-i", str(src), "-c:a", "libopus", "-f", "webm", "-live", "1", str(live)], check=True)
        orig = server.ImportJob._ffmpeg
        seen = []
        with mock.patch.object(server, "MAX_IMPORT_MS", 0), mock.patch.object(server.ImportJob, "_ffmpeg", lambda job, args: seen.append(args) or orig(job, args)):
            self.start("whisper")
            self.req(f"/api/import/file?meeting={MID}", raw=live.read_bytes())
            self.assertIn("太長", next(e for e in self.events() if e["type"] == "error")["error"])
        self.assertEqual(seen[0][seen[0].index("-t") + 1], "60", "轉檔帶 -t 上限")

    def test_cancel_while_waiting_for_soniox(self):
        self.soniox.polls_before_done = 10 ** 6
        self.start("soniox")
        self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(3))
        deadline = time.time() + 20
        while not any(m == "GET" and "/v1/transcriptions/" in p for m, p, _ in self.soniox.requests):
            self.assertLess(time.time(), deadline, "沒開始查狀態")
            time.sleep(0.05)
        self.assertEqual(self.req("/api/import/cancel", {"meeting": MID}), (200, {"ok": True}))
        events = self.events()
        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(any(e["type"] == "error" for e in events), "取消不是錯誤")
        self.assertEqual((self.soniox.files, self.soniox.jobs), ({}, {}))

    def test_stale_slot_uses_last_upload_activity(self):
        # 很早就開始、但一直在收資料的上傳不算丟下；十分鐘沒收到資料才讓出位置
        self.start("whisper")
        job = server.IMPORTS[MID]
        other = "1" * 32
        self.drafts.put_meta(other, {"state": "recording"})
        job.created = time.monotonic() - 3600
        self.assertEqual(self.req("/api/import/start", {"meeting": "2" * 32, "draft": other, "engine": "whisper"})[0], 409)
        job.touched = time.monotonic() - 601
        self.assertEqual(self.req("/api/import/start", {"meeting": "2" * 32, "draft": other, "engine": "whisper"})[0], 200)
        self.assertNotIn(MID, server.IMPORTS)

    def test_upload_finishing_after_its_slot_was_taken_is_dropped(self):
        self.start("whisper")
        job = server.IMPORTS[MID]
        real = self.drafts.import_path

        def kicked(draft):   # 上傳途中位置被讓出去
            server.IMPORTS.pop(MID, None)
            return real(draft)

        with mock.patch.object(self.drafts, "import_path", kicked):
            self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(2))[0], 409)
        self.assertFalse(job.received, "被讓出去的匯入不能開始轉檔")
        self.assertFalse((Path(self.tmp.name) / "drafts" / DRAFT / "import-src").exists())

    def test_cancel_while_converting_reaps_ffmpeg_and_partial_file(self):
        orig = server.ImportJob._ffmpeg

        def realtime(job, args):   # 照播放速度讀，轉檔才會久到來得及取消
            return orig(job, ["-re", *args] if "-progress" in args else args)

        with mock.patch.object(server.ImportJob, "_ffmpeg", realtime):
            self.start("whisper")
            job = server.IMPORTS[MID]
            self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(20))
            deadline = time.time() + 10
            while not (job.stage == "convert" and job.proc and (Path(self.tmp.name) / "drafts" / DRAFT / "import-audio.m4a").exists()):
                self.assertLess(time.time(), deadline, "沒開始轉檔")
                time.sleep(0.05)
            time.sleep(1)
            self.req("/api/import/cancel", {"meeting": MID})
            self.assertEqual(self.events()[-1]["type"], "done")
        self.assertIsNotNone(job.proc.returncode, "ffmpeg 要收掉")
        left = sorted(p.name for p in (Path(self.tmp.name) / "drafts" / DRAFT).iterdir())
        self.assertNotIn("import-audio.m4a", left)
        self.assertNotIn("import-src", left)
        self.assertEqual(self.drafts.load(DRAFT)["meta"]["audio"], {})

    def test_write_error_during_upload_removes_partial_file(self):
        self.start("whisper")
        real = os.fdopen

        class DiskFull:
            def __init__(self, fd):
                self.f, self.n = real(fd, "wb"), 0

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.f.close()

            def write(self, b):
                self.n += 1
                if self.n > 1:
                    raise OSError("disk full")
                self.f.write(b)

        with mock.patch.object(server.os, "fdopen", lambda fd, mode: DiskFull(fd)):
            try:
                status = self.req(f"/api/import/file?meeting={MID}", raw=b"x" * (3 * 1024 * 1024))[0]
            except (urllib.error.URLError, ConnectionError):
                status = None   # 伺服器沒讀完就回應，連線可能被重設
        self.assertIn(status, (500, None))
        err = next(e for e in self.events() if e["type"] == "error")
        self.assertIn("收檔失敗", err["error"])
        self.assertFalse((Path(self.tmp.name) / "drafts" / DRAFT / "import-src").exists(), "寫到一半的原檔要刪掉")

    def test_validation(self):
        self.assertEqual(self.req("/api/import/start", {"meeting": MID, "draft": DRAFT, "engine": "breeze"})[0], 400)
        self.assertEqual(self.req("/api/import/start", {"meeting": MID, "draft": "x", "engine": "whisper"})[0], 400)
        self.assertEqual(self.req("/api/import/start", {"meeting": MID, "draft": "a" * 32, "engine": "whisper"})[0], 404)
        self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=b"x")[0], 409, "沒 start 不收檔")
        with mock.patch.object(server.Handler, "api_key", None):
            self.assertEqual(self.req("/api/import/start", {"meeting": MID, "draft": DRAFT, "engine": "soniox"})[0], 503)
        with mock.patch.object(server, "media_tool", lambda name: None):
            self.assertEqual(self.req("/api/import/start", {"meeting": MID, "draft": DRAFT, "engine": "whisper"})[0], 503)
        self.assertEqual(self.start("whisper")[0], 200)
        other = "1" * 32
        self.drafts.put_meta(other, {"state": "recording"})
        self.assertEqual(self.req("/api/import/start", {"meeting": "2" * 32, "draft": other, "engine": "whisper"})[0], 409, "同時只准一個匯入")
        self.assertEqual(self.req("/api/import/cancel", {"meeting": MID}), (200, {"ok": True}))
        self.assertEqual(self.events()[-1]["type"], "done", "還沒上傳就取消：直接結束")
        self.assertEqual(server.IMPORTS, {})


class CleanClientTokensTest(unittest.TestCase):
    def test_keeps_only_known_fields(self):
        got = server.clean_client_tokens([
            {"text": "甲", "start_ms": 0, "end_ms": 300, "speaker": "1", "confidence": 0.9, "x": {"deep": 1}},
            {"text": "乙", "start_ms": True, "end_ms": -5, "speaker": {"a": 1}, "translation_status": "evil"},
            {"text": "丙", "speaker": 2, "translation_status": "translation"},
            {"text": "長" * 501}, {"start_ms": 1}, "字串", None, 7,
        ])
        self.assertEqual(got, [{"text": "甲", "start_ms": 0, "end_ms": 300, "speaker": "1"}, {"text": "乙"},
                               {"text": "丙", "speaker": 2, "translation_status": "translation"}])
        for bad in (None, {}, "tokens", 1):
            self.assertIsNone(server.clean_client_tokens(bad))
        with mock.patch.object(server, "CLIENT_MAX_TOKENS", 2):
            self.assertIsNone(server.clean_client_tokens([{"text": "a"}] * 3))
        self.assertEqual(server.clean_client_tokens([]), [])


@unittest.skipUnless(HAVE_FFMPEG, "沒有 ffmpeg")
class ClientImportHttpTest(ImportBase):
    """client 模式（#114）：主機只轉檔，Soniox 由瀏覽器呼叫；主機就算有金鑰也不用。"""
    client = True

    def assert_slot_freed(self):
        # done 先送出，匯入位置在收尾的 finally 才讓出：等一下
        deadline = time.time() + 5
        while server.IMPORTS and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(server.IMPORTS, {})

    def upload(self, secs=12):
        self.assertEqual(self.start("soniox"), (200, {"ok": True, "max_bytes": server.MAX_IMPORT_BYTES, "max_minutes": server.MAX_IMPORT_MS // 60000}))
        job = server.IMPORTS[MID]
        self.assertTrue(job.client)
        self.assertIsNone(job.api_key, "client 模式不把主機的金鑰交給匯入")
        self.assertEqual(self.req(f"/api/import/file?meeting={MID}", raw=wav_bytes(secs))[0], 200)
        deadline = time.time() + 20
        while not job.waiting_client():
            self.assertFalse(job.finished, "轉檔後要停下來等瀏覽器")
            self.assertLess(time.time(), deadline, "轉檔沒有完成")
            time.sleep(0.05)
        return job

    def test_browser_transcribes_and_host_batches_the_result(self):
        job = self.upload()
        self.assertEqual(self.req(f"/api/import/status?meeting={MID}")[1], {"running": True, "stage": "client_asr"})
        status, audio = self.req(f"/api/import/audio?meeting={MID}", binary=True)
        self.assertEqual(status, 200)
        self.assertEqual(audio, self.drafts.audio_parts(DRAFT)[0][1].read_bytes(), "給瀏覽器的是暫存裡轉好的 m4a")
        self.assertEqual(self.req("/api/import/progress", {"meeting": MID, "stage": "transcribing"}), (200, {"ok": True}))
        self.assertEqual(job.stage, "transcribing")
        self.req("/api/import/progress", {"meeting": MID, "stage": "evil"})
        self.assertEqual(job.stage, "transcribing", "不認得的階段不收")
        from fake_soniox import TOKENS
        status, body = self.req("/api/import/transcript", {"meeting": MID, "tokens": TOKENS + [{"bad": 1}]})
        self.assertEqual((status, body), (200, {"ok": True, "tokens": len(TOKENS)}))
        events = self.events()
        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(any(e["type"] == "error" for e in events), events)
        self.assertIn("client_asr", [e["stage"] for e in events if e["type"] == "import"])
        batches = [e["tokens"] for e in events if e["type"] == "stt"]
        self.assertEqual(len(batches), 2, "跟主機自己轉的一樣每 30 秒一批")
        self.assertEqual([t["text"] for t in batches[0]], ["今天", "討論 IEP。", "<end>", "好的", "，下週再談。", "<end>"])
        self.assertEqual(batches[0][3]["speaker"], "2")
        self.assertEqual(self.soniox.requests, [], "主機不碰 Soniox")
        self.assert_audio_saved()
        self.assertEqual(self.req("/api/import/transcript", {"meeting": MID, "tokens": TOKENS})[0], 409, "送過就不再收")
        self.assert_slot_freed()

    def test_client_endpoints_need_a_waiting_import(self):
        for path, body in (("/api/import/progress", {"meeting": MID, "stage": "queued"}), ("/api/import/transcript", {"meeting": MID, "tokens": []})):
            self.assertEqual(self.req(path, body)[0], 409, path)
        self.assertEqual(self.req(f"/api/import/audio?meeting={MID}")[0], 409)
        self.assertEqual(self.req("/api/import/audio?meeting=../x")[0], 409)
        self.start("soniox")
        self.assertEqual(self.req(f"/api/import/audio?meeting={MID}")[0], 409, "還沒轉好不給")
        self.req("/api/import/cancel", {"meeting": MID})
        self.events()
        self.asr_hub.sessions.clear()
        self.upload(2)
        self.assertEqual(self.req("/api/import/transcript", {"meeting": MID, "tokens": "x"})[0], 400)
        self.assertEqual(self.req("/api/import/transcript", {"meeting": MID})[0], 400)
        self.assertTrue(server.IMPORTS[MID].waiting_client(), "格式錯的結果不算數，還在等")

    def test_page_gone_too_long_stops_the_import(self):
        with mock.patch.object(server, "CLIENT_ASR_IDLE_S", 3):
            job = self.upload(2)
            for _ in range(10):   # 有回報進度就一直等（共 5 秒，超過逾時）
                time.sleep(0.5)
                self.assertEqual(self.req("/api/import/progress", {"meeting": MID, "stage": "queued"})[0], 200)
            self.assertTrue(job.waiting_client())
            events = self.events()   # 不再回報：逾時結束、讓出位置
        err = next(e for e in events if e["type"] == "error")
        self.assertTrue(err["fatal"])
        self.assertIn("太久沒有回報", err["error"])
        self.assertEqual(events[-1]["type"], "done")
        self.assert_slot_freed()
        self.assertEqual(self.drafts.load(DRAFT)["meta"]["audio"]["1"]["ext"], "m4a", "轉好的音檔留在暫存，還能存 Drive")

    def test_cancel_while_browser_transcribes(self):
        self.upload(2)
        self.assertEqual(self.req("/api/import/cancel", {"meeting": MID}), (200, {"ok": True}))
        events = self.events()
        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(any(e["type"] in ("error", "stt") for e in events), events)
        self.assert_slot_freed()


if __name__ == "__main__":
    unittest.main()
