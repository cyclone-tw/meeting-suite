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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_pack  # noqa: E402

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_claude.py")]
MID = "0123456789abcdef0123456789abcdef"
_TMP = tempfile.TemporaryDirectory()


def setUpModule():
    # 不讀這台機器上真正的常錯字對照
    p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
    p.start()
    unittest.addModuleCleanup(p.stop)
    unittest.addModuleCleanup(_TMP.cleanup)


def wait_for(session, pred, timeout=10):
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


class GlossaryTest(unittest.TestCase):
    def test_parses_hints_and_fixed_pairs(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "g.md"
            f.write_text("# 標題\n說明\n\n## 領域詞\n資源教室、IEP\n\n## 誤聽對照（依上下文）\n- 書上 → 學障\n\n## 固定替換（一定換）\n- 下周 → 下週\n- 壞行\n", encoding="utf-8")
            hints, fixed = server.load_glossary(f)
        self.assertIn("資源教室、IEP", hints)
        self.assertIn("- 書上 → 學障", hints)
        self.assertNotIn("說明", hints)
        self.assertEqual(fixed, [("下周", "下週")])

    def test_missing_file_is_empty(self):
        self.assertEqual(server.load_glossary(Path("/nonexistent/g.md")), ("", []))

    def test_repo_glossary_has_week_fix(self):
        _, fixed = server.load_glossary()
        self.assertIn(("下周", "下週"), fixed)

    def test_apply_fixed(self):
        self.assertEqual(server.apply_fixed("下周一開會", [("下周", "下週"), ("周一", "週一")]), "下週一開會")


class CorrectionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = server.CorrectionStore(Path(self.tmp.name) / "sub" / "corrections.json")

    def test_missing_file_is_empty(self):
        self.assertEqual(self.store.load(), {"hints": [], "fixed": []})

    def test_save_cleans_and_is_private(self):
        got = self.store.save({"hints": [[" 學長 ", "學障"], ["學長", "學障"], ["", "x"], ["同", "同"]], "fixed": [["下周", "下週"]]})
        self.assertEqual(got, {"hints": [["學長", "學障"]], "fixed": [["下周", "下週"]]})
        self.assertEqual(self.store.load(), got)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.path.parent.stat().st_mode & 0o777, 0o700)

    def test_rejects_bad_input(self):
        for bad in ([], {"hints": "x"}, {"hints": [["a"]]}, {"hints": [[1, "b"]]}, {"hints": [["a" * 41, "b"]]},
                    {"hints": [["a\nb", "c"]]}, {"hints": [["a", "b"]] * (server.MAX_CORRECTIONS + 1)}, {"fixed": [["他", "它"]]}):
            with self.assertRaises(ValueError, msg=bad):
                self.store.save(bad)
        self.assertFalse(self.store.path.exists())

    def bad_files(self):
        return sorted(self.store.path.parent.glob("corrections.json.bad-*"))

    def test_broken_file_is_moved_aside_and_flag_survives_until_save(self):
        self.store.path.parent.mkdir()
        self.store.path.write_text("{壞掉", encoding="utf-8")
        self.assertEqual(self.store.load(), {"hints": [], "fixed": []}, "會議開場先碰到壞檔")
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.store.read(), ({"hints": [], "fixed": []}, True), "網頁之後還看得到提醒")
        self.assertEqual([f.read_text(encoding="utf-8") for f in self.bad_files()], ["{壞掉"])
        self.store.save({"hints": [["學長", "學障"]]})
        self.assertEqual(self.store.read(), ({"hints": [["學長", "學障"]], "fixed": []}, False))

    def test_non_utf8_file_and_repeated_damage_keep_every_copy(self):
        self.store.path.parent.mkdir()
        self.store.path.write_bytes('{"hints": [["學長", "學障"]]}'.encode("big5"))
        self.assertEqual(self.store.read()[1], True)
        self.store.path.write_text("{又壞", encoding="utf-8")
        self.store.read()
        self.assertEqual(len(self.bad_files()), 2)

    def test_rename_failure_is_not_reported_as_recovered(self):
        self.store.path.parent.mkdir()
        self.store.path.write_text("{壞掉", encoding="utf-8")
        with mock.patch.object(Path, "rename", side_effect=OSError):
            self.assertEqual(self.store.read(), ({"hints": [], "fixed": []}, False))
        self.assertTrue(self.store.path.exists())

    def test_hand_edited_bad_pair_only_skips_that_pair(self):
        self.store.path.parent.mkdir()
        self.store.path.write_text(json.dumps({"hints": [["學長", "學障"], ["壞"]], "fixed": [["他", "它"], ["下周", "下週"]]}), encoding="utf-8")
        self.assertEqual(self.store.read(), ({"hints": [["學長", "學障"]], "fixed": [["下周", "下週"]]}, False))

    def test_session_merges_user_list(self):
        self.store.save({"hints": [["學長", "學障"]], "fixed": [["資源般", "資源班"]]})
        s = server.AgentSession(MID, command=FAKE, corrections=self.store)
        self.addCleanup(s.close)
        self.assertIn("- 學長 → 學障", s.system_prompt)
        self.assertIn("志願教室 → 資源教室", s.system_prompt, "repo 對照表還在")
        self.assertIn(("資源般", "資源班"), s.fixed)
        self.assertIn(("下周", "下週"), s.fixed)


class ChapterTest(unittest.TestCase):
    def test_parse_hms(self):
        self.assertEqual(server.parse_hms("01:02:03"), 3723000)
        self.assertEqual(server.parse_hms("02:03"), 123000)
        for bad in ("", None, "1", "a:b", "1:2:3:4", "-1:00", "²:00", "０１:００"):
            self.assertIsNone(server.parse_hms(bad))

    def test_snap_without_starts_keeps_time_but_first_is_zero(self):
        got = server.snap_chapters([{"t": "00:05:00", "title": "B"}, {"t": "00:01:00", "title": "A"}], [])
        self.assertEqual(got, [{"t_ms": 0, "title": "A"}, {"t_ms": 300000, "title": "B"}])

    def test_snap_ignores_garbage(self):
        self.assertEqual(server.snap_chapters("not a list", [0]), [])
        self.assertEqual(server.snap_chapters([None, {"t": "00:00:01"}, {"title": "x"}], [0]), [])


class ParseReplyTest(unittest.TestCase):
    def test_fenced_json(self):
        self.assertEqual(server.parse_json_reply('```json\n{"a": 1}\n```'), {"a": 1})

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            server.parse_json_reply("沒有")


class CommandTest(unittest.TestCase):
    def test_isolated_flags_and_tools_last(self):
        cmd = server.claude_command("sonnet", "SYS", claude_bin="/bin/claude")
        self.assertEqual(cmd[0], "/bin/claude")
        for flag in ("--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[cmd.index("--setting-sources") + 1], "")
        self.assertEqual(cmd[-2:], ["--tools", ""])
        self.assertEqual(cmd[cmd.index("--system-prompt") + 1], "SYS")


class SessionTest(unittest.TestCase):
    def make(self, mode=""):
        patcher = mock.patch.dict(os.environ, {"FAKE_MODE": mode})
        patcher.start()
        self.addCleanup(patcher.stop)
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        return s

    def test_paragraph_corrected_and_fixed(self):
        s = self.make()
        s.add_paragraph(1, 0, 5000, "書上學生下周評估")
        got = wait_for(s, lambda g: any(e["type"] == "para" for e in g))
        para = next(e for e in got if e["type"] == "para")
        self.assertEqual(para["corrected"], "學障學生下週評估")
        self.assertIn("下週", para["summary"])
        self.assertEqual((para["idx"], para["start"], para["end"]), (1, 0, 5000))

    def test_new_topic_defaults_true(self):
        s = self.make()
        s.add_paragraph(1, 0, 5000, "第一段")
        s.add_paragraph(2, 5000, 9000, "接著同一件事")
        got = wait_for(s, lambda g: sum(e["type"] == "para" for e in g) == 2)
        self.assertEqual([e["new_topic"] for e in got if e["type"] == "para"], [True, False])

    def test_polish_adds_readable_with_fixes(self):
        s = self.make()
        s.add_paragraph(1, 0, 5000, "嗯就是書上學生下周評估", polish=True)
        s.add_paragraph(2, 5000, 9000, "嗯第二段")
        got = wait_for(s, lambda g: sum(e["type"] == "para" for e in g) == 2)
        p1, p2 = [e for e in got if e["type"] == "para"]
        self.assertEqual(p1["readable"], "學障學生下週評估")
        self.assertEqual(p1["corrected"], "嗯就是學障學生下週評估", "忠實校正不刪口頭禪")
        self.assertNotIn("readable", p2, "沒開優化就不多給")

    def test_live_summary_after_n_paragraphs_and_end_closes(self):
        s = self.make()
        for i in range(server.LIVE_EVERY_PARAS):
            s.add_paragraph(i + 1, i * 1000, i * 1000 + 900, f"第{i}段")
        got = wait_for(s, lambda g: any(e["type"] == "live" for e in g))
        live = next(e for e in got if e["type"] == "live")
        self.assertTrue(live["text"].startswith("## 大綱"))
        self.assertEqual(live["upto"], server.LIVE_EVERY_PARAS)
        workdir = s.workdir
        self.assertTrue(workdir and os.path.isdir(workdir))
        s.add_paragraph(9, 9000, 9500, "最後一段")
        s.end()
        got = wait_for(s, lambda g: g and g[-1]["type"] == "done")
        self.assertEqual([e["type"] for e in got[-4:]], ["para", "live", "summary", "done"])
        for _ in range(50):  # done 先送出，程序與工作目錄接著收掉
            if s.proc is None and not os.path.exists(workdir):
                break
            time.sleep(0.1)
        self.assertIsNone(s.proc)
        self.assertFalse(os.path.exists(workdir), "空工作目錄要清掉")

    def test_end_emits_summary_pack_with_snapped_chapters(self):
        s = self.make()
        for i, start in enumerate((0, 5000, 9000)):
            s.add_paragraph(i + 1, start, start + 900, f"第{i}段")
        s.end()
        got = wait_for(s, lambda g: g and g[-1]["type"] == "done")
        summary = next(e for e in got if e["type"] == "summary")
        self.assertEqual(summary["chapters"], [
            {"t_ms": 0, "title": "開場"},          # 00:00:03 對齊第一段，第一章固定 0
            {"t_ms": 5000, "title": "第二部分"},   # 00:00:06 對齊 5000；00:00:07 同段只留一章
            {"t_ms": 9000, "title": "最後"},       # 超出範圍對齊最後一段；看不懂的時間丟掉
        ])
        self.assertTrue(summary["intro"].startswith("這場在談"))
        self.assertEqual(summary["short"], "下週再評估。")
        self.assertIn("## 核心結論\n下週再談", summary["full"])

    def test_summary_failure_still_closes(self):
        s = self.make("badsummary")
        s.add_paragraph(1, 0, 900, "一")
        s.end()
        got = wait_for(s, lambda g: g and g[-1]["type"] == "done")
        self.assertEqual([e["type"] for e in got], ["para", "live", "summary", "done"])
        self.assertIn("AI 整理失敗", got[2]["error"])
        self.assertEqual(got[0]["corrected"], "一", "總結失敗不影響段落")

    def test_summarize_paragraphs_one_shot(self):
        s = self.make()
        ev = s.summarize_paragraphs([(0, "一"), (5000, "二"), (9000, "三")])
        self.assertTrue(ev["intro"].startswith("重產："), "段落要放進 prompt")
        self.assertEqual([c["t_ms"] for c in ev["chapters"]], [0, 5000, 9000])
        self.assertTrue(s.closed)
        self.assertIsNone(s.proc)

    def test_bad_reply_keeps_process_and_context(self):
        s = self.make("badonce")
        s.add_paragraph(1, 0, 1, "一")
        got = wait_for(s, lambda g: any("error" in e for e in g))
        self.assertEqual(got[-1]["idx"], 1)
        pid = s.proc.pid
        s.add_paragraph(2, 2, 3, "二")
        got = wait_for(s, lambda g: any(e.get("type") == "para" and "corrected" in e for e in g))
        para = next(e for e in got if "corrected" in e)
        self.assertEqual(para["idx"], 2)
        self.assertEqual(s.proc.pid, pid, "格式不對不重開程序，對話歷史留著")
        self.assertFalse(para["summary"].startswith("接續："))

    def test_usage_adds_up_across_process_restart(self):
        s = self.make()
        s.add_paragraph(1, 0, 1000, "一")
        s.add_paragraph(2, 1000, 2000, "二")
        got = wait_for(s, lambda g: sum(e.get("type") == "para" for e in g) == 2)
        u = [e for e in got if e.get("type") == "para"][-1]["usage"]
        self.assertEqual((u["calls"], u["input"], u["output"], u["cache_write"], u["cache_read"]), (2, 20, 10, 200, 100))
        self.assertAlmostEqual(u["cost_usd"], 0.02, msg="程序內累計值只算差額")
        s.proc.kill()
        s.proc.wait()
        s.add_paragraph(3, 2000, 3000, "三")
        got = wait_for(s, lambda g: any(e.get("type") == "para" and e.get("idx") == 3 for e in g))
        u = next(e for e in got if e.get("idx") == 3)["usage"]
        self.assertEqual(u["calls"], 3)
        self.assertAlmostEqual(u["cost_usd"], 0.03, msg="新程序從零算起，不能扣成負的")

    def test_usage_result_without_cost_keeps_baseline(self):
        s = self.make()
        self.addCleanup(s.close)
        for ev in ({"total_cost_usd": 0.02}, {"usage": {"output_tokens": 3}}, {"total_cost_usd": 0.03}):
            s._add_usage(ev)
        self.assertAlmostEqual(s.usage["cost_usd"], 0.03, msg="沒帶金額的那次不能把基準歸零")
        self.assertEqual((s.usage["calls"], s.usage["output"]), (3, 3))

    def test_restart_replays_earlier_notes(self):
        s = self.make()
        s.add_paragraph(1, 0, 1000, "一")
        wait_for(s, lambda g: any(e.get("type") == "para" for e in g))
        s.proc.kill()
        s.proc.wait()
        s.add_paragraph(2, 2000, 3000, "二")
        got = wait_for(s, lambda g: any(e.get("type") == "para" and e.get("idx") == 2 for e in g))
        para = next(e for e in got if e.get("idx") == 2)
        self.assertTrue(para["summary"].startswith("接續："), "重開後先補之前的段落重點")

    def test_closed_session_never_restarts_process(self):
        s = self.make()
        s.close()
        with self.assertRaises(RuntimeError):
            s._ask("x")
        self.assertIsNone(s.proc)
        self.assertIsNone(s.workdir)

    def test_process_death_and_error_result(self):
        for mode in ("die", "error"):
            with self.subTest(mode=mode):
                s = self.make(mode)
                s.add_paragraph(1, 0, 1, "一")
                got = wait_for(s, lambda g: any("error" in e for e in g))
                self.assertIn("AI 整理失敗", got[-1]["error"])

    def test_timeout(self):
        with mock.patch.object(server, "TURN_TIMEOUT", 1):
            s = self.make("hang")
            s.add_paragraph(1, 0, 1, "一")
            got = wait_for(s, lambda g: any("error" in e for e in g))
        self.assertIn("TimeoutError", got[-1]["error"])


class FakeSession:
    def __init__(self, meeting_id):
        self.meeting_id = meeting_id
        self.closed = self.ending = False
        self.last_activity = 0
        self.listeners = 0

    def idle(self, now):
        return self.listeners == 0 and now - self.last_activity > server.IDLE_SECONDS

    def close(self):
        self.closed = True


class HubTest(unittest.TestCase):
    def test_limit_and_idle_reap(self):
        now = [0]
        hub = server.AgentHub(factory=FakeSession, clock=lambda: now[0])
        a = hub.get("a" * 32, create=True)
        hub.get("b" * 32, create=True)
        self.assertIsNone(hub.get("c" * 32, create=True), "超過上限不開新的")
        self.assertIs(hub.get("a" * 32), a)
        now[0] = server.IDLE_SECONDS + 1
        self.assertIsNotNone(hub.get("c" * 32, create=True), "閒置的關掉後可以開新的")
        self.assertTrue(a.closed)
        now[0] = server.IDLE_SECONDS * 2 + 700
        self.assertIsNone(hub.get("a" * 32), "關掉一陣子後移除")

    def test_listener_keeps_session_alive_until_lifetime(self):
        now = [0.0]
        s = server.AgentSession(MID, command=FAKE, clock=lambda: now[0])
        self.addCleanup(s.close)
        s.attach(1)
        now[0] = server.IDLE_SECONDS * 3
        self.assertFalse(s.idle(now[0]), "研習中場休息：網頁還連著就不收")
        s.attach(-1)
        now[0] += server.IDLE_SECONDS + 1
        self.assertTrue(s.idle(now[0]))
        s.attach(1)
        now[0] = server.MAX_LIFETIME + 1
        self.assertTrue(s.idle(now[0]), "超過最長時間一律收")


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE))
        # 不讀這台機器真正的 config；擴充包用測試產生的假包
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = Path(tmp.name) / "config.json"
        cfg.write_text(json.dumps({"packs": [str(fake_pack.make_pack(Path(tmp.name) / "pack"))]}), encoding="utf-8")
        patches = [
            mock.patch.object(server.Handler, "config_file", cfg),
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
        self.addCleanup(lambda: [s.close() for s in self.hub.sessions.values()])
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def post(self, path, obj, header=True):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **({"X-Meeting-Scribe": "1"} if header else {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_para_validation(self):
        good = {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一段"}
        self.assertEqual(self.post("/api/agent/para", good, header=False)[0], 403)
        self.assertEqual(self.post("/api/agent/para", {**good, "meeting": "../x"})[0], 400)
        self.assertEqual(self.post("/api/agent/para", {**good, "text": " "})[0], 400)
        self.assertEqual(self.post("/api/agent/para", {**good, "text": "字" * (server.MAX_PARA_CHARS + 1)})[0], 400)
        self.assertEqual(self.post("/api/agent/para", {**good, "idx": "1"})[0], 400)
        with mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: False)):
            self.assertEqual(self.post("/api/agent/para", good)[0], 503)

    def test_para_then_end_streams_events(self):
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "書上"})[0], 202)
        self.assertEqual(self.post("/api/agent/end", {"meeting": MID}), (200, {"ok": True}))
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 2, "text": "晚到"})[0], 409)
        with urllib.request.urlopen(f"{self.base}/api/agent/events?meeting={MID}", timeout=20) as r:
            self.assertTrue(r.headers["Content-Type"].startswith("text/event-stream"))
            body = r.read().decode()  # 收到 done 之後伺服器會關連線
        events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["para", "live", "summary", "done"])
        self.assertEqual(events[0]["corrected"], "學障")
        self.assertEqual(events[2]["chapters"][0]["t_ms"], 0)
        with urllib.request.urlopen(urllib.request.Request(f"{self.base}/api/agent/events?meeting={MID}", headers={"Last-Event-ID": "3"}), timeout=20) as r:
            replay = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in replay], ["done"], "重連只補沒收到的")

    def test_event_ids_carry_session_epoch(self):
        # 服務重啟後同一場的新 session 從 1 重新編號；舊頁面帶著上一個 session 的代碼重連要從頭補送（#74）
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "書上"})[0], 202)
        self.assertEqual(self.post("/api/agent/end", {"meeting": MID}), (200, {"ok": True}))

        def read(last_id=None):
            headers = {"Last-Event-ID": last_id} if last_id else {}
            with urllib.request.urlopen(urllib.request.Request(f"{self.base}/api/agent/events?meeting={MID}", headers=headers), timeout=20) as r:
                lines = r.read().decode().splitlines()
            return [l[4:] for l in lines if l.startswith("id: ")], [json.loads(l[6:])["type"] for l in lines if l.startswith("data: ")]

        ids, types = read()
        epoch = self.hub.sessions[MID].epoch if MID in self.hub.sessions else ids[0].split(".")[0]
        self.assertTrue(all(i.startswith(epoch + ".") for i in ids), ids)
        self.assertEqual(read(f"{epoch}.3")[1], ["done"], "同一個 session 照序號續傳")
        self.assertEqual(read("0badc0de.3")[1], types, "別的 session（重啟前）的代碼：從頭送")
        self.assertEqual(read("0badc0de.99")[1], types)

    def test_event_seq_parsing(self):
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        self.assertEqual(server.event_seq("", s), 0)
        self.assertEqual(server.event_seq("7", s), 7, "舊格式照舊")
        self.assertEqual(server.event_seq(f"{s.epoch}.5", s), 5)
        self.assertEqual(server.event_seq("other.5", s), 0)
        for bad in ("²", f"{s.epoch}.²", "x", f"{s.epoch}.", "-3"):
            self.assertEqual(server.event_seq(bad, s), 0, bad)

    def test_mindmap_endpoint(self):
        good = {"meeting": MID, "kind": "mindmap", "paras": [{"start": 0, "text": "一"}, {"start": 5000, "text": "二"}]}
        status, ev = self.post("/api/agent/summary", good)
        self.assertEqual(status, 200, ev)
        self.assertEqual(ev["type"], "mindmap")
        self.assertEqual(ev["center"], "IEP 會議", "句號拿掉")
        self.assertEqual([b["label"] for b in ev["branches"]], ["閱讀進度", "評量調整", "待辦"], "空議題丟掉、順序不變")
        self.assertEqual(len(ev["branches"][1]["children"]), server.MINDMAP_LIMITS[1], "每個議題最多 5 個重點")
        self.assertNotIn("children", ev["branches"][0]["children"][1]["children"][0], "最多三層")
        self.assertEqual([c["label"] for c in ev["branches"][2]["children"]], ["導師下週三前給清單"], "固定替換、句號、非字串")
        self.assertIn("usage", ev)
        self.assertEqual(self.hub.sessions, {}, "心智圖不佔會議名額")

    def test_clean_mindmap_single_line_labels(self):
        got = server.clean_mindmap({"center": "A\n" + "`" * 3 + "B", "branches": [{"label": "第一行\n第二行。"}]}, lambda t: t)
        self.assertEqual(got, {"center": "A " + "'" * 3 + "B", "branches": [{"label": "第一行 第二行"}]})

    def test_clean_mindmap_rejects_empty(self):
        with self.assertRaises(ValueError):
            server.clean_mindmap({"branches": [{"label": ""}, "x"]}, lambda t: t)
        self.assertEqual(server.clean_mindmap({"branches": [{"label": "甲" * 40}]}, lambda t: t),
                         {"center": "會議重點", "branches": [{"label": "甲" * server.MINDMAP_LABEL_MAX}]})

    def test_duplicate_paragraph_idx_is_ignored(self):
        good = {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一"}
        self.assertTrue(self.post("/api/agent/para", good)[1]["queued"])
        self.assertFalse(self.post("/api/agent/para", good)[1]["queued"], "重送同一段不再處理（#76）")
        self.assertTrue(self.post("/api/agent/para", {**good, "idx": 2})[1]["queued"])

    def test_para_reply_carries_epoch(self):
        status, body = self.post("/api/agent/para", {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "一"})
        self.assertEqual(status, 202)
        self.assertEqual(body["epoch"], self.hub.sessions[MID].epoch)

    def test_para_polish_flag(self):
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "嗯書上", "polish": True})[0], 202)
        self.assertEqual(self.post("/api/agent/end", {"meeting": MID})[0], 200)
        with urllib.request.urlopen(f"{self.base}/api/agent/events?meeting={MID}", timeout=20) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(events[0]["readable"], "學障")

    def test_corrections_endpoints(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(d) / "c.json")):
            with urllib.request.urlopen(f"{self.base}/api/corrections", timeout=10) as r:
                self.assertEqual(json.loads(r.read()), {"hints": [], "fixed": [], "terms": [], "pending": {"hints": [], "fixed": []}, "conflicts": {"hints": [], "fixed": []},
                                                        "vocabulary": {"source": "glossary"}})
            good = {"hints": [["學長", "學障"]], "fixed": []}
            self.assertEqual(self.post("/api/corrections", good, header=False)[0], 403)
            self.assertEqual(self.post("/api/corrections", good), (200, good))
            status, body = self.post("/api/corrections", {"fixed": [["他", "它"]]})
            self.assertEqual(status, 400)
            self.assertIn("太短", body["error"])
            req = urllib.request.Request(self.base + "/api/corrections", data=b"[" * 100000, method="POST",
                                         headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req, timeout=10)
            self.assertEqual(cm.exception.code, 400)
            with urllib.request.urlopen(f"{self.base}/api/corrections", timeout=10) as r:
                got = json.loads(r.read())
                self.assertEqual({k: got[k] for k in ("hints", "fixed")}, good, "壞的請求不會蓋掉已存的")
                self.assertEqual(got["pending"], good, "沒有共用正本：這台加的都還沒收回")
            server.CORRECTIONS.path.write_bytes(b"\xff\xfe")
            with urllib.request.urlopen(f"{self.base}/api/corrections", timeout=10) as r:
                got = json.loads(r.read())
                self.assertEqual((got["hints"], got["fixed"], got["recovered"]), ([], [], True))

    def test_name_pairs_cleaning(self):
        text = "詩語說思妤今天沒來，子傑也是"
        raw = [{"wrong": "詩語", "right": "詩妤"}, ["思妤", "詩妤"], {"wrong": "詩語", "right": "別的"}, {"wrong": "孟", "right": "夢"},
               {"wrong": "子傑", "right": "子傑人"}, {"wrong": "不在內容", "right": "x"}, {"wrong": "詩語\n", "right": "x"},
               {"wrong": "沒來", "right": "沒\u0007來"}, {"wrong": "今天", "right": ""}, {"wrong": "字" * 21, "right": "x"}, "壞的", ["a"]]
        self.assertEqual(server.clean_name_pairs(raw, text), [["詩語", "詩妤"], ["思妤", "詩妤"]])
        self.assertEqual(server.clean_name_pairs([["不在內容", "x"]]), [["不在內容", "x"]], "沒給內容就不檢查有沒有出現")
        self.assertEqual(len(server.clean_name_pairs([[f"錯{i:02d}", "對"] for i in range(60)])), server.NAME_FIX_MAX)
        self.assertEqual(server.clean_name_pairs("壞的"), [])

    def test_names_endpoint(self):
        good = {"meeting": MID, "request": "書上都是學障", "text": "[00:00:01] 書上的學生下周再談"}
        self.assertEqual(self.post("/api/agent/names", good, header=False)[0], 403)
        self.assertEqual(self.post("/api/agent/names", {**good, "request": " "})[0], 400)
        self.assertEqual(self.post("/api/agent/names", {**good, "request": "字" * (server.NAME_REQUEST_MAX + 1)})[0], 400)
        self.assertEqual(self.post("/api/agent/names", {**good, "text": ""})[0], 400)
        self.assertEqual(self.post("/api/agent/names", {**good, "text": "字" * (server.MAX_SUMMARY_CHARS + 1)})[0], 413)
        with mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: False)):
            self.assertEqual(self.post("/api/agent/names", good)[0], 503)
        status, ev = self.post("/api/agent/names", good)
        self.assertEqual(status, 200, ev)
        self.assertEqual(ev["pairs"], [["書上", "學障"], ["下周", "下週"]], "使用者說明有送進 prompt；不合格的組合丟掉")
        self.assertIn("usage", ev)
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badnames"}):
            status, err = self.post("/api/agent/names", good)
        self.assertEqual(status, 502)
        self.assertEqual(self.hub.sessions, {}, "更正名字不佔會議名額")

    def test_fixes_reach_running_session(self):
        # 會議中更正名字（#130）：之後的段落照新寫法；同一個錯字以新的為準；沒有在整理的會議回 live=false
        self.assertEqual(self.post("/api/agent/fixes", {"meeting": MID, "pairs": [["書上", "學障"]]}), (200, {"ok": True, "live": False}))
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 1, "start": 0, "end": 10, "text": "老師說"})[0], 202)
        self.assertEqual(self.post("/api/agent/fixes", {"meeting": MID, "pairs": [["老師", "導師"], ["一"]]}), (200, {"ok": True, "live": True}))
        self.assertEqual(self.post("/api/agent/fixes", {"meeting": MID, "pairs": [["老"]]})[0], 400)
        self.assertEqual(self.post("/api/agent/fixes", {"meeting": MID, "pairs": [["書上", "學障"]]}, header=False)[0], 403)
        session = self.hub.sessions[MID]
        session.add_fixed([["老師", "教師"]])
        self.assertEqual([x for x in session.fixed if x[0] == "老師"], [("老師", "教師")])
        self.assertEqual(self.post("/api/agent/para", {"meeting": MID, "idx": 2, "start": 10, "end": 20, "text": "老師說好"})[0], 202)
        self.assertEqual(self.post("/api/agent/end", {"meeting": MID}), (200, {"ok": True}))
        with urllib.request.urlopen(f"{self.base}/api/agent/events?meeting={MID}", timeout=20) as r:
            evs = [json.loads(l[6:]) for l in r.read().decode().splitlines() if l.startswith("data: ")]
        para = {e["idx"]: e for e in evs if e.get("type") == "para"}
        self.assertEqual(para[2]["corrected"], "教師說好")

    def test_resummary_endpoint(self):
        good = {"meeting": MID, "paras": [{"start": 0, "text": "一"}, {"start": 5000, "text": "二"}]}
        self.assertEqual(self.post("/api/agent/summary", good, header=False)[0], 403)
        self.assertEqual(self.post("/api/agent/summary", {**good, "paras": []})[0], 400)
        self.assertEqual(self.post("/api/agent/summary", {**good, "paras": [{"start": "0", "text": "一"}]})[0], 400)
        self.assertEqual(self.post("/api/agent/summary", {**good, "paras": [{"start": 0, "text": "字" * (server.MAX_SUMMARY_CHARS + 1)}]})[0], 413)
        with mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: False)):
            self.assertEqual(self.post("/api/agent/summary", good)[0], 503)
        status, ev = self.post("/api/agent/summary", good)
        self.assertEqual(status, 200, ev)
        self.assertEqual(ev["type"], "summary")
        self.assertEqual([c["t_ms"] for c in ev["chapters"]], [0, 5000])
        self.assertEqual((ev["usage"]["calls"], ev["usage"]["output"]), (1, 5), "另開程序的用量附在回應裡")
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badsummary"}):
            status, err = self.post("/api/agent/summary", good)
        self.assertEqual(status, 502)
        self.assertIn("AI 整理失敗", err["error"])
        self.assertEqual(self.hub.sessions, {}, "重新產生不佔會議名額")

    def test_minutes_endpoint(self):
        # 擴充包的模板（#97）：test-teacher 只在假擴充包裡
        good = {"meeting": MID, "kind": "minutes", "template": "test-teacher", "date": "2026-10-20",
                "paras": [{"start": 0, "text": "一"}, {"start": 5000, "text": "二"}]}
        self.assertEqual(self.post("/api/agent/summary", {**good, "template": "../README"})[0], 400)
        self.assertEqual(self.post("/api/agent/summary", {**good, "template": "nope"})[0], 400)
        self.assertEqual(self.post("/api/agent/summary", {**good, "template": ["test-teacher"]})[0], 400)
        self.assertEqual(self.post("/api/agent/summary", {**good, "date": "10/20"})[0], 400)
        status, ev = self.post("/api/agent/summary", good)
        self.assertEqual(status, 200, ev)
        self.assertEqual((ev["type"], ev["template"], ev["title"], ev["date"]), ("minutes", "test-teacher", "測試教師版", "2026-10-20"))
        self.assertEqual(ev["summary"], "# 測試教師版｜2026-10-20｜下週再談", "模板與日期要放進 prompt，固定替換照套")
        self.assertEqual([a["item"] for a in ev["actions"]], ["早一點的事", "晚一點的事", "沒期限的事", "壞日期"], "有期限的依日期排前面，沒期限的照原順序")
        self.assertEqual([a["status"] for a in ev["actions"]], ["已完成", "進行中", "未開始", "未開始"])
        self.assertEqual(ev["actions"][3]["due"], "", "看不懂的期限不要留")
        self.assertEqual(ev["decisions"], ["每週兩節"])
        self.assertEqual(ev["sections"], [{"title": "學生現況", "points": ["閱讀進步"]}])
        status, ev = self.post("/api/agent/summary", {**good, "template": "general"})
        self.assertTrue(ev["summary"].startswith("# 一般會議｜"), "換模板，prompt 跟著換")
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badminutes"}):
            status, err = self.post("/api/agent/summary", good)
        self.assertEqual(status, 502)
        self.assertEqual(self.hub.sessions, {}, "會議紀錄不佔會議名額")

    def test_resummary_one_at_a_time(self):
        good = {"meeting": MID, "paras": [{"start": 0, "text": "一"}]}
        self.assertTrue(server.SUMMARY_SLOT.acquire(blocking=False))
        try:
            self.assertEqual(self.post("/api/agent/summary", good)[0], 503)
        finally:
            server.SUMMARY_SLOT.release()

    def test_end_without_paragraphs_closes_stream(self):
        mid = "f" * 32
        self.assertEqual(self.post("/api/agent/end", {"meeting": mid}), (200, {"ok": True}))
        with urllib.request.urlopen(f"{self.base}/api/agent/events?meeting={mid}", timeout=10) as r:
            events = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
        self.assertEqual([e["type"] for e in events], ["done"])

    def test_events_bad_meeting(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(f"{self.base}/api/agent/events?meeting=zz", timeout=5)
        self.assertEqual(cm.exception.code, 400)

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return json.loads(r.read())

    def test_module_catalog(self):
        # 延伸模組（#136）：會後總結＋本體內建＋擴充包的；選項只給 id 與名稱，不給提示詞
        mods = {m["id"]: m for m in self.get("/api/modules")["modules"]}
        self.assertEqual(list(mods), ["summary", "mindmap", "sprout", "perspective", "test-module"])
        self.assertEqual(mods["summary"]["output"], "summary")
        self.assertEqual((mods["mindmap"]["output"], mods["mindmap"]["options"]), ("mindmap", []), "心智圖不是 Markdown 模組（#150）")
        self.assertEqual(mods["perspective"]["options"][0]["choices"][0], ["boss", "老闆／主管"])
        self.assertEqual(mods["test-module"]["options"], [{"id": "tone", "label": "語氣", "choices": [["warm", "溫和"], ["strict", "嚴格"]]}])
        self.assertNotIn("prompt", json.dumps(mods, ensure_ascii=False))

    def test_module_endpoint(self):
        paras = [{"start": 1000, "text": "書上的學生下周再談"}]
        good = {"meeting": MID, "module": "perspective", "paras": paras, "options": {"who": "parent"}}
        self.assertEqual(self.post("/api/agent/module", good, header=False)[0], 403)
        self.assertEqual(self.post("/api/agent/module", {**good, "paras": []})[0], 400)
        self.assertEqual(self.post("/api/agent/module", {**good, "paras": [{"start": 0, "text": "字" * (server.MAX_SUMMARY_CHARS + 1)}]})[0], 413)
        self.assertEqual(self.post("/api/agent/module", {**good, "module": "nope"})[0], 400)
        self.assertEqual(self.post("/api/agent/module", {**good, "module": ["perspective"]})[0], 400)
        self.assertEqual(self.post("/api/agent/module", {**good, "options": {"who": "cat"}})[0], 400, "不在清單裡的選擇不收")
        self.assertEqual(self.post("/api/agent/module", {**good, "options": {"other": "x"}})[0], 400, "沒宣告的選項不收")
        self.assertEqual(self.post("/api/agent/module", {**good, "options": "parent"})[0], 400)
        with mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: False)):
            self.assertEqual(self.post("/api/agent/module", good)[0], 503)
        status, ev = self.post("/api/agent/module", good)
        self.assertEqual(status, 200, ev)
        self.assertEqual((ev["module"], ev["title"], ev["options"]), ("perspective", "視角回饋：家長", {"who": "parent"}))
        self.assertTrue(ev["markdown"].startswith("## 模組結果\n## 視角回饋"), "拿掉 ```、一級標題改成二級：" + ev["markdown"])
        self.assertIn("- 視角：學生家長", ev["markdown"], "選擇的提示詞換進指示")
        self.assertIn("下週再談", ev["markdown"], "固定替換也套到模組結果")
        self.assertIn("usage", ev)
        # 沒帶選項用第一個；擴充包的模組讀它的指示檔
        status, ev = self.post("/api/agent/module", {**good, "module": "test-module", "options": None})
        self.assertEqual((status, ev["title"], ev["options"]), (200, "測試模組：溫和", {"tone": "warm"}))
        self.assertIn("- 視角：溫和的同事", ev["markdown"])
        self.assertEqual(self.post("/api/agent/module", {**good, "module": "sprout", "options": {}})[1]["title"], "讓這場會議發芽")
        # 擴充包的指示檔壞掉：設定問題回 500，不是請求錯
        prompt = Path(json.loads(server.Handler.config_file.read_text())["packs"][0]) / "prompts" / "module.md"
        prompt.write_bytes(b"\xff\xfe bad")
        server._PACK_CACHE.clear()
        self.assertEqual(self.post("/api/agent/module", {**good, "module": "test-module", "options": None})[0], 500)
        # module=summary 照會後總結包的格式
        status, ev = self.post("/api/agent/module", {"meeting": MID, "module": "summary", "paras": paras})
        self.assertEqual((status, ev["module"]), (200, "summary"))
        self.assertTrue(ev["full"] and ev["intro"])
        with mock.patch.dict(os.environ, {"FAKE_MODE": "badmodule"}):
            self.assertEqual(self.post("/api/agent/module", good)[0], 502, "AI 沒給內容")
        self.assertEqual(self.hub.sessions, {}, "延伸模組不佔會議名額")

    def test_mindmap_module(self):
        # 心智圖模組（#150）：JSON 和 App 的一樣整理過，另附 Mermaid、.opml、Markdown 三種文字
        status, ev = self.post("/api/agent/module", {"meeting": MID, "module": "mindmap", "paras": [{"start": 1000, "text": "閱讀進度"}],
                                                     "options": {"who": "x"}})
        self.assertEqual(status, 200, ev)
        self.assertEqual((ev["module"], ev["title"], ev["options"]), ("mindmap", "心智圖", {}), "心智圖不吃選項")
        self.assertEqual([b["label"] for b in ev["mindmap"]["branches"]], ["閱讀進度", "評量調整", "待辦"], "和 App 的心智圖同一套整理")
        self.assertEqual(ev["mermaid"], server.mindmap_mermaid(ev["mindmap"]))
        self.assertTrue(ev["mermaid"].startswith("mindmap\n  root((IEP 會議))\n    閱讀進度\n      書上學生進步"), ev["mermaid"])
        self.assertIn("導師下週三前給清單", ev["mermaid"], "固定替換照樣套用")
        self.assertTrue(ev["markdown"].startswith("# 心智圖：IEP 會議\n\n```mermaid\nmindmap\n") and "## 大綱\n\n- 閱讀進度\n  - 書上學生進步" in ev["markdown"])
        self.assertIsNotNone(server.clean_opml(ev["opml"]), "存 Drive 收得下")
        self.assertIn('<outline text="IEP 會議"><outline text="閱讀進度"><outline text="書上學生進步"/>', ev["opml"])
        self.assertIn("usage", ev)
        with mock.patch.dict(os.environ, {"FAKE_MODE": "error"}):
            self.assertEqual(self.post("/api/agent/module", {"meeting": MID, "module": "mindmap", "paras": [{"start": 0, "text": "x"}]})[0], 502)
        self.assertEqual(self.hub.sessions, {})

    def test_mindmap_text_formats(self):
        # 和頁面的 mapView：控制字元拿掉、空白收成一格、反引號換掉、沒字的葉子丟掉、沒字但有子項叫（未命名）；Mermaid 括號換全形；XML 要跳脫
        m = {"center": "A(B)[C]{D}", "branches": [
            {"label": "x & <y> \"z\"\x07", "children": [{"label": "  多  空白 ", "children": [{"label": "`反`"}]}]},
            {"label": "", "children": [{"label": "沒標題"}]}, {"label": "  "}]}
        self.assertEqual(server.mindmap_mermaid(m), "mindmap\n  root((A（B）［C］｛D｝))\n    x & <y> \"z\"\n      多 空白\n        '反'\n    （未命名）\n      沒標題")
        self.assertEqual(server.mindmap_markdown(m).split("## 大綱\n\n")[1], "- x & <y> \"z\"\n  - 多 空白\n    - '反'\n- （未命名）\n  - 沒標題\n")
        self.assertEqual(server.mindmap_opml(m), '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>A(B)[C]{D}</title></head>'
                         '<body><outline text="A(B)[C]{D}"><outline text="x &amp; &lt;y&gt; &quot;z&quot;"><outline text="多 空白">'
                         '<outline text="\'反\'"/></outline></outline><outline text="（未命名）"><outline text="沒標題"/></outline></outline></body></opml>\n')

    def test_healthz_reports_agent(self):
        with urllib.request.urlopen(self.base + "/healthz", timeout=5) as r:
            self.assertTrue(json.loads(r.read())["agent"])


if __name__ == "__main__":
    unittest.main()
