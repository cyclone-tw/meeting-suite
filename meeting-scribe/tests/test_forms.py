"""表單紀錄（#3、#97）：擴充包載入、在範本 docx 上寫敘述版紀錄、欄位清理、API。
用 tests/fake_pack.py 產生的假擴充包；客製的範本（例如某縣市的 IEP 會議紀錄）的測試放在各自的擴充包。"""
import copy
import io
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_pack  # noqa: E402

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_claude.py")]
MID = "0123456789abcdef0123456789abcdef"
W = server.W
_TMP = tempfile.TemporaryDirectory()
PACK_DIR = fake_pack.make_pack(Path(_TMP.name) / "pack")
FORMS = {f["id"]: f for f in server.load_pack(PACK_DIR)["forms"]}


def tearDownModule():
    _TMP.cleanup()


def render(tid, obj, spec=None):
    spec = spec or FORMS[tid]
    return server.render_form_docx(spec, server.clean_form(spec, obj))


def paragraphs(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = server.ET.fromstring(z.read("word/document.xml"))
    return root, list(root.iter(f"{W}p"))


def texts_of(data):
    return ["".join(t.text or "" for t in p.iter(f"{W}t")) for p in paragraphs(data)[1]]


def body_after(texts, head):
    """大項標題之後、下一個大項之前的段落（去掉結尾空行）。"""
    i = next(k for k, t in enumerate(texts) if t.startswith(head))
    out = []
    for t in texts[i + 1:]:
        if re.match(r"^(學生本人說明|家長的觀察|導師的觀察|討論事項|學習內容|評量調整|相關服務|其他：|本人已詳細閱讀|會議決議)", t):
            break
        out.append(t)
    while out and not out[-1]:
        out.pop()
    return out


class RenderTest(unittest.TestCase):
    def test_narrative_under_major_headings(self):
        data = render("test-plan", {
            "header": {"name": "王小明", "school": "示範", "grade": "6"},
            "items": {
                "student": {"text": "喜歡閱讀。\n希望數學進步。"},
                "ability": {"on": True, "text": "閱讀理解進步"},
                "chinese": {"on": True, "mode": "外加", "blanks": {"periods": "3"}},
                "special": {"on": True, "blanks": {"name": "社會技巧", "domain": "綜合"}},
                "exam_time": {"on": True, "options": {"延長考試時間20分鐘": True, "其他": "分兩節考"}},
                "pro": {"on": True, "options": {"職能治療": True, "巡迴輔導": "情緒行為"}},
                "staff": {"on": True, "options": {"酌減班級人數": "2"}},
                "family": {"on": True},
                "decision_other": {"text": "期末再檢討"},
            }})
        texts = texts_of(data)
        flat = "\n".join(texts)
        self.assertIn("測試縣 示範 學校", flat)
        self.assertIn("學生姓名： 王小明 ", flat)
        self.assertEqual(body_after(texts, "學生本人說明"), ["喜歡閱讀。", "希望數學進步。"])
        self.assertEqual(body_after(texts, "家長的觀察"), [], "三段說明沒寫就留白，不寫「無。」")
        self.assertEqual(body_after(texts, "討論事項"), ["能力現況：閱讀理解進步"])
        self.assertIn("討論事項：", texts, "標題裡「依個案需求勾選」的說明拿掉")
        self.assertEqual(body_after(texts, "學習內容"), ["語文-國：外加 3 節", "特殊需求：社會技巧、融入綜合領域"])
        self.assertEqual(body_after(texts, "評量調整"), ["評量時間調整：延長考試時間20分鐘、其他：分兩節考"])
        self.assertEqual(body_after(texts, "相關服務"), ["相關專業人員服務申請：職能治療、巡迴輔導（情緒行為）",
                                                     "家庭支持服務", "人力資源：酌減班級人數 2 人"])
        self.assertEqual(body_after(texts, "其他："), ["期末再檢討"])
        for mark in ("□", "○", "依個案需求勾選"):
            self.assertNotIn(mark, flat)
        self.assertIn("本人已詳細閱讀，並同意這份計畫的執行！", flat, "同意簽名留著")
        self.assertEqual(sum(t.startswith("與會者簽名") for t in texts), 1, "簽名欄留著，只留一種會議")
        # 標籤粗體、內容一般字、12pt
        _, ps = paragraphs(data)
        i = texts.index("語文-國：外加 3 節")
        runs = [r for r in ps[i].iter(f"{W}r") if r.findtext(f"{W}t")]
        self.assertEqual([r.findtext(f"{W}t") for r in runs], ["語文-國：", "外加 3 節"])
        self.assertIsNotNone(runs[0].find(f"{W}rPr/{W}b"))
        self.assertIsNone(runs[1].find(f"{W}rPr/{W}b"))
        self.assertEqual(runs[1].find(f"{W}rPr/{W}sz").get(f"{W}val"), "24")

    def test_empty_values_say_none_under_each_major_item(self):
        texts = texts_of(render("test-plan", {}))
        for head in ("討論事項", "學習內容", "評量調整", "相關服務", "其他："):
            self.assertEqual(body_after(texts, head), ["無。"], head)

    def test_unchecked_items_print_nothing(self):
        flat = "\n".join(texts_of(render("test-plan", {"items": {
            "ability": {"on": False, "text": "不該印"}, "special": {"on": False, "blanks": {"name": "不該印"}},
            "exam_paper": {"on": False, "options": {"其他": "不該印", "試題報讀": True}}}})))
        self.assertNotIn("不該印", flat)
        self.assertNotIn("試題報讀", flat)

    def test_decisions_without_major_headings(self):
        texts = texts_of(render("test-exit", {"items": {"exit_keep": {"on": True}, "ability": {"text": "能獨立完成作業"}}}))
        self.assertEqual(body_after(texts, "會議決議"), ["持續接受特殊教育服務。"])
        self.assertIn("能力現況：能獨立完成作業", texts)
        self.assertNotIn("結束特殊教育服務。", texts, "沒選的不印")
        self.assertTrue(texts[0].endswith("測試結束會議"), "只留選的那一種")

    def test_only_one_meeting_and_no_leading_page_break(self):
        for tid in FORMS:
            with self.subTest(tid):
                root, ps = paragraphs(render(tid, {}))
                self.assertEqual(sum("學期" in "".join(t.text or "" for t in p.iter(f"{W}t")) for p in ps), 1)
                self.assertFalse([br for br in root.iter(f"{W}br") if br.get(f"{W}type") == "page"])
                self.assertIsNotNone(root.find(f"{W}body/{W}sectPr"))

    def test_valid_package_and_namespaces(self):
        data = render("test-plan", {"items": {"family": {"on": True}}})
        with zipfile.ZipFile(FORMS["test-plan"]["docx"]) as a, zipfile.ZipFile(io.BytesIO(data)) as b:
            self.assertEqual(a.namelist(), b.namelist())
            new = b.read("word/document.xml").decode()
        root_tag = re.search(r"<w:document\b[^>]*>", new).group(0)
        self.assertIn('xmlns:w14="', root_tag, "原本宣告的命名空間都要留著（mc:Ignorable 會用到）")
        self.assertNotRegex(new, r"<ns\d+:")
        self.assertTrue(new.startswith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'))
        server.ET.fromstring(new.encode())

    def test_xml_special_and_control_characters(self):
        data = render("test-plan", {"header": {"name": "A&B <C>\x00\x07"}, "items": {"teacher": {"text": "上課 <專心> & 準時\x0b\ud800"}}})
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode()
        self.assertIn("A&amp;B &lt;C&gt;", xml)
        self.assertIn("上課 &lt;專心&gt; &amp; 準時", xml)

    def test_template_mismatch_is_refused(self):
        for old, new, why in (("學生姓名：", "姓名：", "學生姓名："), ("評量調整：", "評量：", "評量調整："), ("測試擬訂會議", "別的會議", "這種會議")):
            with self.subTest(why), tempfile.TemporaryDirectory() as d:
                bad = Path(d) / "bad.docx"
                with zipfile.ZipFile(FORMS["test-plan"]["docx"]) as a, zipfile.ZipFile(bad, "w") as b:
                    for info in a.infolist():
                        data = a.read(info.filename)
                        if info.filename == "word/document.xml":
                            data = data.decode().replace(old, new).encode()
                        b.writestr(info, data)
                with self.assertRaisesRegex(ValueError, why):
                    render("test-plan", {}, {**FORMS["test-plan"], "docx": bad})


class CleanTest(unittest.TestCase):
    def test_shape_is_fixed(self):
        spec = FORMS["test-plan"]
        v = server.clean_form(spec, {
            "header": {"name": "  王小明\n ", "grade": 3, "hacker": "x"},
            "items": {
                "student": {"text": "a\r\n\r\n\r\n\r\nb", "on": True},
                "ability": {"text": "有寫內容"},
                "behavior": {"on": False, "text": "取消勾選的"},
                "chinese": {"mode": "亂寫", "blanks": {"periods": "3\n節", "x": "y"}},
                "math": {"on": "true"},
                "exam_time": {"options": {"延長考試時間20分鐘": True, "不存在": True}},
                "exam_paper": {"options": {"其他": "   ", "試題報讀": "yes"}},
                "pro": {"options": {"巡迴輔導": "亂寫", "職能治療": True}},
                "not_a_field": {"on": True},
            }})
        self.assertEqual(v["header"]["name"], "王小明")
        self.assertEqual(v["header"]["grade"], "", "不是字串就不要")
        self.assertNotIn("hacker", v["header"])
        self.assertNotIn("not_a_field", v["items"])
        self.assertEqual(v["items"]["student"], {"text": "a\n\nb"})
        self.assertEqual(v["items"]["ability"], {"on": True, "text": "有寫內容"}, "沒寫 on 但有內容就算勾")
        self.assertEqual(v["items"]["behavior"], {"on": False, "text": "取消勾選的"}, "明確取消勾選的不勾回去")
        self.assertEqual(v["items"]["chinese"], {"on": True, "mode": "", "blanks": {"periods": "3 節"}})
        self.assertEqual(v["items"]["math"]["on"], False, "on 一定要是 true")
        self.assertEqual(v["items"]["exam_time"]["options"], {"延長考試時間20分鐘": True})
        self.assertEqual(v["items"]["exam_paper"]["options"], {}, "空白的其他不算；一般選項不吃字串")
        self.assertEqual(v["items"]["pro"]["options"], {"巡迴輔導": True, "職能治療": True}, "類別看不懂只留勾選")
        self.assertEqual(set(v["items"]), {it["id"] for it in server.form_items(spec)})

    def test_length_limits(self):
        v = server.clean_form(FORMS["test-plan"], {"header": {"name": "名" * 500}, "items": {"student": {"text": "字" * 9000}}})
        self.assertEqual(len(v["header"]["name"]), server.FORM_BLANK_MAX)
        self.assertEqual(len(v["items"]["student"]["text"]), server.FORM_TEXT_MAX)

    def test_schema_for_the_page(self):
        s = server.form_schema(FORMS["test-plan"])
        dump = json.dumps(s, ensure_ascii=False)
        for key in ('"find"', '"after"', '"heading"', '"fmt"', '"docx"', '"prompt"'):
            self.assertNotIn(key, dump, "定位用的字、輸出格式、檔案路徑不送到頁面")
        self.assertEqual((s["pack"], s["forms_title"], s["file_name"]), ("test-pack", "測試會議紀錄（簽名版）", "測試擬訂會議紀錄"))
        self.assertEqual(s["warnings"][2]["when"], [{"off": "transition"}, {"grade_in": [2, 4, 6]}])

    def test_prompt_is_read_on_every_use(self):
        with tempfile.TemporaryDirectory() as d:
            spec = {f["id"]: f for f in server.load_pack(fake_pack.make_pack(Path(d) / "p"))["forms"]}["test-plan"]
            day = server.parse_date("2026-10-22")
            self.assertIn("請依逐字稿填表", server.form_prompt(spec, day))
            (Path(d) / "p" / "prompts" / "form.md").write_text("改過的提示詞「{title}」", encoding="utf-8")
            self.assertEqual(server.form_prompt(spec, day), "改過的提示詞「測試擬訂會議」", "改提示詞不用重新啟動")

    def test_prompt_fills_placeholders_without_format(self):
        p = server.form_prompt(FORMS["test-plan"], server.parse_date("2026-10-22"))
        self.assertIn("這是一場「測試擬訂會議」，日期 2026-10-22（星期四）", p)
        self.assertIn('{"header": {"name": "學生姓名"}', p, "提示詞裡的 JSON 大括號原樣保留")
        self.assertIn("- chinese（勾選）：語文-國；mode 填「抽離」或「外加」；blanks：periods＝節數", p)


class PackLoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def bad(self, mutate, msg):
        pack = copy.deepcopy(fake_pack.PACK)
        mutate(pack)
        d = fake_pack.make_pack(self.root / f"p{len(list(self.root.iterdir()))}", pack)
        with self.assertRaisesRegex(ValueError, msg):
            server.load_pack(d)

    def test_shared_refs_and_minutes(self):
        pack = server.load_pack(PACK_DIR)
        self.assertEqual([f["id"] for f in pack["forms"]], ["test-plan", "test-exit"])
        self.assertEqual(pack["forms"][0]["header"], pack["forms"][1]["header"], "@header 指到同一份")
        self.assertEqual(list(pack["minutes"]), ["test-teacher"])

    def test_rejects_bad_packs(self):
        self.bad(lambda p: p.update(id="../x"), "id 不合法")
        self.bad(lambda p: p["forms"][0].update(docx="../../etc/passwd"), "找不到擴充包裡的檔案")
        self.bad(lambda p: p["forms"][0].update(docx="/etc/hosts"), "路徑不合法")
        self.bad(lambda p: p["forms"][0].update(header="@nope"), "shared 裡沒有")
        self.bad(lambda p: p["forms"][0]["warnings"].append({"when": [{"eval": "x"}], "text": "t"}), "不認得的提醒條件")
        self.bad(lambda p: p["forms"][0]["decisions"][0]["items"][0]["blanks"][0].update(fmt="{} {}"), "剛好有一個")
        self.bad(lambda p: p["forms"][0]["decisions"][0]["items"][0]["blanks"][0].update(fmt="{0.__class__}"), "剛好有一個")
        self.bad(lambda p: p["forms"][0]["decisions"][0]["items"].append({"kind": "check", "id": "chinese", "label": "重複"}), "重複")
        self.bad(lambda p: p["forms"][0].update(drive_file="../x.docx"), "drive_file")
        self.bad(lambda p: p["shared"]["header_defaults"].update(school="os.system"), "header_defaults")
        self.bad(lambda p: p["forms"][0]["decisions"][0].update(heading=None), "heading")
        # 結構：產生 Word 時才會壞的組合，載入時就擋
        self.bad(lambda p: p["forms"][0]["report"][0]["items"].append({"kind": "check", "id": "x1", "label": "x"}), "只能放說明文字")
        self.bad(lambda p: p["forms"][0]["report"][1]["items"].append({"kind": "text", "id": "x2", "label": "x", "find": "x"}), "只能放勾選項目")
        self.bad(lambda p: p["forms"][0].update(decisions=[]), "沒有會議決議")
        self.bad(lambda p: p["forms"][0]["warnings"].append({"when": [{"off": "student"}], "text": "t"}), "要指向勾選項目")
        self.bad(lambda p: p["forms"][0]["warnings"].append({"when": [{"empty": "nope"}], "text": "t"}), "要指向說明文字")
        self.bad(lambda p: p["forms"].append(copy.deepcopy(p["forms"][0])), "表單 id 重複")
        # 延伸模組（#136）：只收宣告式選項，指示檔不能跳出擴充包
        self.bad(lambda p: p["modules"][0].update(id="Bad Id"), "模組 id 不合法")
        self.bad(lambda p: p["modules"][0].update(prompt="../../etc/passwd"), "找不到擴充包裡的檔案")
        self.bad(lambda p: p["modules"][0]["options"][0].update(choices=[]), "1 到 20 個不重複的選擇")
        self.bad(lambda p: p["modules"][0]["options"][0]["choices"].append({"id": "warm", "label": "重複", "prompt": "x"}), "不重複的選擇")
        self.bad(lambda p: p["modules"][0]["options"][0]["choices"][0].update(prompt=""), "prompt 要是字串")
        self.bad(lambda p: p["modules"][0].update(options=[{"id": f"o{i}", "label": "x", "choices": [{"id": "a", "label": "a", "prompt": "a"}]} for i in range(4)]), "最多 3 個")
        self.bad(lambda p: p["modules"].append(copy.deepcopy(p["modules"][0])), "模組 id 重複")

    def test_pack_module_cannot_shadow_builtin(self):
        # 內建模組與會後總結、心智圖（#150）的 id 都保留
        for mid in ("perspective", "summary", "mindmap"):
            with self.subTest(mid=mid):
                pack = copy.deepcopy(fake_pack.PACK)
                pack["modules"][0]["id"] = mid
                cfg = self.root / "config.json"
                cfg.write_text(json.dumps({"packs": [str(fake_pack.make_pack(self.root / f"shadow-{mid}", pack))]}), encoding="utf-8")
                got = server.load_packs(cfg)
                self.assertEqual(got["modules"], {})
                self.assertTrue(any(f"模組 {mid} 和本體" in e for e in got["errors"]), got["errors"])

    def test_symlink_out_of_pack_is_refused(self):
        d = fake_pack.make_pack(self.root / "p")
        outside = self.root / "secret.md"
        outside.write_text("x", encoding="utf-8")
        (d / "prompts" / "form.md").unlink()
        (d / "prompts" / "form.md").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "找不到擴充包裡的檔案"):
            server.load_pack(d)

    def test_load_packs_skips_broken_and_duplicates(self):
        good = fake_pack.make_pack(self.root / "good")
        dup = fake_pack.make_pack(self.root / "dup")
        broken = self.root / "broken"
        broken.mkdir()
        (broken / "pack.json").write_text("{", encoding="utf-8")
        cfg = self.root / "config.json"
        cfg.write_text(json.dumps({"packs": [str(good), str(broken), str(dup), str(self.root / "missing")]}), encoding="utf-8")
        got = server.load_packs(cfg)
        self.assertEqual(sorted(got["forms"]), ["test-exit", "test-plan"])
        self.assertEqual(got["forms"]["test-plan"]["docx"], (good / "forms" / "test.docx").resolve(), "id 重複時前面的優先")
        self.assertEqual(len(got["errors"]), 8, got["errors"])
        self.assertEqual(sum("重複，略過" in e for e in got["errors"]), 6, "重複的表單、議程、模板與模組要說出來")
        self.assertEqual(list(got["modules"]), ["test-module"])
        self.assertFalse(any(str(self.root) in e for e in got["errors"]), "錯誤訊息不帶完整路徑")
        # pack.json 改了就重新讀
        pack = copy.deepcopy(fake_pack.PACK)
        pack["forms"][0]["title"] = "改過的標題"
        os.utime(good / "pack.json", ns=(1, 1))
        fake_pack.make_pack(good, pack)
        self.assertEqual(server.load_packs(cfg)["forms"]["test-plan"]["title"], "改過的標題")

    def test_missing_file_added_later_reloads_without_touching_pack_json(self):
        d = fake_pack.make_pack(self.root / "late")
        doc = d / "forms" / "test.docx"
        data = doc.read_bytes()
        doc.unlink()
        cfg = self.root / "config.json"
        cfg.write_text(json.dumps({"packs": [str(d)]}), encoding="utf-8")
        self.assertEqual(server.load_packs(cfg)["forms"], {}, "缺檔：整包略過")
        doc.write_bytes(data)
        self.assertEqual(sorted(server.load_packs(cfg)["forms"]), ["test-exit", "test-plan"], "補上檔案就重新讀")
        # .git 之類的隱藏資料夾變動不算擴充包內容，不重新讀
        first = server.load_packs(cfg)
        (d / ".git").mkdir()
        (d / ".git" / "FETCH_HEAD").write_text("x", encoding="utf-8")
        self.assertIs(server.load_packs(cfg), first)

    def test_no_config_means_no_packs(self):
        got = server.load_packs(self.root / "none.json")
        self.assertEqual((got["forms"], got["minutes"], got["errors"]), ({}, {}, []))

    def test_core_template_wins_over_pack(self):
        self.assertEqual(server.load_template("general", {"general": PACK_DIR / "minutes" / "test-teacher.md"})[0], "一般會議")
        self.assertEqual(server.load_template("test-teacher", {"test-teacher": PACK_DIR / "minutes" / "test-teacher.md"})[0], "測試教師版")
        self.assertIsNone(server.load_template("test-teacher"))
        self.assertEqual([t["id"] for t in server.list_templates({"test-teacher": PACK_DIR / "minutes" / "test-teacher.md"})],
                         ["general", "test-teacher"])


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "drive"
        self.root.mkdir()
        self.cfg = Path(self.tmp.name) / "config.json"
        self.cfg.write_text(json.dumps({"drive_roots": {"school": {"label": "學校 Drive", "path": str(self.root)}},
                                        "packs": [str(PACK_DIR)]}), encoding="utf-8")
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
                return resp.status, resp.headers.get("Content-Type"), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type"), e.read()

    def test_listings(self):
        status, _, body = self.req("/api/forms")
        got = json.loads(body)
        self.assertEqual((status, [t["id"] for t in got["forms"]], got["errors"]), (200, ["test-plan", "test-exit"], []))
        status, _, body = self.req("/api/templates")
        self.assertEqual(json.loads(body)["templates"], [{"id": "general", "title": "一般會議"}, {"id": "test-teacher", "title": "測試教師版"}])
        # 沒有擴充包：沒有表單、只有本體的模板
        self.cfg.write_text(json.dumps({}), encoding="utf-8")
        self.assertEqual(json.loads(self.req("/api/forms")[2])["forms"], [])
        self.assertEqual([t["id"] for t in json.loads(self.req("/api/templates")[2])["templates"]], ["general"])

    def test_ai_fill(self):
        good = {"meeting": MID, "kind": "form", "template": "test-plan", "date": "2026-10-22",
                "paras": [{"start": 0, "text": "一"}, {"start": 5000, "text": "二"}]}
        for bad in ({"template": "nope"}, {"template": ["test-plan"]}, {"date": "10/22"}):
            self.assertEqual(self.req("/api/agent/summary", {**good, **bad})[0], 400, bad)
        status, _, body = self.req("/api/agent/summary", good)
        ev = json.loads(body)
        self.assertEqual(status, 200, ev)
        self.assertEqual((ev["type"], ev["template"], ev["title"], ev["date"]), ("form", "test-plan", "測試擬訂會議", "2026-10-22"))
        v = ev["values"]
        self.assertEqual(v["items"]["student"]["text"], "測試擬訂會議：個案表示喜歡閱讀。\n希望數學進步。", "會議別放進 prompt；控制字元拿掉")
        self.assertEqual(v["header"]["name"], "王小明")
        self.assertNotIn("hacker", v["header"])
        self.assertEqual(v["items"]["chinese"], {"on": True, "mode": "外加", "blanks": {"periods": "3"}})
        self.assertEqual(v["items"]["exam_paper"], {"on": True, "options": {"其他": "題目加注音"}})
        self.assertEqual(v["items"]["pro"]["options"], {"巡迴輔導": "情緒行為", "職能治療": True})
        self.assertNotIn("not_a_field", v["items"])
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badform"}):
            self.assertEqual(self.req("/api/agent/summary", good)[0], 502)
        self.assertEqual(self.hub.sessions, {}, "不佔會議名額")

    def test_docx_download(self):
        status, ctype, body = self.req("/api/forms/docx", {"meeting": MID, "template": "test-plan", "values": {
            "header": {"name": "王小明"}, "items": {"family": {"on": True}, "junk": {"on": True}}}})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertIn("家庭支持服務", texts_of(body))
        for bad in ({"meeting": MID, "template": "../x"}, {"meeting": MID, "template": []}, {"meeting": MID, "template": {"a": 1}},
                    {"template": "test-plan"}):
            self.assertEqual(self.req("/api/forms/docx", {**bad, "values": {}})[0], 400, bad)
        self.assertEqual(self.req("/api/forms/docx", ["test-plan"])[0], 400)

    def test_broken_template_returns_an_error(self):
        pack = copy.deepcopy(fake_pack.PACK)
        d = fake_pack.make_pack(Path(self.tmp.name) / "broken", pack)
        (d / "forms" / "test.docx").write_bytes(b"not a zip")
        self.cfg.write_text(json.dumps({"packs": [str(d)]}), encoding="utf-8")
        status, _, body = self.req("/api/forms/docx", {"meeting": MID, "template": "test-plan", "values": {}})
        self.assertEqual(status, 500)
        self.assertIn("產生 Word 檔失敗", json.loads(body)["error"])

    def test_save_to_drive_includes_docx(self):
        status, _, body = self.req("/api/save/transcript", {"root": "school", "folder": "", "title": "f", "transcript": "t",
                                                            "form": {"template": "test-exit", "values": {"items": {"exit_keep": {"on": True}}}}})
        body = json.loads(body)
        self.assertEqual(status, 200, body)
        self.assertIn("test-minutes.docx", body["files"])
        self.assertIn("持續接受特殊教育服務。", texts_of((self.root / body["meeting"] / "test-minutes.docx").read_bytes()))
        before = sorted(p.name for p in self.root.iterdir())
        for bad in ({"template": "nope"}, {"template": ["test-plan"]}):
            status, _, _ = self.req("/api/save/transcript", {"root": "school", "folder": "", "title": "bad", "transcript": "t", "form": bad})
            self.assertEqual(status, 400)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), before, "格式錯誤不建資料夾")


if __name__ == "__main__":
    unittest.main()
