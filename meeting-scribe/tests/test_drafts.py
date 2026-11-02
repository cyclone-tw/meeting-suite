import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

D1 = "a" * 32
D2 = "b" * 32
META = {"title": "2026-10-20 示範會議", "place": "資源教室", "engine": "soniox", "started_at": 1, "duration_ms": 0, "state": "recording"}


class DraftStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = [1000.0]
        self.store = server.DraftStore(Path(self.tmp.name) / "drafts", clock=lambda: self.now[0])

    def tearDown(self):
        self.tmp.cleanup()

    def test_tokens_append_only_from_current_length(self):
        self.store.put_meta(D1, META)
        self.assertEqual(self.store.add_tokens(D1, 0, [["你好", "1", 0, False]]), (True, 1))
        self.assertEqual(self.store.add_tokens(D1, 0, [["重送", "1", 0, False]]), (False, 1))
        self.assertEqual(self.store.add_tokens(D1, 1, [["。", "1", 300, True]]), (True, 2))
        got = self.store.load(D1)
        self.assertEqual(got["finals"], [["你好", "1", 0, False], ["。", "1", 300, True]])
        self.assertEqual(got["meta"]["title"], META["title"])

    def test_unknown_draft_and_bad_id(self):
        with self.assertRaises(LookupError):
            self.store.add_tokens(D1, 0, [["x", None, None, False]])
        for bad in ("../x", "A" * 32, "", None):
            with self.assertRaises(ValueError):
                self.store.put_meta(bad, META)

    def test_files_are_private(self):
        self.store.put_meta(D1, META)
        self.store.add_tokens(D1, 0, [["x", None, None, False]])
        self.store.add_audio(D1, 1, "webm", 0, b"abc")
        d = Path(self.tmp.name) / "drafts" / D1
        for f in (d, d / "meta.json", d / "finals.jsonl", d / "audio-1.webm"):
            self.assertEqual(stat.S_IMODE(os.stat(f).st_mode) & 0o077, 0, f)

    def test_audio_parts_in_order_with_offsets(self):
        self.store.put_meta(D1, META)
        self.assertEqual(self.store.add_audio(D1, 1, "webm", 0, b"ab"), (True, 2))
        self.assertEqual(self.store.add_audio(D1, 1, "webm", 0, b"ab"), (False, 2))
        self.assertEqual(self.store.add_audio(D1, 1, "webm", 2, b"cd"), (True, 4))
        self.assertEqual(self.store.add_audio(D1, 2, "webm", 0, b"ef"), (True, 2))
        with self.assertRaises(ValueError):
            self.store.add_audio(D1, 1, "m4a", 4, b"x")
        parts = self.store.audio_parts(D1)
        self.assertEqual([(p, f.read_bytes()) for p, f in parts], [(1, b"abcd"), (2, b"ef")])

    def test_listing_newest_first_and_reap_after_seven_days(self):
        self.store.put_meta(D1, META)
        self.now[0] += 10
        self.store.put_meta(D2, dict(META, title="第二場"))
        self.assertEqual([x["id"] for x in self.store.listing()], [D2, D1])
        self.now[0] += server.DRAFT_KEEP_SECONDS - 5
        self.assertEqual(self.store.reap(), 1)   # D1 超過 7 天，D2 還沒
        self.assertEqual([x["id"] for x in self.store.listing()], [D2])
        self.assertFalse((Path(self.tmp.name) / "drafts" / D1).exists())

    def test_partial_write_is_overwritten_on_retry(self):
        self.store.put_meta(D1, META)
        self.store.add_tokens(D1, 0, [["一", "1", 0, False]])
        self.store.add_audio(D1, 1, "webm", 0, b"ab")
        d = Path(self.tmp.name) / "drafts" / D1
        with open(d / "finals.jsonl", "a", encoding="utf-8") as fh:
            fh.write('["殘渣')            # 上次寫到一半就斷掉
        with open(d / "audio-1.webm", "ab") as fh:
            fh.write(b"JUNK")
        self.assertEqual(self.store.add_tokens(D1, 1, [["二", "1", 9, True]]), (True, 2))
        self.assertEqual(self.store.add_audio(D1, 1, "webm", 2, b"cd"), (True, 4))
        self.assertEqual(self.store.load(D1)["finals"], [["一", "1", 0, False], ["二", "1", 9, True]])
        self.assertEqual((d / "audio-1.webm").read_bytes(), b"abcd")

    def test_load_ignores_unconfirmed_tail(self):
        self.store.put_meta(D1, META)
        self.store.add_tokens(D1, 0, [["一", "1", 0, False]])
        with open(Path(self.tmp.name) / "drafts" / D1 / "finals.jsonl", "a", encoding="utf-8") as fh:
            fh.write('["殘渣')            # 當機後沒有再接著寫
        self.assertEqual(self.store.load(D1)["finals"], [["一", "1", 0, False]])

    def test_reap_removes_dirs_without_readable_meta(self):
        base = Path(self.tmp.name) / "drafts"
        broken = base / D2
        broken.mkdir(parents=True)
        (broken / "meta.json").write_text("{壞掉")
        os.utime(broken, (self.now[0] - server.DRAFT_KEEP_SECONDS - 10,) * 2)
        self.store.put_meta(D1, META)
        self.assertEqual(self.store.reap(), 1)
        self.assertFalse(broken.exists())
        self.assertTrue((base / D1).exists())

    def test_listing_skips_symlinks_and_strangers(self):
        self.store.put_meta(D1, META)
        base = Path(self.tmp.name) / "drafts"
        (base / "notes").mkdir()
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "meta.json").write_text(json.dumps({"updated_at": 1}))
        os.symlink(outside, base / D2)
        self.assertEqual([x["id"] for x in self.store.listing()], [D1])
        with self.assertRaises(ValueError):
            self.store.delete(D2)
        self.assertTrue(outside.exists())


class DraftParseTest(unittest.TestCase):
    def test_tokens(self):
        self.assertEqual(server.parse_draft_tokens([["a", "1", 0, True], ["b", None, None, False]]),
                         [["a", "1", 0, True], ["b", None, None, False]])
        for bad in ([], "x", [["a"]], [["a", 1, 0, True]], [["a", "1", -1, True]], [["a", "1", True, True]],
                    [["a", "1", 0, "yes"]], [["x" * 4001, "1", 0, True]], [["a", "1", 0, True]] * (server.MAX_DRAFT_TOKENS + 1)):
            with self.assertRaises(ValueError, msg=repr(bad)[:60]):
                server.parse_draft_tokens(bad)

    def test_meta(self):
        self.assertEqual(server.parse_draft_meta(META)["state"], "recording")
        for bad in (None, dict(META, state="x"), dict(META, title=1), dict(META, started_at=-1), dict(META, duration_ms=True), dict(META, place="x" * 201)):
            with self.assertRaises(ValueError):
                server.parse_draft_meta(bad)


class DraftHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name) / "drive"
        cls.root.mkdir()
        cfg = Path(cls.tmp.name) / "config.json"
        cfg.write_text(json.dumps({"drive_roots": {"d": {"label": "Drive", "path": str(cls.root)}}}))
        cls.handler = type("H", (server.Handler,), {"drafts": server.DraftStore(Path(cls.tmp.name) / "drafts"), "config_file": cfg})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, path, body=None, raw=None, method="POST", csrf=True):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, method=method, data=data)
        if csrf and method == "POST":
            r.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_round_trip_and_cross_device_save(self):
        d = "c" * 32
        self.assertEqual(self.call("/api/drafts/meta", {"draft": d, "meta": META})[0], 200)
        self.assertEqual(self.call("/api/drafts/finals", {"draft": d, "from": 0, "tokens": [["你好。", "1", 0, True]]}), (200, {"ok": True, "tokens": 1}))
        self.assertEqual(self.call("/api/drafts/finals", {"draft": d, "from": 0, "tokens": [["你好。", "1", 0, True]]}), (409, {"ok": False, "tokens": 1}))
        self.assertEqual(self.call("/api/drafts/ai", {"draft": d, "ai": {"chunks": [{"idx": 1, "summary": "重點"}]}})[0], 200)
        self.assertEqual(self.call(f"/api/drafts/audio?draft={d}&part=1&ext=webm&offset=0", raw=b"AUDIO")[1], {"ok": True, "bytes": 5})
        self.assertEqual(self.call(f"/api/drafts/audio?draft={d}&part=1&ext=webm&offset=0", raw=b"AUDIO"), (409, {"ok": False, "bytes": 5}))
        status, listing = self.call("/api/drafts", method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(listing["keep_days"], 7)
        item = next(x for x in listing["drafts"] if x["id"] == d)
        self.assertEqual((item["title"], item["tokens"], item["audio_bytes"]), (META["title"], 1, 5))
        status, got = self.call(f"/api/drafts/get?draft={d}", method="GET")
        self.assertEqual((status, got["finals"], got["ai"]["chunks"][0]["summary"]), (200, [["你好。", "1", 0, True]], "重點"))
        # 另一台裝置：先存逐字稿，再把暫存的音檔複製進同一個會議資料夾
        status, saved = self.call("/api/save/transcript", {"root": "d", "folder": "會議紀錄", "title": "示範", "transcript": "[00:00:00] 你好。"})
        self.assertEqual(status, 200)
        self.assertEqual(self.call("/api/save/draft-audio", {"root": "d", "meeting": saved["meeting"], "draft": d}), (200, {"audio": ["audio.webm"], "bytes": 5}))
        self.assertEqual(self.call("/api/save/draft-audio", {"root": "d", "meeting": saved["meeting"], "draft": d})[0], 409)
        self.assertEqual(self.call("/api/drafts/delete", {"draft": d}), (200, {"ok": True}))
        self.assertEqual(self.call(f"/api/drafts/get?draft={d}", method="GET")[0], 404)

    def test_rejects_bad_requests(self):
        d = "e" * 32
        self.assertEqual(self.call("/api/drafts/meta", {"draft": d, "meta": META}, csrf=False)[0], 403)
        self.assertEqual(self.call("/api/drafts/meta", {"draft": "../x", "meta": META})[0], 400)
        self.assertEqual(self.call("/api/drafts/finals", {"draft": "f" * 32, "from": 0, "tokens": [["x", None, None, False]]})[0], 404)
        self.assertEqual(self.call("/api/drafts/meta", raw=b"[" * 8000 + b"]" * 8000)[0], 400)
        self.assertEqual(self.call(f"/api/drafts/audio?draft={d}&part=0&ext=webm&offset=0", raw=b"x")[0], 400)
        self.assertEqual(self.call(f"/api/drafts/audio?draft={d}&part=1&ext=exe&offset=0", raw=b"x")[0], 400)
        self.assertEqual(self.call("/api/drafts/get?draft=../../etc", method="GET")[0], 400)
        self.assertEqual(self.call("/api/save/draft-audio", {"root": "d", "meeting": "../..", "draft": d})[0], 400)


if __name__ == "__main__":
    unittest.main()
