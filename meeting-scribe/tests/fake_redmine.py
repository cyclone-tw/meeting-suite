"""測試用的假 Redmine（#82）：只做 meeting-scribe 會用到的幾個 REST API，資料放記憶體。"""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler

from nodns import NoDnsServer
from urllib.parse import parse_qs, urlsplit

KEY = "test-redmine-key-0123456789"


class FakeRedmine:
    def __init__(self, project="student-meetings", project_id=8):
        self.project, self.project_id = project, project_id
        self.issues = {}          # id → issue dict（含 project_id、parent_issue_id）
        self.requests = []        # (method, path, payload)
        self.fail_posts_after = None   # 第幾次 POST 之後回 500（模擬中途失敗）
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
                payload = json.loads(self.rfile.read(n)) if n else None
                url = urlsplit(self.path)
                with fake.lock:
                    fake.requests.append((method, self.path, payload))
                    if self.headers.get("X-Redmine-API-Key") != KEY:
                        return self._reply(401)
                    status, obj = fake.route(method, url.path, parse_qs(url.query), payload)
                self._reply(status, obj)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_PUT(self):
                self._handle("PUT")

        self.httpd = NoDnsServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def children(self, parent):
        return [i for i in self.issues.values() if i.get("parent_issue_id") == parent]

    def route(self, method, path, query, payload):
        if method == "GET" and path in (f"/projects/{self.project}.json", f"/projects/{self.project_id}.json"):
            return 200, {"project": {"id": self.project_id, "identifier": self.project}}
        m = re.fullmatch(r"/issues/(\d+)\.json", path)
        if m:
            issue = self.issues.get(int(m.group(1)))
            if issue is None:
                return 404, None
            if method == "GET":
                return 200, {"issue": {**issue, "project": {"id": issue["project_id"]}}}
            if method == "PUT":
                issue.update(payload["issue"])
                return 204, None
        if path == "/issues.json" and method == "GET":
            parent = int(query["parent_id"][0])
            return 200, {"issues": self.children(parent), "total_count": len(self.children(parent))}
        if path == "/issues.json" and method == "POST":
            posts = sum(1 for r in self.requests if r[0] == "POST")
            if self.fail_posts_after is not None and posts > self.fail_posts_after:
                return 500, None
            issue = dict(payload["issue"])
            # 和真的 Redmine 一樣：角色沒有「新任務」的狀態轉換時，建立時一律是預設狀態（新建立），指定的 status_id 被忽略
            issue["status_id"] = 1
            if issue.get("due_date") and issue.get("start_date") and issue["due_date"] < issue["start_date"]:
                return 422, {"errors": ["到期日 必須大於開始日期"]}
            issue["id"] = max(self.issues, default=100) + 1
            self.issues[issue["id"]] = issue
            return 201, {"issue": {**issue, "status": {"id": issue["status_id"]}}}
        return 404, None
