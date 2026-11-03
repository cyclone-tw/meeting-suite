"""主機回給頁面的文字跟著介面語言（#197）。

頁面英文模式下 api() 會帶 lang=en；主機把 error／errors 欄位的訊息、辨識引擎與內建模組、本體紀錄模板的名稱
照 web/shared/lang-en.js 換成英文。中文訊息照樣寫在 server.py 裡；新加的訊息沒進字典，這裡會擋。
擴充包帶來的內容與會議資料（逐字稿、心智圖節點）不翻。
"""
import copy
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import fake_pack  # noqa: E402
import i18n_scan  # noqa: E402
import server  # noqa: E402

SRC = (HERE.parent / "server.py").read_text(encoding="utf-8")


def builtin_labels():
    """主機給頁面的內建名稱：辨識引擎（client 模式列出全部）、內建模組的標題、說明、選項，本體的紀錄模板。"""
    out = [e["label"] for e in server.engines_status("k", None, "client")]
    for m in server.list_modules():
        out += [m["title"], m.get("description") or ""]
        for o in m.get("options", []):
            out += [o["label"]] + [c[1] for c in o["choices"]]
    out += [t["title"] for t in server.list_templates()]
    return [x for x in dict.fromkeys(out) if x]


class DictionaryCoversServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.en = server.load_lang_en()
        cls.canon = {i18n_scan.canon(k) for k in cls.en}

    def test_every_server_message_has_english(self):
        missing = [f"{ln}: {t}" for ln, t in i18n_scan.server_messages(SRC) if i18n_scan.canon(t) not in self.canon]
        self.assertEqual(missing, [], "server.py 回給頁面的訊息要在 web/shared/lang-en.js 有英文（{} 的位置用 {名稱}）")

    def test_every_builtin_label_has_english(self):
        self.assertEqual([x for x in builtin_labels() if x not in self.en], [], "內建名稱要有英文")

    def test_server_shapes_are_unambiguous(self):
        # 主機訊息的形狀（{名稱} 換成 {}）在字典裡有好幾個鍵時，英文的形狀要一樣，不然反查會不知道用哪一個
        shapes = {i18n_scan.canon(t) for _, t in i18n_scan.server_messages(SRC)}
        by = {}
        for k in self.en:
            by.setdefault(i18n_scan.canon(k), []).append(k)
        # 英文的形狀也一樣（例如 {title}：{description} 與 {name}：{error} 都是「{}: {}」）就沒差
        en_shape = lambda k: i18n_scan.canon(json.dumps(self.en[k], ensure_ascii=False))  # noqa: E731
        self.assertEqual({c: ks for c, ks in by.items() if c in shapes and len({en_shape(k) for k in ks}) > 1}, {})

    def test_dictionary_loads_on_the_server(self):
        self.assertGreater(len(server.TRANSLATE_EN.table), 500)


class ScanServerTest(unittest.TestCase):
    """掃描器本身：各種送到頁面的寫法都要抓到，f-string 片段不能重複算。"""

    def scan(self, code):
        return [t for _, t in i18n_scan.server_messages(code)]

    def test_sinks(self):
        code = '''
MSG = "常數訊息"
def ai_error(e):
    return f"整理失敗（{type(e).__name__}）"
def f(self, e, ok):
    self._json(400, {"error": "錯了" if ok else MSG})
    raise ValueError(f"{e} 要剛好有一個 {{}}")
    self._fail(f"匯入失敗（{e}）")
    out["errors"].append(f"{e}：重複")
    print("記錄用，不送頁面")
    return {"error": str(e)}
'''
        self.assertEqual(sorted(self.scan(code)), sorted(["常數訊息", "整理失敗（{}）", "錯了", "{} 要剛好有一個 {}", "匯入失敗（{}）", "{}：重複"]))


class TranslatorTest(unittest.TestCase):
    def setUp(self):
        self.tr = server.Translator({
            "連不到 Soniox": "Can't reach Soniox",
            "AI 整理失敗（{err}）": "AI processing failed ({err})",
            "{name}：{error}": "{name}: {error}",
            "檔案路徑不合法：{path}": "Invalid file path: {path}",
            "共 {n} 段": ["{n} paragraph", "{n} paragraphs"],
            "{what} 要剛好有一個 {}": "{what} must contain exactly one {}",
            "{only}": "never used",
        })

    def test_exact_and_passthrough(self):
        self.assertEqual(self.tr("連不到 Soniox"), "Can't reach Soniox")
        self.assertEqual(self.tr("沒在字典裡"), "沒在字典裡")
        self.assertEqual(self.tr("plain english"), "plain english")
        self.assertIsNone(self.tr(None))

    def test_template_keeps_variables(self):
        self.assertEqual(self.tr("AI 整理失敗（TimeoutError）"), "AI processing failed (TimeoutError)")
        self.assertEqual(self.tr("x 要剛好有一個 {}"), "x must contain exactly one {}")

    def test_specific_template_wins_and_nested_messages_translate(self):
        self.assertEqual(self.tr("檔案路徑不合法：a：b"), "Invalid file path: a：b")
        self.assertEqual(self.tr("pack.json：檔案路徑不合法：x"), "pack.json: Invalid file path: x")

    def test_plural(self):
        self.assertEqual(self.tr("共 1 段"), "1 paragraph")
        self.assertEqual(self.tr("共 3 段"), "3 paragraphs")

    def test_localize_only_touches_error_fields(self):
        ev = {"type": "para", "text": "連不到 Soniox", "chunks": [{"idx": 1, "error": "AI 整理失敗（X）"}],
              "errors": ["連不到 Soniox"], "label": "連不到 Soniox"}
        out = server.localize(ev, self.tr)
        self.assertEqual(out["chunks"][0]["error"], "AI processing failed (X)")
        self.assertEqual(out["errors"], ["Can't reach Soniox"])
        self.assertEqual((out["text"], out["label"]), ("連不到 Soniox", "連不到 Soniox"), "會議內容與其他欄位不動")
        self.assertEqual(ev["chunks"][0]["error"], "AI 整理失敗（X）", "不改原本的資料（事件還會送給中文頁面）")


class StoredDataStaysChineseTest(unittest.TestCase):
    """頁面存回暫存的段落錯誤是英文時換回中文原文：換語言打開同一場，錯誤照介面語言顯示，不會卡在英文。"""

    def test_page_errors_are_stored_in_chinese(self):
        en = server.TRANSLATE_EN("AI 整理失敗（TimeoutError）")
        self.assertNotEqual(en, "AI 整理失敗（TimeoutError）")
        out = server.merge_ai({}, {"chunks": [{"idx": 0, "error": en}, {"idx": 1, "error": server.TRANSLATE_EN("連不到伺服器")},
                                              {"idx": 2, "error": "HTTP 500"}]}, "page")
        self.assertEqual([c["error"] for c in out["chunks"]], ["AI 整理失敗（TimeoutError）", "連不到伺服器", "HTTP 500"])

    def test_agent_errors_are_untouched(self):
        out = server.merge_ai({}, {"chunks": [{"idx": 0, "error": "AI 整理失敗（X）"}]}, "agent")
        self.assertEqual(out["chunks"][0]["error"], "AI 整理失敗（X）")

    def test_round_trip(self):
        # 主機訊息翻成英文再翻回來要是同一句（反查表有兩個中文鍵英文一樣時才可能不同，這裡擋住）
        for _, t in i18n_scan.server_messages(SRC):
            if "{}" in t:
                continue
            self.assertEqual(server.TRANSLATE_ZH(server.TRANSLATE_EN(t)), t)


class HttpLangTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        pack = copy.deepcopy(fake_pack.PACK)
        # 擴充包的模組剛好跟內建模組同名：還是擴充包的內容，不翻
        pack["modules"][0]["title"] = "視角回饋"
        pdir = fake_pack.make_pack(Path(self.tmp.name) / "pack", pack)
        cfg = Path(self.tmp.name) / "config.json"
        cfg.write_text(json.dumps({"packs": [str(pdir)]}), encoding="utf-8")
        p = mock.patch.object(server.Handler, "config_file", cfg)
        p.start()
        self.addCleanup(p.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_error_follows_lang(self):
        self.assertEqual(self.get("/api/drafts/get?draft=..%2Fx")[1]["error"], "暫存代碼不合法")
        status, body = self.get("/api/drafts/get?draft=..%2Fx&lang=en")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], server.TRANSLATE_EN("暫存代碼不合法"))
        self.assertFalse(i18n_scan.CJK.search(body["error"]), body)
        self.assertEqual(self.get("/api/agent/events?meeting=bad&lang=en")[1]["error"], server.TRANSLATE_EN("會議代碼不合法"))

    def test_engine_names(self):
        zh = self.get("/api/engines")[1]["engines"]
        en = self.get("/api/engines?lang=en")[1]["engines"]
        self.assertEqual([e["id"] for e in zh], [e["id"] for e in en])
        self.assertTrue(all(i18n_scan.CJK.search(e["label"]) for e in zh))
        self.assertFalse([e["label"] for e in en if i18n_scan.CJK.search(e["label"])])

    def test_builtin_modules_translate_pack_modules_do_not(self):
        en = {m["id"]: m for m in self.get("/api/modules?lang=en")[1]["modules"]}
        zh = {m["id"]: m for m in self.get("/api/modules")[1]["modules"]}
        self.assertEqual(zh["perspective"]["title"], "視角回饋")
        self.assertEqual(en["perspective"]["title"], server.TRANSLATE_EN("視角回饋"))
        self.assertNotEqual(en["perspective"]["title"], "視角回饋")
        self.assertFalse(i18n_scan.CJK.search(json.dumps([en[k] for k in ("summary", "mindmap", "sprout", "perspective")], ensure_ascii=False)))
        self.assertNotIn("options", en["summary"], "沒有選項的模組不多出欄位")
        self.assertEqual(en["test-module"], zh["test-module"], "擴充包的模組不翻，就算名稱跟內建的一樣")
        self.assertEqual(en["test-module"]["title"], "視角回饋")

    def test_builtin_templates_translate(self):
        en = self.get("/api/templates?lang=en")[1]["templates"]
        zh = self.get("/api/templates")[1]["templates"]
        builtin = {p.stem for p in server.TEMPLATES_DIR.glob("*.md")}
        for a, b in zip(zh, en):
            if a["id"] in builtin:
                self.assertFalse(i18n_scan.CJK.search(b["title"]), b)
            else:
                self.assertEqual(a, b, "擴充包的模板名稱不翻")

    def test_pack_load_errors_list(self):
        # 擴充包讀不到時 /api/forms 的 errors 也是給人看的訊息
        bad = Path(self.tmp.name) / "bad"
        bad.mkdir()
        (bad / "pack.json").write_text(json.dumps({"id": "BAD ID"}), encoding="utf-8")
        cfg = Path(self.tmp.name) / "config2.json"
        cfg.write_text(json.dumps({"packs": [str(bad)]}), encoding="utf-8")
        with mock.patch.object(server.Handler, "config_file", cfg):
            zh = self.get("/api/forms")[1]["errors"]
            en = self.get("/api/forms?lang=en")[1]["errors"]
        self.assertEqual(len(zh), 1)
        self.assertTrue(i18n_scan.CJK.search(zh[0][len("bad") + 1:] if zh[0].startswith("bad") else zh[0]), zh)
        self.assertFalse(i18n_scan.CJK.search(en[0]), en)


if __name__ == "__main__":
    unittest.main()
