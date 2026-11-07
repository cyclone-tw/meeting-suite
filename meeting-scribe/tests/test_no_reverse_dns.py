"""綁埠時不能做反向名稱查詢（#211）：標準函式庫的 HTTPServer.server_bind 會呼叫 socket.getfqdn，
在 GitHub 的 macOS 機器上第二次起服務固定卡約 35 秒，e2e 的 10 秒啟動窗口因此全滅。"""
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


def exploding_getfqdn(*args, **kwargs):
    raise AssertionError("綁埠時不應該做反向名稱查詢（socket.getfqdn）")


class NoReverseDnsTest(unittest.TestCase):
    def test_production_server_binds_without_getfqdn(self):
        with mock.patch.object(socket, "getfqdn", exploding_getfqdn):
            httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        self.addCleanup(httpd.server_close)
        self.assertEqual(httpd.server_name, "127.0.0.1")
        self.assertEqual(httpd.server_port, httpd.server_address[1])

    def test_test_servers_bind_without_getfqdn(self):
        from fake_google import FakeGoogle
        from fake_redmine import FakeRedmine
        from fake_soniox import FakeSoniox
        with mock.patch.object(socket, "getfqdn", exploding_getfqdn):
            for fake in (FakeRedmine(), FakeSoniox(), FakeGoogle(["http://127.0.0.1/"])):
                started = fake.start()
                self.addCleanup(started.httpd.server_close)
                self.addCleanup(started.httpd.shutdown)

    def test_shared_nodns_server_keeps_the_attributes_http_server_users_expect(self):
        import nodns
        with mock.patch.object(socket, "getfqdn", exploding_getfqdn):
            httpd = nodns.NoDnsServer(("127.0.0.1", 0), nodns.http.server.BaseHTTPRequestHandler)
        self.addCleanup(httpd.server_close)
        self.assertEqual((httpd.server_name, httpd.server_port), ("127.0.0.1", httpd.server_address[1]))


if __name__ == "__main__":
    unittest.main()
