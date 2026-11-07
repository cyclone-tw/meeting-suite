"""測試用 HTTP server：綁埠時不做反向名稱查詢（#211）。

標準函式庫的 HTTPServer.server_bind 會呼叫 socket.getfqdn；在 GitHub 的 macOS 機器上它第二次起服務固定卡約 35 秒。
測試服務只綁 127.0.0.1，不需要主機的完整網域名稱。"""
import http.server
import socketserver


class NoDnsServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name, self.server_port = host, port
