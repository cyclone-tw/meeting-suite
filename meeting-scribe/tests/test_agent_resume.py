"""AI 整理的結果不因頁面重新整理、關掉或手機鎖螢幕而遺失（#126）：伺服器直接寫暫存、合併規則、
沒人連著也收尾、重新接上、補跑缺少的段落。"""
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

FAKE = [sys.executable, str(Path(__file__).resolve().parent / "fake_claude.py")]
MID = "0123456789abcdef0123456789abcdef"
MID2 = "1123456789abcdef0123456789abcdef"
DRAFT = "d" * 32
META = {"title": "示範", "place": "", "engine": "soniox", "started_at": 1, "duration_ms": 0, "state": "done"}
_TMP = tempfile.TemporaryDirectory()


def setUpModule():
    p = mock.patch.object(server, "CORRECTIONS", server.CorrectionStore(Path(_TMP.name) / "none.json"))
    p.start()
    unittest.addModuleCleanup(p.stop)
    unittest.addModuleCleanup(_TMP.cleanup)


def until(pred, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("等不到")


class MergeTest(unittest.TestCase):
    def test_result_wins_over_empty_and_error_either_order(self):
        result = {"chunks": [{"idx": 1, "start": 0, "end": 9, "corrected": "校正", "readable": "", "summary": "重點", "new_topic": False}]}
        pending = {"chunks": [{"idx": 1, "start": 0, "end": 9, "text": "原文", "corrected": "", "summary": "", "error": "連不到伺服器", "seg": 3}]}
        for first, second, a, b in ((result, pending, "agent", "page"), (pending, result, "page", "agent")):
            got = server.merge_ai(server.merge_ai(None, first, a), second, b)["chunks"]
            self.assertEqual(len(got), 1)
            c = got[0]
            self.assertEqual((c["corrected"], c["summary"], c["error"], c["new_topic"]), ("校正", "重點", "", False), (a, b))
            self.assertEqual((c["text"], c["seg"]), ("原文", 3), "原文與時間軸位置兩邊都留著")

    def test_error_only_when_no_result_and_chunks_union(self):
        got = server.merge_ai({"chunks": [{"idx": 2, "text": "二"}]}, {"chunks": [{"idx": 1, "text": "一", "error": "失敗"}, {"idx": True}, "壞的"]}, "page")
        self.assertEqual([c["idx"] for c in got["chunks"]], [1, 2], "只出現在一邊的段落都留著；壞的丟掉")
        self.assertEqual(got["chunks"][0]["error"], "失敗")

    def test_summary_and_live_rules(self):
        s = server.merge_ai(None, {"summary": {"intro": "整場"}, "live": {"text": "新", "upto": 5}}, "agent")
        s = server.merge_ai(s, {"summary": None, "live": {"text": "舊", "upto": 3}}, "page")
        self.assertEqual(s["summary"]["intro"], "整場", "空的總結不清掉已有的")
        self.assertEqual(s["live"]["text"], "新", "段落編號比較舊的即時摘要不蓋掉新的")
        s = server.merge_ai(s, {"summary": {"intro": "重新產生"}}, "page")
        self.assertEqual(s["summary"]["intro"], "重新產生", "後到的總結（例如按重新產生）蓋掉前面的")

    def test_page_owned_fields_follow_page_including_clear(self):
        s = server.merge_ai(None, {"minutes": {"summary": "紀錄"}, "mindmap": {"center": "圖"}}, "page")
        s = server.merge_ai(s, {"chunks": [{"idx": 1, "corrected": "x"}], "minutes": "不該寫"}, "agent")
        self.assertEqual(s["minutes"], {"summary": "紀錄"}, "伺服器不能寫頁面的欄位")
        s = server.merge_ai(s, {"minutes": None}, "page")
        self.assertIsNone(s["minutes"], "接續錄時頁面清掉的會議紀錄要清掉")
        self.assertEqual(s["mindmap"], {"center": "圖"}, "頁面沒送的欄位不動")

    def test_usage_per_epoch_folds_into_extra(self):
        u = lambda n: {"calls": n, "input": n, "output": 0, "cache_write": 0, "cache_read": 0, "cost_usd": 0.5 * n}
        s = server.merge_ai(None, {"usage": u(3), "usage_epoch": "e1"}, "agent")
        s = server.merge_ai(s, {"usage": u(2), "usage_epoch": "e1"}, "agent")
        self.assertEqual(s["usage"]["calls"], 3, "同一個程序的用量不倒退")
        s = server.merge_ai(s, {"usage": u(1), "usage_epoch": "e2"}, "agent")
        self.assertEqual((s["usage"]["calls"], s["extra_usage"]["calls"], s["extra_usage"]["cost_usd"]), (1, 3, 1.5), "換程序：前一個併進 extra_usage")
        # 頁面晚一步送同一個程序的用量：用量取多的，extra_usage 以頁面算的為準
        s = server.merge_ai(s, {"usage": None, "usage_epoch": "e2", "extra_usage": u(3)}, "page")
        self.assertEqual((s["usage"]["calls"], s["extra_usage"]["calls"]), (1, 3))
        # 頁面送的是自己另一個程序：整組以頁面為準
        s = server.merge_ai(s, {"usage": u(7), "usage_epoch": "", "extra_usage": None}, "page")
        self.assertEqual((s["usage"]["calls"], s["usage_epoch"], s["extra_usage"]), (7, "", None))


class StoreTest(unittest.TestCase):
    def test_merge_needs_draft_and_respects_size(self):
        with tempfile.TemporaryDirectory() as d:
            store = server.DraftStore(Path(d))
            with self.assertRaises(LookupError):
                store.merge_ai(DRAFT, {"chunks": []}, "page")
            store.put_meta(DRAFT, META)
            store.merge_ai(DRAFT, {"chunks": [{"idx": 1, "text": "一"}]}, "agent")
            self.assertEqual(store.get_ai(DRAFT)["chunks"][0]["text"], "一")
            with mock.patch.object(server, "MAX_DRAFT_AI_BYTES", 100), self.assertRaises(ValueError):
                store.merge_ai(DRAFT, {"chunks": [{"idx": 2, "text": "字" * 200}]}, "agent")


class SessionDraftTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = server.DraftStore(Path(self.tmp.name))
        self.store.put_meta(DRAFT, META)
        p = mock.patch.dict(os.environ, {"FAKE_MODE": ""})
        p.start()
        self.addCleanup(p.stop)

    def make(self, mid=MID, backfill=False):
        s = server.AgentSession(mid, command=FAKE)
        self.addCleanup(s.close)
        s.bind_draft(self.store, DRAFT, backfill=backfill)
        return s

    def ai(self):
        return self.store.get_ai(DRAFT) or {}

    def test_results_written_without_any_listener(self):
        """頁面送完段落、按結束就關掉：伺服器自己把每段結果、總結、用量寫進暫存。"""
        s = self.make()
        for i, start in enumerate((0, 5000, 9000)):
            s.add_paragraph(i + 1, start, start + 900, f"書上第{i}段", seg=i * 2)
        self.assertEqual([c["text"] for c in self.ai()["chunks"]], ["書上第0段", "書上第1段", "書上第2段"], "收到就先記原文")
        s.end()
        until(lambda: s.closed)
        ai = self.ai()
        self.assertEqual([c["corrected"] for c in ai["chunks"]], ["學障第0段", "學障第1段", "學障第2段"])
        self.assertEqual([c["seg"] for c in ai["chunks"]], [0, 2, 4])
        self.assertTrue(all(c["summary"] for c in ai["chunks"]))
        self.assertTrue(ai["summary"]["whole"] and ai["summary"]["intro"].startswith("這場在談"), "整場都是這個程序看過的：一般總結")
        self.assertTrue(ai["live"]["text"])
        self.assertEqual((ai["usage_epoch"], ai["usage"]["calls"]), (s.epoch, s.usage["calls"]))

    def test_page_snapshot_after_server_does_not_erase(self):
        s = self.make()
        s.add_paragraph(1, 0, 900, "書上")
        s.end()
        until(lambda: s.closed)
        # 重新整理前的頁面晚到的快照：段落還沒結果、沒有總結
        self.store.merge_ai(DRAFT, {"chunks": [{"idx": 1, "text": "書上", "corrected": "", "summary": ""}], "summary": None, "live": None,
                                    "minutes": None, "usage": None, "usage_epoch": "", "extra_usage": None}, "page")
        ai = self.ai()
        self.assertEqual(ai["chunks"][0]["corrected"], "學障")
        self.assertTrue(ai["summary"])

    def test_error_written_then_backfill_fills_and_resummarizes(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": "bad"}):
            s = self.make()
            s.add_paragraph(1, 0, 900, "第一段")
            s.add_paragraph(2, 5000, 5900, "第二段")
            s.end()
            until(lambda: s.closed)
        ai = self.ai()
        self.assertTrue(all(c["error"] and not c["corrected"] for c in ai["chunks"]), "失敗也記下，之後才知道要補跑")
        # 第一段後來有結果（例如頁面那邊收到了），只補跑第二段
        self.store.merge_ai(DRAFT, {"chunks": [{"idx": 1, "corrected": "第一段", "summary": "一的重點"}]}, "page")
        b = self.make(MID2, backfill=True)
        self.assertEqual(b.notes, ["- 第 1 段（00:00:00–00:00:00）：一的重點"], "補跑先把已有段落的重點當前文")
        b.add_paragraph(2, 5000, 5900, "第二段")
        b.end()
        until(lambda: b.closed)
        types = [e["type"] for _, e in b.events]
        self.assertNotIn("live", types, "補跑不更新即時摘要")
        ai = self.ai()
        self.assertEqual([c["corrected"] for c in ai["chunks"]], ["第一段", "第二段"])
        self.assertEqual(ai["chunks"][1]["error"], "")
        self.assertTrue(ai["summary"]["whole"])
        self.assertTrue(ai["chunks"][1]["summary"].startswith("接續："), "程序開起來的第一題帶著前文")
        self.assertTrue(ai["summary"]["intro"].startswith("重產："), f"用整份暫存重新總結：{ai['summary']['intro']}")
        self.assertEqual([c["t_ms"] for c in ai["summary"]["chapters"]], [0, 5000], "章節對齊整份暫存的段落")
        self.assertEqual(ai["extra_usage"]["calls"], s.usage["calls"], "前一個程序的用量併進 extra_usage")

    def test_partial_session_too_long_does_not_overwrite_summary(self):
        self.store.merge_ai(DRAFT, {"chunks": [{"idx": 1, "corrected": "前半" * 10}], "summary": {"intro": "前半場"}}, "page")
        with mock.patch.object(server, "MAX_SUMMARY_CHARS", 5):
            s = self.make()
            s.add_paragraph(2, 5000, 5900, "後半")
            s.end()
            until(lambda: s.closed)
        summ = next(e for _, e in s.events if e["type"] == "summary")
        self.assertNotIn("whole", summ)
        self.assertEqual(self.ai()["summary"], {"intro": "前半場"}, "只涵蓋後半場的總結不寫進暫存")

    def test_deleted_draft_is_not_recreated(self):
        s = self.make()
        self.store.delete(DRAFT)
        s.add_paragraph(1, 0, 900, "一")
        s.end()
        until(lambda: s.closed)
        self.assertFalse((Path(self.tmp.name) / DRAFT).exists(), "存到 Drive 刪掉的暫存不能被寫回來")

    def test_ending_session_survives_idle_until_grace(self):
        now = [0.0]
        s = server.AgentSession(MID, command=FAKE, clock=lambda: now[0])
        self.addCleanup(s.close)
        s.end()
        now[0] = server.IDLE_SECONDS * 3
        self.assertFalse(s.idle(now[0]), "按了結束：沒人連著也做完再收")
        now[0] = server.END_GRACE + 1
        self.assertTrue(s.idle(now[0]), "收尾太久就收")

    def test_retire_ends_gracefully_only_with_draft_and_paragraphs(self):
        s = server.AgentSession(MID, command=FAKE)
        self.addCleanup(s.close)
        s.retire(time.monotonic())
        self.assertTrue(s.closed, "沒有暫存的照舊直接關")
        t = self.make(MID2)
        t.add_paragraph(1, 0, 900, "書上")
        t.retire(time.monotonic())
        self.assertTrue(t.ending, "有暫存、有段落：照結束收尾")
        until(lambda: t.closed)
        self.assertTrue(self.ai()["summary"])

    def test_hub_sweep_retires_idle_session(self):
        now = [0.0]
        hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE, clock=lambda: now[0]), clock=lambda: now[0])
        s = hub.get(MID, create=True)
        self.addCleanup(s.close)
        s.bind_draft(self.store, DRAFT)
        s.add_paragraph(1, 0, 900, "書上")
        until(lambda: self.ai().get("chunks", [{}])[0].get("corrected"))
        self.assertIs(hub.find_draft(DRAFT), s)
        now[0] = server.IDLE_SECONDS + 10
        hub.sweep()
        self.assertTrue(s.ending, "分頁被關掉、沒按結束：閒置後自己收尾")
        until(lambda: s.closed)
        self.assertTrue(self.ai()["summary"])
        self.assertIsNone(hub.find_draft(DRAFT))


class QueueAndFallbackTest(unittest.TestCase):
    """排隊（max_concurrent_agents）與 Codex 備援照常運作，結果一樣寫進暫存。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = server.DraftStore(Path(self.tmp.name))
        self.store.put_meta(DRAFT, META)

    def test_ended_while_waiting_finishes_after_turn_without_listener(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": ""}):
            hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE, fallback=False), gate=server.AgentGate(limit=lambda: 1))
            first = hub.get(MID, create=True)
            second = hub.get(MID2, create=True)
            self.addCleanup(first.close)
            self.addCleanup(second.close)
            second.bind_draft(self.store, DRAFT)
            second.add_paragraph(1, 0, 900, "書上")
            second.end()
            time.sleep(1)
            self.assertFalse(self.store.get_ai(DRAFT)["chunks"][0]["corrected"], "排隊中不整理")
            self.assertIs(hub.find_draft(DRAFT), second)
            self.assertTrue(second.info()["waiting"])
            first.close()
            until(lambda: second.closed)
            ai = self.store.get_ai(DRAFT)
            self.assertEqual(ai["chunks"][0]["corrected"], "學障")
            self.assertTrue(ai["summary"]["whole"])

    def test_codex_fallback_results_written(self):
        fake_codex = [sys.executable, str(Path(__file__).resolve().parent / "fake_codex.py")]
        with mock.patch.dict(os.environ, {"FAKE_MODE": "die", "FAKE_CODEX_MODE": ""}), mock.patch.object(server, "CLAUDE_DOWN", [0.0]):
            s = server.AgentSession(MID, command=FAKE, fallback="codex",
                                    codex=lambda wd: fake_codex + server.codex_command(wd, codex="codex")[1:])
            self.addCleanup(s.close)
            s.bind_draft(self.store, DRAFT)
            s.add_paragraph(1, 0, 900, "書上")
            s.end()
            until(lambda: s.closed)
        ai = self.store.get_ai(DRAFT)
        self.assertEqual(s.engine, "codex")
        self.assertTrue(ai["chunks"][0]["corrected"] and not ai["chunks"][0]["error"], ai["chunks"])
        self.assertTrue(ai["summary"])


class HttpResumeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = server.DraftStore(Path(self.tmp.name) / "drafts")
        self.store.put_meta(DRAFT, META)
        self.delay = Path(self.tmp.name) / "delay"
        self.hub = server.AgentHub(factory=lambda mid: server.AgentSession(mid, command=FAKE), gate=server.AgentGate(lambda: 2))
        patches = [
            mock.patch.object(server.Handler, "hub", self.hub),
            mock.patch.object(server.Handler, "drafts", self.store),
            mock.patch.object(server.Handler, "config_file", Path(self.tmp.name) / "none.json"),
            mock.patch.object(server.Handler, "agent_ready", staticmethod(lambda: True)),
            mock.patch.dict(os.environ, {"FAKE_MODE": "", "FAKE_DELAY_FILE": str(self.delay)}),
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

    def call(self, path, obj=None):
        req = urllib.request.Request(self.base + path, data=None if obj is None else json.dumps(obj).encode(),
                                     method="GET" if obj is None else "POST",
                                     headers={"Content-Type": "application/json", "X-Meeting-Scribe": "1"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_get_reports_running_session_then_results(self):
        self.delay.write_text("0.3")
        for i in range(3):
            st, _ = self.call("/api/agent/para", {"meeting": MID, "draft": DRAFT, "idx": i + 1, "start": i * 1000, "end": i * 1000 + 900,
                                                  "text": f"書上{i}", "seg": i})
            self.assertEqual(st, 202)
        self.call("/api/agent/end", {"meeting": MID})
        st, got = self.call(f"/api/drafts/get?draft={DRAFT}")
        self.assertEqual(st, 200)
        self.assertEqual((got["agent"]["meeting"], got["agent"]["ending"]), (MID, True), "整理中：告訴頁面要接哪一場")
        self.assertEqual(len(got["ai"]["chunks"]), 3, "還沒整理的段落也已經在暫存")
        listing = self.call("/api/drafts")[1]["drafts"]
        self.assertTrue(next(x for x in listing if x["id"] == DRAFT)["ai_running"])
        # 沒有人接事件：伺服器自己做完
        until(lambda: self.call(f"/api/drafts/get?draft={DRAFT}")[1]["agent"] is None, 20)
        got = self.call(f"/api/drafts/get?draft={DRAFT}")[1]
        self.assertEqual([c["corrected"] for c in got["ai"]["chunks"]], ["學障0", "學障1", "學障2"])
        self.assertTrue(got["ai"]["summary"]["whole"])
        self.assertFalse(next(x for x in self.call("/api/drafts")[1]["drafts"] if x["id"] == DRAFT)["ai_running"])

    def test_page_post_merges_instead_of_replacing(self):
        self.call("/api/agent/para", {"meeting": MID, "draft": DRAFT, "idx": 1, "start": 0, "end": 900, "text": "書上"})
        until(lambda: (self.store.get_ai(DRAFT) or {}).get("chunks", [{}])[0].get("corrected"))
        st, _ = self.call("/api/drafts/ai", {"draft": DRAFT, "ai": {"chunks": [{"idx": 1, "text": "書上", "corrected": ""}], "minutes": {"summary": "紀錄"}}})
        self.assertEqual(st, 200)
        ai = self.store.get_ai(DRAFT)
        self.assertEqual((ai["chunks"][0]["corrected"], ai["minutes"]), ("學障", {"summary": "紀錄"}))

    def test_discard_stops_only_that_drafts_session(self):
        # 捨棄這場（#133）：刪暫存帶 stop_ai，綁這份暫存的整理程序一起停；別場、以及存到 Drive 後的一般刪除都不受影響
        other, mid2, kept, mid3 = "c" * 32, MID2, "f" * 32, "2" * 32
        self.store.put_meta(other, META)
        self.store.put_meta(kept, META)
        self.delay.write_text("2")
        for m, d in ((MID, DRAFT), (mid2, other), (mid3, kept)):
            self.assertEqual(self.call("/api/agent/para", {"meeting": m, "draft": d, "idx": 1, "start": 0, "end": 900, "text": "書上"})[0], 202)
        self.assertEqual(self.call("/api/drafts/delete", {"draft": DRAFT, "stop_ai": True}), (200, {"ok": True}))
        self.assertTrue(self.hub.get(MID).closed, "捨棄的那場不再整理")
        self.assertEqual(self.call(f"/api/drafts/get?draft={DRAFT}")[0], 404)
        self.assertFalse(self.hub.get(mid2).closed, "別場照常整理")
        # 停掉的程序手上那段做完也不能把刪掉的暫存寫回來
        time.sleep(2.5)
        self.assertEqual(self.call(f"/api/drafts/get?draft={DRAFT}")[0], 404)
        self.assertFalse((self.store.base / DRAFT).exists())
        self.assertEqual(self.call("/api/drafts/delete", {"draft": kept}), (200, {"ok": True}))
        self.assertFalse(self.hub.get(mid3).closed, "沒帶 stop_ai：總結可能還在產生，程序留著")

    def test_bad_draft_and_seg_are_ignored(self):
        st, _ = self.call("/api/agent/para", {"meeting": MID, "draft": "../x", "idx": 1, "text": "一", "seg": "x"})
        self.assertEqual(st, 202, "draft 不合法就當沒帶，段落照收")
        self.assertIsNone(self.hub.get(MID).draft)


if __name__ == "__main__":
    unittest.main()
