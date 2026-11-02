"""會議議程（#97）：擴充包的議程設定、讀學生資料（唯讀）、規則層、AI 個別化、API。用 tests/fake_pack.py 的假擴充包與假學生資料。"""
import copy
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_pack  # noqa: E402

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_claude.py")]
MID = "0123456789abcdef0123456789abcdef"
_TMP = tempfile.TemporaryDirectory()
PACK_DIR = fake_pack.make_pack(Path(_TMP.name) / "pack")
STUDENTS = fake_pack.make_students(Path(_TMP.name) / "students")
AGENDAS = {a["id"]: a for a in server.load_pack(PACK_DIR)["agendas"]}


def tearDownModule():
    _TMP.cleanup()


class PackAgendaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.n = 0

    def bad(self, mutate, msg):
        pack = copy.deepcopy(fake_pack.PACK)
        mutate(pack["agendas"][0], pack)
        self.n += 1
        d = fake_pack.make_pack(Path(self.tmp.name) / f"p{self.n}", pack)
        with self.assertRaisesRegex(ValueError, msg):
            server.load_pack(d)

    def test_loaded(self):
        a = AGENDAS["test-agenda"]
        self.assertEqual((a["title"], a["form"]), ("測試擬訂議程", "test-plan"))
        self.assertEqual([it["id"] for it in a["items"]], ["student", "parent", "behavior", "transition", "emotion"])
        self.assertEqual(a["student_files"], [{"glob": "profile.md", "latest": None}, {"glob": "reports/*-minutes.md", "latest": 1}])
        self.assertIsNone(AGENDAS["test-free"]["prompt"])

    def test_shared_items_can_be_spliced(self):
        pack = copy.deepcopy(fake_pack.PACK)
        pack["shared"]["common"] = [{"id": "c1", "title": "共用一"}, {"id": "c2", "title": "共用二"}]
        pack["agendas"][1]["items"] = ["@common", {"id": "own", "title": "自己的"}]
        a = {x["id"]: x for x in server.load_pack(fake_pack.make_pack(Path(self.tmp.name) / "s", pack))["agendas"]}["test-free"]
        self.assertEqual([it["id"] for it in a["items"]], ["c1", "c2", "own"])

    def test_rejects_bad_agendas(self):
        self.bad(lambda a, p: a.update(id="../x"), "議程 id 不合法")
        self.bad(lambda a, p: a.update(form="nope"), "form 不存在")
        self.bad(lambda a, p: a["items"].append({"id": "x", "title": "x", "when": [{"eval": "1"}]}), "不認得的條件")
        self.bad(lambda a, p: a["items"].append({"id": "x", "title": "x", "when": [{"grade_in": ["六"]}]}), "格式錯誤")
        self.bad(lambda a, p: a["items"].append({"id": "x", "title": "x", "when": [{"text_has": []}]}), "格式錯誤")
        self.bad(lambda a, p: a["items"].append({"id": "x", "title": "x", "form_item": "nope"}), "form_item 不在表單裡")
        self.bad(lambda a, p: a["items"].append({"id": "student", "title": "重複"}), "重複")
        self.bad(lambda a, p: a.update(student_files=["../other/profile.md"]), "student_files 不合法")
        self.bad(lambda a, p: a.update(student_files=["/etc/passwd"]), "student_files 不合法")
        self.bad(lambda a, p: a.update(student_files=["**/*.md"]), "student_files 不合法")
        self.bad(lambda a, p: a.update(student_files=[{"glob": "x.md", "latest": 0}]), "latest")
        self.bad(lambda a, p: a.update(prompt="../../x.md"), "找不到擴充包裡的檔案")
        self.bad(lambda a, p: p["agendas"].append(copy.deepcopy(a)), "議程 id 重複")


class StudentFilesTest(unittest.TestCase):
    def test_list_skips_underscore(self):
        self.assertEqual(server.list_students(STUDENTS), [{"code": "s-001", "label": "s-001"}, {"code": "s-002", "label": "s-002"}])

    def test_label_from_first_heading(self):
        self.assertEqual(server.list_students(STUDENTS, "README.md"),
                         [{"code": "s-001", "label": "王〇安（s-001）"}, {"code": "s-002", "label": "s-002"}],
                         "第一個 # 標題當名字；沒有這個檔就用代碼")

    def test_label_file_out_of_folder_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "students"
            (root / "s-x").mkdir(parents=True)
            (Path(d) / "secret.md").write_text("# 外面的名字\n", encoding="utf-8")
            (root / "s-x" / "README.md").symlink_to(Path(d) / "secret.md")
            self.assertEqual(server.list_students(root, "README.md"), [{"code": "s-x", "label": "s-x"}])

    def test_label_config(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "config.json"
            for bad in ("/etc/passwd", "../x.md", "~/x.md", "*.md", "a\\b.md", "", 3, None):
                with self.subTest(bad):
                    cfg.write_text(json.dumps({"students_label": bad}), encoding="utf-8")
                    self.assertIsNone(server.load_students_label(cfg))
            cfg.write_text(json.dumps({"students_label": "README.md"}), encoding="utf-8")
            self.assertEqual(server.load_students_label(cfg), "README.md")

    def test_reads_latest_and_skips_symlink_out(self):
        files = server.read_student_files(STUDENTS, "s-001", AGENDAS["test-agenda"]["student_files"])
        self.assertEqual([n for n, _ in files], ["profile.md", "reports/2026-06-25-minutes.md"],
                         "只取最新一份會議紀錄；指到外面的符號連結略過，不會因此讀不到最新的")
        self.assertNotIn("外面的秘密", json.dumps(files, ensure_ascii=False))

    def test_codes_and_missing(self):
        for bad in ("../s-001", "_inbox", ".git", "s 1", "", None, 1):
            with self.subTest(bad), self.assertRaises(ValueError):
                server.read_student_files(STUDENTS, bad, [])
        with self.assertRaises(LookupError):
            server.read_student_files(STUDENTS, "s-999", [])

    def test_symlinked_student_folder_out_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "students"
            root.mkdir()
            (root / "s-x").symlink_to(STUDENTS / "s-001")
            with self.assertRaises(LookupError):
                server.read_student_files(root, "s-x", [{"glob": "profile.md", "latest": None}])

    def test_size_limits(self):
        with mock.patch.object(server, "STUDENT_FILE_MAX", 5), mock.patch.object(server, "STUDENT_TOTAL_MAX", 8):
            files = server.read_student_files(STUDENTS, "s-001", AGENDAS["test-agenda"]["student_files"])
        self.assertEqual([len(t) for _, t in files], [5, 3])


class RulesTest(unittest.TestCase):
    def ids(self, grade, text):
        return [(it["id"], it["required"], it["uncertain"]) for it in server.agenda_rules(AGENDAS["test-agenda"], grade, text)]

    def test_grade_and_text_conditions(self):
        self.assertEqual(self.ids(6, "有情緒障礙"), [("student", True, False), ("parent", True, False), ("behavior", True, False),
                                                 ("transition", True, False), ("emotion", False, False)])
        self.assertEqual(self.ids(3, "沒有"), [("student", True, False), ("parent", True, False), ("behavior", True, False)])

    def test_unknown_conditions_are_kept_but_not_required(self):
        self.assertEqual(self.ids(0, ""), [("student", True, False), ("parent", True, False), ("behavior", True, False),
                                           ("transition", False, True), ("emotion", False, True)])

    def test_clean_ai(self):
        facts, details, extra = server.clean_agenda_ai({
            "facts": {"grade": True, "class": "甲\x07"},
            "items": {"student": " 提問 ", "nope": "x", "parent": 3},
            "extra": [{"title": "一"}, {"title": ""}, "壞的"] + [{"title": f"多{i}"} for i in range(10)]}, AGENDAS["test-agenda"])
        self.assertEqual(facts, {"grade": 0, "class": "甲"}, "布林不是年級；控制字元拿掉")
        self.assertEqual(details, {"student": "提問"})
        self.assertEqual(len(extra), 8)
        self.assertEqual(extra[0], {"title": "一", "detail": ""})


def wait_events(session, pred, timeout=20):
    seq, got = 0, []
    deadline = time.time() + timeout
    while time.time() < deadline:
        events, closed = session.wait(seq, 0.5)
        for n, e in events:
            got.append(e)
            seq = n
        if pred(got) or closed:
            return got
    raise AssertionError(f"沒等到預期事件：{got}")


class LiveAgendaTest(unittest.TestCase):
    """會議中（P2）：每兩段判斷一次哪些議程項目談過；只問還沒談的；結束時再判斷一次。"""
    # 已經談過的排第一個：如果連談過的也拿去問，假 AI 會回它，測試就抓得到
    ITEMS = [{"id": "m-1", "title": "老師自己加的", "done": True},
             {"id": "student", "title": "學生本人說明", "detail": "可用圖卡", "done": False},
             {"id": "parent", "title": "家長期望", "done": False}]

    def setUp(self):
        p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
        p.start()
        self.addCleanup(p.stop)
        self.env = mock.patch.dict(os.environ, {"FAKE_MODE": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(self.s.close)

    def test_clean(self):
        self.assertEqual(server.clean_live_agenda([{"id": "a", "title": " 題 ", "detail": 3, "done": "yes"}, {"id": "b", "title": ""}]),
                         [{"id": "a", "title": "題", "detail": "", "done": False}], "沒標題的略過；done 一定要是 true")
        self.assertIsNone(server.clean_live_agenda("x"))
        self.assertEqual(server.clean_live_agenda([{"id": "../x", "title": "t"}, {"title": "t"}, ["壞"], {"id": "ok", "title": "好"}]),
                         [{"id": "ok", "title": "好", "detail": "", "done": False}], "格式不對的項目略過，其他照收")
        self.assertEqual(len(server.clean_live_agenda([{"id": f"a{i}", "title": "t"} for i in range(50)])), server.AGENDA_ITEMS_MAX)
        self.assertEqual(len(server.clean_live_agenda([{"id": "a", "title": "t"}, {"id": "a", "title": "重複"}])), 1)

    def test_checks_every_two_paragraphs_only_pending_items(self):
        self.s.set_agenda(server.clean_live_agenda(self.ITEMS))
        self.s.add_paragraph(1, 0, 1000, "第一段")
        self.s.add_paragraph(2, 1000, 2000, "第二段")
        got = wait_events(self.s, lambda ev: any(e["type"] == "agenda" for e in ev))
        ev = [e for e in got if e["type"] == "agenda"][0]
        self.assertEqual(ev["covered"], [{"id": "student", "para": 1, "note": "談到student"},
                                         {"id": "parent", "para": None, "note": "段落不存在"}],
                         "不存在的 id、重複的丟掉；段落編號不存在就不給；控制字元拿掉")
        self.assertIn("usage", ev)
        self.assertEqual([it["done"] for it in self.s.agenda], [True, True, True], "談過的不再問")
        # 頁面在收到判斷前送出的段落帶著舊的 done：已經談過的維持談過
        self.s.set_agenda(server.clean_live_agenda(self.ITEMS))
        self.assertEqual([it["done"] for it in self.s.agenda], [True, True, True])
        # 都談過了：再兩段、會議結束都不會再問
        self.s.add_paragraph(3, 2000, 3000, "第三段")
        self.s.add_paragraph(4, 3000, 4000, "第四段")
        self.s.end()
        got = wait_events(self.s, lambda ev: any(e["type"] == "done" for e in ev), timeout=30)
        self.assertEqual(sum(e["type"] == "agenda" for e in got), 1)

    def test_final_check_at_end(self):
        self.s.set_agenda(server.clean_live_agenda(self.ITEMS))
        self.s.add_paragraph(1, 0, 1000, "只有一段")
        self.s.end()
        got = wait_events(self.s, lambda ev: any(e["type"] == "done" for e in ev), timeout=30)
        self.assertEqual([e["covered"][0]["id"] for e in got if e["type"] == "agenda"], ["student"], "結束時把最後幾段也判斷一次")

    def test_bad_reply_only_affects_agenda(self):
        os.environ["FAKE_MODE"] = "badcheck"   # 假 Claude 第一次被問時才啟動，整個測試期間都要是這個模式（setUp 的 patch 會還原）
        s = server.AgentSession("f" * 32, command=FAKE)
        self.addCleanup(s.close)
        s.set_agenda(server.clean_live_agenda(self.ITEMS))
        s.add_paragraph(1, 0, 1000, "一")
        s.add_paragraph(2, 1000, 2000, "二")
        got = wait_events(s, lambda ev: any(e["type"] == "agenda" for e in ev))
        self.assertTrue([e for e in got if e["type"] == "agenda"][0]["error"].startswith("AI 整理失敗"))
        self.assertEqual(sum(e["type"] == "para" and "error" not in e for e in got), 2, "段落整理照常")


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Path(self.tmp.name) / "config.json"
        self.cfg.write_text(json.dumps({"packs": [str(PACK_DIR)], "students_dir": str(STUDENTS)}), encoding="utf-8")
        self.hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE))
        patches = [
            mock.patch.object(server.Handler, "hub", self.hub),
            mock.patch.object(server.Handler, "config_file", self.cfg),
            mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: True)),
            mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(self.tmp.name) / "none.json")),
            mock.patch.dict(os.environ, {"FAKE_MODE": ""}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [s.close() for s in self.hub.sessions.values()])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def req(self, path, obj=None):
        data = json.dumps(obj).encode() if obj is not None else None
        r = urllib.request.Request(self.base + path, data=data, method="POST" if data else "GET",
                                   headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def build(self, **kw):
        return self.req("/api/agenda/build", {"meeting": MID, "agenda": "test-agenda", "date": "2026-10-22", **kw})

    def test_listings(self):
        self.assertEqual(self.req("/api/agendas")[1]["agendas"], [
            {"id": "test-agenda", "title": "測試擬訂議程", "form": "test-plan", "student": True},
            {"id": "test-free", "title": "沒有學生資料的議程", "form": None, "student": False}])
        self.assertEqual(self.req("/api/students")[1], {"ready": True, "students": [
            {"code": "s-001", "label": "s-001"}, {"code": "s-002", "label": "s-002"}]})
        self.cfg.write_text(json.dumps({"packs": [str(PACK_DIR)], "students_dir": str(STUDENTS), "students_label": "README.md"}), encoding="utf-8")
        self.assertEqual(self.req("/api/students")[1]["students"][0], {"code": "s-001", "label": "王〇安（s-001）"})
        self.cfg.write_text(json.dumps({}), encoding="utf-8")
        self.assertEqual(self.req("/api/students")[1], {"ready": False, "students": []})
        self.assertEqual(self.req("/api/agendas")[1], {"agendas": []})

    def test_rules_only_without_student(self):
        status, j = self.build(grade=4)
        self.assertEqual(status, 200, j)
        self.assertEqual([(it["id"], it["required"], it["source"]) for it in j["items"]], [
            ("student", True, "rule"), ("parent", True, "rule"), ("behavior", True, "rule"), ("transition", True, "rule"),
            ("emotion", False, "rule")], "沒有學生資料：text_has 判斷不了，留著但不必談")
        self.assertEqual(j["items"][0]["detail"], "可用圖卡")
        self.assertEqual((j["facts"]["grade"], j["usage"], j["files"]), (4, None, []), "沒讀學生資料就不叫 AI")
        self.assertEqual(self.hub.sessions, {})

    def test_with_student_ai_personalises(self):
        status, j = self.build(student="s-001")
        self.assertEqual(status, 200, j)
        items = {it["id"]: it for it in j["items"]}
        self.assertEqual(j["facts"], {"grade": 6, "class": "甲"}, "年級由 AI 從學生資料讀出來")
        self.assertEqual(list(items), ["student", "parent", "behavior", "transition", "emotion", "ai-1"], "空標題、不是物件的額外項目丟掉")
        self.assertEqual(items["student"]["detail"], "請小安用圖卡說說最喜歡的課")
        self.assertEqual(items["parent"]["detail"], "", "AI 給的不是字串就用原本的說明")
        self.assertEqual(items["behavior"]["detail"], "上次決議：數學抽離 4 節", "最新一份會議紀錄有送給 AI")
        self.assertTrue(items["transition"]["required"], "六年級要談轉銜")
        self.assertEqual((items["ai-1"]["title"], items["ai-1"]["source"], items["ai-1"]["required"]), ("鑑輔到期", "ai", False))
        self.assertEqual(j["files"], ["profile.md", "reports/2026-06-25-minutes.md"])
        self.assertIsNotNone(j["usage"])
        self.assertEqual(self.hub.sessions, {}, "不佔會議名額")

    def test_teacher_grade_wins(self):
        status, j = self.build(student="s-002", grade=6)
        self.assertEqual(j["facts"]["grade"], 6)
        self.assertIn("transition", [it["id"] for it in j["items"]])
        status, j = self.build(student="s-002")
        self.assertEqual(j["facts"]["grade"], 3)
        self.assertNotIn("transition", [it["id"] for it in j["items"]], "三年級不必談轉銜")
        self.assertNotIn("emotion", [it["id"] for it in j["items"]], "學生資料沒有情緒相關的字")

    def test_para_with_agenda(self):
        good = {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一段"}
        # 議程格式不對不擋段落：段落照收，壞的項目略過
        self.assertEqual(self.req("/api/agent/para", {**good, "agenda": "壞"})[0], 202)
        self.assertEqual(self.hub.get(MID).agenda, [], "不是清單就不更新")
        self.assertEqual(self.req("/api/agent/para", {**good, "idx": 2, "agenda": [{"id": "../x", "title": "t"}, {"id": "a", "title": "議題"}]})[0], 202)
        self.assertEqual(self.hub.get(MID).agenda, [{"id": "a", "title": "議題", "detail": "", "done": False}])

    def test_errors(self):
        self.assertEqual(self.build(agenda="nope")[0], 400)
        self.assertEqual(self.build(agenda=["test-agenda"])[0], 400)
        self.assertEqual(self.build(grade="六")[0], 400)
        self.assertEqual(self.build(grade=True)[0], 400)
        self.assertEqual(self.build(date="10/22")[0], 400)
        self.assertEqual(self.build(student="../s-001")[0], 400)
        self.assertEqual(self.build(student="s-999")[0], 404)
        self.assertEqual(self.req("/api/agenda/build", {"agenda": "test-agenda"})[0], 400, "要帶會議代碼")
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badagenda"}):
            self.assertEqual(self.build(student="s-001")[0], 502)
        self.cfg.write_text(json.dumps({"packs": [str(PACK_DIR)]}), encoding="utf-8")
        self.assertEqual(self.build(student="s-001")[0], 503, "沒設學生資料夾")
        self.assertEqual(self.build()[0], 200, "沒選學生照樣可以產生")


if __name__ == "__main__":
    unittest.main()
