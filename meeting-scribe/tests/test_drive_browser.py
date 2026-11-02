"""存到 Google Drive 由瀏覽器直傳（#107）：drive_mode 設定、/api/save/bundle、暫存音檔下載、模式守門、CSP 與 OAuth 頁。
瀏覽器端的上傳（multipart、續傳、token 過期）在 e2e 用假的 Google 測（tests/fake_google.py、tests/e2e/run.mjs 的 drive-browser-*）。"""
import base64
import json
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
import fake_pack  # noqa: E402

CID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com"
D1 = "c" * 32
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect x="1" y="1" width="5" height="5" fill="#fff"/></svg>'


class DriveModeConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, data):
        self.cfg.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def test_mode_defaults_to_local(self):
        self.assertEqual(server.load_drive_mode(Path(self.tmp.name) / "missing.json"), "local")
        for data in ({}, "{not json", [1], {"drive_mode": "BROWSER"}, {"drive_mode": "client"}, {"drive_mode": None}):
            self.write(data)
            self.assertEqual(server.load_drive_mode(self.cfg), "local", data)
        self.write({"drive_mode": "browser"})
        self.assertEqual(server.load_drive_mode(self.cfg), "browser")

    def test_google_client_id_is_checked(self):
        self.write({"google_client_id": CID})
        self.assertEqual(server.load_google_drive(self.cfg), {"client_id": CID, "folder_name": server.DEFAULT_DRIVE_FOLDER})
        self.write({"google_client_id": "  " + CID + "\n"})
        self.assertEqual(server.load_google_drive(self.cfg)["client_id"], CID)
        for bad in ("", None, 123, "abc", CID + "&redirect_uri=https://evil.example", CID.replace(".apps.", ".evil."),
                    'x" onload="y.apps.googleusercontent.com', "GOCSPX-secret-looking-value"):
            self.write({"google_client_id": bad})
            self.assertIsNone(server.load_google_drive(self.cfg), bad)
        self.assertIsNone(server.load_google_drive(Path(self.tmp.name) / "missing.json"))

    def test_folder_name_is_cleaned(self):
        self.write({"google_client_id": CID, "drive_folder_name": "學校/會議:紀錄"})
        self.assertEqual(server.load_google_drive(self.cfg)["folder_name"], "學校 會議 紀錄")
        for blank in ("  ", "..", 5):
            self.write({"google_client_id": CID, "drive_folder_name": blank})
            self.assertEqual(server.load_google_drive(self.cfg)["folder_name"], server.DEFAULT_DRIVE_FOLDER)

    def test_meeting_folder_name(self):
        from datetime import datetime
        now = datetime(2026, 10, 24, 9, 5)
        self.assertEqual(server.meeting_folder_name("IEP / 期初", now), "2026-10-24 0905 IEP   期初")
        self.assertEqual(server.meeting_folder_name("x", now, stamp="2026-10-25 1530"), "2026-10-25 1530 x", "用網頁那台的當地時間")
        for bad in ("2026-10-25", "2026-10-25 15:30", "../x", 1, None, "2026-10-25 1530\n"):
            self.assertEqual(server.meeting_folder_name("x", now, stamp=bad), "2026-10-24 0905 x", bad)
        self.assertEqual(server.meeting_folder_name(["x"], now), "2026-10-24 0905 會議")

    def test_folder_parts(self):
        self.assertEqual(server.folder_parts("會議紀錄/ 2026 上學期 /./"), ["會議紀錄", "2026 上學期"])
        self.assertEqual(server.folder_parts(""), [])
        self.assertEqual(server.folder_parts(None), [])
        for bad in ("../x", "a/../b", "/abs", "a/\x00b", ["a"], 3):
            with self.assertRaises(ValueError, msg=bad):
                server.folder_parts(bad)


class DriveBrowserHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.root = base / "drive"
        cls.root.mkdir()
        cls.pack = fake_pack.make_pack(base / "pack")
        cls.cfg = base / "config.json"
        cls.handler = type("H", (server.Handler,), {"config_file": cls.cfg, "api_key": None,
                                                    "drafts": server.DraftStore(base / "drafts")})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        self.set_mode("browser")

    def set_mode(self, mode, **extra):
        data = {"drive_roots": {"school": {"label": "學校 Drive", "path": str(self.root)}}, "packs": [str(self.pack)],
                "google_client_id": CID, **extra}
        if mode:
            data["drive_mode"] = mode
        self.cfg.write_text(json.dumps(data), encoding="utf-8")

    def call(self, path, body=None, ctype="application/json", raw=False):
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET")
        if data is not None:
            req.add_header("Content-Type", ctype)
            req.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(req) as r:
                got = r.read()
                return r.status, (got, dict(r.headers)) if raw else json.loads(got)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def meeting(self, **kw):
        body = {"root": "school", "folder": "會議紀錄/期初", "title": "IEP", "transcript": "大家好\n開始開會", "summary": "# 會後總結",
                "minutes": "# 會議紀錄", "mindmap": "# 心智圖", "mindmap_svg": SVG,
                "mindmap_opml": '<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body><outline text="a"/></body></opml>',
                "form": {"template": "test-exit", "values": {"items": {"exit_keep": {"on": True}}}},
                "extras": [{"label": "讓這場會議發芽", "markdown": "# 讓這場會議發芽\n\n延伸"}]}   # 延伸一項一個檔（#157）
        body.update(kw)
        return body

    def test_roots_report_browser_mode_without_paths(self):
        status, body = self.call("/api/drive/roots")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"roots": [], "mode": "browser", "google": {"client_id": CID, "folder_name": server.DEFAULT_DRIVE_FOLDER}})
        self.assertNotIn(str(self.root), json.dumps(body))
        self.cfg.write_text(json.dumps({"drive_mode": "browser", "google_client_id": "nope"}), encoding="utf-8")
        self.assertEqual(self.call("/api/drive/roots")[1]["google"], None, "client ID 格式不對：網頁顯示還沒設定")

    def test_local_mode_response_is_unchanged(self):
        for mode in (None, "local"):
            self.set_mode(mode)
            self.assertEqual(self.call("/api/drive/roots"), (200, {"roots": [{"id": "school", "label": "學校 Drive"}]}))

    def test_bundle_has_the_same_files_as_a_local_save(self):
        self.set_mode("local")
        status, saved = self.call("/api/save/transcript", self.meeting())
        self.assertEqual(status, 200, saved)
        on_disk = {p.name: p.read_bytes() for p in (self.root / saved["meeting"]).iterdir()}
        self.set_mode("browser")
        status, b = self.call("/api/save/bundle", self.meeting(stamp="2026-10-24 1530"))
        self.assertEqual(status, 200, b)
        self.assertEqual(b["folder"], ["會議紀錄", "期初"])
        self.assertEqual(b["name"], "2026-10-24 1530 IEP")
        self.assertEqual([f["name"] for f in b["files"]], saved["files"], "跟寫進主機資料夾時同一組檔、同樣順序")
        types = {f["name"]: f["type"] for f in b["files"]}
        self.assertEqual(types["transcript.txt"], "text/plain")
        self.assertEqual(types["summary.md"], "text/markdown")
        self.assertEqual(types["mindmap.svg"], "image/svg+xml")
        self.assertEqual(types["mindmap.opml"], "text/x-opml")
        self.assertEqual(types["讓這場會議發芽.md"], "text/markdown", "延伸也在同一組檔裡")
        for f in b["files"]:
            data = base64.b64decode(f["base64"]) if "base64" in f else f["text"].encode("utf-8")
            if f["name"].endswith(".docx"):
                self.assertEqual(f["type"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                self.assertTrue(data.startswith(b"PK"), "表單是 Word 檔")
                continue
            self.assertEqual(data, on_disk[f["name"]], f["name"])

    def test_bundle_cleans_svg_and_rejects_bad_input(self):
        status, err = self.call("/api/save/bundle", self.meeting(mindmap_svg=SVG.replace("<rect", '<script>alert(1)</script><rect')))
        self.assertEqual((status, err["error"]), (400, "心智圖格式錯誤"), "存到 Drive 的 SVG 一樣照白名單檢查")
        for bad, msg in (({"transcript": " "}, "逐字稿是空的"), ({"folder": "../x"}, "資料夾路徑不合法"), ({"folder": "/x"}, None),
                         ({"form": {"template": "nope"}}, "沒有這種表單"), ({"summary": ["x"]}, "總結格式錯誤")):
            status, err = self.call("/api/save/bundle", self.meeting(**bad))
            self.assertEqual(status, 400, bad)
            if msg:
                self.assertEqual(err["error"], msg)
        self.assertEqual(self.call("/api/save/bundle", b"[1, 2]")[0], 400)
        status, b = self.call("/api/save/bundle", {"transcript": "t", "title": {"x": 1}, "stamp": "bad"})
        self.assertEqual(status, 200, b)
        self.assertRegex(b["name"], r"^\d{4}-\d{2}-\d{2} \d{4} 會議$")
        self.assertEqual((b["folder"], [f["name"] for f in b["files"]]), ([], ["transcript.txt"]))

    def test_browser_mode_never_writes_host_folders(self):
        before = sorted(p.name for p in self.root.rglob("*"))
        for path, body in (("/api/save/transcript", self.meeting()), ("/api/save/draft-audio", {"root": "school", "meeting": "x", "draft": D1})):
            status, err = self.call(path, body)
            self.assertEqual(status, 403, path)
            self.assertIn("browser", err["error"])
        qs = urllib.parse.urlencode({"root": "school", "meeting": "x", "ext": "webm"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"abc", "audio/webm")[0], 403)
        self.assertEqual(self.call("/api/save/bundle", self.meeting())[0], 200)
        self.assertEqual(sorted(p.name for p in self.root.rglob("*")), before)

    def test_local_mode_refuses_browser_endpoints(self):
        self.set_mode("local")
        self.assertEqual(self.call("/api/save/bundle", self.meeting())[0], 403)
        self.assertEqual(self.call(f"/api/drafts/audio-list?draft={D1}")[0], 403)
        self.assertEqual(self.call(f"/api/drafts/audio-file?draft={D1}&part=1")[0], 403)

    def test_draft_audio_list_and_file(self):
        drafts = self.handler.drafts
        drafts.put_meta(D1, {"title": "t", "state": "done"})
        drafts.add_audio(D1, 1, "webm", 0, b"first-part")
        drafts.add_audio(D1, 2, "m4a", 0, b"second")
        self.addCleanup(drafts.delete, D1)
        status, body = self.call(f"/api/drafts/audio-list?draft={D1}")
        self.assertEqual(status, 200)
        self.assertEqual(body["parts"], [
            {"part": 1, "name": "audio.webm", "bytes": 10, "type": "audio/webm"},
            {"part": 2, "name": "audio-2.m4a", "bytes": 6, "type": "audio/mp4"},
        ], "檔名跟寫進主機資料夾時一樣")
        self.assertNotIn(str(Path(self.tmp.name)), json.dumps(body), "不回主機上的路徑")
        status, (data, headers) = self.call(f"/api/drafts/audio-file?draft={D1}&part=2", raw=True)
        self.assertEqual((status, data, headers["Content-Type"], headers["Cache-Control"]), (200, b"second", "audio/mp4", "no-store"))
        self.assertEqual(self.call(f"/api/drafts/audio-file?draft={D1}&part=3")[0], 404)
        self.assertEqual(self.call("/api/drafts/audio-file?draft=../x&part=1")[0], 400)
        self.assertEqual(self.call(f"/api/drafts/audio-list?draft={'d' * 32}"), (200, {"parts": []}))

    def test_oauth_page_is_served(self):
        status, (data, headers) = self.call("/oauth/", raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(data, (server.WEB / "oauth" / "index.html").read_bytes())


class DrivePageTest(unittest.TestCase):
    page = (server.WEB / "index.html").read_text(encoding="utf-8")
    oauth = (server.WEB / "oauth" / "index.html").read_text(encoding="utf-8")

    @staticmethod
    def csp_of(html):
        m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', html)
        return {d.split()[0]: d.split()[1:] for d in m.group(1).split(";") if d.strip()}

    def test_csp_only_adds_the_drive_api(self):
        conn = self.csp_of(self.page)["connect-src"]
        google = [c for c in conn if "google" in c]
        self.assertEqual(google, ["https://www.googleapis.com"], "只放 Drive API；授權是彈出視窗的跳轉，不經 fetch")
        self.assertEqual(self.csp_of(self.page)["form-action"], ["'self'"])

    def test_google_endpoints_and_scope_are_fixed(self):
        for line in ('auth: "https://accounts.google.com/o/oauth2/v2/auth"', 'files: "https://www.googleapis.com/drive/v3/files"',
                     'upload: "https://www.googleapis.com/upload/drive/v3/files"', 'scope: "https://www.googleapis.com/auth/drive.file"'):
            self.assertIn(line, self.page)
        self.assertEqual(re.findall(r"https://www\.googleapis\.com/auth/[a-z.]+", self.page), ["https://www.googleapis.com/auth/drive.file"])
        self.assertIn('response_type: "token"', self.page)
        self.assertIn('redirect_uri: location.origin + "/oauth/"', self.page)
        self.assertIn("d.state !== state", self.page, "只收自己發出的那一次授權")
        self.assertNotRegex(self.page, r'<script[^>]+src="https?://', "不載入外部 script（包含 Google 的 JS 套件）")
        self.assertNotIn("client_secret", self.page)

    def test_token_stays_out_of_local_storage_and_host(self):
        self.assertIn('sessionStorage.setItem("ms.gtoken"', self.page)
        self.assertNotRegex(self.page, r"localStorage\.setItem\([^)]*(gtoken|token)", "Google token 不放 localStorage")
        script = self.page.split("<script>", 1)[1]
        # 帶 token 的請求只有 gfetch：它只打寫死的 Google 網址或 Google 給的續傳網址，不經過 api()
        self.assertEqual(script.count("Authorization: `Bearer ${gToken.token}`"), 1)
        self.assertNotRegex(script, r"api\([^)]*\)[^;]*gToken")

    def test_oauth_page_is_self_contained(self):
        csp = self.csp_of(self.oauth)
        self.assertEqual(csp["default-src"], ["'none'"])
        self.assertNotIn("connect-src", csp)
        self.assertNotRegex(self.oauth, r"https?://", "授權頁不連任何網址")
        self.assertIn('history.replaceState(null, "", location.pathname)', self.oauth, "token 不留在網址列")
        self.assertIn('postMessage({ msGoogleAuth: msg }, location.origin)', self.oauth, "只送給同一個網站")
        self.assertIn('<meta name="referrer" content="no-referrer">', self.oauth)


if __name__ == "__main__":
    unittest.main()
