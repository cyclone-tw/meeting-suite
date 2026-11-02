"""會議說明（#185）：使用者寫的會議背景，所有 AI 整理都帶上；AI 修正（原「更正名字」）不只改名字。"""
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

CTX = "主持人小美開場，四位老師輪流分享，每人約 10 分鐘，最後 Q&A。"
_TMP = tempfile.TemporaryDirectory()


def setUpModule():
    p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
    p.start()
    unittest.addModuleCleanup(p.stop)
    unittest.addModuleCleanup(_TMP.cleanup)


class CleanTest(unittest.TestCase):
    def test_clean_meeting_context(self):
        self.assertEqual(server.clean_meeting_context(f"  {CTX}\n第二行\t \n"), f"{CTX}\n第二行")
        self.assertEqual(server.clean_meeting_context(""), "")
        self.assertEqual(server.clean_meeting_context("a\x00b\x1bc"), "abc", "控制字元拿掉，換行留著")
        self.assertIsNone(server.clean_meeting_context(3))
        self.assertIsNone(server.clean_meeting_context("字" * (server.CONTEXT_MAX + 1)))
        self.assertEqual(len(server.clean_meeting_context("字" * server.CONTEXT_MAX)), server.CONTEXT_MAX)

    def test_draft_meta_keeps_context(self):
        base = {"title": "t", "place": "", "engine": "soniox", "state": "recording", "started_at": 1, "duration_ms": 0}
        self.assertEqual(server.parse_draft_meta(base)["context"], "", "舊暫存沒有說明")
        self.assertEqual(server.parse_draft_meta({**base, "context": CTX})["context"], CTX)
        for bad in (3, "字" * (server.CONTEXT_MAX + 1)):
            with self.assertRaises(ValueError):
                server.parse_draft_meta({**base, "context": bad})


class PromptTest(unittest.TestCase):
    def test_context_prompt_leaves_the_faithful_transcript_alone(self):
        p = server.CONTEXT_PROMPT.format(context=CTX)
        self.assertIn("corrected", p, "說清楚逐字稿校正不受說明影響")
        self.assertIn("講者標記", p)


class SessionTest(unittest.TestCase):
    def make(self):
        log = Path(tempfile.mkdtemp()) / "prompts.jsonl"
        p = mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_PROMPT_LOG": str(log)})
        p.start()
        self.addCleanup(p.stop)
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        return s, log

    def prompts(self, log):
        return [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []

    def para(self, s, idx):
        s.add_paragraph(idx, idx * 1000, idx * 1000 + 900, f"講者 1：第{idx}段")
        wait_for(s, lambda g: sum(e["type"] == "para" for e in g) >= idx)

    def test_context_is_sent_once_and_again_when_changed_or_cleared(self):
        s, log = self.make()
        s.set_context(CTX)
        self.para(s, 1)
        self.para(s, 2)
        s.set_context("改成三位老師分享")
        self.para(s, 3)
        s.set_context("")
        self.para(s, 4)
        p = [x for x in self.prompts(log) if "段逐字稿" in x]
        self.assertIn("<meeting_context>", p[0])
        self.assertIn(CTX, p[0])
        self.assertIn("講者 N", p[0], "說明「講者 N」是聲音分的編號")
        self.assertNotIn("<meeting_context>", p[1], "沒改就不重送")
        self.assertIn("改成三位老師分享", p[2])
        self.assertNotIn("<meeting_context>", p[3])
        self.assertIn("會議說明清掉了", p[3], "清空也要告訴 AI")

    def test_no_context_sends_nothing_extra(self):
        s, log = self.make()
        self.para(s, 1)
        self.assertNotIn("<meeting_context>", self.prompts(log)[0])
        self.assertNotIn("會議說明清掉了", self.prompts(log)[0])

    def test_context_is_sent_again_after_the_process_restarts(self):
        s, log = self.make()
        s.set_context(CTX)
        self.para(s, 1)
        s.proc.kill()
        s.proc.wait()
        self.para(s, 2)
        p = [x for x in self.prompts(log) if "段逐字稿" in x]
        self.assertIn(CTX, p[1], "新程序沒看過說明，要再送")

    def test_codex_gets_the_context_every_time(self):
        s, _ = self.make()
        self.assertNotIn("<meeting_context>", s._codex_prompt("題目"))
        s.set_context(CTX)
        self.assertIn(CTX, s._codex_prompt("題目"))
        self.assertIn(CTX, s._codex_prompt("下一題"))

    def test_post_meeting_outputs_carry_the_context(self):
        s, log = self.make()
        s.set_context(CTX)
        paras = [(0, "主持人開場")]
        s.mindmap_from_paragraphs(paras)
        self.assertIn(CTX, self.prompts(log)[-1])
        self.assertIn("整理成一張心智圖", self.prompts(log)[-1])


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.log = Path(tempfile.mkdtemp()) / "prompts.jsonl"
        self.hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE))
        patches = [
            mock.patch.object(server.Handler, "hub", self.hub),
            mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: True)),
            mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_PROMPT_LOG": str(self.log)}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [s.close() for s in self.hub.sessions.values()])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def post(self, path, obj):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def prompts(self):
        return [json.loads(x) for x in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def test_para_sets_the_context_and_a_bad_one_is_ignored(self):
        good = {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一段", "context": CTX}
        self.assertEqual(self.post("/api/agent/para", good)[0], 202)
        self.assertEqual(self.hub.sessions[MID].context, CTX)
        self.assertEqual(self.post("/api/agent/para", {**good, "idx": 2, "context": 3})[0], 202, "格式不對就不更新，段落照收")
        self.assertEqual(self.hub.sessions[MID].context, CTX)

    def test_regenerated_outputs_and_ai_fixes_carry_the_context(self):
        paras = [{"start": 0, "text": "書上學生進步很多"}]
        status, _ = self.post("/api/agent/summary", {"meeting": MID, "paras": paras, "kind": "mindmap", "context": CTX})
        self.assertEqual(status, 200)
        self.assertIn(CTX, self.prompts()[-1])
        status, body = self.post("/api/agent/names", {"meeting": MID, "request": "心智圖裡的書上是學障", "text": "書上學生", "context": CTX})
        self.assertEqual(status, 200, body)
        last = self.prompts()[-1]
        self.assertIn(CTX, last)
        self.assertIn("講者的稱呼", last, "AI 修正的提示不只講名字")
        self.assertNotIn("被語音辨識聽錯了。使用者的說明", last, "不再只講名字聽錯")
        self.assertEqual(self.post("/api/agent/summary", {"meeting": MID, "paras": paras, "context": "字" * (server.CONTEXT_MAX + 1)})[0], 400)


class CliTest(unittest.TestCase):
    def test_local_summary_entry_takes_a_context(self):
        import io
        log = Path(tempfile.mkdtemp()) / "prompts.jsonl"
        cfg = Path(tempfile.mkdtemp()) / "config.json"
        cfg.write_text("{}", encoding="utf-8")
        with mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_PROMPT_LOG": str(log)}):
            out = io.StringIO()
            code = server.cli_summary(io.StringIO(json.dumps({"paras": [{"start": 0, "text": "主持人開場"}], "module": "mindmap", "context": CTX}, ensure_ascii=False)),
                                      out, config_file=cfg, ready=lambda: True, factory=lambda mid: server.AgentSession(mid, command=FAKE))
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn(CTX, json.loads(log.read_text(encoding="utf-8").splitlines()[-1]))
        out = io.StringIO()
        code = server.cli_summary(io.StringIO(json.dumps({"paras": [{"start": 0, "text": "x"}], "context": 3})), out, config_file=cfg,
                                  ready=lambda: True, factory=lambda mid: server.AgentSession(mid, command=FAKE))
        self.assertEqual(code, 2, "說明格式不對是輸入錯誤")


if __name__ == "__main__":
    unittest.main()
