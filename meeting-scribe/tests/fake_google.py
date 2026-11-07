"""假的 Google OAuth 與 Drive API（#107）：e2e 不打真的 Google。只做網頁用到的部分，照官方文件的行為：

- GET /o/oauth2/v2/auth：implicit 流程（response_type=token），檢查 client_id、scope、redirect_uri 後，
  302 跳回 redirect_uri，結果放在 # 後面（access_token、token_type、expires_in、scope、state）。
- /drive/v3/files：查詢（q 只支援網頁會用到的條件）、建資料夾、查單一檔案。
- /upload/drive/v3/files：multipart 一次傳完、resumable 續傳（308＋Range、bytes */總長 查進度、Location 是續傳網址）。
- 所有 Drive 請求都要帶 Authorization: Bearer <有效 token>，不然回 401。
- CORS：跟 Google 一樣回 Access-Control-Allow-Origin，並讓網頁讀得到 Location、Range。

測試控制（Python 屬性，或 POST /__ctl/<名稱> 帶 JSON）：
- expire：所有 token 立刻失效（模擬 1 小時到了）。
- drop_puts：[第幾次續傳 PUT]，那一次只收一半就直接斷線、不回應（模擬手機切背景、網路中斷）。
- short_puts：[第幾次續傳 PUT]，那一次只收一半、照常回 308（Range 是實際收到的位置；官方文件說不能假設整段都收到）。
- expire_after_bytes：某個續傳收到這麼多位元組後，所有 token 失效。
- fail：[{"method", "name", "status", "times"}]，對檔名是 name 的上傳（multipart 或開始續傳）回 status。
- deny：授權頁回 error=access_denied。
- rename：{"id", "name"}，把那個檔或資料夾改名（模擬使用者在 Drive 上改名）。
- move：{"id", "parent"}，把那個檔或資料夾搬到別的資料夾底下。
GET /__ctl/state 回目前的檔案（含內容的 sha256）與紀錄。
"""
import hashlib
import json
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler

from nodns import NoDnsServer
from urllib.parse import parse_qs, urlencode, urlsplit

CLIENT_ID = "123456789012-e2etestclientabcdefghijklmnop.apps.googleusercontent.com"
SCOPE = "https://www.googleapis.com/auth/drive.file"
FOLDER = "application/vnd.google-apps.folder"


def parse_q(q):
    """網頁用到的查詢條件：'id' in parents、name = '…'、mimeType = '…'、trashed = false、appProperties has { key='k' and value='v' }。
    其他寫法丟 ValueError（真的 Google 會回 400），免得網頁送錯了測試還過。"""
    conds = []
    s = q.strip()
    lit = r"'((?:\\.|[^'\\])*)'"
    unq = lambda v: re.sub(r"\\(.)", r"\1", v)
    m = re.search(r"appProperties has \{ key=" + lit + r" and value=" + lit + r" \}", s)
    if m:
        conds.append(("prop", unq(m.group(1)), unq(m.group(2))))
        s = (s[:m.start()] + s[m.end():]).strip()
        s = re.sub(r"^and\s+|\s+and$", "", s).replace(" and  and ", " and ").strip()
    for part in [p.strip() for p in re.split(r"\s+and\s+(?=(?:[^']*'[^']*')*[^']*$)", s) if p.strip()]:
        if re.fullmatch(lit + r" in parents", part):
            conds.append(("parent", unq(re.fullmatch(lit + r" in parents", part).group(1))))
        elif re.fullmatch(r"name = " + lit, part):
            conds.append(("name", unq(re.fullmatch(r"name = " + lit, part).group(1))))
        elif re.fullmatch(r"mimeType = " + lit, part):
            conds.append(("mime", unq(re.fullmatch(r"mimeType = " + lit, part).group(1))))
        elif part == "trashed = false":
            conds.append(("untrashed",))
        else:
            raise ValueError(f"不支援的查詢：{part!r}")
    return conds


def matches(f, conds):
    for c in conds:
        if c[0] == "parent" and c[1] not in f["parents"]:
            return False
        if c[0] == "name" and f["name"] != c[1]:
            return False
        if c[0] == "mime" and f["mimeType"] != c[1]:
            return False
        if c[0] == "untrashed" and f["trashed"]:
            return False
        if c[0] == "prop" and f["appProperties"].get(c[1]) != c[2]:
            return False
    return True


class FakeGoogle:
    def __init__(self, redirect_uris=(), client_id=CLIENT_ID, expires_in=3600):
        self.redirect_uris = list(redirect_uris)
        self.client_id = client_id
        self.expires_in = expires_in
        self.lock = threading.Lock()
        self.tokens = {}         # token → 還有效
        self.files = {}          # id → {id, name, mimeType, parents, appProperties, trashed, data}
        self.sessions = {}       # upload_id → {meta, total, data}
        self.log = []            # [(方法, 路徑, 狀態)]
        self.auths = []          # 授權請求的參數
        self.puts = 0            # 收過幾次續傳 PUT（含查進度）
        self.dropped = 0         # 斷過幾次線
        self.status_queries = 0  # 網頁問過幾次續傳進度
        self.drop_puts = []
        self.short_puts = []
        self.expire_after_bytes = None
        self.fail = []
        self.deny = False
        self.seq = 0
        self.httpd = None

    # ---- 控制 ----
    def expire(self):
        with self.lock:
            for t in self.tokens:
                self.tokens[t] = False

    def state(self):
        with self.lock:
            files = [self._public(f) for f in self.files.values()]
            return {"files": files, "log": list(self.log), "auths": list(self.auths), "sessions": len(self.sessions), "puts": self.puts,
                    "dropped": self.dropped, "status_queries": self.status_queries,
                    "tokens": sorted(self.tokens)}

    @staticmethod
    def _public(f):
        out = {k: v for k, v in f.items() if k != "data"}
        out["size"] = len(f["data"])
        out["sha256"] = hashlib.sha256(f["data"]).hexdigest()
        out["text"] = f["data"].decode("utf-8", "replace") if f["mimeType"].startswith("text/") or f["mimeType"] == "image/svg+xml" else None
        return out

    def _new_id(self, prefix):
        self.seq += 1
        return f"{prefix}{self.seq:04d}"

    def _create(self, meta, data=b""):
        fid = self._new_id("f")
        parents = meta.get("parents") or ["root"]
        self.files[fid] = {"id": fid, "name": str(meta.get("name", "")), "mimeType": str(meta.get("mimeType") or "application/octet-stream"),
                           "parents": list(parents), "appProperties": dict(meta.get("appProperties") or {}), "trashed": False, "data": bytes(data)}
        return self.files[fid]

    def start(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
                self.send_header("Access-Control-Expose-Headers", "Location, Range")
                self.send_header("Vary", "Origin")

            def _send(self, status, obj=None, headers=()):
                body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode()
                with fake.lock:
                    fake.log.append((self.command, self.path.split("?", 1)[0], status))
                self.send_response(status)
                self._cors()
                for k, v in headers:
                    self.send_header(k, v)
                if obj is not None:
                    self.send_header("Content-Type", "application/json; charset=UTF-8")
                if self.close_connection:
                    self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def _authed(self):
                auth = self.headers.get("Authorization") or ""
                tok = auth[7:] if auth.startswith("Bearer ") else ""
                with fake.lock:
                    ok = fake.tokens.get(tok, False)
                if not ok:
                    self._send(401, {"error": {"code": 401, "message": "Request had invalid authentication credentials.", "status": "UNAUTHENTICATED"}})
                return ok

            def _failed(self, name):
                with fake.lock:
                    for rule in fake.fail:
                        if rule.get("name") == name and rule.get("times", 1) > 0:
                            rule["times"] = rule.get("times", 1) - 1
                            status = int(rule.get("status", 500))
                            break
                    else:
                        return False
                self._send(status, {"error": {"code": status, "message": "e2e 指定的失敗"}})
                return True

            def do_OPTIONS(self):
                self.send_response(200)
                self._cors()
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
                self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers") or "")
                self.send_header("Access-Control-Max-Age", "600")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if u.path == "/__ctl/state":
                    self._send(200, fake.state())
                    return
                if u.path == "/o/oauth2/v2/auth":
                    self._auth(q)
                    return
                if u.path == "/drive/v3/files":
                    if not self._authed():
                        return
                    try:
                        conds = parse_q(q.get("q", ""))
                    except ValueError as e:
                        self._send(400, {"error": {"code": 400, "message": str(e)}})
                        return
                    size = max(1, min(1000, int(q.get("pageSize") or 100)))
                    start = int(q.get("pageToken") or 0)
                    with fake.lock:
                        hits = [f for f in fake.files.values() if matches(f, conds)]
                    page = hits[start:start + size]
                    out = {"files": [{"id": f["id"], "name": f["name"], "mimeType": f["mimeType"],
                                      **({} if f["mimeType"] == FOLDER else {"size": str(len(f["data"]))})} for f in page]}
                    if start + size < len(hits):
                        out["nextPageToken"] = str(start + size)
                    self._send(200, out)
                    return
                m = re.fullmatch(r"/drive/v3/files/([A-Za-z0-9_-]+)", u.path)
                if m:
                    if not self._authed():
                        return
                    f = fake.files.get(m.group(1))
                    if f is None:
                        self._send(404, {"error": {"code": 404, "message": "File not found"}})
                        return
                    # 跟 Google 一樣只回 fields 要的欄位（預設 id、name、mimeType）
                    want = [x.strip() for x in (q.get("fields") or "id,name,mimeType").split(",") if x.strip()]
                    self._send(200, {k: f[k] for k in want if k in ("id", "name", "mimeType", "trashed", "parents")})
                    return
                self._send(404, {"error": {"code": 404, "message": "not found"}})

            def _auth(self, q):
                with fake.lock:
                    fake.auths.append(q)
                redirect = q.get("redirect_uri", "")
                if q.get("client_id") != fake.client_id:
                    self._send(400, {"error": "invalid_client"})
                    return
                if redirect not in fake.redirect_uris:
                    self._send(400, {"error": "redirect_uri_mismatch"})
                    return
                if q.get("response_type") != "token" or q.get("scope") != SCOPE:
                    self._send(400, {"error": "invalid_request"})
                    return
                if fake.deny:
                    frag = {"error": "access_denied", "state": q.get("state", "")}
                else:
                    with fake.lock:
                        tok = f"ya29.fake-{len(fake.tokens) + 1}-{hashlib.sha256(str(fake.seq).encode()).hexdigest()[:8]}"
                        fake.seq += 1
                        fake.tokens[tok] = True
                    frag = {"access_token": tok, "token_type": "Bearer", "expires_in": str(fake.expires_in), "scope": SCOPE, "state": q.get("state", "")}
                self._send(302, None, headers=[("Location", redirect + "#" + urlencode(frag))])

            def do_POST(self):
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                if u.path.startswith("/__ctl/"):
                    self._ctl(u.path[7:], self._body())
                    return
                body = self._body()
                if not self._authed():
                    return
                if u.path == "/drive/v3/files":
                    meta = json.loads(body or b"{}")
                    if meta.get("mimeType") != FOLDER:
                        self._send(400, {"error": {"code": 400, "message": "只做資料夾"}})
                        return
                    with fake.lock:
                        f = fake._create(meta)
                    self._send(200, {"id": f["id"], "name": f["name"]})
                    return
                if u.path == "/upload/drive/v3/files" and q.get("uploadType") == "multipart":
                    m = re.search(r"boundary=([^;]+)", self.headers.get("Content-Type") or "")
                    if not m or not self.headers.get("Content-Type", "").startswith("multipart/related"):
                        self._send(400, {"error": {"code": 400, "message": "要 multipart/related"}})
                        return
                    sep = b"--" + m.group(1).encode()
                    parts = [p for p in body.split(sep) if p not in (b"", b"--\r\n", b"--")]
                    if len(parts) != 2:
                        self._send(400, {"error": {"code": 400, "message": "要兩段"}})
                        return
                    head1, meta_raw = parts[0].split(b"\r\n\r\n", 1)
                    head2, data = parts[1].split(b"\r\n\r\n", 1)
                    meta = json.loads(meta_raw.rstrip(b"\r\n"))
                    data = data[:-2] if data.endswith(b"\r\n") else data
                    if self._failed(meta.get("name")):
                        return
                    with fake.lock:
                        f = fake._create(meta, data)
                    self._send(200, {"id": f["id"], "name": f["name"], "size": str(len(f["data"]))})
                    return
                if u.path == "/upload/drive/v3/files" and q.get("uploadType") == "resumable":
                    meta = json.loads(body or b"{}")
                    if self._failed(meta.get("name")):
                        return
                    total = self.headers.get("X-Upload-Content-Length")
                    with fake.lock:
                        uid = fake._new_id("up")
                        fake.sessions[uid] = {"meta": meta, "total": int(total) if total else None, "data": bytearray(), "done": None}
                    host = self.headers.get("Host")
                    self._send(200, None, headers=[("Location", f"http://{host}/upload/drive/v3/files?uploadType=resumable&upload_id={uid}")])
                    return
                self._send(404, {"error": {"code": 404, "message": "not found"}})

            def do_PUT(self):
                # 續傳 PUT 一律回 Connection: close：瀏覽器在重用的連線上遇到斷線會自己重送，網頁就看不到中斷
                self.close_connection = True
                u = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                body = self._body()
                if not self._authed():
                    return
                s = fake.sessions.get(q.get("upload_id", ""))
                if u.path != "/upload/drive/v3/files" or s is None:
                    self._send(404, {"error": {"code": 404, "message": "upload session not found"}})
                    return
                with fake.lock:
                    fake.puts += 1
                    n = fake.puts
                    drop = n in fake.drop_puts
                    short = n in fake.short_puts
                cr = self.headers.get("Content-Range") or ""
                if s["done"] is not None:
                    f = s["done"]
                    self._send(200, {"id": f["id"], "name": f["name"], "size": str(len(f["data"]))})
                    return
                m = re.fullmatch(r"bytes \*/(\d+|\*)", cr)
                if m:   # 查進度
                    with fake.lock:
                        fake.status_queries += 1
                    self._range(s)
                    return
                m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", cr)
                if not m or int(m.group(2)) - int(m.group(1)) + 1 != len(body):
                    self._send(400, {"error": {"code": 400, "message": "Content-Range 不對"}})
                    return
                start, total = int(m.group(1)), int(m.group(3))
                with fake.lock:
                    # 從已收到的位置之前重送沒關係（蓋掉後面）；跳過沒收到的位置就是網頁算錯了
                    bad = start > len(s["data"])
                    if not bad:
                        s["data"][start:] = body[: len(body) // 2] if drop or short else body
                if bad:
                    self._send(400, {"error": {"code": 400, "message": "跳過了沒收到的位置"}})
                    return
                if drop:   # 收一半就斷線，不回應
                    with fake.lock:
                        fake.dropped += 1
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    return
                if fake.expire_after_bytes is not None and len(s["data"]) >= fake.expire_after_bytes:
                    fake.expire_after_bytes = None
                    fake.expire()
                if len(s["data"]) >= total:
                    with fake.lock:
                        f = fake._create(s["meta"], bytes(s["data"][:total]))
                        s["done"] = f
                    self._send(200, {"id": f["id"], "name": f["name"], "size": str(len(f["data"]))})
                    return
                self._range(s)

            def _range(self, s):
                if s["done"] is not None:
                    f = s["done"]
                    self._send(200, {"id": f["id"], "name": f["name"], "size": str(len(f["data"]))})
                    return
                n = len(s["data"])
                self._send(308, None, headers=[("Range", f"bytes=0-{n - 1}")] if n else [])

            def _ctl(self, name, raw):
                arg = json.loads(raw or b"null")
                if name == "expire":
                    fake.expire()
                elif name == "drop_puts":
                    fake.drop_puts = list(arg or [])
                elif name == "short_puts":
                    fake.short_puts = list(arg or [])
                elif name == "expire_after_bytes":
                    fake.expire_after_bytes = arg
                elif name == "fail":
                    fake.fail = list(arg or [])
                elif name == "deny":
                    fake.deny = bool(arg)
                elif name in ("rename", "move"):
                    with fake.lock:
                        f = fake.files.get((arg or {}).get("id", ""))
                        if f is not None:
                            if name == "rename":
                                f["name"] = str(arg["name"])
                            else:
                                f["parents"] = [str(arg["parent"])]
                    if f is None:
                        self._send(404, {"error": "沒有這個檔"})
                        return
                elif name == "redirect_uris":
                    fake.redirect_uris = list(arg or [])
                else:
                    self._send(404, {"error": "沒有這個控制"})
                    return
                self._send(200, {"ok": True})

        self.httpd = NoDnsServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
