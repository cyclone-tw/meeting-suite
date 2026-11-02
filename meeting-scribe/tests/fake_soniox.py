"""測試用的假 Soniox 非即時 API（#90）：檔案上傳、建立轉錄、查狀態、拿結果、刪除；資料放記憶體。"""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = "test-soniox-key"
TOKENS = [
    {"text": "今天", "start_ms": 0, "end_ms": 400, "speaker": "1"},
    {"text": "討論 IEP。", "start_ms": 400, "end_ms": 1200, "speaker": "1"},
    {"text": "好的", "start_ms": 3000, "end_ms": 3400, "speaker": "2"},
    {"text": "，下週再談。", "start_ms": 3400, "end_ms": 4200, "speaker": "2"},
    {"text": "第二批", "start_ms": 31000, "end_ms": 31500, "speaker": "1"},
]


class FakeSoniox:
    def __init__(self):
        self.files, self.jobs, self.requests = {}, {}, []
        self.polls_before_done = 2      # 查幾次狀態後才完成
        self.fail = {}                  # (method, 路徑開頭) → HTTP 狀態碼
        self.final_status = "completed"
        self.tokens = list(TOKENS)
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, status, obj=None):
                body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self, method):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                with fake.lock:
                    fake.requests.append((method, self.path, raw if self.path == "/v1/files" else (json.loads(raw) if raw else None)))
                    if self.headers.get("Authorization") != f"Bearer {KEY}":
                        return self._reply(401)
                    for (m, prefix), code in fake.fail.items():
                        if m == method and self.path.startswith(prefix):
                            return self._reply(code)
                    status, obj = fake.route(method, self.path, raw, self.headers)
                self._reply(status, obj)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_DELETE(self):
                self._handle("DELETE")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def route(self, method, path, raw, headers):
        if method == "POST" and path == "/v1/files":
            if not headers.get("Content-Type", "").startswith("multipart/form-data; boundary=") or b'name="file"' not in raw:
                return 400, {"error": "bad multipart"}
            fid = f"file-{len(self.files) + 1}"
            self.files[fid] = len(raw)
            return 201, {"id": fid}
        if method == "POST" and path == "/v1/transcriptions":
            req = json.loads(raw)
            if req.get("file_id") not in self.files:
                return 400, {"error": "no file"}
            tid = f"tr-{len(self.jobs) + 1}"
            self.jobs[tid] = {"req": req, "polls": 0}
            return 201, {"id": tid, "status": "queued"}
        m = re.fullmatch(r"/v1/transcriptions/([\w-]+)(/transcript)?", path)
        if m and m.group(1) in self.jobs:
            job = self.jobs[m.group(1)]
            if method == "DELETE":
                del self.jobs[m.group(1)]
                return 204, None
            if m.group(2):
                return 200, {"id": m.group(1), "text": "", "tokens": self.tokens}
            job["polls"] += 1
            if job["polls"] <= self.polls_before_done:
                return 200, {"id": m.group(1), "status": "queued" if job["polls"] == 1 else "transcribing"}
            return 200, {"id": m.group(1), "status": self.final_status, "error_message": "bad audio" if self.final_status != "completed" else None}
        m = re.fullmatch(r"/v1/files/([\w-]+)", path)
        if m and method == "DELETE" and m.group(1) in self.files:
            del self.files[m.group(1)]
            return 204, None
        return 404, {"error": "not found"}
