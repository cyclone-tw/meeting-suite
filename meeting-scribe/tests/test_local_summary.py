"""本機會後整理入口（#139）：不開伺服器，stdin 進、stdout 出，格式和 POST /api/agent/module 一樣。"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_pack  # noqa: E402

HERE = Path(__file__).resolve().parent
FAKE = [sys.executable, str(HERE / "fake_claude.py")]
FAKE_CODEX = [sys.executable, str(HERE / "fake_codex.py")]
PARAS = [{"start": 1000, "text": "書上的學生下周再談"}, {"start": 6000, "text": "導師會準備評量清單"}]


class LocalSummaryTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.tmp = Path(d.name)
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"packs": [str(fake_pack.make_pack(self.tmp / "pack"))]}), encoding="utf-8")
        for p in (mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(self.tmp / "none.json")),
                  mock.patch.object(server, "CLAUDE_DOWN", [0.0]),
                  mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_CODEX_MODE": ""})):
            p.start()
            self.addCleanup(p.stop)

    def run_cli(self, body, mode="", fallback=False, ready=True):
        os.environ["FAKE_MODE"] = mode
        codex = lambda wd: FAKE_CODEX + server.codex_command(wd, codex="codex")[1:]
        out = io.StringIO()
        raw = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        code = server.cli_summary(io.StringIO(raw), out, config_file=self.cfg, ready=lambda: ready,
                                  factory=lambda mid: server.AgentSession(mid, command=FAKE, fallback=fallback or False, codex=codex))
        return code, json.loads(out.getvalue())

    def test_summary_matches_api_format(self):
        code, got = self.run_cli({"paras": PARAS})
        self.assertEqual(code, 0, got)
        self.assertEqual(got["module"], "summary")
        for k in ("intro", "chapters", "full", "short", "usage"):
            self.assertIn(k, got)
        self.assertTrue(got["intro"].startswith("重產："), "用的是會後重新總結的提示詞")

    def test_module(self):
        code, got = self.run_cli({"paras": PARAS, "module": "perspective", "options": {"who": "sped"}})
        self.assertEqual((code, got["title"], got["options"]), (0, "視角回饋：特教專家", {"who": "sped"}))
        self.assertIn("下週再談", got["markdown"], "常錯字對照的固定替換照樣套用")
        code, got = self.run_cli({"paras": PARAS, "module": "test-module"})
        self.assertEqual((code, got["title"]), (0, "測試模組：溫和"), "讀得到設定檔裡的擴充包")
        code, got = self.run_cli({"paras": PARAS, "module": "mindmap"})
        self.assertEqual((code, got["module"], got["mindmap"]["center"]), (0, "mindmap", "IEP 會議"), "心智圖也能在本機跑（#150）")
        self.assertTrue(got["mermaid"].startswith("mindmap\n") and got["opml"].startswith("<?xml") and got["markdown"].startswith("# 心智圖："))

    def test_claude_down_switches_to_codex(self):
        code, got = self.run_cli({"paras": PARAS}, mode="limit", fallback="codex")
        self.assertEqual((code, got["intro"]), (0, "codex 導言"))
        code, got = self.run_cli({"paras": PARAS}, mode="limit")
        self.assertEqual(code, 1, "沒設備援就照實回報失敗")
        self.assertIn("AI 整理失敗", got["error"])

    def test_bad_input(self):
        for body in ("不是 JSON", "[]", {"paras": []}, {"paras": [{"start": "0", "text": "x"}]},
                     {"paras": PARAS, "module": "nope"}, {"paras": PARAS, "module": "perspective", "options": {"who": "cat"}}):
            with self.subTest(body=body):
                code, got = self.run_cli(body)
                self.assertEqual(code, 2)
                self.assertIn("error", got)
        code, got = self.run_cli({"paras": [{"start": 0, "text": "字" * (server.MAX_SUMMARY_CHARS + 1)}]})
        self.assertEqual((code, got["error"]), (2, "逐字稿太長，無法一次總結"))
        code, got = self.run_cli({"paras": PARAS}, ready=False)
        self.assertEqual(code, 3)

    def test_command_line_utf8_round_trip(self):
        # 真的用 `python3 -I server.py summary` 跑一次：C 語系下中文照樣進出；設定檔與常錯字對照由環境變數指定
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(self.tmp), "LC_ALL": "C", "LANG": "C",
               "MEETING_SCRIBE_CONFIG": str(self.tmp / "none.json"), "MEETING_SCRIBE_CORRECTIONS": str(self.tmp / "none.json")}
        r = subprocess.run([sys.executable, "-I", str(HERE.parent / "server.py"), "summary"], env=env, capture_output=True,
                           input=json.dumps({"paras": []}, ensure_ascii=False).encode(), timeout=30)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(json.loads(r.stdout.decode("utf-8")), {"error": "沒有段落可以總結"})


if __name__ == "__main__":
    unittest.main()
