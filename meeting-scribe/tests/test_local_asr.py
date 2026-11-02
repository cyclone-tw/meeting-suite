import json
import math
import os
import random
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from array import array
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_asr_worker.py")]
MID = "0123456789abcdef0123456789abcdef"
SR = server.SAMPLE_RATE


def tone(ms, amp=8000):
    n = SR * ms // 1000
    return array("h", (int(amp * math.sin(2 * math.pi * 440 * i / SR)) for i in range(n)))


def silence(ms):
    return array("h", bytes(SR * ms // 1000 * 2))


def collect(session, pred, timeout=10):
    seq, got = 0, []
    deadline = time.time() + timeout
    while time.time() < deadline:
        events, _ = session.wait(seq, 0.5)
        for n, e in events:
            got.append(e)
            seq = n
        if pred(got):
            return got
    raise AssertionError(f"沒等到預期事件：{got}")


def make_hub(root):
    """建一個假的 HF 快取：沒釘版本的走 refs/main，釘住的用指定版本。"""
    for eid, info in server.LOCAL_ENGINES.items():
        base = Path(root) / ("models--" + info["repo"].replace("/", "--"))
        rev = info["revision"] or "abc123"
        snap = base / "snapshots" / rev
        snap.mkdir(parents=True)
        (snap / "config.json").write_text("{}")
        (snap / "weights.safetensors").write_text("x")
        if not info["revision"]:
            (base / "refs").mkdir()
            (base / "refs" / "main").write_text(rev)
    return Path(root)


class CutTest(unittest.TestCase):
    def test_short_waits_unless_ending(self):
        pcm = tone(4000)
        self.assertIsNone(server.pick_cut(pcm))
        self.assertEqual(server.pick_cut(pcm, ending=True), (len(pcm), False))
        self.assertIsNone(server.pick_cut(array("h"), ending=True))

    def test_loud_waits_until_max_then_cuts_inside_window(self):
        self.assertIsNone(server.pick_cut(tone(7000)), "沒有停頓、還沒到上限就再等")
        n, pause = server.pick_cut(tone(11000))
        self.assertLessEqual(n, SR * server.MAX_WINDOW_MS // 1000)
        self.assertGreaterEqual(n, SR * server.MIN_WINDOW_MS // 1000 - SR // 10)
        self.assertFalse(pause)

    def test_cuts_at_pause(self):
        pcm = tone(5500) + silence(600) + tone(1000)
        n, pause = server.pick_cut(pcm)
        self.assertTrue(pause)
        self.assertTrue(5500 <= n * 1000 // SR <= 6100, n * 1000 // SR)

    def test_clean_segments(self):
        segs = [{"text": " 大家好 "}, {"text": "大家好"}, {"text": "請不吝點贊訂閱"}, {"text": "對對對對對對"}, {"text": ""}, {"text": "下一句"}]
        self.assertEqual([s["text"] for s in server.clean_segments(segs)], ["大家好", "對對", "下一句"])
        # ep05 實測 large-v3 在安靜段生出的口白（#70）
        self.assertEqual(server.clean_segments([{"text": "謝謝大家的收看"}, {"text": "感谢收看"}]), [])
        self.assertEqual([x["text"] for x in server.clean_segments([{"text": "大家可以收看直播"}])], ["大家可以收看直播"], "一般句子裡的收看不能丟")


class ModelDirTest(unittest.TestCase):
    def test_resolves_cached_models(self):
        with tempfile.TemporaryDirectory() as d:
            hub = make_hub(d)
            self.assertEqual(server.model_dir("whisper", hub).name, "abc123")
            self.assertIsNone(server.model_dir("nope", hub))
            self.assertIsNone(server.model_dir("breeze", hub), "Breeze 已拿掉（#55）")
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(server.model_dir("whisper", Path(d)))

    def test_pinned_revision(self):
        pinned = {"pinned": {"label": "x", "repo": "someone/model-mlx", "revision": "deadbeef"}}
        with mock.patch.dict(server.LOCAL_ENGINES, pinned), tempfile.TemporaryDirectory() as d:
            hub = make_hub(d)
            self.assertEqual(server.model_dir("pinned", hub).name, "deadbeef")
            (Path(d) / "models--someone--model-mlx" / "refs").mkdir()
            (Path(d) / "models--someone--model-mlx" / "refs" / "main").write_text("other")
            self.assertEqual(server.model_dir("pinned", hub).name, "deadbeef", "釘住就不跟 refs/main 走")


class SessionTest(unittest.TestCase):
    def make(self, mode=""):
        p = mock.patch.dict(os.environ, {"FAKE_ASR": mode})
        p.start()
        self.addCleanup(p.stop)
        worker = server.AsrWorker(command=FAKE)
        self.addCleanup(worker._stop)
        s = server.LocalAsrSession(MID, worker=worker)
        s.configure("/models/x", "資源教室、IEP")
        self.addCleanup(s.close)
        return s, worker

    def test_windows_carry_offsets_and_end_flushes(self):
        s, _ = self.make()
        s.add_audio((tone(5500) + silence(600) + tone(3000)).tobytes())
        got = collect(s, lambda g: any(e["type"] == "tokens" for e in g))
        first = next(e for e in got if e["type"] == "tokens")
        self.assertEqual(first["tokens"][0], {"text": "第1段", "start": 0})
        self.assertTrue(first["pause"])
        self.assertIn("/models/x|資源教室、IEP|", first["tokens"][1]["text"], "模型與提示詞有送到 worker")
        s.end()
        got = collect(s, lambda g: g and g[-1]["type"] == "done")
        second = [e for e in got if e["type"] == "tokens"][-1]
        self.assertEqual(second["tokens"][0]["text"], "第2段")
        self.assertTrue(5500 <= second["tokens"][0]["start"] <= 6100, "第二段的時間接在第一段切點後")
        self.assertEqual(len(s.pcm), 0, "關掉後不留音訊")

    def test_silence_is_not_sent_to_model(self):
        s, worker = self.make()
        s.add_audio(silence(6000).tobytes())
        s.end()
        got = collect(s, lambda g: g and g[-1]["type"] == "done")
        self.assertFalse([t for e in got if e["type"] == "tokens" for t in e["tokens"]])
        self.assertEqual(worker.seq, 0, "靜音段不呼叫模型")

    def test_quiet_speech_is_boosted_and_sent(self):
        # 手機放桌上收遠處講話：整段平均很小聲（約 -60 dBFS），但有講話的地方還是比底噪大聲
        s, worker = self.make()
        quiet = array("h")
        for _ in range(6):   # 講話是一陣一陣的：0.4 秒聲音、0.6 秒停
            quiet += tone(400, amp=80) + silence(600)
        level, peak = server.window_levels(quiet)
        self.assertLess(level, -50)
        self.assertGreater(peak, server.SILENT_DB)
        s.add_audio(quiet.tobytes())
        s.end()
        got = collect(s, lambda g: g and g[-1]["type"] == "done")
        self.assertEqual(worker.seq, 2, "小聲但有講話的兩段都要送去辨識（6 秒切成 5 秒＋1 秒）")
        self.assertEqual([t["text"] for e in got if e["type"] == "tokens" for t in e["tokens"]][0], "第1段")

    def test_short_quiet_tail_is_still_sent(self):
        # 結束時剩下的短尾巴（不到 1 秒）最大聲本來就約等於平均，不能當成底噪丟掉
        s, worker = self.make()
        s.add_audio(tone(500, amp=80).tobytes())
        s.end()
        collect(s, lambda g: g and g[-1]["type"] == "done")
        self.assertEqual(worker.seq, 1)

    def test_flat_noise_floor_is_not_boosted(self):
        # 手機底噪：平平的、沒有講話起伏，雖然過了靜音門檻也不送模型
        rnd = random.Random(1)
        floor = array("h", (int(rnd.gauss(0, 1) * 45) for _ in range(SR * 6)))
        level, peak = server.window_levels(floor)
        self.assertGreater(peak, server.SILENT_DB)
        self.assertLess(peak - level, server.FLAT_NOISE_DB)
        s, worker = self.make()
        s._transcribe(floor, 0, True)   # 直接給一整段，不經過切段（切完的短尾巴照規則會送）
        self.assertEqual(worker.seq, 0, "底噪不呼叫模型")
        self.assertEqual(s.events[-1][1], {"type": "tokens", "tokens": [], "pause": True}, "跳過時仍保留換段")

    def test_window_levels_and_boost(self):
        loud = tone(1000, amp=8000)
        self.assertIs(server.boost(loud, server.window_levels(loud)[1]), loud, "夠大聲就不動")
        quiet = tone(1000, amp=300)
        _, peak = server.window_levels(quiet)
        _, boosted = server.window_levels(server.boost(quiet, peak))
        self.assertAlmostEqual(boosted, server.TARGET_PEAK_DB, delta=1)
        faint = tone(1000, amp=2)
        _, fpeak = server.window_levels(faint)
        _, fboost = server.window_levels(server.boost(faint, fpeak))
        self.assertAlmostEqual(fboost - fpeak, server.MAX_BOOST_DB, delta=1, msg="放大有上限")
        clip = server.boost(array("h", [30000, -30000, 10]), -40)
        self.assertEqual(list(clip)[:2], [32767, -32768], "放大超出範圍就削掉，不會溢位")

    def test_hallucination_filtered_and_error_reported(self):
        s, _ = self.make("halluc")
        s.add_audio(tone(3000).tobytes())
        s.end()
        got = collect(s, lambda g: g and g[-1]["type"] == "done")
        texts = [t["text"] for e in got if e["type"] == "tokens" for t in e["tokens"]]
        self.assertNotIn("謝謝觀看", texts)
        s2, _ = self.make("error")
        s2.add_audio(tone(3000).tobytes())
        s2.end()
        got = collect(s2, lambda g: g and g[-1]["type"] == "done")
        self.assertIn("本機辨識失敗", next(e for e in got if e["type"] == "error")["error"])

    def test_worker_restarts_on_model_change_and_timeout(self):
        worker = server.AsrWorker(command=FAKE)
        self.addCleanup(worker._stop)
        segs, _ = worker.transcribe("/m/a", tone(500).tobytes())
        pid_a = segs[1]["text"].split("|")[2]
        segs, _ = worker.transcribe("/m/a", tone(500).tobytes())
        self.assertEqual(segs[1]["text"].split("|")[2], pid_a, "同模型沿用同一個程序")
        segs, _ = worker.transcribe("/m/b", tone(500).tobytes())
        self.assertNotEqual(segs[1]["text"].split("|")[2], pid_a, "換模型重開，舊模型的記憶體還回去")
        with mock.patch.dict(os.environ, {"FAKE_ASR": "hang"}), mock.patch.object(server, "ASR_TIMEOUT", 1):
            hang = server.AsrWorker(command=FAKE)
            with self.assertRaises(TimeoutError):
                hang.transcribe("/m/a", tone(500).tobytes())
            self.assertIsNone(hang.proc, "逾時就關掉程序")

    def test_worker_stuck_on_stdin_times_out(self):
        # 10 秒音訊約 430 KB，超過 pipe 緩衝，worker 不讀的話 write 會一直擋著
        with mock.patch.dict(os.environ, {"FAKE_ASR": "stuck"}), mock.patch.object(server, "ASR_TIMEOUT", 1):
            stuck = server.AsrWorker(command=FAKE)
            self.addCleanup(stuck._stop)
            t0 = time.time()
            with self.assertRaises(TimeoutError):
                stuck.transcribe("/m/a", tone(10000).tobytes())
            self.assertLess(time.time() - t0, 8, "寫入也要受逾時限制")
            self.assertIsNone(stuck.proc, "逾時就關掉程序")

    def test_concurrent_configure_starts_one_runner(self):
        runs = []

        class Slow(server.LocalAsrSession):
            # 讀 started 時故意停一下，沒上鎖的話兩個請求都會看到 False
            @property
            def started(self):
                value = self._started
                time.sleep(0.05)
                return value

            @started.setter
            def started(self, v):
                self._started = v

            def _run(self):
                runs.append(1)

        session = Slow(MID, worker=server.AsrWorker(command=FAKE))
        self.addCleanup(session.close)
        threads = [threading.Thread(target=session.configure, args=("/m/a", "")) for _ in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        time.sleep(0.1)
        self.assertEqual(len(runs), 1, "同一場會議只能有一條辨識迴圈")

    def test_worker_idle_reap(self):
        now = [0.0]
        worker = server.AsrWorker(command=FAKE, clock=lambda: now[0])
        self.addCleanup(worker._stop)
        worker.transcribe("/m/a", tone(200).tobytes())
        worker.reap()
        self.assertIsNotNone(worker.proc)
        now[0] = server.ASR_IDLE_SECONDS + 1
        worker.reap()
        self.assertIsNone(worker.proc)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        hub_dir = make_hub(self.tmp.name)
        self.worker = server.AsrWorker(command=FAKE)
        self.addCleanup(self.worker._stop)
        self.asr_hub = server.AgentHub(factory=lambda mid: server.LocalAsrSession(mid, worker=self.worker))
        patches = [
            mock.patch.object(server.Handler, "asr_hub", self.asr_hub),
            mock.patch.object(server.Handler, "hf_hub", hub_dir),
            mock.patch.object(server.Handler, "api_key", "k"),
            mock.patch.object(server, "asr_python", lambda: Path(sys.executable)),
            mock.patch.dict(os.environ, {"FAKE_ASR": ""}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [s.close() for s in self.asr_hub.sessions.values()])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def req(self, path, body=None, raw=None, header=True):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET",
                                   headers={"Content-Type": "application/json", **({"X-Meeting-Scribe": "1"} if header else {})})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_engines_listing(self):
        status, body = self.req("/api/engines")
        self.assertEqual(status, 200)
        self.assertEqual({e["id"]: e["ok"] for e in body["engines"]}, {"soniox": True, "whisper": True})

    def test_start_validation(self):
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper"}, header=False)[0], 403)
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "soniox"})[0], 503)
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "breeze"})[0], 503, "Breeze 已拿掉，舊頁面送來也不接")
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": ["whisper"]})[0], 503, "engine 不是字串也要回錯誤，不是斷線")
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}", raw=tone(100).tobytes())[0], 404, "沒 start 不收音訊")
        with mock.patch.object(server, "asr_python", lambda: None):
            self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper"})[0], 503)

    def test_full_flow_streams_tokens(self):
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "terms": ["資源教室", "IEP"]}), (200, {"ok": True}))
        audio = (tone(5500) + silence(600) + tone(2000)).tobytes()
        for i in range(0, len(audio), 32000):
            self.assertEqual(self.req(f"/api/local/audio?meeting={MID}", raw=audio[i:i + 32000])[0], 202)
        self.assertEqual(self.req("/api/local/end", {"meeting": MID}), (200, {"ok": True}))
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}", raw=tone(100).tobytes())[0], 409)
        with urllib.request.urlopen(f"{self.base}/api/local/events?meeting={MID}", timeout=20) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["tokens", "tokens", "done"])
        self.assertEqual(events[0]["tokens"][0]["text"], "第1段")
        self.assertIn("abc123", events[0]["tokens"][1]["text"], "用的是快取 refs/main 指的 Whisper 版本")
        self.assertIn("資源教室、IEP", events[0]["tokens"][1]["text"])

    def test_start_offset_shifts_timestamps(self):
        # 服務重啟後頁面用同一場重新開始，時間戳要接在已送過的音訊後面（#74）
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "offset_ms": "1"})[0], 400)
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "offset_ms": -5})[0], 400)
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "offset_ms": True})[0], 400)
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "offset_ms": server.MAX_LIFETIME * 1000 + 1})[0], 400, "超過一場最長時間")
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper", "offset_ms": 60000}), (200, {"ok": True}))
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}", raw=tone(3000).tobytes())[0], 202)
        self.assertEqual(self.req("/api/local/end", {"meeting": MID}), (200, {"ok": True}))
        with urllib.request.urlopen(f"{self.base}/api/local/events?meeting={MID}", timeout=20) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertGreaterEqual(events[0]["tokens"][0]["start"], 60000)

    def test_duplicate_audio_seq_is_dropped(self):
        # 回應遺失後重送同一包（同一個 seq）不能重複餵給辨識（#76）
        self.assertEqual(self.req("/api/local/start", {"meeting": MID, "engine": "whisper"}), (200, {"ok": True}))
        chunk = tone(1000).tobytes()
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}&seq=1", raw=chunk), (202, {"queued": True}))
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}&seq=1", raw=chunk), (202, {"queued": False, "duplicate": True}))
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}&seq=2", raw=chunk), (202, {"queued": True}))
        self.assertEqual(len(self.asr_hub.sessions[MID].pcm), 2 * len(chunk) // 2, "只收了兩包")
        self.assertEqual(self.req(f"/api/local/audio?meeting={MID}", raw=chunk)[0], 202, "沒帶 seq 的舊頁面照收")

    def test_end_without_start_closes_stream(self):
        mid = "e" * 32
        self.assertEqual(self.req("/api/local/end", {"meeting": mid}), (200, {"ok": True}))
        with urllib.request.urlopen(f"{self.base}/api/local/events?meeting={mid}", timeout=10) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["done"])

    def test_stale_last_event_id_still_gets_done(self):
        # 服務重啟後，舊分頁帶著重啟前的序號重連：新程序只有一則 done，也要送給它，不然每幾秒重連一次（#64）
        mid = "f" * 32
        self.assertEqual(self.req("/api/local/end", {"meeting": mid}), (200, {"ok": True}))
        req = urllib.request.Request(f"{self.base}/api/local/events?meeting={mid}", headers={"Last-Event-ID": "40"})
        with urllib.request.urlopen(req, timeout=10) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["done"])


if __name__ == "__main__":
    unittest.main()
