"""外部 review 的加固項目（#207）：Host 白名單、tailnet 身分、SSE 上限與等待期限、/token 速率限制。"""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

MID = "a" * 32


class FakeClock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class LimiterTest(unittest.TestCase):
    def test_conn_limiter_caps_and_releases(self):
        lim = server.ConnLimiter(2)
        self.assertTrue(lim.acquire())
        self.assertTrue(lim.acquire())
        self.assertFalse(lim.acquire(), "第三條要被擋")
        lim.release()
        self.assertTrue(lim.acquire(), "放掉一條就有空位")

    def test_rate_limiter_sliding_window(self):
        clock = FakeClock()
        lim = server.RateLimiter(3, 60, clock=clock)
        self.assertEqual([lim.allow() for _ in range(4)], [True, True, True, False])
        clock.t += 59
        self.assertFalse(lim.allow(), "還在 60 秒窗口內")
        clock.t += 2
        self.assertTrue(lim.allow(), "窗口滑過去就恢復")


class HostRuleTest(unittest.TestCase):
    def test_host_allowed(self):
        ok = ["127.0.0.1", "127.0.0.1:18095", "localhost", "LOCALHOST:8080", "[::1]", "[::1]:18095",
              "mini.tail1234.ts.net", "mini.tail1234.ts.net:8443", "scribe.example.dev"]
        bad = ["", "evil.com", "evil.com:18095", "127.0.0.1.evil.com", "localhost.evil.com", "evil.ts.net.evil.com",
               "ts.net", ".ts.net", "mini.ts.net:abc", "mini.ts.net:", "127.0.0.1:99999x", "a b.ts.net", "[::1", "0.0.0.0", "192.168.1.5:18095"]
        extra = frozenset({"scribe.example.dev"})
        for h in ok:
            self.assertTrue(server.host_allowed(h, extra), h)
        for h in bad:
            self.assertFalse(server.host_allowed(h, extra), h)
        self.assertFalse(server.host_allowed("scribe.example.dev", frozenset()), "沒列在設定檔就不放行")
        self.assertFalse(server.host_allowed(None, extra))

    def test_config_loaders(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "config.json"
            cfg.write_text(json.dumps({"allowed_hosts": ["Scribe.Example.dev", "a b", 7, "x.dev:80", "*", ""],
                                       "tailscale_users": ["Alice@Example.com", "", 3]}), encoding="utf-8")
            self.assertEqual(server.load_allowed_hosts(cfg), frozenset({"scribe.example.dev"}))
            self.assertEqual(server.load_tailscale_users(cfg), frozenset({"alice@example.com"}))
            for data in ("{bad", "[]", json.dumps({"allowed_hosts": "x.dev", "tailscale_users": None})):
                cfg.write_text(data, encoding="utf-8")
                self.assertEqual(server.load_allowed_hosts(cfg), frozenset(), data)
                self.assertEqual(server.load_tailscale_users(cfg), frozenset(), data)
            self.assertEqual(server.load_tailscale_users(Path(d) / "missing.json"), frozenset())


class HardenedHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfg = Path(cls.tmp.name) / "config.json"
        cls.calls = []

        def opener(req, timeout=None):
            cls.calls.append(req)
            import io
            return type("R", (io.BytesIO,), {"__enter__": lambda s: s, "__exit__": lambda s, *a: False})(b'{"api_key": "snx_temp_ok"}')

        cls.handler = type("H", (server.Handler,), {"config_file": cls.cfg, "api_key": "LONG-KEY", "opener": staticmethod(opener),
                                                    "sse_wait_seconds": 0.3, "sse_wait_poll": 0.05})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        self.config({})
        self.calls.clear()
        self._saved = (server.SSE_LIMIT, server.TOKEN_LIMIT)
        server.SSE_LIMIT = server.ConnLimiter(64)
        server.TOKEN_LIMIT = server.RateLimiter(1000, 60)
        self.addCleanup(lambda: (setattr(server, "SSE_LIMIT", self._saved[0]), setattr(server, "TOKEN_LIMIT", self._saved[1])))

    def config(self, data):
        self.cfg.write_text(json.dumps(data), encoding="utf-8")

    def req(self, path, method="GET", host="auto", headers=None, read=True):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if method == "POST":
            h.setdefault("X-Meeting-Scribe", "1")
        if host == "auto":
            host = f"127.0.0.1:{self.port}"
        if host is None:
            c.putrequest(method, path, skip_host=True)
            for k, v in h.items():
                c.putheader(k, v)
            c.putheader("Content-Length", "0")
            c.endheaders()
        else:
            h["Host"] = host
            c.request(method, path, body=b"" if method == "POST" else None, headers=h)
        r = c.getresponse()
        data = r.read() if read else b""
        c.close()
        return r.status, data

    # ---- #1 Host 白名單 ----
    def test_foreign_host_is_403_on_get_and_post(self):
        for host in ("evil.com", f"evil.com:{self.port}", "127.0.0.1.evil.com", None):
            self.assertEqual(self.req("/healthz", host=host)[0], 403, host)
            self.assertEqual(self.req("/api/drafts", host=host)[0], 403, host)
            self.assertEqual(self.req("/token", "POST", host=host)[0], 403, host)
            self.assertEqual(self.req("/", host=host)[0], 403, host)
        self.assertEqual(self.calls, [], "被擋的請求不能碰到 Soniox")

    def test_loopback_and_tailnet_hosts_pass(self):
        for host in ("auto", "localhost", f"localhost:{self.port}", "[::1]", "mini.tail1234.ts.net"):
            self.assertEqual(self.req("/healthz", host=host)[0], 200, host)
        self.assertEqual(self.req("/token", "POST", host="mini.tail1234.ts.net")[0], 200)

    def test_allowed_hosts_comes_from_config(self):
        self.assertEqual(self.req("/healthz", host="scribe.example.dev")[0], 403)
        self.config({"allowed_hosts": ["scribe.example.dev"]})
        self.assertEqual(self.req("/healthz", host="scribe.example.dev")[0], 200)
        self.assertEqual(self.req("/healthz", host="other.example.dev")[0], 403)

    def test_preflight_with_foreign_host_is_403(self):
        self.config({"cors_origins": ["https://pages.example.dev"]})
        status, _ = self.req("/api/agent/para", "OPTIONS", host="evil.com",
                             headers={"Origin": "https://evil.com", "Access-Control-Request-Method": "POST"})
        self.assertEqual(status, 403)

    # ---- #3 tailnet 身分 ----
    def test_tailscale_users_unset_changes_nothing(self):
        self.assertEqual(self.req("/healthz", host="mini.ts.net", headers={"Tailscale-User-Login": "anyone@x.com"})[0], 200)
        self.assertEqual(self.req("/healthz", host="mini.ts.net")[0], 200)

    def test_tailscale_users_limits_tailnet_requests(self):
        self.config({"tailscale_users": ["Alice@Example.com"]})
        ts = "mini.tail1234.ts.net"
        self.assertEqual(self.req("/healthz", host=ts, headers={"Tailscale-User-Login": "alice@example.com"})[0], 200)
        self.assertEqual(self.req("/healthz", host=ts, headers={"Tailscale-User-Login": "ALICE@example.com"})[0], 200, "不分大小寫")
        self.assertEqual(self.req("/healthz", host=ts, headers={"Tailscale-User-Login": "bob@example.com"})[0], 403)
        self.assertEqual(self.req("/token", "POST", host=ts, headers={"Tailscale-User-Login": "bob@example.com"})[0], 403)
        self.assertEqual(self.req("/healthz", host=ts)[0], 403, "沒帶身分標頭的 tailnet 請求（例如 tagged 裝置）一律擋")
        self.assertEqual(self.req("/healthz", host=ts, headers={"Tailscale-User-Login": ""})[0], 403)
        self.assertEqual(self.calls, [])

    def test_tailscale_users_header_cannot_be_dodged_with_loopback_host(self):
        # tailnet 上的人自己把 Host 改成 127.0.0.1：tailscale serve 仍會帶上他的身分，照樣要在清單內
        self.config({"tailscale_users": ["alice@example.com"]})
        self.assertEqual(self.req("/healthz", host="127.0.0.1", headers={"Tailscale-User-Login": "bob@example.com"})[0], 403)

    def test_tailscale_users_set_still_allows_local_browser(self):
        self.config({"tailscale_users": ["alice@example.com"]})
        self.assertEqual(self.req("/healthz")[0], 200, "本機直連（沒有身分標頭、Host 是迴路）照常")
        self.assertEqual(self.req("/token", "POST")[0], 200)

    # ---- #4 SSE 與 /token ----
    def test_sse_over_the_cap_is_503_and_slot_is_released(self):
        server.SSE_LIMIT = server.ConnLimiter(0)
        self.assertEqual(self.req(f"/api/agent/events?meeting={MID}")[0], 503)
        self.assertEqual(self.req(f"/api/caption/events?channel={MID}")[0], 503)
        self.assertEqual(self.req(f"/api/local/events?meeting={MID}")[0], 503)
        server.SSE_LIMIT = server.ConnLimiter(1)
        self.assertEqual(self.req(f"/api/agent/events?meeting={'zz'}")[0], 400, "代碼不合法照舊回 400，也不占名額")
        self.assertTrue(server.SSE_LIMIT.acquire(), "400 之後名額還在")

    def test_sse_waiting_for_a_session_gives_up_after_the_deadline(self):
        import time
        t0 = time.monotonic()
        status, body = self.req(f"/api/agent/events?meeting={MID}")   # 沒有這場：只會等，到期後伺服器關連線
        self.assertEqual(status, 200)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertIn(b": waiting", body)
        self.assertTrue(server.SSE_LIMIT.acquire(), "等待結束要把名額還回來")

    def test_token_is_rate_limited(self):
        clock = FakeClock()
        server.TOKEN_LIMIT = server.RateLimiter(2, 60, clock=clock)
        self.assertEqual([self.req("/token", "POST")[0] for _ in range(3)], [200, 200, 429])
        self.assertEqual(len(self.calls), 2, "被限速的請求不能打 Soniox")
        clock.t += 61
        self.assertEqual(self.req("/token", "POST")[0], 200)

    def test_rejected_token_calls_do_not_use_the_quota(self):
        server.TOKEN_LIMIT = server.RateLimiter(1, 60, clock=FakeClock())
        self.assertEqual(self.req("/token", "POST", headers={"X-Meeting-Scribe": "0"})[0], 403)
        self.assertEqual(self.req("/token", "POST", host="evil.com")[0], 403)
        self.assertEqual(self.req("/token", "POST")[0], 200)


if __name__ == "__main__":
    unittest.main()
