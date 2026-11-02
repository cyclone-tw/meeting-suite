// 交給 coding agent 的交接單
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handoffEnabled, handoffFromPackage, handoffFromStudio, paragraphs, renderTranscript, slugify, writeHandoff } from "../lib/wiki-handoff.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";

useTestProfile({ icloud_inbox: "Inbox" });

function tempIcloud(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const icloud = path.join(root, "icloud");
  fs.mkdirSync(icloud);
  return { root, icloud, toWiki: path.join(icloud, "Inbox", "to-wiki") };
}

const item = (title = "共學 第3次") => ({ date: "2026-10-24", title, handoff: "# h\n", transcript: "# t\n" });

test("handoffs land in iCloud <icloud_inbox>/to-wiki and never overwrite an existing one", (t) => {
  const { icloud, toWiki } = tempIcloud(t);
  const a = writeHandoff(item(), { icloud });
  assert.equal(a.dir, path.join(toWiki, "2026-10-24--共學-第3次"));
  assert.equal(fs.readFileSync(path.join(a.dir, "handoff.md"), "utf8"), "# h\n");
  assert.equal(fs.readFileSync(path.join(a.dir, "transcript.md"), "utf8"), "# t\n");
  fs.writeFileSync(path.join(a.dir, "handoff.md"), "agent 正在看");
  const b = writeHandoff(item(), { icloud });
  assert.equal(b.name, "2026-10-24--共學-第3次-2");
  assert.equal(fs.readFileSync(path.join(a.dir, "handoff.md"), "utf8"), "agent 正在看", "the first one is untouched");
  // 處理完搬到 done/ 的名稱也不能再用，免得 agent 搬的時候撞名
  fs.mkdirSync(path.join(toWiki, "done", "2026-10-24--共學-第3次-3"), { recursive: true });
  assert.equal(writeHandoff(item(), { icloud }).name, "2026-10-24--共學-第3次-4");
});

test("a missing iCloud Drive is an error and nothing is written anywhere else", (t) => {
  const { root } = tempIcloud(t);
  const missing = path.join(root, "nope");
  assert.throws(() => writeHandoff(item(), { icloud: missing }), /找不到 iCloud Drive/);
  assert.equal(fs.existsSync(missing), false);
});

test("folder names keep Chinese but drop path separators and Finder-unsafe characters", () => {
  assert.equal(slugify("../a/b: c?*"), "a-b-c");
  assert.equal(slugify("  "), "recording");
  assert.equal([...slugify("字".repeat(80))].length, 60);
});

test("transcript paragraphs break on pauses and long runs, and lines without end punctuation do not run together", () => {
  const segs = [
    { start: 0, end: 1, text: "今天談" }, { start: 1.2, end: 2, text: "Claude Code" }, { start: 2.1, end: 3, text: "好。" }, { start: 3.1, end: 4, text: "下一句" },
    { start: 7, end: 8, text: "停頓後" }, { start: 8, end: 9, text: "   " },
  ];
  const ps = paragraphs(segs);
  assert.deepEqual(ps.map((p) => p.text), ["今天談 Claude Code 好。下一句", "停頓後"]);
  assert.equal(paragraphs(Array.from({ length: 200 }, (_, i) => ({ start: i, end: i + 1, text: "字字" }))).length > 1, true, "90 秒或 280 字就換段");
  assert.match(renderTranscript({ title: "x", segments: segs }), /\*\*\[00:00:07\]\*\* 停頓後/);
});

test("a transcript package becomes a handoff with its source, length, engine and package path", (t) => {
  const { root, icloud } = tempIcloud(t);
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkg, "transcripts", "mlx"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "transcripts", "mlx", "segments.json"), JSON.stringify({ segments: [{ start: 0, end: 2, text: "第一句" }, { start: 3725, end: 3730, text: "最後" }] }));
  fs.writeFileSync(path.join(pkg, "manifest.json"), JSON.stringify({
    recording_kind: "youtube",
    source_meta: { title: "別人的分享", uploader: "某頻道", upload_date: "2026-09-01", webpage_url: "https://www.youtube.com/watch?v=abc" },
    engine_fallbacks: [{ from: "mlx", to: "captions", reason: "HTTP 403" }],
    transcription_candidates: [{ engine: "youtube-captions", model: "youtube-captions", language: "zh", output_segments_json: "transcripts/mlx/segments.json" }],
  }));
  const r = handoffFromPackage(pkg, { source: "https://youtu.be/abc", icloud });
  assert.equal(r.name, "2026-09-01--別人的分享", "YouTube 用上傳日期");
  const h = fs.readFileSync(path.join(r.dir, "handoff.md"), "utf8");
  for (const want of ["- 來源：https://www.youtube.com/watch?v=abc", "- 長度：01:02:10", "- 語言：zh", "- 轉錄方式：youtube-captions",
    "頻道：某頻道", "引擎改用：mlx → captions（HTTP 403）", "可能是自動字幕", `轉錄包：${pkg}（還沒歸檔到 Drive`, "沒有分章重點"]) {
    assert.ok(h.includes(want), `missing ${want}\n${h}`);
  }
  assert.match(h, /^event_date: "2026-09-01"$/m);
});

test("a Studio project hands over its description, AI-changed lines and full text", (t) => {
  const { root, icloud } = tempIcloud(t);
  const video = path.join(root, "會議.mp4");
  fs.writeFileSync(video, "v");
  const p = {
    name: "會議", video, duration_ms: 65_000, proofreader: "claude", cuts: [{ start: 0, end: 1000 }],
    description: "簡介\n\n00:00 開場\n・重點一\n",
    cues: [{ start: 0, end: 1000, text: "大家好" }, { start: 61_000, end: 62_000, text: "Claude Code", ai: [{ find: "Cloud Code", replace: "Claude Code" }] }, { start: 63_000, end: 64_000, text: " " }],
  };
  const r = handoffFromStudio(p, { dir: path.join(root, "會議-字幕"), icloud });
  const h = fs.readFileSync(path.join(r.dir, "handoff.md"), "utf8");
  for (const want of ["00:00 開場\n・重點一", "[00:01:01] AI 校對把「Cloud Code」改成「Claude Code」", "- 長度：00:01:05", "有剪輯", "字幕專案資料夾：", "Soniox＋claude 校對"]) {
    assert.ok(h.includes(want), `missing ${want}\n${h}`);
  }
  const tx = fs.readFileSync(path.join(r.dir, "transcript.md"), "utf8");
  assert.match(tx, /\*\*\[00:00:00\]\*\* 大家好/);
  assert.match(tx, /\*\*\[00:01:01\]\*\* Claude Code/);
  assert.throws(() => handoffFromStudio({ ...p, cues: [] }, { dir: root, icloud }), /沒有字幕/);
});

test("a half-written handoff is removed, and titles with line breaks stay on one line", (t) => {
  const { icloud, toWiki } = tempIcloud(t);
  assert.throws(() => writeHandoff({ ...item(), handoff: undefined }, { icloud }));
  assert.deepEqual(fs.readdirSync(toWiki), [], "no half-written folder is left for an agent to pick up");
  const r = handoffFromStudio({ name: "第一行\n第二行", video: "/nope.mp4", cues: [{ start: 0, end: 1000, text: "嗨" }] }, { dir: "/x", icloud });
  const h = fs.readFileSync(path.join(r.dir, "handoff.md"), "utf8");
  assert.match(h, /^# 交接單：第一行 第二行$/m);
  assert.match(h, /^title: "第一行 第二行"$/m);
});

test("without icloud_inbox there is no handoff, and writing one is refused", (t) => {
  const { icloud } = tempIcloud(t);
  assert.equal(handoffEnabled(""), false);
  assert.equal(handoffEnabled("Inbox"), true);
  assert.throws(() => writeHandoff(item(), { icloud, inbox: "" }), /沒有設定 icloud_inbox/);
  assert.deepEqual(fs.readdirSync(icloud), [], "iCloud 裡什麼都沒寫");
});
