"""介面中英切換（#195）：會議 App 的中文都要能翻，英文字典要跟頁面對得上。

之後每改一次介面都要兩種語言一起改：
- 頁面裡給人看的中文（靜態 HTML 的文字與 title／placeholder／aria-label／alt、script 裡的字串）都要在英文字典裡；
  script 裡的字串要包在 _("中文") 裡。資料或產出內容（檔名、會議紀錄檔、送給 AI 的格式）在那一行註解寫「不翻」。
- 字典 web/shared/lang-en.js 不能有用不到的鍵；英文不能是空的或還有中文；{名稱} 要跟中文一樣。
"""
import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import i18n_scan  # noqa: E402

WEB = HERE.parent / "web"
PAGE = WEB / "index.html"
DICT = WEB / "shared" / "lang-en.js"
VARS = re.compile(r"\{(\w+)\}")


def load_dict(path=DICT):
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^window\.MeetingLangEN = Object\.freeze\((\{.*\})\);\s*$", text, re.S | re.M)
    assert m, "lang-en.js 要是 window.MeetingLangEN = Object.freeze({…});，中間是 JSON"
    return json.loads(m.group(1))


class PageTranslatableTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = PAGE.read_text(encoding="utf-8")
        cls.en = load_dict()

    def test_script_strings_are_wrapped(self):
        raw = [f"{ln}: {s[:60]}" for kind, ln, s, wrapped in i18n_scan.page_cjk_strings(self.text) if kind.startswith("js") and not wrapped]
        self.assertEqual(raw, [], "script 裡的中文要包在 _(\"…\") 裡；資料或產出內容在那一行註解寫「不翻」")

    def test_translator_name_is_not_shadowed(self):
        # _ 是全域的翻譯函式：函式參數或變數也叫 _ 的話，那裡面的 _("…") 會壞掉（例如 Azure 回呼的 (_, e)）
        shadow = re.compile(r"\(\s*_\s*[,)=]|,\s*_\s*[,)\]=]|(?<![\w$.])_\s*=>|\b(?:const|let|var)\s+_\b|\[\s*_\s*[,\]]|\{\s*_\s*[,}:]")
        bad = []
        for base, src in i18n_scan.parse_html(self.text).scripts:
            code = re.sub(r"//[^\n]*", "", src)
            for m in shadow.finditer(code):
                line = base + code.count("\n", 0, m.start())
                if "const _ = I18N._;" not in self.text.split("\n")[line - 1]:
                    bad.append(f"{line}: {self.text.split(chr(10))[line - 1].strip()[:80]}")
        self.assertEqual(bad, [], "不要把參數或變數取名 _，會蓋掉翻譯函式")

    def test_translate_calls_use_plain_strings(self):
        _, bad = i18n_scan.page_keys(self.text)
        self.assertEqual(bad, [], "_( ) 的第一個參數要是單純的字串（變數用 {名稱} 加第二個參數），字典才查得到")

    def test_every_key_has_english(self):
        keys, _ = i18n_scan.page_keys(self.text)
        missing = [f"{ln}: {k[:60]}" for k, ln in keys.items() if k not in self.en]
        self.assertEqual(missing, [], "英文字典 web/shared/lang-en.js 少了這些")

    def test_no_unused_keys(self):
        keys, _ = i18n_scan.page_keys(self.text)
        used = set(keys) | i18n_scan.page_literals(self.text)
        self.assertEqual(sorted(k for k in self.en if k not in used), [], "字典裡有頁面用不到的鍵")

    def test_values_are_english_and_keep_placeholders(self):
        for k, v in self.en.items():
            forms = v if isinstance(v, list) else [v]
            self.assertTrue(isinstance(v, str) or (len(v) == 2 and "{n}" in k), f"單複數要剛好兩個，而且中文要有 {{n}}：{k}")
            for f in forms:
                self.assertIsInstance(f, str, k)
                self.assertTrue(f.strip() or not k.strip(), f"英文是空的：{k}")
                self.assertFalse(i18n_scan.CJK.search(f), f"英文裡還有中文或全形標點：{k} → {f}")
                self.assertEqual(set(VARS.findall(f)), set(VARS.findall(k)), f"{{名稱}} 要跟中文一樣：{k} → {f}")


class ScannerTest(unittest.TestCase):
    """掃描器本身：註解、正規表示式、樣板字串、不翻標記都要認對，不然上面的檢查會漏。"""

    def scan(self, js):
        return [(s, w) for kind, ln, s, w in i18n_scan.page_cjk_strings(f"<p>x</p><script>\n{js}\n</script>") if kind.startswith("js")]

    def test_comments_and_regex_are_not_strings(self):
        self.assertEqual(self.scan('// 註解 "中文"\n/* 區塊 "中文" */\nconst r = /[，。]$/.test(x); const d = a / b / "中";'), [("中", False)])

    def test_wrapped_and_unwrapped(self):
        self.assertEqual(self.scan('f(_("開始"), "結束", x._("不是"), a_("也不是"))'),
                         [("開始", True), ("結束", False), ("不是", False), ("也不是", False)])

    def test_template_literals(self):
        self.assertEqual(self.scan("t = `<b>${ok ? _(\"好\") : \"壞\"}</b>`; u = `共 ${n} 段`;"),
                         [("好", True), ("壞", False), ("共 {} 段", False)])

    def test_keep_marker(self):
        self.assertEqual(self.scan('a = "檔名";   // 不翻：檔名\nb = "提示";'), [("提示", False)])

    def test_html_text_and_attributes(self):
        found = i18n_scan.page_cjk_strings('<p title="說明">  開始\n  錄音 </p><style>/* 樣式 */</style><textarea>預設</textarea><input placeholder="例如">')
        self.assertEqual([(k, s) for k, ln, s, w in found], [("html", "開始 錄音"), ("attr:title", "說明"), ("attr:placeholder", "例如")])

    def test_keys_cook_escapes(self):
        keys, bad = i18n_scan.page_keys('<script>\n_("第一行\\n第二行「\\u4e2d」", { n }); _(`樣板`); _("中" + x);\n</script>')
        self.assertIn("第一行\n第二行「中」", keys)
        self.assertEqual(len(bad), 2, "樣板字串與拼接都不能當鍵")


if __name__ == "__main__":
    unittest.main()
