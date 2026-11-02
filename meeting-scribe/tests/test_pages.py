"""網頁放 Cloudflare Pages、API 留在主機（#106）：CORS 白名單、preflight、打包腳本。"""
import http.client
import importlib.util
import json
import re
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

_spec = importlib.util.spec_from_file_location("build_pages", ROOT / "deploy" / "build-pages.py")
build_pages = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_pages)

PAGES = "https://scribe.example.dev"
API = "https://scribe-host.tail-test.ts.net:9443"
EVIL = "https://evil.example"


class CorsConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def origins(self, data):
        self.cfg.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        return server.load_cors_origins(self.cfg)

    def test_missing_or_broken_config_means_same_origin_only(self):
        self.assertEqual(server.load_cors_origins(Path(self.tmp.name) / "missing.json"), frozenset())
        for data in ({}, "{not json", [1], {"cors_origins": "https://a.dev"}, {"cors_origins": None}):
            self.assertEqual(self.origins(data), frozenset(), data)

    def test_origins_are_normalized_and_validated(self):
        got = self.origins({"cors_origins": [
            "https://Scribe.Example.dev/", "https://a.dev:8443", "http://127.0.0.1:18300", "http://localhost:9",
            "*", "null", "", 7, "https://a.dev/path", "http://plain.example", "ftp://a.dev", "https://a.dev:8443?x",
        ]})
        self.assertEqual(got, frozenset({"https://scribe.example.dev", "https://a.dev:8443",
                                         "http://127.0.0.1:18300", "http://localhost:9"}))


class CorsHttpTest(unittest.TestCase):
    """真的開一個 server，用不同 Origin 打。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg = Path(cls.tmp.name) / "config.json"
        cls.handler = type("H", (server.Handler,), {})
        cls.handler.config_file = cls.cfg
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        self.allow([PAGES])

    def allow(self, origins):
        self.cfg.write_text(json.dumps({"cors_origins": origins} if origins is not None else {}), encoding="utf-8")

    def req(self, path, method="GET", headers=None, body=None, read=True):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read() if read else b""
        c.close()
        return r.status, r.headers, data

    def preflight(self, origin, method="POST", headers="content-type,x-meeting-scribe", extra=None):
        h = {"Origin": origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers}
        h.update(extra or {})
        return self.req("/api/agent/para", "OPTIONS", h)

    # ---- 沒設 cors_origins：跟以前完全一樣 ----
    def test_without_config_nothing_changes(self):
        self.allow(None)
        status, headers, _ = self.preflight(PAGES)
        self.assertEqual(status, 501, "沒設 cors_origins 時不回 preflight")
        self.assertIsNone(headers["Access-Control-Allow-Origin"])
        for origin in (None, PAGES, EVIL):
            status, headers, _ = self.req("/api/engines", headers={"Origin": origin} if origin else {})
            self.assertEqual(status, 200, origin)
            self.assertIsNone(headers["Access-Control-Allow-Origin"], origin)
            self.assertNotIn("Origin", headers.get_all("Vary") or [], origin)

    def test_empty_list_is_same_as_no_config(self):
        self.allow([])
        self.assertEqual(self.preflight(PAGES)[0], 501)
        self.assertEqual(self.req("/api/engines", headers={"Origin": EVIL})[0], 200)

    # ---- preflight ----
    def test_preflight_from_allowed_origin(self):
        status, headers, body = self.preflight(PAGES)
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Access-Control-Allow-Origin"], PAGES)
        allowed = {h.strip().lower() for h in headers["Access-Control-Allow-Headers"].split(",")}
        self.assertTrue({"x-meeting-scribe", "content-type", "last-event-id"} <= allowed, allowed)
        self.assertEqual({m.strip() for m in headers["Access-Control-Allow-Methods"].split(",")}, {"GET", "POST"})
        self.assertIsNone(headers["Access-Control-Allow-Credentials"], "不用 cookie，不能開 credentials")
        self.assertIsNone(headers["Access-Control-Allow-Private-Network"], "沒問就不回")
        self.assertIn("Origin", headers.get_all("Vary"))

    def test_preflight_origin_is_case_insensitive(self):
        status, headers, _ = self.preflight("https://SCRIBE.example.dev")
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], PAGES)

    def test_preflight_private_network(self):
        status, headers, _ = self.preflight(PAGES, extra={"Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_preflight_rejected(self):
        for origin in (EVIL, "null", "https://scribe.example.dev.evil.example", PAGES + ":444", "http://scribe.example.dev"):
            status, headers, _ = self.preflight(origin, extra={"Access-Control-Request-Private-Network": "true"})
            self.assertEqual(status, 403, origin)
            self.assertIsNone(headers["Access-Control-Allow-Origin"], origin)
            self.assertIsNone(headers["Access-Control-Allow-Private-Network"], origin)
        for method in ("DELETE", "PUT", ""):
            self.assertEqual(self.preflight(PAGES, method=method)[0], 403, method)

    # ---- 真正的請求 ----
    def test_get_from_allowed_origin(self):
        status, headers, body = self.req("/api/engines", headers={"Origin": PAGES})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], PAGES)
        self.assertIn("Origin", headers.get_all("Vary"))
        self.assertIn("engines", json.loads(body))

    def test_requests_from_other_origins_are_refused(self):
        for origin in (EVIL, "null", "garbage"):
            for method, path in (("GET", "/api/engines"), ("GET", "/api/drafts"), ("POST", "/api/drafts/delete")):
                headers = {"Origin": origin, "X-Meeting-Scribe": "1", "Content-Type": "application/json"}
                status, got, body = self.req(path, method, headers, b"{}" if method == "POST" else None)
                self.assertEqual(status, 403, (origin, path))
                self.assertIsNone(got["Access-Control-Allow-Origin"], (origin, path))
                self.assertNotIn(b"drafts", body)

    def test_no_origin_and_same_host_still_work(self):
        # 主機自己送的網頁（同源）照常可用：curl／桌面字幕小程式不帶 Origin，同源 POST 的 Origin 等於 Host
        self.assertEqual(self.req("/api/engines")[0], 200)
        same = f"http://127.0.0.1:{self.port}"
        status, headers, _ = self.req("/api/nope", "POST", {"Origin": same, "X-Meeting-Scribe": "1"}, b"")
        self.assertEqual(status, 404, "同源 POST 要能過 Origin 檢查")
        self.assertIsNone(headers["Access-Control-Allow-Origin"], "同源不需要 CORS 標頭")
        self.assertEqual(self.req("/", headers={"Origin": same})[0], 200)

    def test_csrf_header_still_required(self):
        status, headers, _ = self.req("/api/nope", "POST", {"Origin": PAGES}, b"")
        self.assertEqual(status, 403, "白名單來源也要帶 X-Meeting-Scribe")
        self.assertEqual(headers["Access-Control-Allow-Origin"], PAGES)
        status, headers, _ = self.req("/api/nope", "POST", {"Origin": PAGES, "X-Meeting-Scribe": "1"}, b"")
        self.assertEqual(status, 404)
        self.assertEqual(headers["Access-Control-Allow-Origin"], PAGES)

    def test_event_stream_crosses_origin(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/api/agent/events?meeting=" + "a" * 32, headers={"Origin": PAGES, "Last-Event-ID": "x.1"})
        r = c.getresponse()
        try:
            self.assertEqual(r.status, 200)
            self.assertTrue(r.headers["Content-Type"].startswith("text/event-stream"))
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], PAGES)
        finally:
            c.close()

    def test_config_is_read_per_request(self):
        self.assertEqual(self.req("/api/engines", headers={"Origin": EVIL})[0], 403)
        self.allow([PAGES, EVIL])
        status, headers, _ = self.req("/api/engines", headers={"Origin": EVIL})
        self.assertEqual((status, headers["Access-Control-Allow-Origin"]), (200, EVIL), "改設定檔不用重啟")


class BuildPagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "site"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, api=API):
        build_pages.build(api, self.out)
        return (self.out / "index.html").read_text(encoding="utf-8")

    @staticmethod
    def csp_of(text):
        return {d.split()[0]: d.split()[1:] for d in text.split(";") if d.strip()}

    def test_source_page_defaults_to_same_origin(self):
        page = (server.WEB / "index.html").read_text(encoding="utf-8")
        self.assertEqual(page.count('<meta name="scribe-api" content="">'), 1, "原始網頁預設同源（預設用法）")

    def test_api_base_and_csp(self):
        html = self.build(API + "/")
        self.assertIn(f'<meta name="scribe-api" content="{API}">', html)
        meta = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', html).group(1)
        p = self.csp_of(meta)
        self.assertEqual(p["connect-src"][:2], ["'self'", API])
        for src in ("https://api.soniox.com", "wss://stt-rt.soniox.com", "https://*.api.cognitive.microsoft.com",
                    "wss://*.stt.speech.microsoft.com"):
            self.assertIn(src, p["connect-src"])
        for src in p["connect-src"]:
            self.assertNotIn(src, ("*", "https:", "wss:", "http:", "ws:"))
        # #111 的教訓：Azure SDK 用 data: Worker、音訊 worklet 用 blob:，Pages 版也要能跑
        self.assertTrue({"blob:", "data:"} <= set(p["worker-src"]))
        self.assertIn("blob:", p["script-src"])
        self.assertNotIn("'unsafe-eval'", p["script-src"])
        self.assertEqual(p["default-src"], ["'self'"])
        # 回應標頭的 CSP 跟頁面裡同一份，另外加 frame-ancestors
        headers = (self.out / "_headers").read_text(encoding="utf-8")
        line = next(ln for ln in headers.splitlines() if ln.strip().startswith("Content-Security-Policy:"))
        hp = self.csp_of(line.split(":", 1)[1])
        self.assertEqual(hp.pop("frame-ancestors"), ["'none'"])
        self.assertEqual(hp, p)
        self.assertIn("X-Content-Type-Options: nosniff", headers)

    def test_build_id_matches_server_and_build_txt(self):
        html = self.build()
        self.assertNotIn("__MS_BUILD__", html)
        self.assertIn(f'const pageBuild = "{server.BUILD}"', html)
        self.assertEqual((self.out / "build.txt").read_text(encoding="ascii").strip(), server.BUILD)

    def test_build_id_covers_mindmap_component(self):
        # 心智圖元件和頁面一起出貨（#155）：只改 mindmap.js 或 .css 也要換版本，已開著的頁面才會提醒重新整理；主機與 Pages 同一個算法
        web = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, web)
        (web / "shared").mkdir()
        names = ["index.html", "shared/mindmap.css", "shared/mindmap.js"]
        for name in names + ["shared/README.md", "shared/.hidden.js"]:
            (web / name).write_text(name, encoding="utf-8")
        self.assertEqual(server.web_build_files(web), names, "只算 index.html 與 shared 底下的 .js／.css")
        self.assertEqual(build_pages.web_build_files(web), names)
        first = server.web_build(web)
        self.assertEqual(build_pages.web_build(web), first)
        for name in names:
            (web / name).write_text(name + " v2", encoding="utf-8")
            self.assertNotEqual(server.web_build(web), first, name)
            self.assertEqual(build_pages.web_build(web), server.web_build(web), name)
            first = server.web_build(web)
        (web / "shared" / "md.js").write_text("新的元件", encoding="utf-8")
        self.assertNotEqual(server.web_build(web), first, "新增共用元件也換版本")

    def test_mindmap_component_is_standalone(self):
        # 字幕工作室直接載入同一個檔（#155）：不能碰 App 的 id 或全域變數，標籤不能拼成 HTML
        files = server.web_build_files()[1:]
        self.assertIn("shared/mindmap.js", files)
        for name in files:
            text = (server.WEB / name).read_text(encoding="utf-8")
            # 看不見的字元（控制字元、U+FFFE／FFFF）要寫成跳脫碼，編輯器或工具一轉就會悄悄變掉
            self.assertFalse(re.search("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]", text), f"{name} 有看不見的字元")
            if name.endswith(".js"):
                # 註解裡提到（例如「不用 innerHTML」）不算：只看整行註解與 /* */ 以外的程式
                code = re.sub(r"/\*.*?\*/", "", re.sub(r"(?m)^\s*//.*$", "", text), flags=re.S)
                for bad in ("getElementById", "$(", "innerHTML", "insertAdjacentHTML", "meetingTitle", "pageTheme", "saveAiSoon", "localStorage"):
                    self.assertFalse(bad in code, f"{name} 用了 {bad}")
                self.assertRegex(text, r"window\.\w+ = Object\.freeze\(", name)
                continue
            # 每條規則都要以元件自己的 class 開頭（.mm-…，或加在 body 上的 class），不能改到頁面別的地方
            for sel in re.findall(r"(?:^|[{}])\s*([^{}@/][^{}]*?)\s*{", re.sub(r"/\*.*?\*/", "", text, flags=re.S)):
                if sel.strip().startswith("@"):
                    continue
                for part in sel.split(","):
                    self.assertRegex(part.strip(), r"^(body)?\.[a-z]+(-|\b)", f"{name} 的樣式只能管元件自己：{part.strip()}")
        self.assertIn('href="/shared/mindmap.css"', (server.WEB / "index.html").read_text(encoding="utf-8"))

    def test_static_files_and_vendor_are_shipped(self):
        self.build()
        for name in server.web_build_files()[1:]:
            self.assertEqual((self.out / name).read_bytes(), (server.WEB / name).read_bytes(), name)
        for path, (name, _) in server.STATIC.items():
            if path in ("/", "/favicon.ico") or name == "index.html":
                continue
            self.assertEqual((self.out / name).read_bytes(), (server.WEB / name).read_bytes(), path)
        self.assertIn("/vendor/*", (self.out / "_headers").read_text(encoding="utf-8"))
        files = {p.relative_to(self.out).as_posix() for p in self.out.rglob("*") if p.is_file()}
        self.assertFalse(any(f.endswith(".md") for f in files), files)
        self.assertNotIn("_worker.js", files, "只放靜態檔，不用 Functions")
        self.assertFalse(any(f.startswith("functions/") for f in files))
        self.assertIn("_headers", files)

    def test_bad_api_refused(self):
        for bad in ("http://scribe-host.example.ts.net", "https://a.dev/api", "scribe-host:9443", "", "https://a.dev?x=1",
                    "javascript:alert(1)", 'https://a.dev" onload="x'):
            with self.assertRaises(ValueError, msg=bad):
                build_pages.build(bad, Path(self.tmp.name) / "bad")
        self.assertEqual(build_pages.check_api("http://127.0.0.1:18300"), "http://127.0.0.1:18300", "本機測試可以用 http")

    def test_out_dir_must_be_empty(self):
        self.out.mkdir()
        (self.out / "old.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(ValueError):
            build_pages.build(API, self.out)


class PageApiCallsTest(unittest.TestCase):
    page = (server.WEB / "index.html").read_text(encoding="utf-8")

    def test_every_host_call_goes_through_api_helper(self):
        # 直接寫相對路徑的 API 呼叫在 Pages 上會打到 Cloudflare，不是主機
        script = self.page.split("<script>", 1)[1]
        bare = re.findall(r'(?:fetch|EventSource|xhr\.open\("POST",)\s*\(?\s*["`](/(?:api|token|healthz)[^"`]*)', script)
        self.assertEqual(bare, ['/healthz'], "只有同源時的版本檢查可以直接打 /healthz")
        self.assertIn("return fetch(api(path)", script, "postJson 也要經過 api()")
        self.assertGreaterEqual(script.count("api(`/api/") + script.count('api("/api/'), 30)

    def test_manifest_sends_access_cookie(self):
        # Cloudflare Access 擋著時，manifest 預設不帶 cookie 會被導去登入頁
        self.assertIn('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">', self.page)


if __name__ == "__main__":
    unittest.main()
