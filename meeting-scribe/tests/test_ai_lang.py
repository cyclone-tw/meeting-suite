"""AI 產出語言（#202）：一場會議開始時決定，整場固定。中文照舊；英文時系統提示要英文整理結果，逐字稿校正照原本的語言。"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from test_agent import FAKE, MID, wait_for  # noqa: E402

_TMP = tempfile.TemporaryDirectory()


def setUpModule():
    p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
    p.start()
    unittest.addModuleCleanup(p.stop)
    unittest.addModuleCleanup(_TMP.cleanup)


class PromptTest(unittest.TestCase):
    def test_default_is_the_old_chinese_prompt(self):
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        self.assertEqual(s.lang, "zh")
        self.assertIn("一律使用台灣繁體中文與台灣用語", s.system_prompt)
        self.assertNotIn("輸出語言：英文", s.system_prompt)

    def test_english_prompt_keeps_the_transcript_language(self):
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        self.assertEqual(s.set_lang("en"), "en")
        self.assertIn("輸出語言：英文", s.system_prompt)
        self.assertNotIn("一律使用台灣繁體中文", s.system_prompt)
        self.assertIn("corrected、readable", s.system_prompt, "逐字稿校正照原本說的語言")
        self.assertIn("未開始、進行中、已完成", s.system_prompt, "會議紀錄的狀態值不翻（clean_minutes 只認這三個）")

    def test_real_command_carries_the_english_prompt(self):
        s = server.AgentSession(MID)
        self.addCleanup(s.close)
        s.set_lang("en")
        self.assertEqual(s.command[s.command.index("--system-prompt") + 1], s.system_prompt)

    def test_bad_values_are_ignored(self):
        for v in (None, "EN", "ja", 1, ""):
            self.assertIsNone(server.clean_ai_lang(v), v)
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        self.assertEqual(s.set_lang(None), "zh")

    def test_language_is_fixed_once_the_meeting_started(self):
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        s.add_paragraph(1, 0, 10, "第一段", polish=False)
        wait_for(s, lambda got: any(e.get("type") == "para" for e in got))
        self.assertEqual(s.set_lang("en"), "zh", "已經開始整理就不換：中途切介面不影響這場")
        self.assertNotIn("輸出語言：英文", s.system_prompt)

    def test_language_is_fixed_once_the_process_started(self):
        # 程序已經開了、還沒有任何事件的空檔也不換（#204）
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        s.proc = object()
        try:
            self.assertEqual(s.set_lang("en"), "zh")
        finally:
            s.proc = None
        self.assertNotIn("輸出語言：英文", s.system_prompt)

    def test_codex_fallback_uses_the_language(self):
        # Codex 備援沒有對話記憶，每題都帶系統說明：換了語言，送給 Codex 的也是英文規則
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        s.set_lang("en")
        prompt = s._codex_prompt("問題")
        self.assertIn("輸出語言：英文", prompt)
        self.assertNotIn("一律使用台灣繁體中文", prompt)

    def test_draft_meta_keeps_the_language(self):
        base = {"title": "t", "place": "", "engine": "", "started_at": 1, "duration_ms": 0, "state": "done"}
        self.assertEqual(server.parse_draft_meta({**base, "ai_lang": "en"})["ai_lang"], "en")
        self.assertNotIn("ai_lang", server.parse_draft_meta(base), "舊暫存沒有，當中文")
        self.assertNotIn("ai_lang", server.parse_draft_meta({**base, "ai_lang": "fr"}))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.made = []

        def factory(mid):
            self.made.append(server.AgentSession(mid, command=FAKE))
            return self.made[-1]
        self.hub = server.AgentHub(factory=factory)
        for p in (mock.patch.object(server.Handler, "hub", self.hub),
                  mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: True)),
                  mock.patch.dict(os.environ, {"FAKE_MODE": ""})):
            p.start()
            self.addCleanup(p.stop)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [s.close() for s in self.made])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def post(self, path, obj):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_para_sets_the_language_of_the_meeting(self):
        para = {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一段", "ai_lang": "en"}
        self.assertEqual(self.post("/api/agent/para", para)[0], 202)
        self.assertEqual(self.hub.sessions[MID].lang, "en")

    def test_post_meeting_outputs_follow_the_language(self):
        paras = [{"start": 0, "text": "書上學生進步很多"}]
        for body in ({"kind": "mindmap"}, {}, {"module": "sprout"}):
            path = "/api/agent/module" if "module" in body else "/api/agent/summary"
            status, got = self.post(path, {"meeting": MID, "paras": paras, "ai_lang": "en", **body})
            self.assertEqual(status, 200, got)
            self.assertEqual(self.made[-1].lang, "en", body)
        self.post("/api/agent/summary", {"meeting": MID, "paras": paras, "kind": "mindmap"})
        self.assertEqual(self.made[-1].lang, "zh", "沒帶就是中文")

    def test_builtin_module_title_follows_the_meeting_language(self):
        # 結果標題會變成 Drive 的檔名與標題：英文會議用英文（#204）
        paras = [{"start": 0, "text": "書上學生進步很多"}]
        status, en = self.post("/api/agent/module", {"meeting": MID, "paras": paras, "module": "sprout", "ai_lang": "en"})
        self.assertEqual(status, 200, en)
        self.assertEqual(en["title"], server.TRANSLATE_EN("讓這場會議發芽"))
        self.assertNotEqual(en["title"], "讓這場會議發芽")
        self.assertEqual(self.post("/api/agent/module", {"meeting": MID, "paras": paras, "module": "sprout"})[1]["title"], "讓這場會議發芽")


if __name__ == "__main__":
    unittest.main()
