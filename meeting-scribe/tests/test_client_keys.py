"""client 模式（#105）：長期轉錄金鑰只在使用者裝置，server 不發臨時金鑰、不用自己的金鑰匯入。"""
import json
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from test_server import opener_returning  # noqa: E402

AZURE = "/vendor/azure-speech-sdk-1.52.0.bundle-min.js"
OPENER = opener_returning({"api_key": "snx_temp_ok"})


class KeyModeConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def mode(self, data):
        self.cfg.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
        return server.load_asr_key_mode(self.cfg)

    def test_default_is_server(self):
        self.assertEqual(server.load_asr_key_mode(Path(self.tmp.name) / "missing.json"), "server")
        self.assertEqual(self.mode({}), "server")
        self.assertEqual(self.mode("{not json"), "server")
        self.assertEqual(self.mode([1, 2]), "server")

    def test_client_and_unknown_values(self):
        self.assertEqual(self.mode({"asr_key_mode": "client"}), "client")
        self.assertEqual(self.mode({"asr_key_mode": "server"}), "server")
        for bad in ("CLIENT", "browser", "", 1, None):
            self.assertEqual(self.mode({"asr_key_mode": bad}), "server", bad)

    def test_engines_listing_by_mode(self):
        self.assertEqual([e["id"] for e in server.engines_status("k", None, "server")][:1], ["soniox"])
        self.assertNotIn("azure", [e["id"] for e in server.engines_status("k", None, "server")])
        client = {e["id"]: e["ok"] for e in server.engines_status(None, None, "client")}
        self.assertEqual((client["soniox"], client["azure"]), (True, True), "金鑰在裝置上：server 沒金鑰也能選")
        self.assertFalse({e["id"]: e["ok"] for e in server.engines_status(None, None, "server")}["soniox"])


class ClientModeHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg = Path(cls.tmp.name) / "config.json"
        cls.handler = type("H", (server.Handler,), {})
        # 就算這台剛好有長期金鑰，client 模式也不准拿來用
        cls.handler.api_key = "LONG-KEY"
        cls.handler.opener = staticmethod(OPENER)
        cls.handler.config_file = cls.cfg
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        self.set_mode("client")
        OPENER.last_request = None

    def set_mode(self, mode):
        self.cfg.write_text(json.dumps({"asr_key_mode": mode}), encoding="utf-8")

    def req(self, path, method="GET", body=None):
        data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
        r = urllib.request.Request(self.base + path, method=method, data=data)
        if method == "POST":
            r.add_header("X-Meeting-Scribe", "1")
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_token_refused_without_calling_soniox(self):
        status, _, body = self.req("/token", "POST")
        self.assertEqual(status, 403)
        self.assertNotIn(b"snx_temp_ok", body)
        self.assertNotIn(b"LONG-KEY", body)
        self.assertIsNone(OPENER.last_request, "client 模式不能用 server 的金鑰去 Soniox 換臨時金鑰")

    def test_server_mode_still_mints(self):
        self.set_mode("server")
        status, _, body = self.req("/token", "POST")
        self.assertEqual((status, json.loads(body)), (200, {"api_key": "snx_temp_ok"}))

    def test_engines_report_key_mode(self):
        _, _, body = self.req("/api/engines")
        j = json.loads(body)
        self.assertEqual(j["key_mode"], "client")
        self.assertTrue({"soniox", "azure"} <= {e["id"] for e in j["engines"]})
        self.set_mode("server")
        j = json.loads(self.req("/api/engines")[2])
        self.assertEqual(j["key_mode"], "server")
        self.assertNotIn("azure", {e["id"] for e in j["engines"]})

    def test_soniox_import_does_not_use_host_key_in_client_mode(self):
        # client 模式的匯入改由瀏覽器送 Soniox（#114）：不再拒絕，也不拿主機的金鑰去打 Soniox；完整流程在 test_import
        status, _, body = self.req("/api/import/start", "POST", {"meeting": "a" * 32, "draft": "b" * 32, "engine": "soniox", "terms": []})
        self.assertIn(status, (404, 503), "沒有這份暫存（或沒裝 ffmpeg），不是因為金鑰模式被拒")
        self.assertNotIn("裝置", json.loads(body)["error"])
        self.assertIsNone(OPENER.last_request)

    def test_azure_sdk_served_with_long_cache(self):
        status, headers, body = self.req(AZURE)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], server.VENDOR_CACHE)
        self.assertTrue(body.startswith(b"(()=>{"), "Azure SDK 要原封不動")
        self.assertIn(b"window.SpeechSDK=", body)


class PageSecurityTest(unittest.TestCase):
    page = (server.WEB / "index.html").read_text(encoding="utf-8")

    def csp(self):
        m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', self.page)
        self.assertIsNotNone(m, "頁面要有 CSP")
        return {d.split()[0]: d.split()[1:] for d in m.group(1).split(";") if d.strip()}

    def test_csp_limits_where_the_page_can_connect(self):
        p = self.csp()
        self.assertEqual(p["default-src"], ["'self'"])
        self.assertEqual(p["object-src"], ["'none'"])
        self.assertEqual(p["base-uri"], ["'none'"])
        self.assertNotIn("'unsafe-eval'", p["script-src"])
        conn = p["connect-src"]
        self.assertEqual(conn[0], "'self'")
        for src in conn:
            self.assertNotIn(src, ("*", "https:", "wss:", "http:", "ws:"), "connect-src 不能開放全部網址")
        self.assertIn("https://api.soniox.com", conn)
        self.assertIn("wss://stt-rt.soniox.com", conn)
        self.assertIn("https://*.api.cognitive.microsoft.com", conn)
        # Azure SDK 的計時器用 data: 網址建 Worker（送音訊落後即時時才會建）；擋掉的話辨識會被取消（PR #111 review）
        self.assertIn("data:", p["worker-src"])
        sdk = (server.WEB / "vendor" / "azure-speech-sdk-1.52.0.bundle-min.js").read_text(encoding="utf-8")
        self.assertIn('"data:text/javascript;base64,"', sdk, "換 SDK 版本時重新確認它建 Worker 的方式")

    def test_azure_sdk_is_not_loaded_up_front(self):
        self.assertNotRegex(self.page, r'<script[^>]+src="[^"]*azure', "Azure SDK 只在選 Azure 時才載入")
        self.assertIn(f'const AZURE_SDK = "{AZURE}"', self.page)

    def test_provider_endpoints_are_fixed_in_the_page(self):
        # 金鑰只能送到寫死的服務網址：伺服器或設定檔都不能改掉它
        self.assertIn('sonioxTemp: "https://api.soniox.com/v1/auth/temporary-api-key"', self.page)
        self.assertIn('sonioxWs: "wss://stt-rt.soniox.com/transcribe-websocket"', self.page)
        self.assertIn('sonioxApi: "https://api.soniox.com/v1",', self.page)
        # 匯入檔案的 Soniox 呼叫都要用寫死的網址（#114）
        self.assertNotRegex(self.page, r"fetch\((?!ASR_URLS|api\(|\$\{|u,|url|\w+\.url)[^)]*soniox", "Soniox 網址只能來自 ASR_URLS")
        self.assertIn('xhr.open("POST", ASR_URLS.sonioxApi + "/files")', self.page)
        self.assertIn("azureToken: (region) => `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`", self.page)

    def test_vault_uses_strong_key_derivation(self):
        m = re.search(r"PBKDF2_ITER = (\d+)", self.page)
        self.assertGreaterEqual(int(m.group(1)), 600000)
        self.assertIn('name: "AES-GCM"', self.page)
        self.assertNotRegex(self.page, r"localStorage\.setItem\([^)]*(key|secret)", "金鑰不能放 localStorage")


if __name__ == "__main__":
    unittest.main()
