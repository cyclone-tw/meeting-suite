import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_returning(payload):
    def _open(req, timeout=None):
        _open.last_request = req
        return FakeResp(json.dumps(payload).encode())
    return _open


def opener_raising(code):
    def _open(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, code, "err", {}, None)
    return _open


class MintTempKeyTest(unittest.TestCase):
    def test_returns_temp_key_and_sends_bearer(self):
        op = opener_returning({"api_key": "snx_temp_abc", "expires_at": "x"})
        status, body = server.mint_temp_key("LONG-KEY", opener=op)
        self.assertEqual((status, body), (200, {"api_key": "snx_temp_abc"}))
        self.assertEqual(op.last_request.get_header("Authorization"), "Bearer LONG-KEY")
        sent = json.loads(op.last_request.data)
        self.assertEqual(sent["usage_type"], "transcribe_websocket")
        self.assertTrue(sent["single_use"])
        self.assertLessEqual(sent["expires_in_seconds"], 60)

    def test_accepts_alternate_field_name(self):
        status, body = server.mint_temp_key("K", opener=opener_returning({"key": "snx_temp_x"}))
        self.assertEqual(body, {"api_key": "snx_temp_x"})

    def test_http_error_never_echoes_long_key(self):
        status, body = server.mint_temp_key("LONG-KEY", opener=opener_raising(402))
        self.assertEqual(status, 402)
        self.assertNotIn("LONG-KEY", json.dumps(body))

    def test_missing_key_in_response_is_502(self):
        status, _ = server.mint_temp_key("K", opener=opener_returning({}))
        self.assertEqual(status, 502)


class ResolveApiKeyTest(unittest.TestCase):
    def test_env_wins(self):
        with mock.patch.dict(os.environ, {"SONIOX_API_KEY": " env-key "}):
            self.assertEqual(server.resolve_api_key(), "env-key")

    def test_rejects_world_readable_key_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "soniox.key"
            f.write_text("file-key")
            f.chmod(0o644)
            with mock.patch.dict(os.environ, {"SONIOX_API_KEY": ""}), \
                    mock.patch.object(server, "KEY_FILE", f), \
                    mock.patch.object(server.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="")):
                self.assertIsNone(server.resolve_api_key())
            f.chmod(0o600)
            with mock.patch.dict(os.environ, {"SONIOX_API_KEY": ""}), \
                    mock.patch.object(server, "KEY_FILE", f), \
                    mock.patch.object(server.subprocess, "run", return_value=mock.Mock(returncode=1, stdout="")):
                self.assertEqual(server.resolve_api_key(), "file-key")


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.handler = type("H", (server.Handler,), {})
        cls.handler.api_key = "LONG-KEY"
        cls.handler.opener = staticmethod(opener_returning({"api_key": "snx_temp_ok"}))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, path, method="GET", csrf=True):
        r = urllib.request.Request(self.base + path, method=method, data=b"" if method == "POST" else None)
        if method == "POST" and csrf:
            r.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_index_served(self):
        status, body = self.req("/")
        self.assertEqual(status, 200)
        self.assertIn("Cyclone Scribe".encode(), body)

    def test_icons_served(self):
        import re
        _, body = self.req("/")
        hrefs = re.findall(rb'<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"', body)
        self.assertEqual(len(hrefs), 3, hrefs)
        manifest = json.loads(self.req("/manifest.webmanifest")[1])
        for href in [h.decode() for h in hrefs] + [i["src"] for i in manifest["icons"]] + ["/favicon.ico"]:
            r = urllib.request.urlopen(self.base + href)
            self.assertEqual(r.status, 200, href)
            want = "image/svg+xml" if href.endswith(".svg") else "image/png"
            self.assertEqual(r.headers["Content-Type"], want, href)
            head = r.read(8)
            self.assertTrue(head.startswith(b"<svg") if href.endswith(".svg") else head == b"\x89PNG\r\n\x1a\n", href)

    def test_page_loads_no_third_party_script(self):
        import re
        _, body = self.req("/")
        srcs = re.findall(rb'<script[^>]+src="([^"]+)"', body)
        self.assertTrue(srcs)
        for src in srcs:
            self.assertTrue(src.startswith(b"/"), src)
            self.assertEqual(self.req(src.decode())[0], 200, src)

    def raw(self, path, encoding=None):
        r = urllib.request.Request(self.base + path)
        if encoding is not None:
            r.add_header("Accept-Encoding", encoding)
        with urllib.request.urlopen(r) as resp:
            return resp.headers, resp.read()

    def test_vendor_cached_long_page_and_api_not(self):
        # 慢線路（#102）：vendor 檔名帶版本，重新整理不該再下載；頁面與 API 每次都要最新
        h, _ = self.raw("/vendor/opencc-js-1.0.5-full.js")
        self.assertEqual(h["Cache-Control"], "public, max-age=31536000, immutable")
        for path in ("/", "/index.html", "/healthz", "/manifest.webmanifest", "/icon.svg"):
            self.assertEqual(self.raw(path)[0]["Cache-Control"], "no-store", path)

    def test_large_text_gzipped_when_accepted(self):
        import gzip
        for path, name in (("/vendor/opencc-js-1.0.5-full.js", "vendor/opencc-js-1.0.5-full.js"), ("/", "index.html")):
            want = (server.WEB / name).read_bytes().replace(b"__MS_BUILD__", server.BUILD.encode())
            h, body = self.raw(path, "gzip, deflate, br")
            self.assertEqual(h["Content-Encoding"], "gzip", path)
            self.assertEqual(h["Vary"], "Accept-Encoding", path)
            self.assertEqual(int(h["Content-Length"]), len(body), path)
            self.assertEqual(gzip.decompress(body), want, path)
            self.assertLess(len(body), len(want) // 2, path)
            h, body = self.raw(path, "identity")
            self.assertIsNone(h["Content-Encoding"], path)
            self.assertEqual(h["Vary"], "Accept-Encoding", path)
            self.assertEqual(body, want, path)
        h, body = self.raw("/icon-192.png", "gzip")
        self.assertIsNone(h["Content-Encoding"], "圖片本來就壓過")
        self.assertTrue(body.startswith(b"\x89PNG"))
        self.assertIsNone(self.raw("/healthz", "gzip")[0]["Content-Encoding"])

    def test_accepts_gzip(self):
        for v in ("gzip", "deflate, gzip", "GZIP;q=0.5", "*", "br, gzip;q=1.0"):
            self.assertTrue(server.accepts_gzip(v), v)
        for v in (None, "", "identity", "br", "gzip;q=0", "gzip;q=0.0", "gzip;q=x", "x-gzip"):
            self.assertFalse(server.accepts_gzip(v), v)

    def test_gzip_compressed_once(self):
        server._GZIPPED.pop("t", None)
        a = server.gzipped("t", b"x" * 5000)
        self.assertIs(server.gzipped("t", b"x" * 5000), a, "同內容沿用記憶體裡的結果")
        self.assertIsNot(server.gzipped("t", b"y" * 5000), a, "內容換了要重壓")
        server._GZIPPED.pop("t", None)

    def test_opencc_does_not_block_page(self):
        # 1.1 MB 的轉換檔不能同步擋在 <head>（#102）：要 defer，並在載好後才啟用轉換
        import re
        _, body = self.req("/")
        tags = re.findall(rb'<script[^>]*src="/vendor/opencc[^"]*"[^>]*>', body)
        self.assertEqual(len(tags), 1, tags)
        self.assertRegex(tags[0], rb"\sdefer[\s>]")
        self.assertIn(b'onload="openccReady()"', tags[0])
        self.assertIn(b"function openccReady()", body)
        self.assertNotRegex(body, rb"\n(?:let|const|var|try).*OpenCC\.Converter", "不能在頁面主程式一開始就呼叫 OpenCC")

    def test_page_never_contains_long_key(self):
        _, body = self.req("/")
        self.assertNotIn(b"LONG-KEY", body)

    def test_token_returns_only_temp_key(self):
        status, body = self.req("/token", "POST")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"api_key": "snx_temp_ok"})

    def test_unknown_paths_404(self):
        self.assertEqual(self.req("/server.py")[0], 404)
        self.assertEqual(self.req("/../server.py")[0], 404)
        self.assertEqual(self.req("/other", "POST")[0], 404)

    def test_post_without_csrf_header_is_403(self):
        self.assertEqual(self.req("/token", "POST", csrf=False)[0], 403)

    def test_healthz(self):
        status, body = self.req("/healthz")
        self.assertEqual(status, 200)
        got = json.loads(body)
        self.assertEqual({k: v for k, v in got.items() if k not in ("agent", "recording_idle_s", "build")}, {"ok": True, "key": True, "host": "主機"})
        self.assertRegex(got["build"], r"^[0-9a-f]{12}$")
        self.assertEqual(got["build"], server.web_build())
        page = self.req("/")[1]
        page = page.decode() if isinstance(page, bytes) else page
        self.assertIn(f'const pageBuild = "{got["build"]}"', page, "頁面帶著自己的版本代碼")

    def test_host_label(self):
        # 頁面提示用的主機名稱（#170）：config 的 host_label；沒設、空白、不是字串、有控制字元都說「主機」；最多 40 字
        cfg = Path(tempfile.mkdtemp()) / "config.json"
        self.addCleanup(shutil.rmtree, cfg.parent)
        for value, want in (("辦公室的 Mac（備援）", "辦公室的 Mac（備援）"), ("  mini  ", "mini"), ("", "主機"), (3, "主機"), ("a\nb", "主機"), ("字" * 50, "字" * 40)):
            cfg.write_text(json.dumps({"host_label": value}), encoding="utf-8")
            self.assertEqual(server.load_host_label(cfg), want, value)
        self.assertEqual(server.load_host_label(cfg.parent / "nope.json"), "主機")

    def test_shared_components_served(self):
        # 共用元件（#155）：web/shared/ 底下的 .js／.css 直接供應；怪檔名、跑出資料夾、不存在的都是 404
        status, body = self.req("/shared/mindmap.js")
        self.assertEqual(status, 200)
        self.assertEqual(body if isinstance(body, bytes) else body.encode(), (server.WEB / "shared" / "mindmap.js").read_bytes())
        self.assertEqual(self.req("/shared/mindmap.css")[0], 200)
        for bad in ("/shared/nope.js", "/shared/../server.py", "/shared/%2e%2e/server.py", "/shared/Mindmap.js", "/shared/mindmap.js.bak",
                    "/shared/x/../mindmap.js", "/shared/", "/shared/.hidden.js", "/mindmap.js"):
            self.assertEqual(self.req(bad)[0], 404, bad)

    def test_healthz_reports_recording_activity(self):
        server.LAST_RECORDING[0] = None
        self.assertIsNone(json.loads(self.req("/healthz")[1])["recording_idle_s"], "開機後沒錄過")
        self.req("/token", "POST")
        self.assertIsNone(json.loads(self.req("/healthz")[1])["recording_idle_s"], "拿金鑰不算錄音")
        self.req("/api/local/audio", "POST", csrf=False)
        self.assertIsNone(json.loads(self.req("/healthz")[1])["recording_idle_s"], "被 CSRF 擋下的不算")
        self.req("/api/local/audio?meeting=x", "POST")
        self.assertEqual(json.loads(self.req("/healthz")[1])["recording_idle_s"], 0, "送音訊就算在錄（就算這場已不存在）")
        server.LAST_RECORDING[0] -= 120
        self.assertGreaterEqual(json.loads(self.req("/healthz")[1])["recording_idle_s"], 120)
        server.LAST_RECORDING[0] = None

    def test_token_without_key_is_503(self):
        self.handler.api_key = None
        try:
            self.assertEqual(self.req("/token", "POST")[0], 503)
        finally:
            self.handler.api_key = "LONG-KEY"



CH = "a" * 32
CH2 = "b" * 32


def caption(channel=CH, parts=None, rec=True):
    return {"channel": channel, "parts": [{"t": "今天研習", "f": True}, {"t": "開始", "f": False}] if parts is None else parts,
            "rec": rec}


class CaptionParseTest(unittest.TestCase):
    def test_valid_caption_is_normalized(self):
        body = caption()
        body["parts"][0]["extra"] = "x"
        body["lamp"] = "REC 0:05"
        channel, state = server.parse_caption(body)
        self.assertEqual(channel, CH)
        self.assertEqual(state, {"parts": [{"t": "今天研習", "f": True}, {"t": "開始", "f": False}], "rec": True})

    def test_rejects_bad_input(self):
        bad = [
            None, [], caption(channel="xyz"), caption(channel=CH.upper()), caption(parts="text"),
            caption(parts=[{"t": "a"}]), caption(parts=[{"t": "a", "f": 1}]), caption(parts=[{"t": 3, "f": True}]),
            caption(parts=[{"t": "字" * (server.CAPTION_MAX_CHARS + 1), "f": True}]),
            caption(parts=[{"t": "a", "f": True}] * (server.CAPTION_MAX_PARTS + 1)),
            caption(rec="yes"),
        ]
        no_rec = caption()
        del no_rec["rec"]
        bad.append(no_rec)
        for body in bad:
            with self.assertRaises(ValueError, msg=repr(body)):
                server.parse_caption(body)

    def test_empty_parts_allowed_for_idle(self):
        self.assertEqual(server.parse_caption(caption(parts=[], rec=False))[1]["parts"], [])


class CaptionBoardTest(unittest.TestCase):
    def test_wait_returns_newer_state_only(self):
        b = server.CaptionBoard()
        self.assertEqual(b.wait(CH, 0, 0.01), (0, None))
        b.put(CH, {"n": 1})
        seq, state = b.wait(CH, 0, 0.01)
        self.assertEqual(state, {"n": 1})
        self.assertEqual(b.wait(CH, seq, 0.01), (seq, None))

    def test_channels_are_isolated(self):
        b = server.CaptionBoard()
        b.put(CH, {"n": 1})
        self.assertEqual(b.wait(CH2, 0, 0.01), (0, None))

    def test_wait_wakes_on_put(self):
        b = server.CaptionBoard()
        threading.Timer(0.05, lambda: b.put(CH, {"n": 2})).start()
        self.assertEqual(b.wait(CH, 0, 2)[1], {"n": 2})

    def test_idle_channels_are_pruned(self):
        now = [0.0]
        b = server.CaptionBoard(clock=lambda: now[0])
        b.put(CH, {"n": 1})
        now[0] = server.CAPTION_IDLE + 1
        b.put(CH2, {"n": 2})
        self.assertNotIn(CH, b.channels)
        self.assertEqual(b.wait(CH, 0, 0.01), (0, None))

    def test_idle_channel_is_not_served_to_new_reader(self):
        now = [0.0]
        b = server.CaptionBoard(clock=lambda: now[0])
        b.put(CH, {"n": 1})
        now[0] = server.CAPTION_IDLE + 1
        self.assertEqual(b.wait(CH, 0, 0.01), (0, None))

    def test_recreated_channel_is_not_missed(self):
        now = [0.0]
        b = server.CaptionBoard(clock=lambda: now[0])
        b.put(CH, {"n": 1})
        seq, _ = b.wait(CH, 0, 0.01)
        now[0] = server.CAPTION_IDLE + 1
        b.put(CH2, {"n": 2})
        b.put(CH, {"n": 3})
        self.assertEqual(b.wait(CH, seq, 0.01)[1], {"n": 3})

    def test_channel_limit_evicts_oldest(self):
        now = [0.0]
        b = server.CaptionBoard(clock=lambda: now[0])
        ids = [f"{i:032x}" for i in range(server.CAPTION_MAX_CHANNELS + 1)]
        for i, c in enumerate(ids):
            now[0] = i
            b.put(c, {"n": i})
        self.assertEqual(len(b.channels), server.CAPTION_MAX_CHANNELS)
        self.assertNotIn(ids[0], b.channels)
        self.assertIn(ids[-1], b.channels)


class CaptionHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.handler = type("H", (server.Handler,), {"captions": server.CaptionBoard(), "caption_keepalive": 0.2})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def post(self, body, csrf=True):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/caption", method="POST", data=data)
        if csrf:
            r.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_post_requires_csrf_and_valid_body(self):
        self.assertEqual(self.post(caption(), csrf=False)[0], 403)
        self.assertEqual(self.post(b"{not json")[0], 400)
        self.assertEqual(self.post(caption(channel="nope")), (400, {"error": "頻道代碼不合法"}))
        self.assertEqual(self.post(b"x" * (server.CAPTION_MAX_BYTES + 1))[0], 413)
        self.assertEqual(self.post(b"[" * 8000 + b"]" * 8000)[0], 400)

    def test_events_rejects_bad_channel(self):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/caption/events?channel=../x")
            self.fail("expected 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_events_stream_latest_caption_for_its_channel_only(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", f"/api/caption/events?channel={CH2}")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/event-stream"))
        self.assertEqual(self.post(caption(channel=CH)), (200, {"ok": True}))
        self.assertEqual(self.post(caption(channel=CH2, parts=[{"t": "第二頻道", "f": True}])), (200, {"ok": True}))
        line = b""
        while not line.startswith(b"data: "):
            line = resp.fp.readline()
        self.assertEqual(json.loads(line[6:]), {"parts": [{"t": "第二頻道", "f": True}], "rec": True})
        conn.close()

    def test_late_reader_gets_current_caption(self):
        import http.client
        ch = "c" * 32
        self.assertEqual(self.post(caption(channel=ch, parts=[], rec=False))[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", f"/api/caption/events?channel={ch}")
        resp = conn.getresponse()
        line = b""
        while not line.startswith(b"data: "):
            line = resp.fp.readline()
        self.assertEqual(json.loads(line[6:]), {"parts": [], "rec": False})
        conn.close()


class LoggingTest(unittest.TestCase):
    def test_log_line_drops_query_and_tolerates_malformed(self):
        h = server.Handler.__new__(server.Handler)
        h.command, h.path = "POST", "/api/save/audio?meeting=2026-10-19%20IEP%20%E7%8E%8B%E5%B0%8F%E6%98%8E"
        with mock.patch.object(sys, "stderr", new_callable=io.StringIO) as err:
            h.log_message("%s", "x", "200")
            h2 = server.Handler.__new__(server.Handler)
            h2.log_message("%s", "x", "400")
        out = err.getvalue()
        self.assertIn("POST /api/save/audio 200", out)
        self.assertNotIn("meeting", out)
        self.assertNotIn("%E7", out)
        self.assertIn("- - 400", out)

    def test_handle_error_prints_type_only(self):
        srv = server.QuietServer.__new__(server.QuietServer)
        with mock.patch.object(sys, "stderr", new_callable=io.StringIO) as err:
            try:
                raise PermissionError(13, "denied", "/Users/x/Drive/2026-10-19 IEP 王小明/transcript.txt")
            except PermissionError:
                srv.handle_error(None, ("127.0.0.1", 1))
        self.assertEqual(err.getvalue(), "error PermissionError\n")


if __name__ == "__main__":
    unittest.main()
