"""Linux 主機與 Codex 備援（#108）：Claude 不能用時改用 Codex、同時整理上限與排隊、本機 Whisper 在 Linux 上不可用。"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

HERE = Path(__file__).resolve().parent
FAKE = [sys.executable, str(HERE / "fake_claude.py")]
FAKE_CODEX = [sys.executable, str(HERE / "fake_codex.py")]
MID = "0123456789abcdef0123456789abcdef"
_TMP = tempfile.TemporaryDirectory()


def setUpModule():
    p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
    p.start()
    unittest.addModuleCleanup(p.stop)
    unittest.addModuleCleanup(_TMP.cleanup)


def wait_for(session, pred, timeout=15):
    seq, got = 0, []
    deadline = time.time() + timeout
    while time.time() < deadline:
        events, _ = session.wait(seq, 0.5)
        for n, e in events:
            got.append(e)
            seq = n
        if pred(got):
            return got
    raise AssertionError(f"沒等到預期事件：{got}")


def fake_codex(workdir):
    # 用真的 codex_command 組參數，只把執行檔換成假的，測得到隔離參數
    return FAKE_CODEX + server.codex_command(workdir, codex="codex")[1:]


class CodexCommandTest(unittest.TestCase):
    def test_isolated_flags_and_stdin_prompt(self):
        cmd = server.codex_command("/tmp/wd", model="gpt-x", disable=("shell_tool", "apps"), codex="/bin/codex")
        self.assertEqual(cmd[:2], ["/bin/codex", "exec"])
        for flag in ("--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[cmd.index("--sandbox") + 1], "read-only")
        self.assertIn("mcp_servers={}", cmd)
        self.assertEqual([cmd[i + 1] for i, x in enumerate(cmd) if x == "--disable"], ["shell_tool", "apps"])
        self.assertEqual(cmd[cmd.index("--model") + 1], "gpt-x")
        self.assertEqual(cmd[-3:], ["--cd", "/tmp/wd", "-"])

    def test_default_disables_tools_and_no_model(self):
        cmd = server.codex_command("/wd", codex="c")
        self.assertEqual([cmd[i + 1] for i, x in enumerate(cmd) if x == "--disable"], list(server.DEFAULT_CODEX_DISABLE))
        self.assertNotIn("--model", cmd)


class SettingsTest(unittest.TestCase):
    def write(self, obj):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        p = Path(d.name) / "config.json"
        p.write_text(json.dumps(obj) if not isinstance(obj, str) else obj, encoding="utf-8")
        return p

    def test_defaults(self):
        for cfg in (self.write({}), self.write("壞掉"), Path(_TMP.name) / "missing.json"):
            got = server.load_agent_settings(cfg)
            self.assertIsNone(got["fallback"])
            self.assertEqual(got["max_concurrent"], server.MAX_SESSIONS)
            self.assertEqual(got["codex_disable"], list(server.DEFAULT_CODEX_DISABLE))

    def test_valid_values(self):
        got = server.load_agent_settings(self.write({"agent_fallback": "codex", "codex_model": "gpt-6-luna",
                                                     "codex_disable": ["shell_tool"], "max_concurrent_agents": 3}))
        self.assertEqual(got, {"fallback": "codex", "codex_model": "gpt-6-luna", "codex_disable": ["shell_tool"], "max_concurrent": 3})

    def test_bad_values_ignored(self):
        got = server.load_agent_settings(self.write({"agent_fallback": "gemini", "codex_model": "x; rm -rf /",
                                                     "codex_disable": ["ok", "--dangerous"], "max_concurrent_agents": 99}))
        self.assertIsNone(got["fallback"])
        self.assertIsNone(got["codex_model"])
        self.assertEqual(got["codex_disable"], list(server.DEFAULT_CODEX_DISABLE))
        self.assertEqual(got["max_concurrent"], server.MAX_SESSIONS)
        self.assertEqual(server.load_agent_settings(self.write({"max_concurrent_agents": True}))["max_concurrent"], server.MAX_SESSIONS)


class ErrorKindTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(server.claude_error_kind({"result": "Claude AI usage limit reached|1760000000"}), "limit")
        self.assertEqual(server.claude_error_kind({"result": "", "api_error_status": 429}), "limit")
        self.assertEqual(server.claude_error_kind({"result": "API Error: 529 overloaded"}), "limit")
        self.assertEqual(server.claude_error_kind({"result": "Invalid API key · Please run /login"}), "auth")
        self.assertEqual(server.claude_error_kind({"result": "OAuth token has expired"}), "auth")
        self.assertIsNone(server.claude_error_kind({"result": "Prompt is too long: 250000 tokens"}))
        self.assertIsNone(server.claude_error_kind({"result": "", "subtype": "error_during_execution"}))


class EnvTest(unittest.TestCase):
    def test_codex_gets_no_claude_or_soniox_secrets(self):
        env = {"PATH": "/bin", "CLAUDE_CODE_OAUTH_TOKEN": "t", "ANTHROPIC_API_KEY": "k", "SONIOX_API_KEY": "s", "HOME": "/h"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(server.agent_env("codex"), {"PATH": "/bin", "HOME": "/h"})
            claude = server.agent_env("claude")
        self.assertEqual(claude["CLAUDE_CODE_OAUTH_TOKEN"], "t")
        self.assertNotIn("SONIOX_API_KEY", claude)


class FallbackSessionTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.log = Path(d.name) / "codex.jsonl"
        for p in (mock.patch.object(server, "CLAUDE_DOWN", [0.0]),
                  mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_CODEX_MODE": "", "FAKE_CODEX_LOG": str(self.log)})):
            p.start()
            self.addCleanup(p.stop)

    def make(self, mode="", fallback="codex", command=FAKE):
        os.environ["FAKE_MODE"] = mode
        s = server.AgentSession(MID, command=command, fallback=fallback, codex=fake_codex)
        self.addCleanup(s.close)
        return s

    def calls(self):
        return [json.loads(x) for x in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def test_claude_ok_never_calls_codex(self):
        s = self.make("")
        s.add_paragraph(1, 0, 5000, "書上學生")
        got = wait_for(s, lambda g: any(e["type"] == "para" for e in g))
        para = next(e for e in got if e["type"] == "para")
        self.assertFalse(para["corrected"].startswith("codex:"))
        self.assertEqual(s.engine, "claude")
        self.assertEqual(self.calls(), [])

    def test_switches_on_limit_auth_death_and_start_failure(self):
        cases = [("limit", FAKE, "limit"), ("auth", FAKE, "auth"), ("die", FAKE, "died"),
                 ("", [str(Path(_TMP.name) / "no-such-claude")], "start")]
        for mode, command, reason in cases:
            with self.subTest(reason=reason):
                server.CLAUDE_DOWN[0] = 0.0
                s = self.make(mode, command=command)
                s.add_paragraph(1, 0, 5000, "書上學生")
                got = wait_for(s, lambda g: any(e["type"] == "para" for e in g))
                para = next(e for e in got if e["type"] == "para")
                self.assertNotIn("error", para)
                self.assertEqual(para["corrected"], "codex:書上學生", "同一段改用 Codex 重問")
                status = [e for e in got if e["type"] == "status"]
                self.assertEqual(status, [{"type": "status", "state": "running", "engine": "codex", "reason": reason}])
                self.assertEqual(s.engine, "codex")
                self.assertEqual(server.CLAUDE_DOWN[0] > time.monotonic(), reason != "died", "只有額度、登入、起不來才讓新會議直接用 Codex")
                s.close()

    def test_no_fallback_keeps_old_error(self):
        s = self.make("limit", fallback=False)
        s.add_paragraph(1, 0, 1, "一")
        got = wait_for(s, lambda g: any("error" in e for e in g))
        self.assertIn("AI 整理失敗", got[-1]["error"])
        self.assertEqual(self.calls(), [])

    def test_both_fail_says_so(self):
        os.environ["FAKE_CODEX_MODE"] = "fail"
        s = self.make("limit")
        s.add_paragraph(1, 0, 1, "一")
        got = wait_for(s, lambda g: any("error" in e for e in g))
        self.assertEqual(got[-1]["error"], "AI 整理失敗（Claude 不能用，改用 Codex 也失敗）")

    def test_codex_timeout(self):
        os.environ["FAKE_CODEX_MODE"] = "hang"
        with mock.patch.object(server, "TURN_TIMEOUT", 1):
            s = self.make("limit")
            s.add_paragraph(1, 0, 1, "一")
            got = wait_for(s, lambda g: any("error" in e for e in g))
        self.assertIn("TimeoutError", got[-1]["error"])

    def test_codex_isolated_and_gets_history(self):
        secrets_env = {"CLAUDE_CODE_OAUTH_TOKEN": "tok", "SONIOX_API_KEY": "son", "ANTHROPIC_API_KEY": "ak"}
        with mock.patch.dict(os.environ, secrets_env):
            s = self.make("")
            s.add_paragraph(1, 0, 5000, "第一段書上")
            wait_for(s, lambda g: any(e["type"] == "para" for e in g))
            # Claude 中途掛掉：下一段重開程序時就結束，改用 Codex
            os.environ["FAKE_MODE"] = "die"
            s._stop_proc()
            s.add_paragraph(2, 5000, 9000, "第二段")
            got = wait_for(s, lambda g: any(e.get("type") == "para" and e.get("idx") == 2 for e in g))
        self.assertEqual(next(e for e in got if e.get("idx") == 2)["corrected"], "codex:第二段")
        call = self.calls()[0]
        self.assertEqual(call["leaked"], [], "Codex 拿不到 Claude token、Soniox 與 Anthropic 金鑰")
        self.assertEqual(call["files"], [], "在空的工作目錄跑")
        self.assertFalse(os.path.exists(call["cwd"]), "跑完刪掉工作目錄")
        self.assertIn("--ignore-user-config", call["argv"])
        self.assertTrue(call["prompt"].startswith(server.CODEX_PREAMBLE))
        self.assertIn("第一段書上", call["prompt"], "前文帶過去")
        self.assertIn("<assistant>", call["prompt"])
        self.assertIn("第二段", call["prompt"].rsplit("</assistant>", 1)[-1], "這一題放在前文後面")

    def test_long_history_falls_back_to_notes(self):
        s = self.make("")
        s.history = [("舊題" + "字" * 100, "舊答")] * 5
        s.notes = ["- 第 1 段：很早的重點"]
        with mock.patch.object(server, "CODEX_HISTORY_CHARS", 250):
            prompt = s._codex_prompt("這一題")
        self.assertIn("很早的重點", prompt, "太早的前文只帶各段重點")
        self.assertEqual(prompt.count("<user>\n"), 2, "只留最近兩題")
        self.assertTrue(prompt.endswith("這一題"))

    def test_cooldown_new_meeting_starts_on_codex(self):
        server.CLAUDE_DOWN[0] = time.monotonic() + 60
        s = self.make("")
        got = wait_for(s, lambda g: any(e["type"] == "status" for e in g))
        self.assertEqual(got[0]["reason"], "cooldown")
        s.add_paragraph(1, 0, 5000, "書上")
        got = wait_for(s, lambda g: any(e["type"] == "para" for e in g))
        self.assertEqual(next(e for e in got if e["type"] == "para")["corrected"], "codex:書上")
        server.CLAUDE_DOWN[0] = time.monotonic() + 60
        self.assertEqual(self.make("", fallback=False).engine, "claude", "沒開備援就不受影響")

    def test_summary_and_one_shot_use_codex(self):
        s = self.make("limit")
        s.add_paragraph(1, 0, 5000, "書上")
        wait_for(s, lambda g: any(e["type"] == "para" for e in g))
        s.end()
        got = wait_for(s, lambda g: any(e["type"] == "done" for e in g))
        self.assertEqual(next(e for e in got if e["type"] == "summary")["intro"], "codex 導言")
        server.CLAUDE_DOWN[0] = 0.0
        one = self.make("limit")
        self.assertEqual(one.summarize_paragraphs([(0, "書上")])["short"], "codex 短總結")
        self.assertTrue(one.closed)

    def test_codex_usage_counted(self):
        s = self.make("limit")
        s.add_paragraph(1, 0, 5000, "書上")
        got = wait_for(s, lambda g: any(e["type"] == "para" for e in g))
        usage = next(e for e in got if e["type"] == "para")["usage"]
        self.assertGreaterEqual(usage["input"], 100)
        self.assertGreaterEqual(usage["cache_read"], 40)

    def test_close_kills_running_codex(self):
        os.environ["FAKE_CODEX_MODE"] = "hang"
        s = self.make("limit")
        s.add_paragraph(1, 0, 1, "一")
        deadline = time.time() + 10
        while s.codex_proc is None and time.time() < deadline:
            time.sleep(0.05)
        proc = s.codex_proc
        self.assertIsNotNone(proc)
        s.close()
        proc.wait(timeout=5)


class GateSession:
    def __init__(self, meeting_id):
        self.meeting_id = meeting_id
        self.closed = self.ending = False
        self.last_activity = 0
        self.listeners = 0
        self.gate = None
        self.log = []

    def idle(self, now):
        return False

    def queued(self):
        self.log.append("waiting")

    def started(self):
        self.log.append("running")

    def close(self):
        self.closed = True
        if self.gate:
            self.gate.leave(self)


class GateTest(unittest.TestCase):
    def test_queue_in_order_and_cap(self):
        hub = server.AgentHub(factory=GateSession, gate=server.AgentGate(limit=lambda: 2))
        ids = [c * 32 for c in "abcdefg"]
        got = [hub.get(i, create=True) for i in ids]
        a, b, c, d, e, f, g = got
        self.assertFalse(hub.gate.is_waiting(a) or hub.gate.is_waiting(b))
        self.assertTrue(all(hub.gate.is_waiting(x) for x in (c, d, e)), "上限 2：第 3 到 5 場排隊")
        self.assertEqual(c.log, ["waiting"])
        self.assertIsNone(f, "排隊最多 MAX_WAITING 場")
        self.assertIsNone(g)
        self.assertNotIn("f" * 32, hub.sessions)
        a.close()
        self.assertFalse(hub.gate.is_waiting(c), "前面結束就輪到下一場")
        self.assertEqual(c.log, ["waiting", "running"])
        self.assertTrue(hub.gate.is_waiting(d))
        d.close()
        b.close()
        self.assertEqual(e.log, ["waiting", "running"], "排隊中關掉的不佔位置")

    def test_limit_follows_settings(self):
        with mock.patch.dict(server.AGENT_SETTINGS, {"max_concurrent": 1}):
            hub = server.AgentHub(factory=GateSession, gate=server.AgentGate())
            hub.get("a" * 32, create=True)
            self.assertTrue(hub.gate.is_waiting(hub.get("b" * 32, create=True)))

    def test_asr_hub_keeps_hard_limit(self):
        hub = server.AgentHub(factory=GateSession)
        hub.get("a" * 32, create=True)
        hub.get("b" * 32, create=True)
        self.assertIsNone(hub.get("c" * 32, create=True), "本機辨識沒有排隊，超過就不開")

    def test_waiting_session_holds_paragraphs_until_turn(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": ""}):
            hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE, fallback=False),
                                  gate=server.AgentGate(limit=lambda: 1))
            first = hub.get("a" * 32, create=True)
            second = hub.get("b" * 32, create=True)
            self.addCleanup(first.close)
            self.addCleanup(second.close)
            second.add_paragraph(1, 0, 5000, "等一下")
            got = wait_for(second, lambda g: any(e["type"] == "status" for e in g))
            self.assertEqual(got[0], {"type": "status", "state": "waiting"})
            time.sleep(1)
            self.assertFalse(any(e["type"] == "para" for _, e in second.events), "排隊中不整理")
            first.close()
            got = wait_for(second, lambda g: any(e["type"] == "para" for e in g))
            self.assertIn({"type": "status", "state": "running", "engine": "claude"}, got)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE, fallback=False),
                                   gate=server.AgentGate(limit=lambda: 1))
        patches = [
            mock.patch.object(server.Handler, "hub", self.hub),
            mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: True)),
            mock.patch.dict(os.environ, {"FAKE_MODE": ""}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.httpd = server.QuietServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(lambda: [s.close() for s in list(self.hub.sessions.values())])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def request(self, path, obj=None):
        req = urllib.request.Request(self.base + path, data=None if obj is None else json.dumps(obj).encode(),
                                     method="GET" if obj is None else "POST",
                                     headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_para_reply_says_waiting(self):
        first = self.request("/api/agent/para", {"meeting": "a" * 32, "idx": 1, "start": 0, "end": 5, "text": "一"})
        second = self.request("/api/agent/para", {"meeting": "b" * 32, "idx": 1, "start": 0, "end": 5, "text": "二"})
        self.assertEqual((first[0], first[1]["waiting"]), (202, False))
        self.assertEqual((second[0], second[1]["waiting"]), (202, True))

    def test_local_engine_unsupported_on_linux(self):
        with mock.patch.object(server, "local_asr_supported", lambda: False):
            status, body = self.request("/api/engines")
            whisper = next(e for e in body["engines"] if e["id"] == "whisper")
            self.assertEqual((whisper["ok"], whisper["reason"]), (False, "unsupported"))
            status, body = self.request("/api/local/start", {"meeting": MID, "engine": "whisper"})
            self.assertEqual((status, body["error"]), (503, server.LOCAL_UNSUPPORTED))

    def test_local_engine_missing_on_mac(self):
        with mock.patch.object(server, "local_asr_supported", lambda: True), \
             mock.patch.object(server, "asr_python", lambda: None):
            _, body = self.request("/api/engines")
        whisper = next(e for e in body["engines"] if e["id"] == "whisper")
        self.assertEqual((whisper["ok"], whisper["reason"]), (False, "missing"))


class AvailabilityTest(unittest.TestCase):
    def test_codex_counts_only_with_fallback(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        codex = Path(d.name) / "codex"
        codex.write_text("#!/bin/sh\n", encoding="utf-8")
        codex.chmod(0o755)
        env = {"MEETING_SCRIBE_CLAUDE": str(Path(d.name) / "none"), "MEETING_SCRIBE_CODEX": str(codex)}
        with mock.patch.dict(os.environ, env):
            with mock.patch.dict(server.AGENT_SETTINGS, {"fallback": None}):
                self.assertFalse(server.agent_available())
            with mock.patch.dict(server.AGENT_SETTINGS, {"fallback": "codex"}):
                self.assertTrue(server.agent_available())

    def test_local_asr_supported_only_on_apple_silicon(self):
        with mock.patch.object(server.sys, "platform", "linux"):
            self.assertFalse(server.local_asr_supported())
        with mock.patch.object(server.sys, "platform", "darwin"), mock.patch.object(server.platform, "machine", lambda: "x86_64"):
            self.assertFalse(server.local_asr_supported())
        with mock.patch.object(server.sys, "platform", "darwin"), mock.patch.object(server.platform, "machine", lambda: "arm64"):
            self.assertTrue(server.local_asr_supported())


if __name__ == "__main__":
    unittest.main()
