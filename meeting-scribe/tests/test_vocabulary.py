"""共用用詞正本（#140）：轉錄用詞的 Markdown 筆記，解析規則同 recording-transcriber 的 lib/vocabulary.mjs。"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_claude.py")]
NOTE = """---
type: Reference
---

# 轉錄用詞正本

說明文字不算。

## 四類怎麼用

- 這段 → 不收

## 領域詞與專有名詞

資源教室、IEP（個別化教育計畫）, OpenAB
- Hermes，Cyclone

## 固定替換（所有工具一律換）

### 英文

- Cloud Code → Claude Code
- Remy → Remi
- Cyclon → Cyclone

### 中文

- 下周 → 下週
- 學長 → 學障（講到學生類別時）
- 他 → 它
- 寫成箭頭 -> 不收

## 口述替換（ZeroType 一律換；其他交給 AI 判斷）

- 開一修 → 開 issue

## 誤聽對照（AI 依上下文判斷）

- 思妤 → 詩妤
"""


class ParseTest(unittest.TestCase):
    def test_sections(self):
        v = server.parse_shared_vocabulary(NOTE)
        self.assertEqual(v["terms"], ["資源教室", "IEP", "OpenAB", "Hermes", "Cyclone"], "、，, 都能分隔，備註拿掉，- 開頭也收")
        self.assertEqual(v["fixed"], [("Cloud Code", "Claude Code"), ("Remy", "Remi"), ("Cyclon", "Cyclone"), ("下周", "下週")],
                         "### 小標題只是分組；帶備註、一個中文字的錯字不字面取代；-> 不收")
        self.assertEqual(v["hints"], [("學長", "學障", "講到學生類別時"), ("他", "它", ""), ("開一修", "開 issue", ""), ("思妤", "詩妤", "")],
                         "口述替換在會議 App 給 AI 參考")

    def test_missing_fixed_section_means_broken(self):
        self.assertIsNone(server.parse_shared_vocabulary(NOTE.replace("## 固定替換", "## 一定換")))
        self.assertIsNone(server.parse_shared_vocabulary("### 固定替換\n- 下周 → 下週\n"), "### 不算換段")


class ApplyFixedTest(unittest.TestCase):
    def test_word_edges_no_cascade_and_protected_targets(self):
        fixed = [("Remy", "Remi"), ("Cyclon", "Cyclone"), ("甲乙", "丙丁"), ("丙丁", "戊己"), ("Cloud", "Claude"), ("Cloud Code", "Claude Code")]
        self.assertEqual(server.apply_fixed("Remy 和 XRemy、Remyx", fixed), "Remi 和 XRemy、Remyx", "英文只在字的邊界比對")
        self.assertEqual(server.apply_fixed("Cyclone 與 Cyclon", fixed), "Cyclone 與 Cyclone", "正確寫法不會被改到")
        self.assertEqual(server.apply_fixed("甲乙", fixed), "丙丁", "不會連鎖替換")
        self.assertEqual(server.apply_fixed("用 Cloud Code 寫", fixed), "用 Claude Code 寫", "長的先比")
        self.assertEqual(server.apply_fixed("下周一開會", [("下周", "下週"), ("周一", "週一")]), "下週一開會")
        self.assertEqual(server.apply_fixed("學長", [("學長", "學障"), ("學長", "學長們")]), "學長們", "同一個錯字以後面的為準")
        self.assertEqual(server.apply_fixed("", fixed), "")
        self.assertEqual(server.apply_fixed("不變", []), "不變")


class SplitTest(unittest.TestCase):
    def test_buckets(self):
        vocab = {"terms": [], "fixed": [("X 錯", "甲")], "hints": [("X 錯", "乙", ""), ("Y 錯", "丙", ""), ("Y 錯", "丁", "")]}
        data = {"hints": [["X 錯", "乙"], ["Y 錯", "丁"], ["Z 錯", "戊"]], "fixed": [["X 錯", "乙"], ["X 錯", "甲"], ["Y 錯", "己"]]}
        used, pending, conflicts = server.split_corrections(data, vocab)
        self.assertEqual(used, {"hints": [["Y 錯", "丁"], ["Z 錯", "戊"]], "fixed": [["X 錯", "甲"]]})
        self.assertEqual(pending, {"hints": [["Z 錯", "戊"]], "fixed": []})
        self.assertEqual(conflicts, {"hints": [["X 錯", "乙", "甲"]], "fixed": [["X 錯", "乙", "甲"], ["Y 錯", "己", "丙"]]},
                         "正本有固定替換就只認那一個：AI 參考裡的別的寫法不能讓這台的蓋過去")

    def test_no_vocabulary_uses_everything(self):
        data = {"hints": [["思妤", "詩妤"]], "fixed": [["下周", "下週"]]}
        used, pending, conflicts = server.split_corrections(data, None)
        self.assertEqual((used, pending, conflicts), (data, data, {"hints": [], "fixed": []}))


class LoadTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.tmp = Path(d.name)
        self.good = self.tmp / "good.md"
        self.good.write_text(NOTE, encoding="utf-8")
        self.broken = self.tmp / "broken.md"
        self.broken.write_text(NOTE.replace("## 固定替換", "## 一定換"), encoding="utf-8")
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"vocabulary_files": [str(self.tmp / "missing.md"), str(self.broken), str(self.good)]}), encoding="utf-8")

    def test_first_good_candidate_and_reload(self):
        v = server.load_vocabulary(self.cfg)
        self.assertEqual(v["terms"][0], "資源教室", "缺的、壞的不擋住後面好的那份")
        self.assertEqual(len(v["sha256"]), 64)
        self.good.write_text(NOTE.replace("資源教室、", "資源班、"), encoding="utf-8")
        os.utime(self.good, ns=(1, 1))
        self.assertEqual(server.load_vocabulary(self.cfg)["terms"][0], "資源班", "檔案變了就重讀")

    def test_symlink_switch_to_new_snapshot(self):
        # 搜尋副本：current 連結換到新快照，檔案大小與修改時間剛好一樣也要讀新的
        a, b = self.tmp / "snap-a.md", self.tmp / "snap-b.md"
        a.write_text(NOTE, encoding="utf-8")
        b.write_text(NOTE.replace("資源教室、", "資源班班、"), encoding="utf-8")
        os.utime(a, ns=(5, 5))
        os.utime(b, ns=(5, 5))
        cur = self.tmp / "current.md"
        cur.symlink_to(a)
        self.cfg.write_text(json.dumps({"vocabulary_files": [str(cur)]}), encoding="utf-8")
        self.assertEqual(server.load_vocabulary(self.cfg)["terms"][0], "資源教室")
        cur.unlink()
        cur.symlink_to(b)
        self.assertEqual(server.load_vocabulary(self.cfg)["terms"][0], "資源班班")

    def test_no_config_or_all_broken_falls_back(self):
        self.assertIsNone(server.load_vocabulary(self.tmp / "none.json"))
        self.cfg.write_text(json.dumps({"vocabulary_files": [str(self.broken), 3]}), encoding="utf-8")
        self.assertIsNone(server.load_vocabulary(self.cfg))
        self.good.write_bytes(b"\xff\xfe")
        self.cfg.write_text(json.dumps({"vocabulary_files": [str(self.good)]}), encoding="utf-8")
        self.assertIsNone(server.load_vocabulary(self.cfg), "讀不出 UTF-8 也當沒有")

    def test_session_uses_shared_note_then_local_corrections(self):
        store = server.CorrectionStore(self.tmp / "c.json")
        store.save({"hints": [["思語", "詩妤"], ["思妤", "思學"]], "fixed": [["Cloud Code", "Claude"], ["Quad Code", "Claude Code"], ["新錯字", "新寫法"]]})
        with mock.patch.object(server.Handler, "config_file", self.cfg):
            s = server.AgentSession("0" * 32, command=FAKE, corrections=store)
        self.addCleanup(s.close)
        self.assertIn(("下周", "下週"), s.fixed)
        self.assertNotIn(("上周", "上週"), s.fixed, "有正本就不用 repo 的 glossary.md")
        self.assertEqual(server.apply_fixed("Cloud Code 和新錯字", s.fixed), "Claude Code 和新寫法", "這台加的接在後面；和正本衝突的不用，以正本為準（#148）")
        self.assertIn(("Quad Code", "Claude Code"), s.fixed, "和正本一樣的照用")
        self.assertNotIn("- 思妤 → 思學", s.system_prompt, "衝突的 AI 參考也不用")
        for text in ("資源教室、IEP、OpenAB、Hermes、Cyclone", "- 學長 → 學障（講到學生類別時）", "- 開一修 → 開 issue", "- 思妤 → 詩妤", "- 思語 → 詩妤"):
            self.assertIn(text, s.system_prompt)
        with mock.patch.object(server.Handler, "config_file", self.tmp / "none.json"):
            s2 = server.AgentSession("1" * 32, command=FAKE, corrections=store)
        self.addCleanup(s2.close)
        self.assertIn(("上周", "上週"), s2.fixed, "讀不到正本就照舊用 glossary.md")

    def test_speaker_labels_never_become_corrections(self):
        # #198：「講者 1 → 某人」只對那一場有意義；存進對照會把之後每一場的講者一都改成同一個人
        bad = [["講者 1", "小美"], ["講者2", "阿明"], ["講者一", "小美"], ["說話者 3", "小華"], ["Speaker 4", "Amy"], [" 講者５", "小華"]]
        path = self.tmp / "c.json"
        path.write_text(json.dumps({"hints": bad + [["思語", "詩妤"]], "fixed": [["講者 1", "小美"], ["下周", "下週"]]}, ensure_ascii=False), encoding="utf-8")
        store = server.CorrectionStore(path)
        self.assertEqual(store.load(), {"hints": [["思語", "詩妤"]], "fixed": [["下周", "下週"]]}, "舊檔裡的講者對應讀進來就略過")
        saved = store.save({"hints": bad + [["講者會議", "講座會議"]], "fixed": []})
        self.assertEqual(saved["hints"], [["講者會議", "講座會議"]], "存檔時丟掉講者對應；「講者」後面不是編號的照留")
        self.assertNotIn("小美", path.read_text(encoding="utf-8"))
        v = server.parse_shared_vocabulary(NOTE + "\n- 講者 1 → 小美\n")
        self.assertFalse(any(w.startswith("講者") for w, *_ in v["hints"] + v["fixed"]), "共用正本裡的講者對應也不用")

    def test_corrections_endpoint_reports_pending(self):
        store = server.CorrectionStore(self.tmp / "c.json")
        store.save({"hints": [["思妤", "詩妤"], ["詩語", "詩妤"], ["學長", "學弟"]], "fixed": [["下周", "下週"], ["Quad Code", "Claude Code"], ["Cloud Code", "Claude"]]})
        patches = [mock.patch.object(server.Handler, "config_file", self.cfg), mock.patch.object(server, "CORRECTIONS", store)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/api/corrections", timeout=10) as r:
            got = json.loads(r.read())
        self.assertEqual(got["pending"], {"hints": [["詩語", "詩妤"]], "fixed": [["Quad Code", "Claude Code"]]}, "正本已經有的、衝突的都不算待收回")
        self.assertEqual(got["conflicts"], {"hints": [["學長", "學弟", "學障"]], "fixed": [["Cloud Code", "Claude", "Claude Code"]]},
                         "同一個錯字、寫法不同：列出這台與正本的寫法")
        self.assertEqual(got["terms"][:2], ["資源教室", "IEP"])
        self.assertEqual((got["vocabulary"]["source"], got["vocabulary"]["fixed"]), ("shared", 4))
        self.assertEqual(len(got["hints"]) + len(got["fixed"]), 6, "這台的對照照舊整份回傳")


if __name__ == "__main__":
    unittest.main()
