"""匯出（#215）：頁面組好的完整紀錄 Markdown 轉成 Word（只用標準函式庫）與 POST /api/export/docx。"""
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
from xml.dom import minidom

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

MID = "c" * 32
SAMPLE = """# 週三個案會議

會議：個案 & 討論
地點：資源班 <A>

## 簡介

開場說明
[ 分段章節 ]
00:00:05 開場

## 會議紀錄

### 待辦事項

| 事項 | 負責人 | 期限 | 狀態 |
| --- | --- | --- | --- |
| 交清單 \\| 補件 | 導師 | 11/12 | 未開始 |

- **重點**：閱讀進步
  - 子項 `code` [連結](https://example.com)
1. 第一
> 引用

```
mermaid 程式
```

---
[00:00:05] 逐字稿一句\x01有控制字元
"""


def docx_parts(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    return {n: z.read(n).decode("utf-8") for n in z.namelist()}


class MarkdownDocxTest(unittest.TestCase):
    def test_package_is_a_valid_word_file(self):
        parts = docx_parts(server.markdown_docx(SAMPLE, "週三 & <會議>"))
        self.assertEqual(sorted(parts), sorted(["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml"]))
        for name, text in parts.items():
            minidom.parseString(text.encode("utf-8"))   # 每個部分都是合法 XML（跳脫、控制字元都處理過）
        self.assertIn("<dc:title>週三 &amp; &lt;會議&gt;</dc:title>", parts["docProps/core.xml"])
        self.assertIn('<w:pgSz w:w="11906" w:h="16838"/>', parts["word/document.xml"], "A4")

    def test_blocks_become_word_structures(self):
        doc = docx_parts(server.markdown_docx(SAMPLE))["word/document.xml"]
        texts = lambda xml: "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))   # noqa: E731
        paras = re.findall(r"<w:p>.*?</w:p>|<w:p/>", doc)
        style = lambda t: next((re.search(r'w:pStyle w:val="(\w+)"', p).group(1) for p in paras if texts(p) == t and "w:pStyle" in p), None)   # noqa: E731
        self.assertEqual(style("週三個案會議"), "Title")
        self.assertEqual(style("簡介"), "Heading1")
        self.assertEqual(style("待辦事項"), "Heading2")
        self.assertIn("會議：個案 &amp; 討論", doc, "跳脫 &")
        self.assertIn("地點：資源班 &lt;A&gt;", doc, "跳脫 < >")
        # 每一行一個段落：章節時間不會和前一行併在一起
        self.assertTrue(any(texts(p) == "00:00:05 開場" for p in paras))
        # 表格：表頭粗體、跳脫的 | 還原成文字
        self.assertEqual(doc.count("<w:tbl>"), 1)
        self.assertIn("</w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>", doc, "tblPr 後面接 tblGrid（Word 才不會要求修復）")
        self.assertEqual(doc.count("<w:tr>"), 2)
        self.assertIn("交清單 | 補件", doc)
        self.assertRegex(doc, r"<w:tc>.*?<w:b/>.*?事項")
        # 清單、巢狀縮排、粗體、行內程式碼、連結寫成文字（網址）
        self.assertIn("• ", doc)
        self.assertIn('w:left="360"', doc)
        self.assertIn('w:left="720"', doc, "第二層縮排多一格")
        self.assertRegex(doc, r"<w:b/></w:rPr><w:t xml:space=\"preserve\">重點</w:t>")
        self.assertIn('w:ascii="Menlo"', doc)
        self.assertIn("連結（https://example.com）", doc)
        self.assertIn("<w:i/>", doc, "引用是斜體")
        self.assertIn('w:fill="F2F2F0"', doc, "程式碼區塊有底色")
        self.assertIn("<w:pBdr>", doc, "分隔線")
        self.assertIn("逐字稿一句有控制字元", doc, "XML 不收的控制字元拿掉")
        self.assertNotIn("**", doc)

    def test_empty_markdown_still_makes_a_document(self):
        doc = docx_parts(server.markdown_docx("   \n"))["word/document.xml"]
        self.assertIn("<w:body><w:p>", doc)


class ExportHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patches = [
            mock.patch.object(server.Handler, "config_file", Path(self.tmp.name) / "config.json"),
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
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def post(self, obj, header=True):
        r = urllib.request.Request(self.base + "/api/export/docx", data=json.dumps(obj).encode(), method="POST",
                                   headers={"Content-Type": "application/json", **({"X-Meeting-Scribe": "1"} if header else {})})
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                return resp.status, resp.headers.get("Content-Type"), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type"), e.read()

    def test_export_docx_endpoint(self):
        good = {"meeting": MID, "title": "週三個案會議", "markdown": SAMPLE}
        self.assertEqual(self.post(good, header=False)[0], 403)
        self.assertEqual(self.post({**good, "meeting": "x"})[0], 400)
        self.assertEqual(self.post({**good, "markdown": "  "})[0], 400)
        self.assertEqual(self.post({**good, "markdown": 3})[0], 400)
        with mock.patch.object(server, "DOCX_MAX_CHARS", 10):
            self.assertEqual(self.post(good)[0], 413)
        status, ctype, body = self.post({**good, "title": ["不是字串"]})
        self.assertEqual((status, ctype), (200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
        self.assertTrue(body.startswith(b"PK"))
        self.assertIn("週三個案會議", docx_parts(body)["word/document.xml"])
        # 單獨的代理字元（JSON 的 "\ud800"）：拿掉，不讓整份匯出失敗
        status, _, body = self.post({**good, "markdown": "# 標題\n壞掉的字\ud800在這裡"})
        self.assertEqual(status, 200)
        self.assertIn("壞掉的字在這裡", docx_parts(body)["word/document.xml"])


if __name__ == "__main__":
    unittest.main()
