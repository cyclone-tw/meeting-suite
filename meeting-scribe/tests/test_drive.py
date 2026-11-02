import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class ResolveFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "drive"
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_nested_relative_folder(self):
        self.assertEqual(server.resolve_folder(self.root, "會議紀錄/2026 上學期"), self.root / "會議紀錄" / "2026 上學期")

    def test_empty_folder_is_root(self):
        self.assertEqual(server.resolve_folder(self.root, ""), self.root)

    def test_rejects_parent_and_absolute(self):
        for bad in ("../x", "a/../../x", "/etc", "a/\x00b"):
            with self.assertRaises(ValueError, msg=bad):
                server.resolve_folder(self.root, bad)

    def test_rejects_symlink_escape(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (self.root / "link").symlink_to(outside)
        with self.assertRaises(ValueError):
            server.resolve_folder(self.root, "link/x")

    def test_create_meeting_dir_names_and_dedupes(self):
        now = datetime(2026, 10, 19, 9, 30)
        a = server.create_meeting_dir(self.root, "會議紀錄", "IEP / 期初", now=now)
        b = server.create_meeting_dir(self.root, "會議紀錄", "IEP / 期初", now=now)
        self.assertEqual(a.name, "2026-10-19 0930 IEP   期初")
        self.assertEqual(b.name, "2026-10-19 0930 IEP   期初 (2)")
        self.assertTrue(a.is_dir() and b.is_dir())

    def test_blank_title_falls_back(self):
        d = server.create_meeting_dir(self.root, "", "  ..  ", now=datetime(2026, 1, 2, 3, 4))
        self.assertEqual(d.name, "2026-01-02 0304 會議")


class LoadRootsTest(unittest.TestCase):
    def test_keeps_only_existing_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "config.json"
            cfg.write_text(json.dumps({"drive_roots": {
                "school": {"label": "學校 Drive", "path": d},
                "gone": {"label": "x", "path": str(Path(d) / "missing")},
                "bad": "not-a-dict",
            }}), encoding="utf-8")
            roots = server.load_drive_roots(cfg)
            self.assertEqual(list(roots), ["school"])
            self.assertEqual(roots["school"]["label"], "學校 Drive")

    def test_missing_or_broken_config(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(server.load_drive_roots(Path(d) / "none.json"), {})
            bad = Path(d) / "bad.json"
            bad.write_text("{", encoding="utf-8")
            self.assertEqual(server.load_drive_roots(bad), {})


class SaveHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "drive"
        self.root.mkdir()
        cfg = Path(self.tmp.name) / "config.json"
        cfg.write_text(json.dumps({"drive_roots": {"school": {"label": "學校 Drive", "path": str(self.root)}}}), encoding="utf-8")
        handler = type("H", (server.Handler,), {"config_file": cfg, "api_key": None})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, path, body=None, ctype="application/json", csrf=True):
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data is not None else "GET")
        if data is not None:
            req.add_header("Content-Type", ctype)
            if csrf:
                req.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_roots_lists_labels_not_paths(self):
        status, body = self.call("/api/drive/roots")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"roots": [{"id": "school", "label": "學校 Drive"}]})
        self.assertNotIn(str(self.root), json.dumps(body))

    def test_transcript_then_audio(self):
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "會議紀錄", "title": "測試", "transcript": "大家好"})
        self.assertEqual(status, 200, body)
        meeting = self.root / body["meeting"]
        self.assertEqual((meeting / "transcript.txt").read_text(encoding="utf-8"), "大家好")
        self.assertTrue(body["display"].startswith("學校 Drive/會議紀錄/"))
        qs = urllib.parse.urlencode({"root": "school", "meeting": body["meeting"], "ext": "m4a"})
        status, body2 = self.call(f"/api/save/audio?{qs}", b"\x00\x01audio-bytes", "audio/mp4")
        self.assertEqual((status, body2), (200, {"audio": "audio.m4a", "bytes": 13}))
        self.assertEqual((meeting / "audio.m4a").read_bytes(), b"\x00\x01audio-bytes")
        self.assertFalse((meeting / "audio.m4a.part").exists())

    def test_transcript_with_summary_md(self):
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "s", "transcript": "t", "summary": "# 會後總結"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["files"], ["transcript.txt", "summary.md"])
        self.assertEqual((self.root / body["meeting"] / "summary.md").read_text(encoding="utf-8"), "# 會後總結")
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "n", "transcript": "t", "summary": "  "})
        self.assertEqual(body["files"], ["transcript.txt"], "空白總結不寫檔")
        self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "summary": ["x"]})[0], 400)
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "m", "transcript": "t", "summary": "# 會後總結", "minutes": "# 會議紀錄"})
        self.assertEqual(body["files"], ["transcript.txt", "summary.md", "minutes.md"])
        self.assertEqual((self.root / body["meeting"] / "minutes.md").read_text(encoding="utf-8"), "# 會議紀錄")
        status, err = self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "minutes": {"x": 1}})
        self.assertEqual((status, err["error"]), (400, "會議紀錄格式錯誤"))
        ns = 'xmlns="http://www.w3.org/2000/svg"'
        # 標籤文字裡就算有 href=、onload=、javascript: 也只是文字，照存（第一版的黑名單會誤擋）
        svg = f'<svg {ns} width="10" height="10"><g fill="none"><path d="M0,0 C1,1 2,2 3,3" stroke="#000"/></g><text x="1" y="2" font-size="14">IEP href=x onload=y javascript:z &amp; 學障</text></svg>'
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "map", "transcript": "t", "mindmap": "```mermaid\nmindmap\n```", "mindmap_svg": svg})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["files"], ["transcript.txt", "mindmap.md", "mindmap.svg"])
        saved = (self.root / body["meeting"] / "mindmap.svg").read_text(encoding="utf-8")
        self.assertIn("IEP href=x onload=y javascript:z &amp; 學障", saved)
        self.assertTrue(saved.startswith("<svg") and "<path" in saved)
        # 主題本來就有 script 這個字（例如 JavaScript 教學）：屬性值不能因此被擋（第二版 review P1）
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "js", "transcript": "t",
                                                          "mindmap_svg": f'<svg {ns} aria-label="心智圖：JavaScript 與 CSS url() 入門"><text>Python script</text></svg>'})
        self.assertEqual(status, 200, body)
        self.assertIn('aria-label="心智圖：JavaScript 與 CSS url() 入門"', (self.root / body["meeting"] / "mindmap.svg").read_text(encoding="utf-8"))
        deep = f'<svg {ns}>' + "<g>" * 50 + "</g>" * 50 + "</svg>"
        bad_cases = [deep,
            f'<svg {ns}><script>alert(1)</script></svg>',
            f'<svg {ns} xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',   # 命名空間前綴
            f'<svg {ns} onload="x()"></svg>',
            f'<svg {ns}><a href="javascript:x"><text>x</text></a></svg>',
            f'<svg {ns}><animate attributeName="href" values="&#106;avascript:x"/></svg>',   # 實體編碼
            f'<svg {ns}><style>@import url(https://evil/x.css)</style></svg>',
            f'<svg {ns}><rect fill="url(https://evil/x#g)"/></svg>',
            f'<svg {ns}><foreignObject/></svg>',
            f'<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg {ns}><text>&a;</text></svg>',
            '<svg><text>沒有命名空間</text></svg>',
            'not svg',
        ]
        for bad in bad_cases:
            self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "mindmap_svg": bad})[0], 400, bad)
        # 處理指令與註解不會留下（存的是重組後的內容）
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "pi", "transcript": "t",
                                                          "mindmap_svg": f'<?xml-stylesheet href="https://evil/x.css"?><svg {ns}><!-- c --><text>a</text></svg>'})
        self.assertEqual(status, 200)
        saved = (self.root / body["meeting"] / "mindmap.svg").read_text(encoding="utf-8")
        self.assertNotIn("xml-stylesheet", saved)
        self.assertNotIn("<!--", saved)

    def test_save_extras_one_file_each(self):
        # 延伸一項一個檔（#157）：檔名和工作室同規則；撞到別的檔或彼此撞名就加 -2；空的不存；格式不對整個擋下
        extras = [{"label": "視角回饋（家長）", "markdown": "# 視角回饋（家長）\n\n家長"},
                  {"label": "a/b:c*..", "markdown": "怪名字"}, {"label": "summary", "markdown": "撞名"},
                  {"label": "視角回饋（家長）", "markdown": "第二份"}, {"label": "空的", "markdown": "  "}, {"label": "..", "markdown": "沒名字"}]
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "ext", "transcript": "t", "summary": "總結", "extras": extras})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["files"], ["transcript.txt", "summary.md", "視角回饋（家長）.md", "a_b_c_...md", "summary-2.md", "視角回饋（家長）-2.md", "延伸.md"])
        d = self.root / body["meeting"]
        self.assertEqual((d / "視角回饋（家長）.md").read_text(encoding="utf-8"), "# 視角回饋（家長）\n\n家長")
        self.assertEqual((d / "summary-2.md").read_text(encoding="utf-8"), "撞名")
        for bad in ("x", [{"label": 1, "markdown": "x"}], [{"label": "x"}], ["x"], [{"label": "x", "markdown": "y"}] * (server.EXTRA_FILES_MAX + 1)):
            self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "extras": bad})[0], 400, bad)

    def test_save_mindmap_opml(self):
        # 心智圖 App 用的 .opml：照白名單重組；標籤裡的 & < " 正確轉義（#3）
        opml = ('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>IEP 會議</title></head>'
                '<body><outline text="IEP 會議"><outline text="閱讀 &amp; &lt;評量&gt; &quot;調整&quot;"><outline text="細節"/></outline></outline></body></opml>')
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "opml", "transcript": "t", "mindmap_opml": opml})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["files"], ["transcript.txt", "mindmap.opml"])
        saved = (self.root / body["meeting"] / "mindmap.opml").read_text(encoding="utf-8")
        self.assertTrue(saved.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">'))
        root = server.ET.fromstring(saved)
        self.assertEqual(root.find("head/title").text, "IEP 會議")
        self.assertEqual([o.get("text") for o in root.iter("outline")], ["IEP 會議", '閱讀 & <評量> "調整"', "細節"])
        # 處理指令、註解、多餘屬性不會留下
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "pi", "transcript": "t",
                                                          "mindmap_opml": '<?xml-stylesheet href="x"?><opml version="1.0"><head><!-- c --></head><body><outline text="a"/></body></opml>'})
        self.assertEqual(status, 200, body)
        saved = (self.root / body["meeting"] / "mindmap.opml").read_text(encoding="utf-8")
        self.assertNotIn("xml-stylesheet", saved)
        self.assertNotIn("<!--", saved)
        self.assertIn('version="2.0"', saved)
        deep = "<opml><head/><body>" + '<outline text="x">' * 10 + "</outline>" * 10 + "</body></opml>"
        bad_cases = [deep,
            '<!DOCTYPE opml [<!ENTITY a "aaaa">]><opml><head/><body><outline text="&a;"/></body></opml>',
            '<opml><head/><body><outline text="a" url="https://evil/x"/></body></opml>',
            '<opml><head/><body><outline text="a"><script>x</script></outline></body></opml>',
            '<opml><head><title>a</title><ownerEmail>x</ownerEmail></head><body/></opml>',
            '<opml><body/></opml>',
            '<svg/>',
            'not opml',
        ]
        for bad in bad_cases:
            self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "mindmap_opml": bad})[0], 400, bad)
        self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "t", "mindmap_opml": 1})[0], 400)

    def test_summary_write_failure_cleans_both_files(self):
        from unittest import mock
        real_write = Path.write_text

        def fail_summary(path, data, *a, **k):
            if path.name == "summary.md":
                raise OSError(28, "No space left on device")
            return real_write(path, data, *a, **k)

        with mock.patch.object(Path, "write_text", fail_summary):
            status, _ = self.call("/api/save/transcript", {"root": "school", "folder": "f", "title": "x", "transcript": "t", "summary": "s"})
        self.assertEqual(status, 500)
        self.assertEqual(list((self.root / "f").iterdir()), [])

    def test_minutes_write_failure_cleans_all_files(self):
        from unittest import mock
        real_write = Path.write_text

        def fail_minutes(path, data, *a, **k):
            if path.name == "minutes.md":
                raise OSError(28, "No space left on device")
            return real_write(path, data, *a, **k)

        with mock.patch.object(Path, "write_text", fail_minutes):
            status, _ = self.call("/api/save/transcript", {"root": "school", "folder": "g", "title": "x", "transcript": "t", "summary": "s", "minutes": "m"})
        self.assertEqual(status, 500)
        self.assertEqual(list((self.root / "g").iterdir()), [], "寫到一半失敗，逐字稿和總結也要清掉")

    def test_rejects_escape_unknown_root_and_empty(self):
        self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "../x", "transcript": "a"})[0], 400)
        self.assertEqual(self.call("/api/save/transcript", {"root": "nope", "folder": "", "transcript": "a"})[0], 400)
        self.assertEqual(self.call("/api/save/transcript", {"root": "school", "folder": "", "transcript": "  "})[0], 400)
        self.assertFalse((Path(self.tmp.name) / "x").exists())

    def test_audio_needs_existing_meeting_and_known_ext(self):
        qs = urllib.parse.urlencode({"root": "school", "meeting": "", "ext": "m4a"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"x", "audio/mp4")[0], 400)
        qs = urllib.parse.urlencode({"root": "school", "meeting": "nope", "ext": "m4a"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"x", "audio/mp4")[0], 400)
        (self.root / "m").mkdir()
        # 沒有 transcript.txt 的資料夾（不是本服務建立的）不能寫音檔
        qs = urllib.parse.urlencode({"root": "school", "meeting": "m", "ext": "m4a"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"x", "audio/mp4")[0], 400)
        (self.root / "m" / "transcript.txt").write_text("t", encoding="utf-8")
        qs = urllib.parse.urlencode({"root": "school", "meeting": "m", "ext": "exe"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"x", "audio/mp4")[0], 400)
        qs = urllib.parse.urlencode({"root": "school", "meeting": "../m", "ext": "m4a"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"x", "audio/mp4")[0], 400)

    def test_audio_never_overwrites(self):
        status, body = self.call("/api/save/transcript", {"root": "school", "folder": "", "title": "a", "transcript": "t"})
        qs = urllib.parse.urlencode({"root": "school", "meeting": body["meeting"], "ext": "webm"})
        self.assertEqual(self.call(f"/api/save/audio?{qs}", b"first", "audio/webm")[0], 200)
        qs2 = urllib.parse.urlencode({"root": "school", "meeting": body["meeting"], "ext": "m4a"})
        self.assertEqual(self.call(f"/api/save/audio?{qs2}", b"second", "audio/mp4")[0], 409)
        self.assertEqual((self.root / body["meeting"] / "audio.webm").read_bytes(), b"first")

    def test_requires_csrf_header_and_object_json(self):
        self.assertEqual(self.call("/api/save/transcript", {"root": "school", "transcript": "a"}, csrf=False)[0], 403)
        self.assertEqual(self.call("/api/save/transcript", ["not", "object"])[0], 400)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_write_failure_removes_empty_dir_and_returns_json(self):
        from unittest import mock
        with mock.patch.object(Path, "write_text", side_effect=PermissionError(13, "denied")):
            status, body = self.call("/api/save/transcript", {"root": "school", "folder": "f", "title": "x", "transcript": "t"})
        self.assertEqual(status, 500)
        self.assertIn("PermissionError", body["error"])
        self.assertEqual(list((self.root / "f").iterdir()), [])

    def test_partial_write_is_cleaned_up(self):
        from unittest import mock
        real_write = Path.write_text

        def half_write(path, data, *a, **k):
            real_write(path, data[:1], *a, **k)
            raise OSError(28, "No space left on device")

        with mock.patch.object(Path, "write_text", half_write):
            status, _ = self.call("/api/save/transcript", {"root": "school", "folder": "f", "title": "x", "transcript": "完整內容"})
        self.assertEqual(status, 500)
        self.assertEqual(list((self.root / "f").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
