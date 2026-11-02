import json
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
from fake_redmine import KEY, FakeRedmine  # noqa: E402

MINUTES = {
    "summary": "王小明的閱讀進度穩定，小明數學應用題還需要協助。",
    "actions": [
        {"item": "提供段考報讀需求", "owner": "導師", "due": "2026-10-28", "due_text": "下週三前", "status": "未開始"},
        {"item": "整理小明的數學錯題", "owner": "我", "due": "", "due_text": "", "status": "進行中"},
        {"item": "寄出家長通知", "owner": "", "due": "2026-10-20", "due_text": "", "status": "已完成"},
    ],
    "decisions": ["段考採報讀"],
    "questions": [],
    "sections": [{"title": "閱讀", "points": ["王小明每天讀 10 分鐘"]}],
}


def config(tmp, url, **extra):
    key = Path(tmp) / "api-key"
    key.write_text(KEY + "\n", encoding="ascii")
    cfg = Path(tmp) / "config.json"
    r = {"api_url": url, "public_url": "https://redmine.example", "key_file": str(key), "project": "student-meetings", "assignee": 1}
    r.update(extra)
    cfg.write_text(json.dumps({"redmine": r}), encoding="utf-8")
    return cfg


class MaskTest(unittest.TestCase):
    def test_mask_name(self):
        cases = {"王小明": "王○明", "歐陽小明": "歐○○明", "陳一": "陳○", "林": "林", "": "", " 王 小明 ": "王○明"}
        for name, want in cases.items():
            self.assertEqual(server.mask_name(name), want, name)

    def test_hider_replaces_full_and_given_name(self):
        hide = server.name_hider("王小明")
        self.assertEqual(hide("王小明和小明的哥哥"), "王○明和○明的哥哥")
        self.assertEqual(server.name_hider("歐陽小明")("歐陽小明、小明"), "歐○○明、小明")
        self.assertEqual(server.name_hider("")("王小明"), "王小明")


class IssuesTest(unittest.TestCase):
    def test_parent_and_children(self):
        m = server.clean_minutes(MINUTES, lambda t: t)
        parent, children = server.redmine_issues(m, "王小明", "個案會議", "2026-10-21")
        self.assertEqual(parent["subject"], "【王○明】個案會議 2026-10-21")
        self.assertNotIn("小明", parent["description"].replace("○明", ""))
        self.assertIn("## 決議\n\n- 段考採報讀", parent["description"])
        self.assertIn("不含逐字稿與錄音", parent["description"])
        # 待辦依期限排序：有期限的在前
        self.assertEqual([c["subject"] for c in children], [
            "【王○明】寄出家長通知", "【王○明】導師：提供段考報讀需求", "【王○明】我：整理○明的數學錯題"])
        done, teacher, mine = children
        self.assertEqual((done["status_id"], done["due_date"], done["start_date"]), (5, "2026-10-20", "2026-10-20"))
        self.assertEqual((teacher["status_id"], teacher["due_date"], teacher["start_date"]), (1, "2026-10-28", "2026-10-21"))
        self.assertIn("期限：2026-10-28（下週三前）", teacher["description"])
        self.assertEqual(mine["status_id"], 2)
        self.assertNotIn("due_date", mine)

    def test_without_student(self):
        m = server.clean_minutes(MINUTES, lambda t: t)
        parent, children = server.redmine_issues(m, "", "", "2026-10-21")
        self.assertEqual(parent["subject"], "會議 2026-10-21")
        self.assertEqual(children[1]["subject"], "導師：提供段考報讀需求")

    def test_subject_is_capped(self):
        self.assertEqual(len(server.redmine_subject("字" * 400)), 255)
        self.assertEqual(server.redmine_subject("a\nb"), "a b")


class LoadTest(unittest.TestCase):
    def test_load(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = server.load_redmine(config(d, "http://127.0.0.1:1"))
            self.assertEqual((cfg["key"], cfg["assignee"], cfg["project"]), (KEY, 1, "student-meetings"))
            self.assertIsNone(server.load_redmine(Path(d) / "none.json"))
            self.assertIsNone(server.load_redmine(config(d, "ftp://x")))
            self.assertIsNone(server.load_redmine(config(d, "http://x", key_file=str(Path(d) / "missing"))))
            self.assertIsNone(server.load_redmine(config(d, "http://x", public_url="x")))
            self.assertIsNone(server.load_redmine(config(d, "http://x", assignee=True))["assignee"])
            bad = Path(d) / "bad-key"
            bad.write_text("short", encoding="ascii")
            self.assertIsNone(server.load_redmine(config(d, "http://x", key_file=str(bad))))


class SendTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRedmine().start()
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = server.load_redmine(config(self.tmp.name, self.fake.url))
        self.m = server.clean_minutes(MINUTES, lambda t: t)

    def tearDown(self):
        self.fake.stop()
        self.tmp.cleanup()

    def send(self, parent=None, m=None):
        return server.send_to_redmine(self.cfg, m or self.m, "王小明", "個案會議", "2026-10-21", parent)

    def test_first_send_creates_parent_and_children(self):
        r = self.send()
        self.assertEqual((r["created"], r["total"], r["updated"]), (3, 3, False))
        self.assertEqual(r["url"], f"https://redmine.example/issues/{r['id']}")
        parent = self.fake.issues[r["id"]]
        self.assertEqual((parent["project_id"], parent["tracker_id"], parent["assigned_to_id"]), (8, 3, 1))
        kids = self.fake.children(r["id"])
        self.assertEqual(len(kids), 3)
        self.assertTrue(all(k["assigned_to_id"] == 1 and k["project_id"] == 8 for k in kids))
        self.assertEqual(sorted(k["status_id"] for k in kids), [1, 2, 5], "建好之後要改成會議紀錄裡的狀態")

    def test_resend_updates_parent_and_adds_only_new_actions(self):
        first = self.send()
        kid = self.fake.children(first["id"])[0]
        kid["status_id"] = 3   # 使用者在 Redmine 改過狀態
        more = json.loads(json.dumps(MINUTES))
        more["summary"] = "更新後的摘要"
        more["actions"].append({"item": "約家長面談", "owner": "我", "due": "", "due_text": "", "status": "未開始"})
        again = self.send(first["id"], server.clean_minutes(more, lambda t: t))
        self.assertEqual((again["id"], again["created"], again["updated"]), (first["id"], 1, True))
        self.assertIn("更新後的摘要", self.fake.issues[first["id"]]["description"])
        self.assertEqual(len(self.fake.children(first["id"])), 4)
        self.assertEqual(kid["status_id"], 3, "已經在 Redmine 的子任務不動")

    def test_missing_or_foreign_parent_starts_over(self):
        r = self.send(999)
        self.assertNotEqual(r["id"], 999)
        self.assertFalse(r["updated"])
        self.fake.issues[500] = {"id": 500, "project_id": 7, "subject": "別的專案"}
        r2 = self.send(500)
        self.assertNotEqual(r2["id"], 500)
        self.assertEqual(self.fake.issues[500]["subject"], "別的專案", "不改別的專案的任務")

    def test_failure_midway_keeps_parent_id(self):
        self.fake.fail_posts_after = 2   # 主任務＋第一個子任務成功，第二個子任務失敗
        with self.assertRaises(server.RedmineError) as cm:
            self.send()
        partial = cm.exception.partial
        self.assertEqual((cm.exception.args[0], partial["created"]), (500, 1))
        self.fake.fail_posts_after = None
        r = self.send(partial["id"])
        self.assertEqual((r["id"], r["created"]), (partial["id"], 2))
        self.assertEqual(len(self.fake.children(partial["id"])), 3)

    def test_wrong_key_is_an_error_code_only(self):
        self.cfg["key"] = "x" * 20
        with self.assertRaises(server.RedmineError) as cm:
            self.send()
        self.assertEqual(cm.exception.args, (401,))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRedmine().start()
        self.tmp = tempfile.TemporaryDirectory()
        self.start(config(self.tmp.name, self.fake.url))

    def start(self, cfg):
        handler = type("H", (server.Handler,), {"config_file": cfg, "api_key": None})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.fake.stop()
        self.tmp.cleanup()

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data else "GET")
        if data:
            req.add_header("Content-Type", "application/json")
            req.add_header("X-Meeting-Scribe", "1")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def body(self, **kw):
        return {"meeting": "a" * 32, "minutes": MINUTES, "student": "王小明", "title": "個案會議", "date": "2026-10-21", **kw}

    def test_ready_and_send(self):
        self.assertEqual(self.call("/api/redmine"), (200, {"ready": True}))
        status, r = self.call("/api/redmine/send", self.body())
        self.assertEqual((status, r["created"], r["total"]), (200, 3, 3))
        self.assertNotIn(KEY, json.dumps(r))
        self.assertEqual(self.fake.issues[r["id"]]["subject"], "【王○明】個案會議 2026-10-21")
        status, r2 = self.call("/api/redmine/send", self.body(parent=r["id"]))
        self.assertEqual((status, r2["id"], r2["created"], r2["updated"]), (200, r["id"], 0, True))

    def test_bad_input(self):
        for kw, err in [({"student": "x" * 21}, "學生姓名不合法"), ({"student": "王\n明"}, "學生姓名不合法"),
                        ({"parent": "12"}, "Redmine 任務編號不合法"), ({"parent": True}, "Redmine 任務編號不合法"),
                        ({"minutes": "x"}, "會議紀錄格式錯誤"), ({"minutes": {}}, "會議紀錄是空的"), ({"title": 3}, "會議名稱不合法")]:
            status, r = self.call("/api/redmine/send", self.body(**kw))
            self.assertEqual((status, r["error"]), (400, err), kw)
        self.assertEqual(self.fake.requests, [], "不合法的輸入不送 Redmine")

    def test_redmine_errors(self):
        self.fake.fail_posts_after = 1
        status, r = self.call("/api/redmine/send", self.body())
        self.assertEqual((status, r["error"], r["created"]), (502, "Redmine 回應 500", 0))
        self.assertIn(r["id"], self.fake.issues, "主任務已建好，回應帶編號讓頁面記住")
        self.fake.stop()
        status, r = self.call("/api/redmine/send", self.body())
        self.assertEqual((status, r), (502, {"error": "連不到 Redmine"}))
        self.fake = FakeRedmine().start()   # tearDown 要停一個活的

    def test_not_configured(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.start(Path(self.tmp.name) / "none.json")
        self.assertEqual(self.call("/api/redmine"), (200, {"ready": False}))
        self.assertEqual(self.call("/api/redmine/send", self.body()), (503, {"error": "這台沒有設定 Redmine"}))


if __name__ == "__main__":
    unittest.main()
