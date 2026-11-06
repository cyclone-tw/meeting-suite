// Subtitle Studio
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as ops from "../lib/cue-ops.mjs";
import { icloudStudioDir, isOffline, markAiCues, parseSrt, projectDirFor, readProject, validateCues, writeProject } from "../lib/studio-project.mjs";
import { copyToDriveIsolated } from "../lib/studio-drive.mjs";
import { createStudio, needsCc, shortKey } from "../scripts/subtitle-studio.mjs";
import { fakeRecapFiles } from "./fake-recap-files.mjs";
import { runSubtitle } from "../scripts/subtitle-run.mjs";
import { addCorrection } from "../lib/corrections-sync.mjs";
import { pickInfo } from "../lib/youtube-source.mjs";
import { toSrt } from "../lib/subtitle-text.mjs";
import { nameFixes } from "../lib/subtitle-ai.mjs";
import { scribeDir } from "../lib/meeting-recap.mjs";
import { resetAsrProfileCache } from "../lib/asr-profile.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";

useTestProfile({ icloud_inbox: "Inbox", studio_drive: { label: "學校 Drive" } });
// 測試不看這台有沒有裝 Claude Code：工作室只檢查執行檔在不在，真正的呼叫都換成假的
const FAKE_CLAUDE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-fake-claude-")), "claude");
fs.writeFileSync(FAKE_CLAUDE, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
process.env.CYCLONE_CLAUDE_BIN = FAKE_CLAUDE;
process.on("exit", () => fs.rmSync(path.dirname(FAKE_CLAUDE), { recursive: true, force: true }));

const cues = () => [
  { start: 0, end: 1000, text: "今天我們來談" },
  { start: 1200, end: 2000, text: "Claude Code" },
  { start: 3000, end: 4000, text: "怎麼用" },
];

test("cue ops: find, split, merge, timing limits, insert, replace", () => {
  const c = cues();
  assert.equal(ops.cueIndexAt(c, 500), 0);
  assert.equal(ops.cueIndexAt(c, 2500), -1, "兩句之間");
  assert.equal(ops.cueIndexAt(c, 1200), 1);
  const s = ops.splitCue(c, 0, 2);
  assert.deepEqual(s.slice(0, 2).map((x) => x.text), ["今天", "我們來談"]);
  assert.ok(s[0].end === s[1].start && s[0].end > 0 && s[0].end < 1000);
  assert.equal(c[0].text, "今天我們來談", "不改原陣列");
  assert.equal(ops.splitCue(c, 0, 0), c);
  const m = ops.mergeNext(c, 1);
  assert.deepEqual(m[1], { start: 1200, end: 4000, text: "Claude Code 怎麼用" });
  assert.equal(ops.setTime(c, 1, "start", 500).at(1).start, 1000, "不能早於上一句的結束");
  assert.equal(ops.setTime(c, 1, "end", 9000)[1].end, 3000, "不能晚於下一句的開始");
  assert.equal(ops.setTime(c, 1, "end", 1250)[1].end, 1200 + ops.MIN_CUE_MS);
  assert.equal(ops.nudge(c, 2, "start", -100)[2].start, 2900);
  const ins = ops.insertAt(c, 2100);
  assert.equal(ins.index, 2);
  assert.deepEqual(ins.cues[2], { start: 2100, end: 3000, text: "" });
  assert.equal(ops.insertAt(c, 500).index, -1, "在字幕裡面不插");
  const r = ops.replaceAll([...c, { start: 5000, end: 6000, text: "Claude Code 和 Claude" }], "Claude", "克勞德", 1);
  assert.equal(r.count, 2);
  assert.equal(r.cues[1].text, "Claude Code", "except 那句不動");
  assert.equal(ops.countIn(c, "Code"), 1);
  assert.equal(ops.tooLong("一二三四五六七八九十一二三四五六七八九"), true);
  assert.equal(ops.tooLong("Claude Code 和 Codex 一起用"), false, "英數算半格");
});

test("an edit suggests a wrong→right pair, widened to whole English words", () => {
  assert.deepEqual(ops.correctionFromEdit("今天學長的孩子", "今天學障的孩子"), { wrong: "學長", right: "學障" });
  assert.deepEqual(ops.correctionFromEdit("我用 Clode Code", "我用 Claude Code"), { wrong: "Clode", right: "Claude" });
  assert.equal(ops.correctionFromEdit("一樣", "一樣"), null);
  assert.equal(ops.correctionFromEdit("刪掉這幾個字", "刪掉"), null, "純刪字不提示");
  assert.equal(ops.correctionFromEdit("短", "整句完全改寫成另外一個很長很長的意思了"), null, "太長不提示");
});

test("project helpers: SRT round trip, validation, AI marks", () => {
  const srt = toSrt(cues());
  assert.deepEqual(parseSrt(`﻿${srt.replace(/\n/g, "\r\n")}`), cues());
  assert.throws(() => validateCues([{ start: 5, end: 1, text: "x" }]), /時間/);
  assert.throws(() => validateCues([{ start: 0, end: 1, text: "字".repeat(201) }]), /太長/);
  assert.throws(() => validateCues("nope"), /格式/);
  assert.deepEqual(validateCues([{ start: 2000.4, end: 3000, text: " b\n c " }, { start: 0, end: 1, text: "a", ai: [{ find: 1 }] }]),
    [{ start: 0, end: 1, text: "a" }, { start: 2000, end: 3000, text: "b c" }]);
  const marked = markAiCues(cues(), [{ find: "Cloud Code", replace: "Claude Code" }]);
  assert.deepEqual(marked[1].ai, [{ find: "Cloud Code", replace: "Claude Code" }]);
  assert.equal(marked[0].ai, undefined);
  assert.equal(projectDirFor("/a/b/影片 1.mp4"), "/a/b/影片 1-字幕");
});

test("adding a correction refuses an unexpected body instead of overwriting the master list", async (t) => {
  let posted = false;
  const server = http.createServer((req, res) => {
    if (req.method === "GET") res.writeHead(200, { "Content-Type": "text/html" }).end("<html>login</html>");
    else { posted = true; res.writeHead(500).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const env = { CYCLONE_MEETING_SCRIBE_URL: `http://127.0.0.1:${server.address().port}`, CYCLONE_CORRECTIONS_CACHE: path.join(os.tmpdir(), `rt-nc-${process.pid}.json`) };
  await assert.rejects(addCorrection("克勞德", "Claude", { env }), /格式不對/);
  assert.equal(posted, false, "不能寫回");
});

// ---- Studio server：用假的辨識與燒錄 ----
// 燒錄 ASS 裡每個框（BoxBg）的開始時間
const boxStarts = (ass) => [...ass.matchAll(/^Dialogue: 0,([\d:.]+),[\d:.]+,BoxBg,/gm)].map((m) => m[1]);

// 假裝 Drive 卡住：讀了輸入之後一直不回
const HANG_SCRIPT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-hang-")), "hang.mjs");
fs.writeFileSync(HANG_SCRIPT, "process.stdin.resume(); setInterval(() => {}, 1000);\n");

async function startStudio(t, extra = {}) {
  const dir = extra.dir || fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const calls = { prepare: 0, burn: 0, remux: 0, added: [] };
  let releaseBurn = () => {};
  const burnGate = extra.holdBurn ? new Promise((r) => { releaseBurn = r; }) : Promise.resolve();
  let release = () => {};
  const gate = extra.hold ? new Promise((r) => { release = r; }) : Promise.resolve();
  const studio = createStudio({
    // 不連主機、不跑這台真的會議轉錄 App（#83）
    env: { CYCLONE_STUDIO_STATE: path.join(dir, "state"), CYCLONE_MEETING_SCRIBE_URL: "", CYCLONE_MEETING_SCRIBE_DIR: "", CYCLONE_STUDIO_DRIVE_DIR: "", ...(extra.env || {}) },
    token: "tok",
    deps: {
      preflight() {},
      ffprobeFps: () => 30,
      // 字寬固定用估算、影片當 1080p：測試不跑 osascript／ffprobe（#55）
      measureAdvances: () => ({}),
      videoSize: () => ({ w: 1920, h: 1080 }),
      async prepareSubtitles(o, { work, onStep }) {
        calls.prepare += 1;
        calls.prepareOpts = o;
        assert.ok(fs.existsSync(work));
        onStep("asr");
        await gate;
        if (extra.failPrepare) throw Object.assign(new Error("no speech recognised"), { report: { steps: {} } });
        return { cues: cues(), applied: [{ find: "Cloud Code", replace: "Claude Code" }], rejected: [], description: extra.description || "簡介", chapters: [], timing: [["今", 0, 100]], report: { edits: { applied: 1 } } };
      },
      async burnSubtitles({ srt, target, onProgress, keep, subtitles }) {
        calls.burn += 1;
        calls.keep = keep;
        calls.subtitles = subtitles;
        calls.srt = fs.readFileSync(srt, "utf8");
        onProgress(0.5);
        await burnGate;
        fs.writeFileSync(target, "burned");
      },
      async syncCorrections() { return { source: "meeting-scribe", corrections: { hints: [["學長", "學障"]], fixed: [] } }; },
      async addCorrection(w, r) { calls.added.push([w, r]); return { added: true, hints: 2, fixed: 0 }; },
      async pickFile() { return path.join(dir, "v.mp4"); },
      reveal() {},
      async remuxPreview(src, target) {
        calls.remux += 1;
        // 和真的一樣：先寫 partial，過一下才改名
        const tmp = `${target}.partial.mp4`;
        fs.writeFileSync(tmp, "preview-mp4");
        await new Promise((r) => setTimeout(r, extra.remuxMs || 0));
        fs.renameSync(tmp, target);
      },
      videoDirs: () => [dir],
      inCloudFolder: (f) => f.includes(`${path.sep}icloud${path.sep}`),
      recapFiles: () => fakeRecapFiles,
      ...(extra.deps || {}),
    },
  });
  const port = await studio.listen(0);
  const video = path.join(dir, "v.mp4");
  if (!fs.existsSync(video)) fs.writeFileSync(video, Buffer.from("0123456789abcdef"));
  t.after(async () => { releaseBurn(); await studio.close(); if (!extra.keep) fs.rmSync(dir, { recursive: true, force: true }); });
  const req = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { Host: `127.0.0.1:${port}`, "X-Studio-Token": "tok", ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  const waitFor = async (id, pred) => {
    for (let i = 0; i < 100; i++) {
      const r = await req("GET", `/api/projects/${id}`);
      if (pred(r.json)) return r.json;
      await new Promise((x) => setTimeout(x, 20));
    }
    throw new Error("timed out");
  };
  return { dir, port, video, calls, req, waitFor, release, releaseBurn, studio };
}

test("studio refuses other hosts, cross-site origins and missing tokens", async (t) => {
  const s = await startStudio(t);
  assert.equal((await s.req("GET", "/api/home", { headers: { Host: "evil.example:80" } })).status, 403, "DNS rebinding");
  assert.equal((await s.req("GET", "/api/home", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await s.req("GET", "/api/home", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await s.req("GET", "/api/home", { headers: { "X-Studio-Token": "wrong" } })).status, 403);
  assert.equal((await s.req("POST", "/api/open", { headers: { "X-Studio-Token": "" }, body: { video: s.video, privacy: "public" } })).status, 403);
  assert.equal(s.calls.prepare, 0);
  const page = await s.req("GET", "/", { headers: { "X-Studio-Token": "" } });
  assert.equal(page.status, 200);
  assert.match(page.raw, /<meta name="studio-token" content="tok">/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /script-src 'self'(;|$)/, "頁面沒有 inline script，script-src 不留 unsafe-inline（#163）");
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe/);
  assert.equal((await s.req("GET", "/api/home")).status, 200);
});

test("open → process → edit with revisions → burn; SRT and description are always current", async (t) => {
  const s = await startStudio(t);
  assert.equal((await s.req("POST", "/api/open", { body: { video: s.video, privacy: "nope" } })).status, 400, "privacy 值不合法");
  assert.match((await s.req("POST", "/api/open", { body: { video: s.video, privacy: "student-private", proofreader: "pi" } })).json.error, /mainland-China/);
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  assert.equal(open.status, 200, open.raw);
  const { id } = open.json;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.cues.length, 3);
  assert.deepEqual(p.cues[1].ai, [{ find: "Cloud Code", replace: "Claude Code" }]);
  const folder = projectDirFor(fs.realpathSync(s.video));
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, "project.json")).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(folder).some((n) => n.startsWith(".work-")), "暫存資料夾刪掉了");

  const edited = [...p.cues];
  edited[0] = { ...edited[0], text: "今天我們來聊" };
  const put = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: edited, description: "新的簡介", size: "large" } });
  assert.equal(put.status, 200);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: edited } })).status, 409, "舊版本不能蓋掉新的");
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: put.json.rev, size: "huge" } })).status, 400);
  assert.match(fs.readFileSync(path.join(folder, "subtitles.srt"), "utf8"), /今天我們來聊/);
  assert.equal(fs.readFileSync(path.join(folder, "youtube-description.md"), "utf8"), "新的簡介");

  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  const done = await s.waitFor(id, (x) => x.burn?.status === "done");
  assert.equal(done.burn.output, "v-字幕.mp4");
  assert.equal(done.burn.size, "large");
  assert.match(s.calls.srt, /今天我們來聊/);
  assert.ok(fs.existsSync(path.join(folder, "v-字幕.mp4")));
  assert.ok(!fs.readdirSync(folder).some((n) => n.startsWith(".burn-")));

  // 再開同一支影片：直接回到同一個專案，不重新辨識
  const again = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  assert.deepEqual(again.json, { id, reopened: true });
  assert.equal(s.calls.prepare, 1);
  const home = await s.req("GET", "/api/home");
  assert.equal(home.json.recent[0].id, id);
  assert.deepEqual(home.json.videos.map((v) => v.name), ["v.mp4"], "燒好的 -字幕.mp4 不列進來");
});

test("video streams with byte ranges for seeking", async (t) => {
  const s = await startStudio(t);
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json;
  await s.waitFor(id, (x) => x.status === "ready");
  assert.equal((await s.req("GET", `/api/projects/${id}/video`, { headers: { "X-Studio-Token": "" } })).status, 403);
  const r = await s.req("GET", `/api/projects/${id}/video?t=tok`, { headers: { "X-Studio-Token": "", Range: "bytes=4-7" } });
  assert.equal(r.status, 206);
  assert.equal(r.raw, "4567");
  assert.equal(r.headers["content-range"], "bytes 4-7/16");
  assert.equal((await s.req("GET", `/api/projects/${id}/video?t=tok`, { headers: { Range: "bytes=99-" } })).status, 416);
});

test("the recognition result stays in the project, so a retry or a reprocess does not pay again", async (t) => {
  let fail = true;
  const seen = [];
  const s = await startStudio(t, { deps: {
    async prepareSubtitles(o) {
      seen.push(o.asrCache);
      fs.writeFileSync(o.asrCache, "{}");   // 真的 prepareSubtitles 辨識完就會寫這個檔（#28）
      if (fail) throw new Error("proofreading crashed");
      return { cues: cues(), applied: [], rejected: [], description: "", chapters: [], timing: [], report: {} };
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const failed = await s.waitFor(id, (p) => p.status === "failed");
  assert.match(failed.error, /proofreading crashed/);
  assert.equal(failed.has_asr, true);
  const cache = seen[0];
  assert.equal(path.basename(cache), "asr.json");
  assert.equal((await s.req("POST", `/api/projects/${id}/reprocess`)).status, 200, "失敗的也能重新處理");
  await s.waitFor(id, (p) => p.status === "failed" && seen.length === 2);
  fail = false;
  assert.equal((await s.req("POST", `/api/projects/${id}/retry`)).status, 200);
  const ready = await s.waitFor(id, (p) => p.status === "ready");
  assert.equal(seen[2], cache, "用同一個檔");
  assert.ok(fs.existsSync(cache), "成功後留著（#30）");
  assert.equal(ready.has_asr, true);
  assert.equal((await s.req("POST", `/api/projects/${id}/retry`)).status, 409, "做好的不能重試");
  assert.equal((await s.req("POST", `/api/projects/${id}/reprocess`)).status, 200, "做好的可以重新處理");
  await s.waitFor(id, (p) => p.status === "ready" && seen.length === 4);
  const pv = await s.req("POST", "/api/preview", { body: { video: s.video } });
  assert.equal(pv.json.project_status, "ready");
});

test("re-laying out subtitles uses the saved character times, keeps AI marks and needs no recognition", async (t) => {
  const s = await startStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.has_timing, true);
  const dir = p.folder;
  // 校對後每個字的時間：「去年聽培芬還有聽洪昌老師還有鼎翔老師講述他們的工作內容的時候」＋「今天我們來談Claude Code」
  const text = "去年聽培芬還有聽洪昌老師還有鼎翔老師講述他們的工作內容的時候。今天我們來談Claude Code怎麼用。";
  fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify([...text].map((c, i) => [c, i * 200, i * 200 + 180])));
  const before = s.calls.prepare;
  const r = await s.req("POST", `/api/projects/${id}/relayout`);
  assert.equal(r.status, 200, r.raw);
  const q = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(q.rev, p.rev + 1);
  assert.equal(r.json.cues, q.cues.length);
  assert.ok(q.cues.some((c) => c.text.includes("鼎翔老師")), q.cues.map((c) => c.text).join(" / "));
  assert.ok(q.cues.some((c) => c.ai?.some((e) => e.replace === "Claude Code")), "「AI 改過」的標記還在");
  assert.equal(s.calls.prepare, before, "沒有重新辨識");
  assert.match(fs.readFileSync(path.join(dir, "subtitles.srt"), "utf8"), /鼎翔老師/, "SRT 也更新了");
  fs.rmSync(path.join(dir, "timing.json"));
  assert.equal((await s.req("POST", `/api/projects/${id}/relayout`)).status, 409, "沒有每個字的時間就不能排");
});

test("a folder made by pnpm run subtitle opens without re-running; a failed run can be retried", async (t) => {
  const s = await startStudio(t);
  const other = path.join(s.dir, "w.mp4");
  fs.writeFileSync(other, "x");
  const folder = projectDirFor(fs.realpathSync(other));
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "subtitles.srt"), toSrt(cues()));
  fs.writeFileSync(path.join(folder, "youtube-description.md"), "舊簡介");
  const r = await s.req("POST", "/api/open", { body: { video: other, privacy: "public" } });
  assert.equal(r.json.imported, true);
  const p = (await s.req("GET", `/api/projects/${r.json.id}`)).json;
  assert.equal(p.status, "ready");
  assert.equal(p.cues.length, 3);
  assert.equal(p.description, "舊簡介");
  assert.equal(s.calls.prepare, 0);

  const busy = path.join(s.dir, "x.mp4");
  fs.writeFileSync(busy, "x");
  fs.mkdirSync(projectDirFor(fs.realpathSync(busy)));
  fs.writeFileSync(path.join(projectDirFor(fs.realpathSync(busy)), "notes.txt"), "mine");
  assert.match((await s.req("POST", "/api/open", { body: { video: busy, privacy: "public" } })).json.error, /已經有別的檔案/);
});

test("processing failure is reported and retry runs again", async (t) => {
  const s = await startStudio(t, { failPrepare: true });
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json;
  const p = await s.waitFor(id, (x) => x.status === "failed");
  assert.match(p.error, /no speech/);
  assert.equal((await s.req("POST", `/api/projects/${id}/retry`)).status, 200);
  await s.waitFor(id, (x) => x.status === "failed" && !x.job);
  assert.equal(s.calls.prepare, 2);
});

test("corrections: list comes from the shared store, additions go back to it", async (t) => {
  const s = await startStudio(t);
  const r = await s.req("GET", "/api/corrections");
  assert.deepEqual([r.json.source, r.json.hints], ["meeting-scribe", [["學長", "學障"]]]);
  assert.deepEqual((await s.req("POST", "/api/corrections", { body: { wrong: "克勞德", right: "Claude" } })).json, { added: true, hints: 2, fixed: 0 });
  assert.deepEqual(s.calls.added, [["克勞德", "Claude"]]);
});

test("non-mp4 videos get a preview copy that survives burning and comes back after forgetting", async (t) => {
  const s = await startStudio(t);
  const mkv = path.join(s.dir, "rec.mkv");
  fs.writeFileSync(mkv, "mkv-bytes");
  const { id } = (await s.req("POST", "/api/open", { body: { video: mkv, privacy: "public" } })).json;
  await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(s.calls.remux, 1);
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  await s.waitFor(id, (x) => x.burn?.status === "done");
  const v1 = await s.req("GET", `/api/projects/${id}/video?t=tok`, { headers: { "X-Studio-Token": "" } });
  assert.equal(v1.raw, "preview-mp4", "燒完預覽還在");
  assert.equal((await s.req("POST", `/api/projects/${id}/forget`)).status, 200);
  const again = await s.req("POST", "/api/open", { body: { video: mkv, privacy: "public" } });
  assert.equal(again.json.reopened, true);
  const v2 = await s.req("GET", `/api/projects/${again.json.id}/video?t=tok`, { headers: { "X-Studio-Token": "" } });
  assert.equal(v2.status, 200);
  assert.equal(s.calls.remux, 2, "預覽被刪了就重做");
});

test("a second studio that cannot take the port leaves the running one's burn alone", async (t) => {
  const s = await startStudio(t, { holdBurn: true });
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/burn`);
  await s.waitFor(id, (x) => x.job?.kind === "burn");
  const folder = projectDirFor(fs.realpathSync(s.video));
  const before = fs.readdirSync(folder).filter((n) => n.startsWith(".burn-"));
  assert.equal(before.length, 1);
  const second = createStudio({ env: { CYCLONE_STUDIO_STATE: path.join(s.dir, "state") }, token: "x" });
  await assert.rejects(second.listen(s.port), /EADDRINUSE/);
  assert.deepEqual(fs.readdirSync(folder).filter((n) => n.startsWith(".burn-")), before, "第二個 Studio 沒動暫存");
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "project.json"), "utf8")).burn.status, "running");
  s.releaseBurn();
  assert.equal((await s.waitFor(id, (x) => x.burn?.status === "done")).burn.output, "v-字幕.mp4");
});

test("rebuilding a preview survives autosaves and concurrent video requests", async (t) => {
  const s = await startStudio(t, { remuxMs: 150 });
  const mkv = path.join(s.dir, "rec.mkv");
  fs.writeFileSync(mkv, "mkv-bytes");
  const { id } = (await s.req("POST", "/api/open", { body: { video: mkv, privacy: "public" } })).json;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  fs.rmSync(path.join(projectDirFor(fs.realpathSync(mkv)), ".preview.mp4"));
  const vid = () => s.req("GET", `/api/projects/${id}/video?t=tok`, { headers: { "X-Studio-Token": "" } });
  const [a, b, put] = await Promise.all([vid(), vid(), (async () => {
    await new Promise((r) => setTimeout(r, 40));
    return s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: p.cues } });
  })()]);
  assert.deepEqual([a.status, b.status, put.status], [200, 200, 200]);
  assert.equal(a.raw, "preview-mp4");
  assert.equal(s.calls.remux, 2, "準備時一次＋重做一次，兩個同時的請求共用");
});

test("reopening a public project as containing personal data switches a mainland-China-capable proofreader to Claude", async (t) => {
  const s = await startStudio(t);
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", proofreader: "pi" } })).json;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", "/api/open", { body: { video: s.video, privacy: "student-private" } });
  const p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual([p.privacy, p.proofreader], ["student-private", "claude"]);
  await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.privacy, "student-private", "不會被改回比較寬鬆");
});

test("saving while a burn runs keeps both the edits and the burn result", async (t) => {
  const s = await startStudio(t, { holdBurn: true });
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/burn`);
  await s.waitFor(id, (x) => x.job?.kind === "burn");
  const cues2 = p.cues.map((c, i) => (i === 0 ? { ...c, text: "燒的時候改的" } : c));
  const put = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: cues2 } });
  assert.equal(put.status, 200);
  s.releaseBurn();
  const done = await s.waitFor(id, (x) => x.burn?.status === "done");
  assert.equal(done.cues[0].text, "燒的時候改的");
  assert.equal(done.burn.rev, p.rev, "燒的是開始時的版本，介面會提示要再燒一次");
  assert.notEqual(done.rev, done.burn.rev);
});

test("a studio that was killed mid-job: the next start clears temp files and marks the job interrupted", async (t) => {
  const s = await startStudio(t, { keep: true });
  const { id } = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json;
  await s.waitFor(id, (x) => x.status === "ready");
  const folder = projectDirFor(fs.realpathSync(s.video));
  // 模擬被砍：狀態停在燒錄中，留下暫存
  const pj = JSON.parse(fs.readFileSync(path.join(folder, "project.json"), "utf8"));
  pj.burn = { status: "running" };
  fs.writeFileSync(path.join(folder, "project.json"), JSON.stringify(pj));
  fs.mkdirSync(path.join(folder, ".burn-x"));
  fs.writeFileSync(path.join(folder, ".burn-x", "subs.srt"), "字幕");
  fs.mkdirSync(path.join(folder, ".work-y"));
  fs.writeFileSync(path.join(folder, ".preview.mp4.partial.mp4"), "x");
  await s.studio.close();
  const s2 = await startStudio(t, { dir: s.dir });
  assert.deepEqual(fs.readdirSync(folder).filter((n) => n.startsWith(".")), [], "啟動時就清掉");
  const p = (await s2.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.burn.status, "failed");
  assert.match(p.burn.error, /被關掉/);
});

test("timing edits never overlap neighbours, even when the gap is short", () => {
  const c = [{ start: 0, end: 1000, text: "a" }, { start: 1100, end: 1150, text: "b" }, { start: 1200, end: 2000, text: "c" }];
  assert.equal(ops.setTime(c, 1, "start", 0)[1].start, 1000);
  assert.equal(ops.setTime(c, 1, "end", 5000)[1].end, 1200);
  assert.ok(ops.setTime(c, 1, "start", 1140)[1].start >= 1000);
  assert.equal(ops.splitCue(c, 9, 1), c, "不存在的句子不動");
});

// review #832：拆段後 runSubtitle 的清理保證（暫存刪掉、報告不含錯字表或字幕內容）
test("runSubtitle removes its work files and keeps content out of report.json", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, "v.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "color=c=black:s=64x36:d=1", "-shortest", "-c:v", "libx264", "-c:a", "aac", video]);
  if (mk.status !== 0) return t.skip("ffmpeg cannot make a test clip");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // 假的 mlx_whisper：寫出含學生姓名的辨識結果；假的 pi：不改任何字
  fs.writeFileSync(path.join(bin, "mlx_whisper"), `#!/bin/sh\nwhile [ "$1" != "--output-dir" ]; do shift; done\nprintf '{"segments":[{"words":[{"word":"王小明今天","start":0,"end":0.8}]}]}' > "$2/audio.json"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho '{"edits":[]}'\n`, { mode: 0o755 });
  const corr = path.join(dir, "corr.json");
  fs.writeFileSync(corr, JSON.stringify({ hints: [["王曉明", "王小明"]], fixed: [] }));
  // 不連真的主機、不讀真的快取：只剩本機那份（備援主機的情形）
  const envKeys = ["PATH", "CYCLONE_CORRECTIONS_FILE", "CYCLONE_MEETING_SCRIBE_URL", "CYCLONE_CORRECTIONS_CACHE"];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CYCLONE_CORRECTIONS_FILE = corr;
  process.env.CYCLONE_MEETING_SCRIBE_URL = "";
  process.env.CYCLONE_CORRECTIONS_CACHE = path.join(dir, "no-cache.json");
  t.after(() => { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const out = path.join(dir, "out");
  const report = await runSubtitle({ video, out, privacy: "public", engine: "whisper", proofreader: "pi", terms: [] });
  assert.deepEqual(report.corrections, { source: "local", hints: 1, fixed: 0 });
  assert.equal(report.cleanup.work_dir_left, false);
  assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith(".")), []);
  assert.match(fs.readFileSync(path.join(out, "subtitles.srt"), "utf8"), /王小明今天/);
  assert.doesNotMatch(fs.readFileSync(path.join(out, "report.json"), "utf8"), /王/);

  fs.writeFileSync(path.join(bin, "mlx_whisper"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const out2 = path.join(dir, "out2");
  await assert.rejects(runSubtitle({ video, out: out2, privacy: "public", engine: "whisper", proofreader: "pi", terms: [] }), /mlx_whisper failed/);
  assert.deepEqual(fs.readdirSync(out2), [], "失敗也不留暫存");
});

// ---- 預覽與粗剪（recording-transcriber#4）----
test("opening a project with cuts transcribes only the kept parts and exports edited times", async (t) => {
  const s = await startStudio(t, { description: "簡介\n\n00:00 開場\n00:03 重點\n00:20 結尾\n", deps: { videoDurationMs: () => 40_000 } });
  const bad = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", cuts: [{ start: 5, end: 1 }] } });
  assert.equal(bad.status, 400, "壞掉的剪輯擋下");
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", cuts: [{ start: 1200, end: 2900, by: "user" }, { start: 30_000, end: 99_000 }] } });
  assert.equal(open.status, 200, open.raw);
  const p = await s.waitFor(open.json.id, (x) => x.status === "ready");
  assert.deepEqual(p.cuts, [{ start: 1200, end: 2900, by: "user" }, { start: 30_000, end: 40_000, by: "user" }], "裁到片長、排好");
  assert.deepEqual(s.calls.prepareOpts.keep, [[0, 1200], [2900, 30_000]], "只送保留段辨識");
  assert.equal(s.calls.prepareOpts.durationMs, 40_000);
  const dir = projectDirFor(s.video);
  assert.equal(fs.statSync(path.join(dir, "timing.json")).mode & 0o777, 0o600);
  // 字幕存原片時間；SRT 和說明欄換算成剪輯後的時間
  assert.deepEqual(p.cues.map((c) => c.start), [0, 1200, 3000]);
  const srt = parseSrt(fs.readFileSync(path.join(dir, "subtitles.srt"), "utf8"));
  assert.deepEqual(srt.map((c) => [c.start, c.end, c.text]), [[0, 1000, "今天我們來談"], [1300, 2300, "怎麼用"]], "Claude Code 那句整句剪掉");
  assert.equal(fs.readFileSync(path.join(dir, "youtube-description.md"), "utf8"), "簡介\n\n00:00 開場\n00:18 結尾\n", "章節跟著換算，太近的併掉");
  // 燒字幕：剪輯一起交給 ffmpeg，字幕是剪輯後的時間
  assert.equal((await s.req("POST", `/api/projects/${open.json.id}/burn`)).status, 200);
  await s.waitFor(open.json.id, (x) => x.burn?.status === "done");
  assert.deepEqual(s.calls.keep, [[0, 1200], [2900, 30_000]]);
  assert.deepEqual(boxStarts(s.calls.srt), ["0:00:00.00", "0:00:01.30"], "圓角底框的 ASS：每句一個框，時間是剪完的");
});

test("a project without cuts keeps the old behaviour exactly", async (t) => {
  const s = await startStudio(t);
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  await s.waitFor(open.json.id, (x) => x.status === "ready");
  assert.equal(s.calls.prepareOpts.keep, undefined);
  assert.deepEqual(parseSrt(fs.readFileSync(path.join(projectDirFor(s.video), "subtitles.srt"), "utf8")), cues());
});

// 頁面的 script 沒有編譯步驟：語法錯（例如重複宣告）會讓整頁空白，這裡先擋（#18）。
// 拆檔後（#50）幾個檔共用全域範圍、依序載入：在同一個 vm context 依 studio.html 的順序跑一遍，
// 跨檔重複宣告、或頂層用到後面才宣告的名稱，都會在這裡丟錯。
const pageScripts = () => {
  const html = fs.readFileSync(new URL("../web/studio.html", import.meta.url), "utf8");
  // /shared/ 是會議轉錄 App 的共用元件（#111），在那個 repo 測；這裡的頁面測試用假的代替
  // /studio/lang-en.js 是資料（字典）；/studio/i18n.js 在 <head> 先跑（#152），這裡排在 libs.mjs 後面、其他檔前面，順序一樣
  const all = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map((m) => ({ attrs: m[1], src: m[1].match(/src="([^"]+)"/)?.[1] }))
    .filter((x) => !x.src?.startsWith("/shared/") && x.src !== "/studio/lang-en.js");
  const boot = all.filter((x) => x.src === "/studio/i18n.js"), rest = all.filter((x) => x.src !== "/studio/i18n.js");
  return [rest[0], ...boot, ...rest.slice(1)];
};

test("the page scripts load in order without errors", async () => {
  const vm = await import("node:vm");
  const list = pageScripts();
  assert.equal(list[0].src, "/studio/libs.mjs", "lib 要先載入");
  assert.match(list[0].attrs, /type="module"/);
  // libs.mjs 本身在 node 裡 import 不了（路徑是伺服器上的），檢查語法和它真的把兩個 lib 掛到全域
  const libs = fs.readFileSync(new URL("../web/studio/libs.mjs", import.meta.url), "utf8");
  const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: libs, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(libs, /^import \* as ops from "\/cue-ops\.mjs";$/m);
  assert.match(libs, /^import \* as cutOps from "\/cuts\.mjs";$/m);
  assert.match(libs, /^window\.ops = ops;$/m);
  assert.match(libs, /^window\.cutOps = cutOps;$/m);
  assert.match(libs, /^import \* as shortOps from "\/shorts\.mjs";$/m);
  assert.match(libs, /^window\.shortOps = shortOps;$/m);
  const classic = list.slice(1);
  assert.ok(classic.length >= 5);
  assert.equal(classic[0].src, "/studio/i18n.js", "介面語言的設定要比其他頁面程式先跑（#152）");
  assert.doesNotMatch(classic[0].attrs, /\bdefer\b/);
  for (const x of classic.slice(1)) assert.match(x.attrs, /\bdefer\b/, `${x.src} 要 defer，才會排在 module 後面`);
  // 什麼都接得住的假 DOM：取任何屬性、呼叫都回自己，轉字串是空字串
  const stub = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub),
    apply: () => stub, construct: () => stub, set: () => true,
  });
  const ctx = vm.createContext({ document: stub, location: { hash: "" }, fetch: () => new Promise(() => {}), setTimeout, clearTimeout,
    setInterval, clearInterval, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of classic) {
    const code = fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8");
    assert.match(code, /^"use strict";/, `${x.src} 要維持 strict（原本是 module）`);
    new vm.Script(code, { filename: x.src }).runInContext(ctx);
  }
});

// AI 更正名字（#60）：在同一個 vm context 跑真的頁面 script，假的 DOM 只記住屬性與事件，
// 走一次「請 AI 找 → 預覽 → 取消勾一組 → 套用 → 加入錯字表 → 復原」
function fakePage() {
  const stub = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub),
    apply: () => stub, construct: () => stub, set: () => true,
  });
  const el = () => {
    const o = { value: "", checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "", dataset: {}, style: {}, on: {} };
    o.addEventListener = (type, fn) => { o.on[type] = fn; };
    o.setAttribute = (k, v) => { o[`attr:${k}`] = v; };
    return new Proxy(o, { get: (x, k) => (k in x ? x[k] : k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub), set: (x, k, v) => { x[k] = v; return true; } });
  };
  const els = new Map();
  const doc = new Proxy({
    querySelector: (s) => { if (!els.has(s)) els.set(s, el()); return els.get(s); },
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener() {},
  }, { get: (x, k) => (k in x ? x[k] : stub) });
  return { doc, stub, $: (s) => doc.querySelector(s) };
}

test("AI 更正名字的頁面：預覽、取消一組、套用並標成 AI 改過、加入錯字表、整批復原", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [];
  const replies = {
    "POST /api/projects/0123456789abcdef/names": { pairs: [{ wrong: "思妤", right: "詩妤" }, { wrong: "詩語", right: "詩妤" }, { wrong: "子傑", right: "梓傑" }, { wrong: "剛改掉", right: "x" }], dropped: 1 },
    "PUT /api/projects/0123456789abcdef": { rev: 8, updated: new Date().toISOString() },
    "POST /api/corrections": { added: 1, hints: 3, fixed: 0 },
    "GET /api/corrections?refresh=1": { source: "local", hints: [], fixed: [] },
  };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    // 載入時首頁會要清單：不回應，和原本的頁面測試一樣
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  run(`state.id = "0123456789abcdef"; state.rev = 7; state.cues = ${JSON.stringify([
    { start: 0, end: 1000, text: "今天請到思妤老師" },
    { start: 1000, end: 2000, text: "詩語老師和子傑一起來", ai: [{ find: "以起", replace: "一起" }] },
    { start: 2000, end: 3000, text: "謝謝思妤" },
  ])};`);
  const before = JSON.parse(run("JSON.stringify(state.cues)"));
  // 和 studio.html 的初始狀態一樣：面板收著、「加入錯字表」預設勾選
  $("#namesBox").hidden = true;
  $("#namesCorr").checked = true;

  $("#namesOpen").onclick();
  assert.equal($("#namesBox").hidden, false, "按「AI 更正名字」打開面板");
  await $("#namesFind").onclick();
  assert.equal(calls.length, 0, "沒寫說明不送出");
  assert.match($("#namesNote").textContent, /先寫/);
  $("#namesIn").value = "  思妤、詩語都是詩妤  ";
  await $("#namesFind").onclick();
  assert.deepEqual(calls.at(-1), { key: "POST /api/projects/0123456789abcdef/names", body: { instruction: "思妤、詩語都是詩妤" } });
  assert.equal($("#namesResult").hidden, false);
  assert.equal($("#namesFind").disabled, false, "找完就能再找");
  // 字幕裡已經找不到的那組不列；每組列出次數與上下文
  const html = $("#namesList").innerHTML;
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /思妤<\/span><span class="arrow">→<\/span><b>詩妤<\/b><span class="muted">2 處/);
  assert.match(html, /今天請到<mark>思妤<\/mark>老師/);
  assert.doesNotMatch(html, /剛改掉/);
  assert.match($("#namesNote").textContent, /找到 3 組.*另有 2 組/);
  assert.equal($("#namesApply").textContent, "套用勾選的（4 處）");

  // 取消勾選「詩語 → 詩妤」
  const li = { classList: { toggle: (c, on) => { li.off = on; } } };
  const box = { dataset: { k: "1" }, checked: false, closest: () => li };
  $("#namesList").onchange({ target: { closest: () => box } });
  assert.equal(li.off, true);
  assert.equal($("#namesApply").textContent, "套用勾選的（3 處）");

  await $("#namesApply").onclick();
  const after = JSON.parse(run("JSON.stringify(state.cues)"));
  assert.deepEqual(after.map((c) => c.text), ["今天請到詩妤老師", "詩語老師和梓傑一起來", "謝謝詩妤"], "沒勾的那組不改");
  assert.deepEqual(after[0].ai, [{ find: "思妤", replace: "詩妤" }]);
  assert.deepEqual(after[1].ai, [{ find: "以起", replace: "一起" }, { find: "子傑", replace: "梓傑" }]);
  assert.equal(run("state.cues.filter((c) => c.ai?.length).length"), 3, "三句都在「AI 改過」裡");
  assert.equal($("#namesBox").hidden, true, "套用後收起面板");
  const corr = calls.find((c) => c.key === "POST /api/corrections");
  assert.deepEqual(corr.body, { pairs: [["思妤", "詩妤"], ["子傑", "梓傑"]] }, "只把有套用的加進錯字表，一次送出");
  assert.match($("#toast").innerHTML, /已改 3 處.*已加入錯字表 1 組/);
  // 照常自動存檔：送出的字幕帶著 AI 標記
  await run("flushSave()");
  const put = calls.find((c) => c.key === "PUT /api/projects/0123456789abcdef");
  assert.deepEqual(put.body.cues, after);
  assert.equal(put.body.rev, 7);

  // 「改回原字」照常可用
  run("state.sel = 0; showCue();");
  $("#aiNote").onclick({ target: { closest: (s) => (s === "[data-revert]" ? { dataset: { revert: "0" } } : null) } });
  assert.equal(run("state.cues[0].text"), "今天請到思妤老師");
  assert.equal(run("state.cues[0].ai"), undefined);
  // 復原兩步：先退「改回原字」，再整批退回 AI 更正前
  run("undo()");
  assert.equal(run("state.cues[0].text"), "今天請到詩妤老師");
  run("undo()");
  assert.deepEqual(JSON.parse(run("JSON.stringify(state.cues)")), before, "整批一次復原");
  assert.equal(run("state.undo.length"), 0);
});

test("整理視窗：上傳過才出現「連原始錄影一起丟」，預設不勾、勾了才送出；沒掛 CC 先提醒（#75）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [];
  const replies = { "POST /api/projects/0123456789abcdef/clear": { trashed: "v-字幕", moved: [], original_trashed: true } };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  run(`homeRecent = ${JSON.stringify([
    { id: "0123456789abcdef", name: "v", bytes: 5e6, outputs: [], youtube: { url: "https://youtu.be/V", needs_cc: true }, original_bytes: 4.6e9 },
    { id: "fedcba9876543210", name: "w", bytes: 1, outputs: [] },
  ])};`);
  // 沒上傳過：不出現、不提醒，清的時候不帶
  run(`openManage("fedcba9876543210")`);
  assert.equal($("#manageOrigRow").hidden, true);
  assert.equal($("#manageCcWarn").hidden, true);
  assert.match($("#manageNote").textContent, /原始影片不動/);
  // 上傳過：出現、預設不勾、標出大小；還沒掛 CC 就提醒
  $("#manageOrig").checked = true;
  run(`openManage("0123456789abcdef")`);
  assert.equal($("#manageOrigRow").hidden, false);
  assert.equal($("#manageOrig").checked, false, "每次打開都預設不勾");
  assert.equal($("#manageOrigSize").textContent, "（4.6 GB）");
  assert.equal($("#manageCcWarn").hidden, false);
  await $("#manageClear").onclick();
  assert.equal(calls.at(-1).body.trashOriginal, false, "沒勾就不丟原始錄影");
  run(`openManage("0123456789abcdef")`);
  $("#manageOrig").checked = true;
  $("#manageOrig").onchange();
  assert.match($("#manageNote").textContent, /資料夾和原始錄影都會在垃圾桶.*清空垃圾桶/);
  await $("#manageClear").onclick();
  assert.equal(calls.at(-1).body.trashOriginal, true);
  assert.match($("#toast").innerHTML, /和原始錄影丟到垃圾桶/);
});

test("會後總結分頁：四頁切換、逐字稿用剪輯後的時間、複製全部和 App 同格式、舊的總結會提醒（#80）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [], copied = [];
  const fresh = { intro: "新導言", full: "新的", short: "新短", chapters: [], created: new Date().toISOString(), stale: false };
  const replies = { "POST /api/projects/0123456789abcdef/recap": { recap: fresh } };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: { clipboard: { writeText: async (x) => { copied.push(x); } } }, matchMedia: stub, getComputedStyle: stub,
    RecapFiles: fakeRecapFiles,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  const recap = { intro: "導言", full: "## 核心結論\n結論", short: "短總結", chapters: [{ t_ms: 0, title: "開場" }, { t_ms: 65000, title: "討論" }], created: new Date().toISOString(), stale: false };
  run(`state.id = "0123456789abcdef"; state.p = { name: "v", recap: ${JSON.stringify(recap)} }; state.cues = ${JSON.stringify(cues())}; state.cuts = [{ start: 1100, end: 2100 }]; renderRecap();`);
  assert.equal($("#recapText").value, "導言\n\n[ 分段章節 ]\n00:00:00 開場\n00:01:05 討論", "簡介頁帶分段章節");
  assert.equal($("#recapMake").textContent, "重新產生");
  assert.equal($("#recapReveal").hidden, false);
  const pick = (v) => $("#recapSeg").onclick({ target: { closest: () => ({ dataset: { v } }) } });
  pick("full");
  assert.equal($("#recapText").value, "## 核心結論\n結論");
  pick("transcript");
  assert.equal($("#recapText").value, "[00:00:00] 今天我們來談\n[00:00:02] 怎麼用", "被剪掉的句子不列，時間是剪輯後的");
  await $("#recapCopy").onclick();
  assert.equal(copied.at(-1), "[00:00:00] 今天我們來談\n[00:00:02] 怎麼用");
  await $("#recapCopyAll").onclick();
  assert.equal(copied.at(-1), fakeRecapFiles.summaryMarkdown({ header: ["會議：v"], intro: "導言", chapters: [{ t_ms: 0, title: "開場" }, { t_ms: 65000, title: "討論" }], full: "## 核心結論\n結論", short: "短總結", transcript: "[00:00:00] 今天我們來談\n[00:00:02] 怎麼用" }), "複製全部用共用 RecapFiles 組（和 summary.md 同格式）");
  run("state.p.recap.stale = true; renderRecap();");
  assert.match($("#recapNote").textContent, /字幕改過了.*重新產生/);
  // 還沒有總結：只能產生，不能複製全部、不能在 Finder 顯示
  run("state.p.recap = null; recapView = 'intro'; renderRecap();");
  assert.equal($("#recapMake").textContent, "產生會後總結");
  assert.equal($("#recapCopyAll").disabled, true);
  assert.equal($("#recapReveal").hidden, true);
  await $("#recapMake").onclick();
  assert.equal(calls.at(-1).key, "POST /api/projects/0123456789abcdef/recap");
  assert.equal($("#recapText").value, "新導言", "產生好就顯示新的簡介");
  assert.equal($("#recapMake").disabled, false);
  assert.match($("#toast").innerHTML, /會後總結好了/);
});

test("延伸頁籤用會議 App 的共用 ExtPanel：送對的資料、產生／停止／複製／在 Finder 顯示接對、一次只跑一份（#88、#106、#111）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [], copied = [], updates = [];
  let hooks = null, mountedOn = null, release;
  const PERSP = { id: "perspective", title: "視角回饋", description: "換一個角色看這場會議", output: "markdown", options: [{ id: "who", label: "誰的視角", choices: [["boss", "老闆／主管"], ["parent", "家長"]] }] };
  const SPROUT = { id: "sprout", title: "讓這場會議發芽", description: "延伸探討與後續應用", output: "markdown", options: [] };
  const MAP = { id: "mindmap", title: "心智圖", description: "", output: "mindmap", options: [] };
  const made = { key: "perspective:who=parent", module: "perspective", output: "markdown", title: "視角回饋", label: "視角回饋（家長）<img src=x>", options: { who: "parent" }, markdown: "家長看到的", file: "視角回饋（家長）.md", created: new Date().toISOString(), stale: false, via: "local" };
  const replies = { "GET /api/modules": { modules: [SPROUT, MAP, PERSP] }, "POST /api/projects/0123456789abcdef/reveal": { ok: true }, "POST /api/projects/0123456789abcdef/cancel": { ok: true } };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (key === "POST /api/projects/0123456789abcdef/module") {
      calls.push({ key, body: JSON.parse(opts.body) });
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, json: async () => ({ module: made }) };
    }
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  // 假的 ExtPanel：記下掛在哪裡、宿主給的動作、每次 update 的資料
  const ExtPanel = { mount(el, h) { mountedOn = el; hooks = h; return { update: (st) => updates.push(JSON.parse(JSON.stringify(st))) }; } };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: { clipboard: { writeText: async (x) => { copied.push(x); } } }, matchMedia: stub, getComputedStyle: stub,
    ExtPanel, ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  const older = { key: "sprout", module: "sprout", output: "markdown", title: "讓這場會議發芽", label: "讓這場會議發芽", options: {}, markdown: "發芽的內容", file: "讓這場會議發芽.md", created: "2026-10-01T00:00:00.000Z", stale: true, via: "local" };
  const mapResult = { key: "mindmap", module: "mindmap", output: "mindmap", label: "心智圖", file: "mindmap.md", created: "2026-10-01T00:00:00.000Z" };
  run(`state.id = "0123456789abcdef"; state.p = { name: "v", recap: null, modules: [${JSON.stringify(older)}, ${JSON.stringify(mapResult)}] }; renderModules();`);
  assert.equal(mountedOn, $("#extHost"), "掛在延伸頁籤");
  assert.equal(updates.at(-1).loading, true, "清單還沒來");
  await run("loadModules()");
  let u = updates.at(-1);
  assert.deepEqual(u.modules.map((m) => m.id), ["sprout", "mindmap", "perspective"], "清單整份交給元件，元件自己挑 markdown");
  assert.equal(u.loading, false);
  assert.deepEqual(u.results.map((r) => r.key), ["sprout"], "心智圖的結果不給延伸");
  assert.match(u.results[0].meta, /在這台 Mac 產生，也存成資料夾裡的 讓這場會議發芽\.md/);
  assert.equal(u.busy, null);
  // 產生：元件呼叫 onRun → 工作室送請求、元件收到 busy
  const making = hooks.onRun(PERSP, { who: "parent" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.at(-1), { key: "POST /api/projects/0123456789abcdef/module", body: { module: "perspective", options: { who: "parent" } } });
  assert.deepEqual(updates.at(-1).busy, { key: "perspective:who=parent", label: "視角回饋（家長）" });
  assert.equal($("#tabExt").dataset.busy, "1");
  assert.equal($("#recapMake").disabled, true, "一次只跑一份");
  assert.equal($("#mindMake").disabled, true);
  await hooks.onRun(SPROUT, {});
  assert.equal(calls.filter((c) => c.key.endsWith("/module")).length, 1, "在跑的時候不再送第二份");
  await hooks.onStop();
  assert.equal(calls.at(-1).key, "POST /api/projects/0123456789abcdef/cancel");
  release();
  await making;
  u = updates.at(-1);
  assert.equal(u.busy, null);
  assert.deepEqual(u.results.map((r) => r.key), ["perspective:who=parent", "sprout"]);
  assert.match($("#toast").innerHTML, /視角回饋（家長）&lt;img src=x&gt;」好了/, "App 給的名稱要跳脫");
  await hooks.onCopy("原文");
  assert.equal(copied.at(-1), "原文");
  await hooks.onReveal({ key: "perspective:who=parent" });
  assert.deepEqual(calls.at(-1).body, { what: "module", key: "perspective:who=parent" });
  // 會後總結在跑：元件也收到 busy（產生不能按）
  run(`recapBusyId = state.id; renderModules();`);
  assert.deepEqual(updates.at(-1).busy, { key: "", label: "" });
});

test("沒有會議 App 的共用元件時，延伸頁籤說明原因（#111）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  vm.runInContext(`state.id = "0123456789abcdef"; state.p = { name: "v", modules: [] }; renderModules();`, ctx);
  assert.match($("#extHost").textContent, /找不到會議轉錄 App 的共用元件/);
});

test("Drive 列（三個頁籤都有）：存好顯示位置與檔名、沒存成功給再存一次、舊結果可以補存（#100）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [];
  const saved = { folder: "2026-10-25 2101 錄影", files: ["summary.md", "讓這場會議發芽.md"], saved: "2026-10-26T12:00:00.000Z", where: "學校 Drive／會議紀錄" };
  const replies = { "POST /api/projects/0123456789abcdef/drive": { drive: saved }, "POST /api/projects/0123456789abcdef/reveal": { ok: true } };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  $('meta[name="studio-features"]').content = "drive";   // 有設定 studio_drive
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  run(`state.id = "0123456789abcdef"; state.p = { name: "v", recap: null, modules: [], drive: null }; renderDrive();`);
  assert.equal($("#driveRow_recap").hidden, true, "還沒有結果：不顯示");
  // 舊的結果、還沒存過：可以補存
  run(`state.p.recap = { intro: "x", full: "", short: "", chapters: [] }; renderDrive();`);
  assert.equal($("#driveRow_recap").hidden, false);
  assert.equal($("#driveNote_mind").textContent, "還沒存到 Drive。");
  assert.equal($("#driveRetry_ext").hidden, false);
  assert.equal($("#driveRetry_ext").textContent, "存到 Drive");
  assert.equal($("#driveOpen_recap").hidden, true);
  await $("#driveRetry_ext").onclick();
  assert.equal(calls.at(-1).key, "POST /api/projects/0123456789abcdef/drive");
  assert.equal($("#driveNote_mind").textContent, "已存到學校 Drive／會議紀錄／2026-10-25 2101 錄影（summary.md、讓這場會議發芽.md）");
  assert.equal($("#driveRetry_ext").hidden, true);
  assert.equal($("#driveOpen_recap").hidden, false);
  await $("#driveOpen_recap").onclick();
  assert.deepEqual(calls.at(-1).body, { what: "drive" });
  // 正在背景存：不給按、說明會等多久
  run(`state.p.drive = { ...state.p.drive, pending: true }; renderDrive();`);
  assert.match($("#driveNote_mind").textContent, /^正在存到 Drive…/);
  assert.equal($("#driveRetry_ext").hidden, true);
  run(`delete state.p.drive.pending; renderDrive();`);
  // 上次沒存成功：紅字原因＋再存一次
  run(`state.p.drive = { ...state.p.drive, error: "找不到要存的 Drive 資料夾", failed: "2026-10-26T13:00:00.000Z" }; renderDrive();`);
  assert.match($("#driveNote_mind").textContent, /^沒有存到 Drive：找不到要存的 Drive 資料夾/);
  assert.equal($("#driveNote_mind").className, "hint warn-text");
  assert.equal($("#driveRetry_ext").textContent, "再存一次");
  // 沒設定 Drive：沒存過的不顯示這一行；以前存過的照樣顯示位置，但不給「存到 Drive」
  run(`FEATURES.delete("drive"); state.p.drive = null; renderDrive();`);
  assert.equal($("#driveRow_recap").hidden, true, "沒設定 Drive 就不顯示");
  run(`state.p.drive = ${JSON.stringify(saved)}; renderDrive();`);
  assert.equal($("#driveRow_recap").hidden, false, "存過的照樣顯示位置");
  assert.equal($("#driveRetry_ext").hidden, true);
});

test("心智圖頁籤用會議 App 的共用 MindMap：App 沒提供時說明、掛上元件、編輯後存回去、改過的要按兩次才重新產生（#101、#106、#111）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [];
  let list = { modules: [{ id: "sprout", title: "讓這場會議發芽", output: "markdown", options: [] }] };
  let mounted = null, sets = [], destroyed = 0;
  const MindMap = {
    version: "1.0.0",
    mount(el, opts) { mounted = { el, opts }; return { set: (m) => sets.push(m), setFileName() {}, destroy: () => { destroyed += 1; } }; },
    toMarkdown: (m) => `# 心智圖：${m.center}`, toOpml: () => "<?xml version=\"1.0\"?><opml/>", toMermaid: (m) => `mindmap\n  root((${m.center}))`, toSvg: () => "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
  };
  const map = { center: "閱讀教材", branches: [{ label: "選用" }] };
  const saved = { key: "mindmap", module: "mindmap", output: "mindmap", label: "心智圖", file: "mindmap.md", mindmap: map, created: new Date().toISOString(), stale: false, via: "local" };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (key === "GET /api/modules") return { ok: true, status: 200, json: async () => list };
    if (key === "POST /api/projects/0123456789abcdef/mindmap") {
      const body = JSON.parse(opts.body);
      calls.push({ key, body });
      return { ok: true, status: 200, json: async () => ({ module: { ...saved, mindmap: body.mindmap, edited: body.edited, extra_files: ["mindmap.opml", "mindmap.svg"] }, drive: null }) };
    }
    if (key === "POST /api/projects/0123456789abcdef/module") { calls.push({ key, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ module: saved }) }; }
    return new Promise(() => {});
  };
  const timers = [];
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    MindMap, ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  const run = (code) => vm.runInContext(code, ctx);
  run(`state.id = "0123456789abcdef"; state.p = { name: "家長日", recap: null, modules: [] };`);
  await run("loadModules()");
  assert.equal($("#mindNote").textContent, "會議轉錄 App 還沒提供心智圖。");
  assert.equal($("#mindMake").disabled, true);
  list = { modules: [{ id: "mindmap", title: "心智圖", output: "mindmap", options: [] }] };
  await run("loadModules()");
  assert.equal($("#mindMake").textContent, "產生心智圖");
  assert.equal($("#mindView").hidden, true);
  assert.equal(mounted, null, "還沒有圖就不掛");
  // 產生：送請求，好了掛上元件，並把元件轉好的檔（含 svg）存回去
  await $("#mindMake").onclick();
  assert.deepEqual(calls[0], { key: "POST /api/projects/0123456789abcdef/module", body: { module: "mindmap", options: {} } });
  assert.equal(mounted.el, $("#mindView"));
  assert.equal(mounted.opts.theme, "auto");
  assert.equal(mounted.opts.editable, true);
  assert.equal(mounted.opts.fileName, "家長日-心智圖");
  assert.deepEqual(JSON.parse(JSON.stringify(mounted.opts.map)), map);
  assert.deepEqual(calls[1].body, { key: "mindmap", edited: false, mindmap: map, markdown: "# 心智圖：閱讀教材", opml: "<?xml version=\"1.0\"?><opml/>", mermaid: "mindmap\n  root((閱讀教材))", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" });
  assert.equal($("#mindView").hidden, false);
  assert.equal($("#mindReveal").hidden, false);
  assert.equal($("#mindMake").textContent, "重新產生");
  assert.match($("#mindNote").textContent, /mindmap\.md、mindmap\.opml、mindmap\.svg/);
  // 元件說改過了：等一下再存，送 edited
  const edited = { center: "閱讀教材", branches: [{ label: "選用" }, { label: "家長配合" }], edited: true };
  mounted.opts.onChange(edited);
  assert.equal(calls.length, 2, "不馬上存");
  await timers.at(-1)();
  assert.equal(calls[2].body.edited, true);
  assert.deepEqual(calls[2].body.mindmap, edited);
  assert.match($("#mindNote").textContent, /改過，存成資料夾裡的/);
  // 改過的：第一次按「重新產生」只是提醒，五秒內再按才送
  const before = calls.length;
  await $("#mindMake").onclick();
  assert.equal(calls.length, before, "第一次只提醒");
  assert.equal($("#mindMake").textContent, "確定蓋掉改過的？");
  await $("#mindMake").onclick();
  assert.equal(calls[before].key, "POST /api/projects/0123456789abcdef/module");
  // 換一張圖（重新產生回來的）：用 set，不重掛
  assert.ok(sets.length >= 1);
  // 還在等著存的修改也算改過：第一次按只提醒；換專案時先存回原本的專案
  calls.length = 0;
  mounted.opts.onChange({ center: "閱讀教材", branches: [{ label: "還沒存的" }] });
  run(`mmArmed = 0; state.p.modules = [${JSON.stringify({ ...saved, edited: false })}]; renderMind();`);
  await $("#mindMake").onclick();
  assert.equal(calls.length, 0, "等著存的修改也要先提醒");
  run(`state.id = "fedcba9876543210"; mmReset(); renderMind();`);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].key, "POST /api/projects/0123456789abcdef/mindmap", "存回原本的專案，不會存到新打開的");
  assert.equal(calls[0].body.mindmap.branches[0].label, "還沒存的");
  assert.equal($("#mindMake").textContent, "重新產生", "換專案清掉確認");
  run(`state.id = "0123456789abcdef";`);
  // 沒有元件（版本不對）：說明原因、不掛
  run(`window.MindMap = { version: "2.0.0", mount() { throw new Error("不該呼叫"); } }; renderMind(true);`);
  assert.match($("#mindNote").textContent, /找不到會議轉錄 App 的心智圖元件/);
  assert.equal($("#mindView").hidden, true);
  assert.equal(destroyed, 1, "舊的元件收掉");
});

test("會後總結：完整總結與短總結用共用 MdView 排版，複製仍是原文；簡介與逐字稿照舊（#111）", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const rendered = [], copied = [];
  const MdView = { render: (el, md, opts) => rendered.push({ el, md, top: opts?.top }) };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: { clipboard: { writeText: async (x) => { copied.push(x); } } }, matchMedia: stub, getComputedStyle: stub,
    MdView, ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const recap = { intro: "導言", full: "## 核心結論\n- **重點**", short: "短總結", chapters: [], created: new Date().toISOString(), stale: false };
  run(`state.id = "0123456789abcdef"; state.p = { name: "v", recap: ${JSON.stringify(recap)} }; state.cues = []; recapView = "intro"; renderRecap();`);
  assert.equal($("#recapRich").hidden, true, "簡介照舊用文字框");
  assert.equal($("#recapText").hidden, false);
  $("#recapSeg").onclick({ target: { closest: () => ({ dataset: { v: "full" } }) } });
  assert.equal($("#recapRich").hidden, false);
  assert.equal($("#recapText").hidden, true);
  assert.deepEqual({ ...rendered.at(-1), el: rendered.at(-1).el === $("#recapRich") }, { el: true, md: "## 核心結論\n- **重點**", top: 3 });
  await $("#recapCopy").onclick();
  assert.equal(copied.at(-1), "## 核心結論\n- **重點**", "複製的是原文");
  $("#recapSeg").onclick({ target: { closest: () => ({ dataset: { v: "short" } }) } });
  assert.equal(rendered.at(-1).md, "短總結");
  $("#recapSeg").onclick({ target: { closest: () => ({ dataset: { v: "transcript" } }) } });
  assert.equal($("#recapRich").hidden, true, "逐字稿照舊");
});

test("會後的頁籤與 Drive 那一行用 App 的共用圖示，沒有元件就只有文字（meeting-scribe#168）", async () => {
  const vm = await import("node:vm");
  const asked = [];
  const make = async (MeetingIcons) => {
    const { doc, stub, $ } = fakePage();
    const prepended = [];
    for (const sel of ["#tabRecap", "#tabMind", "#tabExt", "#driveRow_recap", "#driveRow_mind", "#driveRow_ext"]) $(sel).prepend = (x) => prepended.push([sel, x]);
    const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
      setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
      console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
      ...(MeetingIcons ? { MeetingIcons } : {}), ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
    ctx.window = ctx;
    ctx.addEventListener = () => {};
    for (const x of pageScripts().slice(1)) new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
    return prepended;
  };
  const got = await make({ icon: (name, o) => { asked.push([name, o.className]); return { svg: name }; } });
  assert.deepEqual(got.map(([sel, x]) => [sel, x.svg]), [["#tabRecap", "recap"], ["#tabMind", "mindmap"], ["#tabExt", "ext"], ["#driveRow_recap", "drive"], ["#driveRow_mind", "drive"], ["#driveRow_ext", "drive"]]);
  assert.ok(asked.every(([, c]) => c === "tab-icon"));
  assert.deepEqual(await make(null), [], "沒有元件：不加圖示、不會壞");
});

test("page assets are served from an exact allow-list only", async (t) => {
  const s = await startStudio(t);
  const page = await s.req("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.raw, /<meta name="studio-token" content="tok">/, "token 只放在頁面本身");
  assert.doesNotMatch(page.raw, /__STUDIO_TOKEN__/);
  const refs = [...page.raw.matchAll(/(?:src|href)="(\/studio[^"]*)"/g)].map((m) => m[1]);
  const onDisk = ["/studio.css", ...fs.readdirSync(new URL("../web/studio", import.meta.url)).map((f) => `/studio/${f}`)];
  assert.deepEqual([...refs].sort(), [...onDisk].sort(), "頁面引用的檔和 web/studio 裡的檔一致");
  for (const r of refs) {
    const x = await s.req("GET", r);
    assert.equal(x.status, 200, r);
    assert.match(x.headers["content-type"], r.endsWith(".css") ? /^text\/css/ : /^text\/javascript/, r);
    assert.equal(x.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(x.raw, /\btok\b/, "靜態檔不帶 token");
  }
  // 共用模組：短片模組會 import ./subtitle-box.mjs（#55），瀏覽器要拿得到
  for (const lib of ["/cue-ops.mjs", "/cuts.mjs", "/shorts.mjs", "/subtitle-box.mjs"]) {
    const x = await s.req("GET", lib);
    assert.equal(x.status, 200, lib);
    for (const m of x.raw.matchAll(/from "\.\/([\w-]+\.mjs)"/g)) assert.equal((await s.req("GET", `/${m[1]}`)).status, 200, `${lib} import 的 ${m[1]}`);
  }
  for (const bad of ["/studio.html", "/studio/", "/studio", "/studio/x.js", "/studio/../../package.json", "/studio/%2e%2e/%2e%2e/package.json", "/studio/..%2f..%2fpackage.json",
    "/studio%2fcommon.js", "/studio/common.js/", "/studio/COMMON.js", "/web/studio.css", "/package.json"]) {
    const x = await s.req("GET", bad);
    assert.notEqual(x.status, 200, bad);
    assert.doesNotMatch(String(x.raw), /"name": "cyclone-recording-transcriber"/, bad);
  }
});

// ---- 首頁縮圖與圖示（recording-transcriber#18）----
test("home lists videos with posters streamed from memory, skipping iCloud placeholders", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const cloudDir = path.join(dir, "icloud");
  fs.mkdirSync(cloudDir);
  fs.writeFileSync(path.join(cloudDir, "far.mp4"), "x");
  const asked = [];
  const s = await startStudio(t, { dir, deps: {
    videoDirs: () => [dir, cloudDir],
    icloudDir: () => cloudDir,
    isOffline: (f) => f.endsWith("far.mp4"),   // 還沒下載到這台的佔位檔
    async poster(video) { asked.push(path.basename(video)); return { jpg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), duration_ms: 65_000 }; },
  } });
  const home = await s.req("GET", "/api/home");
  const byName = Object.fromEntries(home.json.videos.map((v) => [v.name, v]));
  assert.match(byName["v.mp4"].key, /^[0-9a-f]{16}$/);
  assert.deepEqual([byName["v.mp4"].offline, byName["v.mp4"].icloud], [false, false]);
  assert.deepEqual([byName["far.mp4"].offline, byName["far.mp4"].icloud], [true, true], "iCloud 收件匣的影片標出來（#20）");
  assert.equal((await s.req("GET", "/api/home/posters", { headers: { "X-Studio-Token": "" } })).status, 403, "縮圖也要 token");
  assert.equal((await s.req("GET", "/api/home/posters", { headers: { Origin: "https://evil.example" } })).status, 403);
  const before = fs.readdirSync(dir).sort();
  const lines = (await s.req("GET", "/api/home/posters")).raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.key), [byName["v.mp4"].key], "還在 iCloud 的不抓縮圖（會先整支下載）");
  assert.equal(lines[0].duration_ms, 65_000);
  assert.deepEqual([...Buffer.from(lines[0].jpg, "base64")], [0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "縮圖不寫檔");
  await s.req("GET", "/api/home/posters");
  assert.deepEqual(asked, ["v.mp4"], "第二次直接用記憶體裡的");
  const icon = await s.req("GET", "/app-icon.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/png");
  assert.equal(icon.raw.slice(1, 4), "PNG");
  const ico = await s.req("GET", "/favicon.ico");
  assert.equal(ico.status, 200, "瀏覽器預設要的 /favicon.ico 也是 App 圖示");
  assert.equal(ico.headers["content-type"], "image/png");
  assert.equal(ico.raw, icon.raw);
});

test("an iCloud placeholder has a size but no blocks on disk", () => {
  assert.equal(isOffline({ size: 1_000_000, blocks: 0 }), true);
  assert.equal(isOffline({ size: 1_000_000, blocks: 1960 }), false);
  assert.equal(isOffline({ size: 0, blocks: 0 }), false, "空檔案不算");
  assert.equal(isOffline(fs.statSync(new URL(import.meta.url))), false, "這台上真的檔案");
  assert.equal(icloudStudioDir("/Users/x", { icloud_inbox: "Inbox" }), "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Inbox/studio");
  assert.equal(icloudStudioDir("/Users/x", {}), "", "沒設定 icloud_inbox 就沒有 iCloud 資料夾");
});

test("opening a video still in iCloud asks iCloud for it once and waits until it is here", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const far = path.join(dir, "far.mp4");
  fs.writeFileSync(far, "0123456789");
  let offline = true;
  const asked = [];
  const s = await startStudio(t, { dir, deps: {
    isOffline: (f) => offline && f.endsWith("far.mp4"),
    icloudDownload: (f) => asked.push(path.basename(f)),
    videoDurationMs: () => 5000,
  } });
  const first = await s.req("POST", "/api/preview", { body: { video: far } });
  assert.equal(first.status, 202);
  assert.equal(first.json.downloading, true);
  assert.equal(first.json.name, "far");
  assert.ok(first.json.progress >= 0 && first.json.progress < 1);
  assert.equal((await s.req("POST", "/api/preview", { body: { video: far } })).status, 202);
  assert.deepEqual(asked, ["far.mp4"], "頁面每 2 秒問一次，但只請 iCloud 下載一次");
  offline = false;
  const ready = await s.req("POST", "/api/preview", { body: { video: far } });
  assert.equal(ready.status, 200, ready.raw);
  assert.equal(ready.json.duration_ms, 5000);
  assert.equal(ready.json.downloading, undefined);
  assert.equal((await s.req("POST", "/api/preview", { body: { video: s.video } })).status, 200, "本來就在這台的照常打開");
});

test("an iCloud download is asked again after 30 seconds, and a brctl failure is shown instead of waiting forever", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const far = path.join(dir, "far.mp4");
  fs.writeFileSync(far, "0123456789");
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const asked = [];
  let fail = null;
  const s = await startStudio(t, { dir, deps: {
    isOffline: (f) => f.endsWith("far.mp4"),
    icloudDownload: (f, onFail) => { asked.push(now); fail = onFail; },
  } });
  const open = () => s.req("POST", "/api/preview", { body: { video: far } });
  assert.equal((await open()).status, 202);
  now += 10_000;
  assert.equal((await open()).status, 202);
  assert.equal(asked.length, 1, "30 秒內不重送");
  now += 25_000;
  assert.equal((await open()).status, 202);
  assert.equal(asked.length, 2, "超過 30 秒還沒好，再請一次");
  fail(`brctl: cannot download ${far}`);
  const failed = await open();
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /iCloud 沒辦法下載這支影片.*立即下載/);
  assert.doesNotMatch(failed.json.error, /far\.mp4/, "錯誤訊息不帶完整路徑");
  assert.equal((await open()).status, 202, "再點一次就重新請 iCloud 下載");
  assert.equal(asked.length, 3);
});

test("a real poster: one frame and the length, read without writing files", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-poster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, "lesson.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=10:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const { poster } = await import("../lib/media-preview.mjs");
  const p = await poster(video);
  assert.ok(Math.abs(p.duration_ms - 8000) < 100, String(p.duration_ms));
  assert.ok(p.jpg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "JPEG");
  assert.deepEqual(fs.readdirSync(dir), ["lesson.mp4"]);
  const none = await poster(path.join(dir, "nope.mp4"));
  assert.deepEqual(none, { jpg: null, duration_ms: 0 }, "讀不到就沒有縮圖，不丟錯");
});

test("previewing a video before opening it: playback, thumbnails and waveform, nothing written", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const video = path.join(dir, "lesson.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=10:d=8", "-f", "lavfi", "-i", "sine=f=440:d=4",
    "-af", "apad=whole_dur=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const real = await import("../lib/media-preview.mjs");
  const run = await import("../scripts/subtitle-run.mjs");
  const s = await startStudio(t, { dir, deps: { thumbnails: real.thumbnails, waveform: real.waveform, videoDurationMs: run.videoDurationMs } });
  const before = fs.readdirSync(dir).sort();
  const pv = await s.req("POST", "/api/preview", { body: { video } });
  assert.equal(pv.status, 200, pv.raw);
  assert.equal(pv.json.project, null);
  assert.ok(Math.abs(pv.json.duration_ms - 8000) < 100);
  assert.equal(pv.json.playable, true);
  assert.equal((await s.req("GET", `/api/preview/${pv.json.id}/video`, { headers: { "X-Studio-Token": "", Range: "bytes=0-9" } })).status, 403, "影片也要 token");
  const vid = await s.req("GET", `/api/preview/${pv.json.id}/video?t=tok`, { headers: { Range: "bytes=0-9" } });
  assert.equal(vid.status, 206);
  const thumbs = await s.req("GET", `/api/preview/${pv.json.id}/thumbs`);
  const tiles = thumbs.raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(tiles.length, 4, "8 秒的影片每 2 秒一張");
  assert.ok(tiles.every((x) => Buffer.from(x.jpg, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))), "都是 JPEG");
  const wave = await s.req("GET", `/api/preview/${pv.json.id}/wave`);
  const peaks = Buffer.from(wave.json.peaks, "base64");
  assert.ok(peaks.length > 100);
  const at = (ms) => peaks[Math.floor(ms / wave.json.bucket_ms)];
  assert.ok(at(2000) > 50 && at(6000) < 10, `前 4 秒有聲音（測試音源音量是 1/8）、後 4 秒安靜（${at(2000)}、${at(6000)}）`);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "預覽不在影片旁邊寫任何東西");
  assert.equal((await s.req("GET", "/api/preview/0123456789abcdef/wave")).status, 404);
  assert.equal((await s.req("POST", "/api/preview", { body: { video: path.join(dir, "nope.mp4") } })).status, 400);
});

// ---- 編輯頁剪輯（recording-transcriber#5）----
test("cuts edited in the editor are saved, exported, and an all-cut video is refused", async (t) => {
  const s = await startStudio(t, { deps: { videoDurationMs: () => 10_000 } });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  const id = open.json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  fs.writeFileSync(path.join(s.dir, "v2.mp4"), "x");
  const whole = await s.req("POST", "/api/open", { body: { video: path.join(s.dir, "v2.mp4"), privacy: "public", cuts: [{ start: 0, end: 10_000 }] } });
  assert.equal(whole.status, 400, "開專案時整支剪掉擋下");
  assert.match(whole.json.error, /整支影片都剪掉了/);
  const all = await s.req("POST", "/api/open", { body: { video: path.join(s.dir, "v2.mp4"), privacy: "public", cuts: [{ start: 0, end: 5000 }, { start: 5000, end: 10_000 }] } });
  assert.equal(all.status, 400);
  assert.match(all.json.error, /整支影片都剪掉了/);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 0, end: 10_000 }] } })).status, 400, "存檔時整支剪掉也擋下");
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`, { body: { subtitles: false } })).status, 400, "沒有剪輯就沒有「只剪接」");
  // 剪掉第二句（Claude Code，1.2–2.0 秒）
  const put = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  assert.equal(put.status, 200, put.raw);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual(p.cuts, [{ start: 1100, end: 2100, by: "user" }]);
  assert.equal(p.cues.length, 3, "字幕本身不動，只是輸出時拿掉");
  const srt = parseSrt(fs.readFileSync(path.join(projectDirFor(s.video), "subtitles.srt"), "utf8"));
  assert.deepEqual(srt.map((c) => [c.start, c.text]), [[0, "今天我們來談"], [2000, "怎麼用"]]);
  // 只剪接：不燒字幕、輸出另一個檔名
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`, { body: { subtitles: false } })).status, 200);
  p = await s.waitFor(id, (x) => x.burn?.status === "done");
  assert.equal(s.calls.subtitles, false);
  assert.deepEqual(s.calls.keep, [[0, 1100], [2100, 10_000]]);
  assert.equal(p.burn.output, "v-剪輯.mp4");
  assert.ok(fs.existsSync(path.join(projectDirFor(s.video), "v-剪輯.mp4")));
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  p = await s.waitFor(id, (x) => x.burn?.status === "done" && x.burn.output === "v-字幕.mp4");
  assert.equal(s.calls.subtitles, true);
});

// ---- 輸出選擇與清掉處理資料（recording-transcriber#39）----
test("burned and plain exports are recorded separately and listed on the home page", async (t) => {
  const s = await startStudio(t, { deps: { videoDurationMs: () => 10_000 } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.deepEqual(p.outputs, {});
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  await s.req("POST", `/api/projects/${id}/burn`, { body: { subtitles: false } });
  p = await s.waitFor(id, (x) => x.burn?.status === "done");
  await s.req("POST", `/api/projects/${id}/burn`);
  p = await s.waitFor(id, (x) => x.burn?.status === "done" && x.outputs.burn);
  assert.equal(p.outputs.cut.file, "v-剪輯.mp4");
  assert.equal(p.outputs.cut.cuts, "1100-2100", "剪接版記下當時的剪輯");
  assert.equal(p.outputs.burn.file, "v-字幕.mp4");
  assert.equal(p.outputs.burn.rev, p.rev);
  const home = (await s.req("GET", "/api/home")).json.recent.find((x) => x.id === id);
  assert.deepEqual(home.outputs.sort(), ["v-剪輯.mp4", "v-字幕.mp4"]);
  assert.ok(home.bytes > 0);
  assert.equal(home.busy, false);
  // 檔案被手動刪掉的就不列；#39 之前只記在 burn 的也認得
  fs.rmSync(path.join(projectDirFor(s.video), "v-剪輯.mp4"));
  const pj = readProject(projectDirFor(s.video));
  delete pj.outputs;
  writeProject(projectDirFor(s.video), pj);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual(Object.keys(p.outputs), ["burn"]);
  assert.equal(p.outputs.burn.file, "v-字幕.mp4");
});

test("clearing a project moves the exports beside the video and trashes the folder", async (t) => {
  const trashed = [];
  const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trash-"));
  t.after(() => fs.rmSync(trashDir, { recursive: true, force: true }));
  const s = await startStudio(t, { holdBurn: true, deps: {
    videoDurationMs: () => 10_000,
    async trash(f) { trashed.push(f); fs.renameSync(f, path.join(trashDir, path.basename(f))); },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/burn`);
  await s.waitFor(id, (x) => x.job?.kind === "burn");
  const busy = await s.req("POST", `/api/projects/${id}/clear`, { body: {} });
  assert.equal(busy.status, 409, "處理中不能清");
  assert.equal((await s.req("GET", "/api/home")).json.recent[0].busy, true);
  s.releaseBurn();
  await s.waitFor(id, (x) => x.burn?.status === "done");
  fs.writeFileSync(path.join(s.dir, "v-字幕.mp4"), "older");   // 原片旁邊已經有同名的檔案
  const r = await s.req("POST", `/api/projects/${id}/clear`, { body: {} });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json, { trashed: "v-字幕", moved: ["v-字幕 (2).mp4"] });
  assert.equal(fs.readFileSync(path.join(s.dir, "v-字幕.mp4"), "utf8"), "older", "不覆蓋");
  assert.equal(fs.readFileSync(path.join(s.dir, "v-字幕 (2).mp4"), "utf8"), "burned");
  assert.deepEqual(trashed.map((f) => path.basename(f)), ["v-字幕"]);
  assert.ok(!fs.existsSync(projectDirFor(s.video)));
  assert.ok(fs.existsSync(s.video), "原片不動");
  assert.deepEqual((await s.req("GET", "/api/home")).json.recent, [], "從清單拿掉");
  assert.equal((await s.req("GET", `/api/projects/${id}`)).status, 404);
  // 不保留輸出：影片跟著資料夾進垃圾桶
  fs.rmSync(path.join(trashDir, "v-字幕"), { recursive: true });
  const id2 = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id2, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id2}/burn`);
  await s.waitFor(id2, (x) => x.burn?.status === "done");
  const r2 = await s.req("POST", `/api/projects/${id2}/clear`, { body: { keepOutputs: false } });
  assert.deepEqual(r2.json.moved, []);
  assert.ok(fs.existsSync(path.join(trashDir, "v-字幕", "v-字幕.mp4")));
  assert.ok(!fs.existsSync(path.join(s.dir, "v-字幕 (3).mp4")));
});

test("a failed trash keeps the project listed", async (t) => {
  const s = await startStudio(t, { deps: { async trash() { throw new Error("沒辦法丟到垃圾桶（權限不足）"); } } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const r = await s.req("POST", `/api/projects/${id}/clear`, { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /垃圾桶/);
  assert.equal((await s.req("GET", "/api/home")).json.recent.length, 1);
});

test("the editor timeline gets thumbnails and the waveform of the project video", async (t) => {
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 4000,
    async thumbnails(video, durationMs, { onTile }) { onTile({ i: 0, t_ms: 1000, jpg: Buffer.from([0xff, 0xd8, 1]) }); return 1; },
    async waveform() { return { bucket_ms: 20, peaks: new Uint8Array([0, 128, 255]) }; },
  } });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  await s.waitFor(open.json.id, (x) => x.status === "ready");
  const th = await s.req("GET", `/api/projects/${open.json.id}/thumbs`);
  assert.equal(JSON.parse(th.raw.trim()).t_ms, 1000);
  const w = await s.req("GET", `/api/projects/${open.json.id}/wave`);
  assert.deepEqual([...Buffer.from(w.json.peaks, "base64")], [0, 128, 255]);
  assert.equal((await s.req("GET", `/api/projects/${open.json.id}/wave`, { headers: { "X-Studio-Token": "" } })).status, 403);
});

test("a waveform nobody waits for any more is stopped", async (t) => {
  let aborted = false;
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 4000,
    waveform: (video, ms, { signal }) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }),
  } });
  const pv = await s.req("POST", "/api/preview", { body: { video: s.video } });
  await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: s.port, path: `/api/preview/${pv.json.id}/wave`, headers: { Host: `127.0.0.1:${s.port}`, "X-Studio-Token": "tok" } });
    r.on("error", () => {});
    r.end();
    setTimeout(() => { r.destroy(); setTimeout(resolve, 100); }, 100);
  });
  assert.equal(aborted, true, "離開頁面就停掉 ffmpeg");
});

// ---- AI 剪輯建議（recording-transcriber#6）----
function suggestDeps(calls, extra = {}) {
  return {
    videoDurationMs: () => 60_000,
    async detectSilence() { calls.silence = (calls.silence || 0) + 1; await calls.hold; return [{ start: 10_000, end: 14_000 }]; },
    async detectBlack() { return [{ start: 0, end: 2000 }]; },
    async suggestFromTranscript(timing, opts) {
      calls.timing = timing;
      calls.suggestOpts = opts;
      return { suggestions: [{ start: 30_000, end: 33_000, by: "ai", kind: "retake", reason: "口誤重講：講錯重講", text: "我們先看第一個" }], usage: { calls: 1, cost_usd: 0.01234 } };
    },
    ...extra,
  };
}

test("AI cut suggestions run in the background and are stored as suggestions, not cuts", async (t) => {
  const calls = {};
  const s = await startStudio(t, { deps: suggestDeps(calls) });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "student-private" } });
  const id = open.json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal((await s.req("POST", `/api/projects/${id}/suggest`, { body: {} })).status, 200);
  p = await s.waitFor(id, (x) => !x.job && x.suggestions);
  assert.equal(p.suggestions.status, "done");
  assert.deepEqual(p.suggestions.items.map((x) => [x.kind, x.start, x.end]), [["black", 0, 1700], ["silence", 10_300, 13_700], ["retake", 30_000, 33_000]]);
  assert.ok(p.suggestions.items.every((x) => /^[0-9a-z]+-\d+$/.test(x.id)), "id 每一輪不同");
  assert.deepEqual(p.cuts, [], "只是建議，還沒剪");
  assert.equal(calls.suggestOpts.proofreader, "claude", "預設 Claude");
  assert.deepEqual(calls.timing, [["今", 0, 100]], "用辨識時存的逐字時間");
  assert.deepEqual(p.suggestions.usage, { calls: 1, cost_usd: 0.0123 });
  // 舊一輪的頁面存檔（suggestionsCreated 對不上）不動清單
  const stale = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, suggestions: [], suggestionsCreated: "2000-01-01T00:00:00.000Z" } });
  assert.equal(stale.status, 200);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.suggestions.items.length, 3, "舊清單不會把新結果過濾掉");
  // 頁面套用了黑畫面和口誤重講，不要靜音：剪輯存進去，清單只留還沒處理的
  const put = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 0, end: 1700, by: "ai", reason: "黑畫面" }, { start: 30_000, end: 33_000, by: "ai", reason: "口誤重講" }], suggestions: [], suggestionsCreated: p.suggestions.created } });
  assert.equal(put.status, 200, put.raw);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.cuts.length, 2);
  assert.deepEqual(p.suggestions.items, []);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, suggestions: "s1", suggestionsCreated: p.suggestions.created } })).status, 400);
});

// ---- 只重新寫說明欄（#46）----
test("rewriting the description leaves the subtitles alone and stores the title and tag suggestions", async (t) => {
  const calls = {};
  let release = () => {};
  const s = await startStudio(t, { deps: {
    async prepareSubtitles() {
      return { cues: cues(), applied: [], rejected: [], description: "舊簡介", chapters: [], suggest: { title: "第一次的名稱", tags: ["特教"] }, timing: [["今", 0, 100]], report: {} };
    },
    describe: (c, opts) => new Promise((resolve) => {
      calls.cues = c;
      calls.opts = opts;
      release = () => resolve({ text: "新簡介\n\n00:00 開場\n・重點\n", chapters: [{}, {}, {}], suggest: { title: "新的名稱", tags: ["AI", "字幕"] }, usage: null });
    }),
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.youtube_suggest.title, "第一次的名稱", "處理完就有名稱和標籤建議");
  const before = p;
  const pending = s.req("POST", `/api/projects/${id}/describe`);
  p = await s.waitFor(id, (x) => x.job?.kind === "describe");
  assert.equal((await s.req("POST", `/api/projects/${id}/describe`)).status, 409, "同時只寫一次");
  // 等 AI 的時候改字幕：字幕照存，但頁面上的舊說明欄不能蓋掉等一下的新內容
  const edited = before.cues.map((c, i) => (i ? c : { ...c, text: "改過的第一句" }));
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: edited, description: "頁面上的舊說明欄" } })).status, 200);
  release();
  const r = await pending;
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.description, "新簡介\n\n00:00 開場\n・重點\n");
  assert.deepEqual([r.json.youtube_suggest.title, r.json.youtube_suggest.tags], ["新的名稱", ["AI", "字幕"]]);
  assert.equal(r.json.chapters, 3);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.description, r.json.description);
  assert.equal(p.cues[0].text, "改過的第一句", "等的時候改的字幕還在");
  assert.equal(p.rev, before.rev + 1, "只有那次改字幕讓 rev 加一，頁面不會被當成別的分頁改過");
  assert.deepEqual(p.youtube_suggest.tags, ["AI", "字幕"]);
  assert.equal(calls.opts.proofreader, "claude");
  assert.ok(calls.opts.signal instanceof AbortSignal);
  assert.deepEqual(calls.cues.map((c) => c.text), before.cues.map((c) => c.text).filter((x) => x.trim()), "用當時的字幕寫");
  assert.equal(fs.readFileSync(path.join(p.folder, "youtube-description.md"), "utf8"), r.json.description, "說明欄檔也更新");
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, description: "寫完之後再改" } })).status, 200);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.description, "寫完之後再改", "寫完就可以照常改說明欄");
});

test("reprocessing without a description also drops the old title and tag suggestions", async (t) => {
  let n = 0;
  const s = await startStudio(t, { deps: {
    async prepareSubtitles() {
      n += 1;
      return { cues: cues(), applied: [], rejected: [], description: n === 1 ? "簡介" : "", chapters: [], suggest: n === 1 ? { title: "名稱", tags: ["特教"] } : null, timing: [["今", 0, 100]], report: {} };
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.youtube_suggest.title, "名稱");
  assert.equal((await s.req("POST", `/api/projects/${id}/reprocess`)).status, 200);
  p = await s.waitFor(id, (x) => x.status === "ready" && n === 2 && !x.job);
  assert.equal(p.description, "");
  assert.equal(p.youtube_suggest, null, "說明欄沒寫成功，舊建議不留著");
});

test("stopping or a failed rewrite keeps the old description", async (t) => {
  let mode = "hold";
  const s = await startStudio(t, { deps: {
    describe: (c, { signal }) => new Promise((resolve, reject) => {
      if (mode === "fail") return reject(new Error("claude exited 1"));
      if (mode === "late") return signal.addEventListener("abort", () => resolve({ text: "晚到的說明欄\n", chapters: [], suggest: { title: "", tags: [] }, usage: null }));
      signal.addEventListener("abort", () => reject(new Error("cancelled")));
    }),
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const pending = s.req("POST", `/api/projects/${id}/describe`);
  await s.waitFor(id, (x) => x.job?.kind === "describe");
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  const r = await pending;
  assert.equal(r.status, 409);
  assert.match(r.json.error, /停止/);
  let p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.description, "簡介");
  assert.equal(p.job, null, "停止後就能再寫一次");
  // AI 已經回覆才按停止：說明欄照樣寫進去，回報寫好了，不能說「沒有變」
  mode = "late";
  const late = s.req("POST", `/api/projects/${id}/describe`);
  await s.waitFor(id, (x) => x.job?.kind === "describe");
  await s.req("POST", `/api/projects/${id}/cancel`);
  const lr = await late;
  assert.equal(lr.status, 200, lr.raw);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.description, "晚到的說明欄\n");
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: (await s.req("GET", `/api/projects/${id}`)).json.rev, description: "簡介" } });
  const suggestBefore = (await s.req("GET", `/api/projects/${id}`)).json.youtube_suggest;
  mode = "fail";
  const failed = await s.req("POST", `/api/projects/${id}/describe`);
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /AI 沒寫成功/);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.description, "簡介");
  assert.deepEqual(p.youtube_suggest, suggestBefore, "失敗不動建議");
});

// ---- AI 更正名字（#60）----
test("AI 更正名字：伺服器用專案的校對者找出組合、驗證後回傳，不動字幕；可以停止，資料規則照樣檢查", async (t) => {
  const calls = { opts: [], asked: [] };
  let mode = "ok", release = () => {};
  // 假的校對者：走真的 nameFixes（提示詞與驗證），只把 agent 換掉
  const session = {
    usage: {},
    ask: (prompt) => new Promise((resolve, reject) => {
      calls.asked.push(prompt);
      session.reject = reject;
      if (mode === "garbage") return resolve("抱歉，我找不到");
      const reply = '{"pairs":[{"wrong":"今天","right":"明天"},{"wrong":"Code","right":"Codex"},{"wrong":"不存在","right":"x"},{"wrong":"怎麼","right":"如何"}]}';
      if (mode === "hold") { release = () => resolve(reply); return; }
      resolve(reply);
    }),
    close: () => session.reject?.(new Error("Claude process exited")),
  };
  const s = await startStudio(t, { deps: {
    nameFixes: (c, instruction, opts) => { calls.opts.push(opts); calls.cues = c; return nameFixes(c, instruction, { ...opts, session }); },
    async addCorrections(pairs, o) { calls.batch = [pairs, o.kind]; return { added: pairs.length, hints: 3, fixed: 0 }; },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const before = await s.waitFor(id, (x) => x.status === "ready");
  const url = `/api/projects/${id}/names`;

  // 和其他動作一樣要 token、不接受跨站
  assert.equal((await s.req("POST", url, { body: { instruction: "x" }, headers: { "X-Studio-Token": "nope" } })).status, 403);
  assert.equal((await s.req("POST", url, { body: { instruction: "x" }, headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal(calls.asked.length, 0);
  // 說明要 1 到 500 字
  for (const bad of [{}, { instruction: "   " }, { instruction: 3 }, { instruction: "字".repeat(501) }]) {
    const r = await s.req("POST", url, { body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40));
    assert.match(r.json.error, /寫|500/);
  }
  assert.equal(calls.asked.length, 0);

  const r = await s.req("POST", url, { body: { instruction: "  今天是明天，怎麼是如何  " } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json, { pairs: [{ wrong: "今天", right: "明天" }, { wrong: "怎麼", right: "如何" }], dropped: 2 });
  assert.match(calls.asked[0], /<instruction>\n今天是明天，怎麼是如何\n<\/instruction>/, "說明去掉前後空白");
  assert.equal(calls.opts[0].proofreader, "claude");
  assert.ok(calls.opts[0].signal instanceof AbortSignal);
  assert.deepEqual(calls.cues.map((c) => c.text), before.cues.map((c) => c.text));
  const p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual([p.cues, p.rev], [before.cues, before.rev], "只回建議，不改專案");

  // 回覆不是 JSON：502、中文說明
  mode = "garbage";
  const g = await s.req("POST", url, { body: { instruction: "x" } });
  assert.equal(g.status, 502);
  assert.match(g.json.error, /AI 沒找成功.*格式不對/);

  // 等 AI 的時候：同一支不能再送，可以停止
  mode = "hold";
  const pending = s.req("POST", url, { body: { instruction: "x" } });
  await s.waitFor(id, (x) => x.job?.kind === "names");
  assert.equal((await s.req("POST", url, { body: { instruction: "x" } })).status, 409);
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  const stopped = await pending;
  assert.equal(stopped.status, 409);
  assert.match(stopped.json.error, /停止/);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.job, null);
  release();

  // 錯字表一次加好幾組：走既有的 /api/corrections，只加成 hints
  const c = await s.req("POST", "/api/corrections", { body: { pairs: [["今天", "明天"], ["怎麼", "如何"]] } });
  assert.equal(c.status, 200);
  assert.deepEqual(calls.batch, [[["今天", "明天"], ["怎麼", "如何"]], "hints"]);

  // 含個資的專案：可能走中國大陸雲端模型的校對者照樣被拒絕
  const file = path.join(p.folder, "project.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), privacy: "student-private", proofreader: "pi" }));
  mode = "ok";   // 萬一沒擋住，會拿到 200，不會卡住
  const n = calls.asked.length;
  const china = await s.req("POST", url, { body: { instruction: "x" } });
  assert.equal(china.status, 400);
  assert.match(china.json.error, /mainland-China/);
  assert.equal(calls.asked.length, n, "沒有送出去");
});

test("unreadable AI chunks become a plain warning; only all of them failing counts as an AI error (#36)", async (t) => {
  const calls = {};
  let result = { suggestions: [{ start: 30_000, end: 33_000, by: "ai", kind: "retake", reason: "口誤重講：講錯重講" }], usage: null, chunks: 3, failed: [{ start: 600_000, end: 1_265_000 }] };
  const s = await startStudio(t, { deps: suggestDeps(calls, { async suggestFromTranscript() { return result; } }) });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  const id = open.json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  let p = await s.waitFor(id, (x) => !x.job && x.suggestions);
  assert.equal(p.suggestions.error, "", "部分失敗不算 AI 失敗");
  assert.match(p.suggestions.warning, /^10:00–21:05 這段 AI 回覆的格式不對/);
  assert.doesNotMatch(p.suggestions.warning, /JSON/);
  assert.ok(p.suggestions.items.some((x) => x.kind === "retake"), "其他段落的 AI 建議留著");
  result = { suggestions: [], usage: null, chunks: 2, failed: [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }] };
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  p = await s.waitFor(id, (x) => !x.job && x.suggestions?.created !== p.suggestions.created);
  assert.equal(p.suggestions.error, "AI 回覆的格式不對，讀不出建議");
  assert.equal(p.suggestions.warning, undefined);
});

test("suggestions without AI only use the local detectors; old projects fall back to subtitle timing", async (t) => {
  const calls = {};
  const s = await startStudio(t, { deps: suggestDeps(calls) });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  const id = open.json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/suggest`, { body: { ai: false } });
  let p = await s.waitFor(id, (x) => !x.job && x.suggestions);
  assert.equal(calls.timing, undefined, "不勾 AI 就不送逐字稿");
  assert.deepEqual(p.suggestions.items.map((x) => x.kind), ["black", "silence"]);
  fs.rmSync(path.join(projectDirFor(s.video), "timing.json"));
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  p = await s.waitFor(id, (x) => !x.job && x.suggestions?.ai);
  assert.deepEqual(calls.timing.slice(0, 2), [["今", 0, 167], ["天", 167, 333]], "沒有 timing.json 就把字幕時間平均分給每個字");
  let release;
  calls.hold = new Promise((r) => { release = r; });
  assert.equal((await s.req("POST", `/api/projects/${id}/suggest`, { body: {} })).status, 200);
  assert.equal((await s.req("POST", `/api/projects/${id}/suggest`, { body: {} })).status, 409, "一次只跑一個");
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.job.kind, "suggest");
  release();
  await s.waitFor(id, (x) => !x.job);
});

test("the preview can find long silences before anything is transcribed", async (t) => {
  const calls = {};
  const s = await startStudio(t, { deps: suggestDeps(calls) });
  const pv = await s.req("POST", "/api/preview", { body: { video: s.video } });
  const r = await s.req("GET", `/api/preview/${pv.json.id}/silence`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((x) => [x.start, x.end, x.kind]), [[10_300, 13_700, "silence"]]);
  assert.equal(calls.timing, undefined, "粗剪時不送任何東西給 AI");
});

test("a failed search keeps the previous suggestions; stopping also stops the AI step", async (t) => {
  const calls = {};
  let fail = false;
  const s = await startStudio(t, { deps: suggestDeps(calls, {
    async detectBlack() { if (fail) throw new Error("ffmpeg failed: boom"); return []; },
    suggestFromTranscript: (timing, { signal }) => new Promise((resolve, reject) => {
      calls.signal = signal;
      if (!calls.holdAi) return resolve({ suggestions: [], usage: null });
      signal.addEventListener("abort", () => { calls.aiAborted = true; reject(new Error("cancelled")); });
    }),
  }) });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  const id = open.json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  let p = await s.waitFor(id, (x) => !x.job && x.suggestions);
  const first = p.suggestions;
  assert.equal(first.items.length, 1);
  fail = true;
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  p = await s.waitFor(id, (x) => !x.job && x.suggestions?.lastError);
  assert.deepEqual(p.suggestions.items, first.items, "失敗不蓋掉上一次的建議");
  assert.match(p.suggestions.lastError, /boom/);
  fail = false;
  calls.holdAi = true;
  await s.req("POST", `/api/projects/${id}/suggest`, { body: {} });
  await s.waitFor(id, (x) => x.job?.step === "ai");
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  p = await s.waitFor(id, (x) => !x.job);
  assert.equal(calls.aiAborted, true, "按停止就停掉 AI");
  assert.deepEqual(p.suggestions.items, first.items, "停止也不動原本的建議");
});


// ---- YouTube 上傳（recording-transcriber#40）：假的 Google、記憶體裡的鑰匙圈 ----
function fakeGoogle({ captionFails = false, revoked = false } = {}) {
  const g = { uploads: [], captions: [], playlistItems: [], revoked: [], challenge: "", meta: null, received: [], size: 0, captionFails };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.Authorization;
    if (u.href === "https://oauth2.googleapis.com/token") {
      const f = new URLSearchParams(init.body);
      assert.equal(f.get("client_secret"), "GOCSPX-test");
      if (f.get("grant_type") === "authorization_code") {
        if (f.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        assert.equal(createHash("sha256").update(f.get("code_verifier")).digest("base64url"), g.challenge, "PKCE 對得上");
        return Response.json({ access_token: "at1", refresh_token: "1//rt-good", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.force-ssl" });
      }
      if (revoked || f.get("refresh_token") !== "1//rt-good") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "at2", expires_in: 3600 });
    }
    if (u.href === "https://oauth2.googleapis.com/revoke") { g.revoked.push(new URLSearchParams(init.body).get("token")); return new Response(""); }
    assert.match(auth || "", /^Bearer at[12]$/);
    if (u.pathname === "/youtube/v3/channels") return Response.json({ items: [{ id: "UC123", snippet: { title: "Cyclone 的頻道", thumbnails: { default: { url: "https://yt3.ggpht.com/a" } } } }] });
    if (u.pathname === "/youtube/v3/playlists") return Response.json({ items: [{ id: "PL1", snippet: { title: "特教研習" } }] });
    if (u.pathname === "/upload/youtube/v3/videos") {
      g.meta = JSON.parse(init.body);
      g.notify = u.searchParams.get("notifySubscribers");
      g.size = Number(init.headers["X-Upload-Content-Length"]);
      return new Response("", { status: 200, headers: { Location: "https://upload.example/session" } });
    }
    if (u.href === "https://upload.example/session") {
      g.received.push(Buffer.from(init.body));
      return Response.json({ id: "VID123" }, { status: 201 });
    }
    if (u.pathname === "/upload/youtube/v3/captions") {
      if (g.captionFails) return Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 });
      g.captions.push(init.body.toString("utf8"));
      return Response.json({ id: "CAP1" });
    }
    if (u.pathname === "/youtube/v3/playlistItems") { g.playlistItems.push(JSON.parse(init.body)); return Response.json({ id: "PI1" }); }
    throw new Error(`unexpected ${url}`);
  };
  return g;
}
function memorySecrets() {
  const m = new Map();
  return { m, get: (a) => m.get(a) || "", set: (a, v) => { m.set(a, v); }, delete: (a) => { m.delete(a); } };
}
const CLIENT_JSON = JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test", project_id: "my-studio" } });

async function connectedStudio(t, extra = {}) {
  const g = fakeGoogle(extra.google);
  const secrets = memorySecrets();
  const opened = [];
  const s = await startStudio(t, { ...extra, deps: { youtubeFetch: g.fetch, secrets, openUrl: (u) => opened.push(u), videoDurationMs: () => 10_000, ...(extra.deps || {}) } });
  assert.equal((await s.req("POST", "/api/youtube/client", { body: { json: CLIENT_JSON } })).status, 200);
  const c = await s.req("POST", "/api/youtube/connect", { body: {} });
  const q = new URL(c.json.url).searchParams;
  g.challenge = q.get("code_challenge");
  const cb = await s.req("GET", `/?state=${q.get("state")}&code=good-code`, { headers: { "X-Studio-Token": "" } });
  assert.equal(cb.status, 200, cb.raw);
  return { s, g, secrets, opened, cb, state: q.get("state"), connectUrl: c.json.url };
}

test("YouTube settings: the client secret and channel tokens live in the keychain, not in files", async (t) => {
  const { s, g, secrets, opened, cb, state, connectUrl } = await connectedStudio(t);
  assert.deepEqual(opened, [connectUrl], "用預設瀏覽器打開 Google 授權頁");
  assert.match(cb.raw, /<link rel="icon" href="\/app-icon\.png">/, "授權結果頁的分頁也用 App 圖示");
  assert.match(cb.raw, /已連結 YouTube 頻道「Cyclone 的頻道」/);
  assert.match(cb.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(secrets.m.get("client-secret"), "GOCSPX-test");
  assert.equal(secrets.m.get("refresh:UC123"), "1//rt-good");
  const file = fs.readFileSync(path.join(s.dir, "state", "youtube.json"), "utf8");
  assert.doesNotMatch(file, /GOCSPX|rt-good|at1/, "設定檔裡沒有機密");
  const y = (await s.req("GET", "/api/youtube")).json;
  assert.equal(y.client.ready, true);
  assert.equal(y.client.project_id, "my-studio");
  assert.deepEqual(y.channels.map((c) => [c.id, c.title, c.connected, c.defaults.privacy]), [["UC123", "Cyclone 的頻道", true, "private"]]);
  assert.equal(y.default_channel, "UC123");
  // 同一個授權連結不能用第二次；在 Google 按拒絕也說清楚
  assert.equal((await s.req("GET", `/?state=${state}&code=good-code`, { headers: { "X-Studio-Token": "" } })).status, 400);
  const c2 = new URL((await s.req("POST", "/api/youtube/connect", { body: {} })).json.url).searchParams;
  const denied = await s.req("GET", `/?state=${c2.get("state")}&error=access_denied`, { headers: { "X-Studio-Token": "" } });
  assert.equal(denied.status, 400);
  assert.match(denied.raw, /按了取消或不允許/);
  // 預設值只收認得的欄位；播放清單從 YouTube 讀
  const saved = await s.req("POST", "/api/youtube/channels/UC123", { body: { defaults: { privacy: "unlisted", subtitles: "burned", playlistId: "PL1", tags: "特教, 研習", bogus: 1 } } });
  assert.deepEqual(saved.json.channels[0].defaults.tags, ["特教", "研習"]);
  assert.equal(saved.json.channels[0].defaults.privacy, "unlisted");
  assert.deepEqual((await s.req("GET", "/api/youtube/channels/UC123/playlists")).json.items, [{ id: "PL1", title: "特教研習" }]);
  // 錯的 JSON 檔
  const web = await s.req("POST", "/api/youtube/client", { body: { json: JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } }) } });
  assert.equal(web.status, 400);
  assert.match(web.json.error, /電腦版應用程式/);
  // 換另一個用戶端：舊頻道的授權作廢，要重新連結
  await s.req("POST", "/api/youtube/client", { body: { json: CLIENT_JSON.replace("123-abc", "456-def") } });
  assert.equal((await s.req("GET", "/api/youtube")).json.channels[0].connected, false);
  assert.equal(secrets.m.has("refresh:UC123"), false);
  // 移除頻道會取消授權
  secrets.m.set("refresh:UC123", "1//rt-good");
  const removed = await s.req("POST", "/api/youtube/channels/UC123/remove", { body: {} });
  assert.deepEqual(removed.json.channels, []);
  assert.deepEqual(g.revoked, ["1//rt-good"]);
  await s.req("POST", "/api/youtube/client/remove", { body: {} });
  assert.equal(secrets.m.size, 0);
  assert.equal((await s.req("GET", "/api/youtube")).json.client, null);
});

test("uploading: original video plus CC captions, added to a playlist; the record keeps the links", async (t) => {
  const { s, g } = await connectedStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const bad = await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /請填標題/);
  assert.equal((await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "nope", title: "t" } })).status, 400);
  const r = await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "分數教學", privacy: "unlisted", subtitles: "cc", playlistId: "PL1", tags: "特教", notify: false } });
  assert.equal(r.status, 200, r.raw);
  const p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(s.calls.burn, 0, "沒有剪輯：原片直接上傳，不用輸出");
  assert.deepEqual(Buffer.concat(g.received), fs.readFileSync(s.video));
  assert.equal(g.meta.snippet.title, "分數教學");
  assert.equal(g.meta.snippet.description, "簡介", "沒給說明欄就用專案的");
  assert.equal(g.meta.status.privacyStatus, "unlisted");
  assert.equal(g.notify, "false");
  assert.equal(g.captions.length, 1);
  assert.match(g.captions[0], /"videoId":"VID123"/);
  assert.match(g.captions[0], /00:00:00,000 --> /, "掛上去的是專案的 SRT");
  assert.deepEqual(g.playlistItems[0].snippet, { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "VID123" } });
  assert.equal(p.youtube.url, "https://youtu.be/VID123");
  assert.equal(p.youtube.studio_url, "https://studio.youtube.com/video/VID123/edit");
  assert.deepEqual(p.youtube.warnings, []);
  assert.equal(p.youtube.channel_title, "Cyclone 的頻道");
  assert.equal((await s.req("GET", "/api/home")).json.recent[0].status, "ready");
});

test("uploading exports first when needed: a cut video for CC captions, a burned one otherwise", async (t) => {
  const { s, g } = await connectedStudio(t, { google: { captionFails: true } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "cc" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(s.calls.subtitles, false, "CC 字幕版：先輸出不燒字幕的剪接版");
  assert.equal(Buffer.concat(g.received).toString(), "burned");
  assert.equal(p.outputs.cut.file, "v-剪輯.mp4");
  assert.match(p.youtube.warnings[0], /CC 字幕沒有掛上去/, "字幕失敗只提醒，影片已經上去了");
  // 剪接版沒過期：第二次直接用
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "cc" } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done" && x.youtube.started !== p.youtube.started);
  assert.equal(s.calls.burn, 1);
  // 燒在畫面上：沒燒過就先燒
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.subtitles === "burned" && x.youtube.status === "done");
  assert.equal(s.calls.burn, 2);
  assert.equal(s.calls.subtitles, true);
  assert.equal(p.outputs.burn.file, "v-字幕.mp4");
  // 燒好之後又改字：燒字幕版過期，要重燒；沒改就沿用
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done" && x.youtube.started !== p.youtube.started);
  assert.equal(s.calls.burn, 2, "沒改字就沿用燒好的");
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: [...cues().slice(0, 2), { start: 3000, end: 4000, text: "怎麼使用" }] } });
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done" && x.youtube.started !== p.youtube.started);
  assert.equal(s.calls.burn, 3, "改過字就重燒");
});

test("adding CC captions after a burned upload: uses the text as it is now, once (#71)", async (t) => {
  const { s, g } = await connectedStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  const never = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(never.status, 409);
  assert.match(never.json.error, /還沒上傳/);
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned", alsoCc: false, language: "en" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(g.captions.length, 0, "燒在畫面上、取消勾選 CC：上傳時不掛");
  assert.equal(p.youtube.cc_added, undefined);
  // 上傳後才改字：補上去的是改過的
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: [...cues().slice(0, 2), { start: 3000, end: 4000, text: "上傳後改的字" }] } });
  const r = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(g.captions.length, 1);
  assert.match(g.captions[0], /"videoId":"VID123"/);
  assert.match(g.captions[0], /"language":"en"/, "語言照上傳時選的");
  assert.match(g.captions[0], /上傳後改的字/);
  assert.match(g.captions[0], /00:00:00,000 --> /);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.ok(p.youtube.cc_added, "記在上傳紀錄");
  assert.equal(p.youtube.status, "done");
  const again = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(again.status, 409, "掛過就不再掛第二條");
  assert.match(again.json.error, /已經掛上了/);
  assert.equal(g.captions.length, 1);
});

test("a burned upload also attaches CC captions unless unticked (#71)", async (t) => {
  const { s, g } = await connectedStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  const p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(s.calls.subtitles, true, "影片照樣燒字");
  assert.equal(g.captions.length, 1, "另外掛上 CC");
  assert.match(g.captions[0], /"videoId":"VID123"/);
  assert.ok(p.youtube.cc_added);
  assert.equal((await s.req("POST", `/api/projects/${id}/captions`)).status, 409, "已經掛了，不用補");
});

test("adding CC captions later: a failed CC step can be retried, but not after the cuts changed (#71)", async (t) => {
  const { s, g } = await connectedStudio(t, { google: { captionFails: true } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "cc" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.match(p.youtube.warnings[0], /CC 字幕沒有掛上去.*補上 CC 字幕/);
  assert.equal(p.youtube.cuts, "", "記下上傳時的剪輯");
  // 上傳後改了剪輯：時間會對不上，擋下來
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  const moved = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(moved.status, 409);
  assert.match(moved.json.error, /改過剪輯/);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [] } });
  // Google 還是不收：說清楚，提醒留著
  const failed = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /CC 字幕沒有掛上去/);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.youtube.warnings.length, 1);
  g.captionFails = false;
  const ok = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(ok.status, 200, ok.raw);
  assert.deepEqual(ok.json.youtube.warnings, [], "掛上了就拿掉那條提醒");
  assert.match(g.captions[0], /"language":"zh-TW"/);

  // #71 之前的紀錄沒記剪輯與語言：現在沒剪才補，語言用頻道預設
  const dir = projectDirFor(fs.realpathSync(s.video));
  const raw = readProject(dir);
  raw.youtube = { ...raw.youtube, subtitles: "burned", video_id: "OLD1", warnings: [] };
  for (const k of ["cuts", "language", "cc_added"]) delete raw.youtube[k];
  raw.cuts = [{ start: 1100, end: 2100, by: "user" }];
  writeProject(dir, raw);
  assert.equal((await s.req("POST", `/api/projects/${id}/captions`)).status, 409, "不知道上傳時怎麼剪：不猜");
  raw.cuts = [];
  writeProject(dir, raw);
  const old = await s.req("POST", `/api/projects/${id}/captions`);
  assert.equal(old.status, 200, old.raw);
  assert.match(g.captions[1], /"videoId":"OLD1"/);
  assert.match(g.captions[1], /"language":"zh-TW"/);
});

test("subtitle style: box by default, saved per project, ASS or SRT when burning, and an old outline burn is redone for upload", async (t) => {
  const { s } = await connectedStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.subtitle_style, "box", "沒設定過：新的圓角底框");
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, style: "neon" } })).status, 400, "樣式不在清單裡");
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  p = await s.waitFor(id, (x) => x.burn?.status === "done");
  assert.match(s.calls.srt, /^\[Script Info\]/, "圓角底框燒 ASS");
  assert.equal(boxStarts(s.calls.srt).length, 3, "三句各一個框");
  assert.equal(p.outputs.burn.style, "box");
  assert.equal(p.burn.style, "box");

  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, style: "outline" } })).status, 200);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.subtitle_style, "outline", "存進專案");
  await s.req("POST", `/api/projects/${id}/burn`);
  p = await s.waitFor(id, (x) => x.burn?.status === "done" && x.burn.style === "outline");
  assert.match(s.calls.srt, /^1\n00:00:00,000 --> /, "白字黑邊燒 SRT");
  assert.equal(p.outputs.burn.style, "outline");

  // #55 之前燒的版本（沒記樣式＝白字黑邊），專案是圓角底框：上傳時不能拿舊的那支
  const dir = projectDirFor(fs.realpathSync(s.video));
  const raw = readProject(dir);
  raw.subtitle_style = "box";
  delete raw.outputs.burn.style;
  writeProject(dir, raw);
  const burns = s.calls.burn;
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(s.calls.burn, burns + 1, "樣式不同就重燒");
  assert.match(s.calls.srt, /^\[Script Info\]/);
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned" } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done" && x.youtube.started !== p.youtube.started);
  assert.equal(s.calls.burn, burns + 1, "同樣式、同版本就沿用");
});

test("a short goes stale when the subtitle style changes", () => {
  const item = { start: 0, end: 3000, title: "t" };
  const p = { cues: [{ start: 0, end: 3000, text: "字幕" }], cuts: [] };
  assert.equal(shortKey(item, p), shortKey(item, { ...p, subtitle_style: "box" }), "沒設定就是圓角底框");
  assert.notEqual(shortKey(item, p), shortKey(item, { ...p, subtitle_style: "outline" }));
});

test("CC captions follow the video being uploaded even if the cuts change meanwhile", async (t) => {
  const { s, g } = await connectedStudio(t, { holdBurn: true });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "cc" } });
  p = await s.waitFor(id, (x) => x.job?.kind === "upload" && x.job.step === "export");
  assert.deepEqual(p.job.steps, ["export", "upload", "captions"]);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [] } })).status, 200, "上傳中可以繼續改");
  s.releaseBurn();
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.doesNotMatch(g.captions[0], /Claude Code/, "字幕照開始上傳時的剪輯：被剪掉的句子不在裡面");
  assert.match(g.captions[0], /00:00:02,000 --> /, "時間是剪完的時間");
});

test("an expired authorisation fails the upload in plain words and marks the channel for reconnecting", async (t) => {
  const { s, secrets } = await connectedStudio(t);
  secrets.m.set("refresh:UC123", "1//rt-gone");
  // 新的 Studio 沒有記憶體裡的 access token，一定要用 refresh token 換
  const s2 = await startStudio(t, { dir: s.dir, keep: true, deps: { youtubeFetch: fakeGoogle().fetch, secrets, openUrl() {} } });
  const id = (await s2.req("POST", "/api/open", { body: { video: s2.video, privacy: "public" } })).json.id;
  await s2.waitFor(id, (x) => x.status === "ready");
  await s2.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t" } });
  const p = await s2.waitFor(id, (x) => !x.job && x.youtube?.status === "failed");
  assert.match(p.youtube.error, /重新連結/);
  assert.equal((await s2.req("GET", "/api/youtube")).json.channels[0].connected, false);
  const again = await s2.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t" } });
  assert.equal(again.status, 409);
});

test("an upload cut short by closing the studio is marked failed on the next start", async (t) => {
  const s = await startStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const folder = projectDirFor(s.video);
  const pj = readProject(folder);
  pj.youtube = { status: "uploading", title: "t" };
  writeProject(folder, pj);
  const p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.youtube.status, "failed");
  assert.match(p.youtube.error, /被關掉/);
});

test("clearing restores moved exports when the trash fails", async (t) => {
  const s = await startStudio(t, { deps: { async trash() { throw new Error("沒辦法丟到垃圾桶（權限不足）"); } } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/burn`);
  await s.waitFor(id, (x) => x.burn?.status === "done");
  const r = await s.req("POST", `/api/projects/${id}/clear`, { body: {} });
  assert.equal(r.status, 400);
  assert.ok(fs.existsSync(path.join(projectDirFor(s.video), "v-字幕.mp4")), "搬出去的影片搬回資料夾");
  assert.ok(!fs.existsSync(path.join(s.dir, "v-字幕.mp4")));
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.job, null, "清理失敗後沒有卡住");
});

test("clearing an uploaded recording can trash the original too, never before it is on YouTube (#75)", async (t) => {
  const trashed = [];
  let failOriginal = false;
  const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trash-"));
  t.after(() => fs.rmSync(trashDir, { recursive: true, force: true }));
  const { s } = await connectedStudio(t, { deps: { async trash(f) {
    if (failOriginal && path.extname(f) === ".mp4") throw new Error("沒辦法丟到垃圾桶（權限不足）");
    trashed.push(path.basename(f));
    fs.renameSync(f, path.join(trashDir, `${trashed.length}-${path.basename(f)}`));
  } } });
  const original = fs.readFileSync(s.video);
  let id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  let home = (await s.req("GET", "/api/home")).json.recent[0];
  assert.equal(home.original_bytes, undefined, "還沒上傳：首頁不給這個選項");
  const early = await s.req("POST", `/api/projects/${id}/clear`, { body: { trashOriginal: true } });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /還沒上傳/);
  assert.deepEqual(trashed, [], "被擋下來就什麼都不動");
  assert.ok(fs.existsSync(projectDirFor(fs.realpathSync(s.video))));

  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned", alsoCc: false } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  home = (await s.req("GET", "/api/home")).json.recent[0];
  assert.equal(home.original_bytes, original.length);
  assert.deepEqual(home.youtube, { url: "https://youtu.be/VID123", needs_cc: true }, "還沒掛 CC：首頁知道要提醒");
  const r = await s.req("POST", `/api/projects/${id}/clear`, { body: { trashOriginal: true, keepOutputs: false } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.original_trashed, true);
  assert.deepEqual(trashed, ["v-字幕", path.basename(s.video)], "先清資料夾，再丟原始錄影");
  assert.ok(!fs.existsSync(s.video));

  // 原始錄影丟不掉：資料夾照樣清掉，只回報
  fs.writeFileSync(s.video, original);
  id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "cc" } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal((await s.req("GET", "/api/home")).json.recent[0].youtube.needs_cc, false, "CC 掛好了就不提醒");
  failOriginal = true;
  const r2 = await s.req("POST", `/api/projects/${id}/clear`, { body: { trashOriginal: true } });
  assert.equal(r2.status, 200, r2.raw);
  assert.equal(r2.json.original_failed, true);
  assert.equal(r2.json.original_trashed, undefined);
  assert.ok(fs.existsSync(s.video));
  assert.ok(!fs.existsSync(projectDirFor(fs.realpathSync(s.video))), "資料夾已經清掉");
});

test("meeting recap goes through meeting-scribe with the edited timeline, is saved with summary.md, turns stale after edits, and can be stopped (#80)", async (t) => {
  const sent = [], revealed = [];
  let hold = false, failNext = false;
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 10_000,
    reveal(f) { revealed.push(f); },
    async meetingRecap(paras, { signal }) {
      sent.push(paras);
      if (hold) await new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted"))));
      if (failNext) throw new Error("連不到會議轉錄 App（https://scribe.example）：ECONNREFUSED");
      return { intro: "導言", full: "## 核心結論\n結論", short: "短總結", chapters: [{ t_ms: 0, title: "開場" }] };
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.recap, null);
  // 剪掉第二句：總結和逐字稿都照剪輯後的時間，被剪掉的不送
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  const r = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(sent[0], [{ start: 0, text: "今天我們來談 怎麼用" }]);
  assert.equal(r.json.recap.intro, "導言");
  assert.equal(r.json.recap.stale, false);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual(p.recap.chapters, [{ t_ms: 0, title: "開場" }]);
  assert.equal(p.recap.stale, false);
  assert.equal(p.job, null);
  const md = fs.readFileSync(path.join(p.folder, "summary.md"), "utf8");
  // 格式是 App 的 RecapFiles（這裡是假的）；工作室要交對的資料：會議名稱、總結各段、剪輯後的逐字稿
  assert.equal(md, fakeRecapFiles.summaryMarkdown({ header: ["會議：v"], intro: "導言", chapters: [{ t_ms: 0, title: "開場" }], full: "## 核心結論\n結論", short: "短總結", transcript: "[00:00:00] 今天我們來談\n[00:00:02] 怎麼用" }));
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "summary" } });
  assert.equal(path.basename(revealed[0]), "summary.md");
  // 改字之後：總結還在，但標成舊的
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: [cues()[0], cues()[1], { ...cues()[2], text: "怎麼用它" }] } });
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.recap.stale, true);
  assert.equal(p.recap.intro, "導言");
  // 產生中按停止：總結不變、工作釋放
  hold = true;
  const pending = s.req("POST", `/api/projects/${id}/recap`);
  await s.waitFor(id, (x) => x.job?.kind === "recap");
  assert.equal((await s.req("POST", `/api/projects/${id}/recap`)).status, 409, "一次只跑一份");
  await s.req("POST", `/api/projects/${id}/cancel`);
  const stopped = await pending;
  assert.equal(stopped.status, 409);
  assert.match(stopped.json.error, /已經停止/);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.job, null);
  assert.equal(p.recap.stale, true, "停止不動原本的總結");
  // App 連不上：說清楚，工作釋放
  hold = false;
  failNext = true;
  const failed = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /連不到會議轉錄 App/);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.job, null);
});

test("extension modules come from meeting-scribe, run on the edited timeline, are saved as .md, turn stale, and refuse bad input (#88)", async (t) => {
  const PERSP = { id: "perspective", title: "視角回饋", description: "換個角色看", options: [{ id: "who", label: "誰的視角", choices: [["boss", "老闆／主管"], ["parent", "家長"]] }] };
  const SPROUT = { id: "sprout", title: "讓這場會議發芽", description: "", options: [] };
  // App 給的名稱撞到別份結果或會後總結的檔名：不能互相蓋掉
  const SAME = { id: "sprout2", title: "讓這場會議發芽", description: "", options: [] };
  const SUMMARYISH = { id: "evil", title: "SUMMARY", description: "", options: [] };
  const sent = [], revealed = [];
  let listCalls = 0, hold = false, busyNext = false, listDown = false;
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 10_000,
    reveal(f) { revealed.push(f); },
    async meetingModules() { listCalls += 1; if (listDown) throw new Error("連不到會議轉錄 App（https://scribe.example）：ECONNREFUSED"); return [SPROUT, PERSP, SAME, SUMMARYISH]; },
    async meetingModule(paras, mod, options, { signal }) {
      sent.push({ paras, module: mod.id, options });
      if (hold) await new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted"))));
      if (busyNext) throw Object.assign(new Error("會議轉錄 App 沒有產生「視角回饋」：另一份正在產生"), { status: 503 });
      return { markdown: `## ${mod.title}\n內容`, title: mod.title };
    },
  } });
  const list = await s.req("GET", "/api/modules");
  assert.equal(list.status, 200, list.raw);
  assert.deepEqual(list.json.modules.map((m) => m.id), ["sprout", "perspective", "sprout2", "evil"]);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  assert.deepEqual(p.modules, []);
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  // 選項沒給用第一個；剪掉的句子不送
  const r = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "perspective", options: { who: "parent" } } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(sent[0], { paras: [{ start: 0, text: "今天我們來談 怎麼用" }], module: "perspective", options: { who: "parent" } });
  assert.equal(r.json.module.key, "perspective:who=parent");
  assert.equal(r.json.module.label, "視角回饋（家長）");
  assert.equal(r.json.module.file, "視角回饋（家長）.md");
  assert.equal(r.json.module.stale, false);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(fs.readFileSync(path.join(p.folder, "視角回饋（家長）.md"), "utf8"), fakeRecapFiles.extraFiles([{ label: "視角回饋（家長）", markdown: "## 視角回饋\n內容" }], { header: ["會議：v"] })[0].markdown, "內容照共用格式（標題、會議資訊、結果）");
  assert.equal((await s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout" } })).status, 200);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual(p.modules.map((m) => m.key), ["sprout", "perspective:who=parent"], "最新的在前");
  assert.equal(listCalls, 1, "清單記一分鐘，不每次都問");
  const twin = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout2" } });
  assert.equal(twin.json.module.file, "讓這場會議發芽-2.md", "同名的另一個模組不蓋掉發芽那份（照 App 加 -2）");
  const evil = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "evil" } });
  assert.equal(evil.json.module.file, "SUMMARY-2.md", "不會寫成 summary.md（macOS 不分大小寫）");
  assert.ok(fs.existsSync(path.join(p.folder, "讓這場會議發芽.md")));
  await s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout" } });
  assert.ok(fs.existsSync(path.join(p.folder, "讓這場會議發芽-2.md")), "重新產生發芽不刪別人的檔");
  // 同一個模組＋選項再產生：蓋過去，不多一份
  await s.req("POST", `/api/projects/${id}/module`, { body: { module: "perspective", options: { who: "parent" } } });
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.modules.length, 4);
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "module", key: "perspective:who=parent" } });
  assert.equal(path.basename(revealed.at(-1)), "視角回饋（家長）.md");
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "module", key: "../../etc" } });
  assert.equal(path.basename(revealed.at(-1)), "subtitles.srt", "不認得的 key 不會打開別的檔");
  // 改字之後標成舊的
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: [cues()[0], cues()[1], { ...cues()[2], text: "怎麼用它" }] } });
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.ok(p.modules.every((m) => m.stale));
  // 不在清單裡的模組與選項：擋下，不送 App
  const before = sent.length;
  const unknown = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "nope" } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /沒有這個模組/);
  assert.equal(listCalls, 2, "找不到時再問一次最新的清單");
  const badOpt = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "perspective", options: { who: "cat" } } });
  assert.equal(badOpt.status, 400);
  assert.match(badOpt.json.error, /沒有這個選擇/);
  assert.equal(sent.length, before);
  // App 正在產生另一份：講人話
  busyNext = true;
  const busy = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "perspective" } });
  assert.equal(busy.status, 503);
  assert.match(busy.json.error, /正在產生另一份.*再按一次/);
  busyNext = false;
  // 產生中：會後總結不能同時跑；按停止結果不變
  hold = true;
  const pending = s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout" } });
  await s.waitFor(id, (x) => x.job?.kind === "module");
  assert.equal((await s.req("POST", `/api/projects/${id}/recap`)).status, 409, "一次只跑一份");
  await s.req("POST", `/api/projects/${id}/cancel`);
  const stopped = await pending;
  assert.equal(stopped.status, 409);
  assert.match(stopped.json.error, /已經停止/);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.job, null);
  assert.ok(p.modules.find((m) => m.key === "sprout").stale, "停止不動原本的結果");
  // 清單問不到：說清楚原因
  listDown = true;
  const down = await s.req("GET", "/api/modules?fresh=1");
  assert.equal(down.status, 502);
  assert.match(down.json.error, /連不到會議轉錄 App/);
});

test("the recap runs the meeting app's local entry on this Mac with the synced corrections, and records where it ran (#83)", async (t) => {
  const scribe = fs.mkdtempSync(path.join(os.tmpdir(), "rt-scribe-"));
  t.after(() => fs.rmSync(scribe, { recursive: true, force: true }));
  // 假的 server.py：照 meeting-scribe#139 的介面讀 stdin、印一行 JSON；順便記下收到的錯字表位置
  fs.writeFileSync(path.join(scribe, "server.py"), [
    "import json, os, sys",
    "assert sys.argv[1:] == ['summary']",
    "body = json.loads(sys.stdin.read())",
    "open('seen.json', 'w').write(json.dumps({'paras': body['paras'], 'corrections': os.environ.get('MEETING_SCRIBE_CORRECTIONS', '')}))",
    "print(json.dumps({'type': 'summary', 'module': 'summary', 'intro': '本機導言', 'full': '全文', 'short': '短', 'chapters': [], 'usage': {}}))",
  ].join("\n"));
  const cache = path.join(scribe, "corrections-cache.json");
  const s = await startStudio(t, { env: { CYCLONE_MEETING_SCRIBE_DIR: scribe, CYCLONE_CORRECTIONS_CACHE: cache }, deps: { videoDurationMs: () => 10_000 } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const r = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.recap.intro, "本機導言");
  assert.equal(r.json.recap.via, "local");
  const seen = JSON.parse(fs.readFileSync(path.join(scribe, "seen.json"), "utf8"));
  assert.equal(seen.corrections, cache, "本機入口讀工作室同步來的錯字表");
  assert.equal(seen.paras[0].start, 0);
  // 本機那份壞掉、又沒有主機：說清楚兩邊都不行
  fs.writeFileSync(path.join(scribe, "server.py"), "import sys\nprint('{\"error\": \"這台找不到 Claude Code\"}')\nsys.exit(3)\n");
  const failed = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /沒有設定會議轉錄 App 的網址.*這台也沒成功：本機沒有產生：這台找不到 Claude Code/);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.recap.via, "local", "失敗不動原本的總結");
});

test("recap and module results are copied to the configured Drive folder in the background, overwritten on regenerate, and a missing Drive is reported, not fatal (#100, #105)", async (t) => {
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-drive-"));
  t.after(() => fs.rmSync(drive, { recursive: true, force: true }));
  const revealed = [];
  let n = 0;
  const s = await startStudio(t, { env: { CYCLONE_STUDIO_DRIVE_DIR: drive }, deps: {
    videoDurationMs: () => 10_000,
    reveal(f) { revealed.push(f); },
    async meetingRecap() { n += 1; return { intro: `導言${n}`, full: "全文", short: "短", chapters: [] }; },
    async meetingModules() { return [{ id: "sprout", title: "讓這場會議發芽", description: "", output: "markdown", options: [] }]; },
    async meetingModule() { return { markdown: "## 延伸\n內容", title: "讓這場會議發芽" }; },
  } });
  const settled = (id) => s.waitFor(id, (x) => x.drive && !x.drive.pending && (x.drive.saved || x.drive.error));
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  assert.match((await s.req("GET", "/", { headers: { "X-Studio-Token": "" } })).raw, /<meta name="studio-features" content="[^"]*\bdrive\b/, "有設定 Drive 才給頁面 drive 功能");
  const r = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.drive.pending, true, "結果先回來，Drive 在背景存");
  let p = await settled(id);
  const folder = p.drive.folder;
  assert.match(folder, /^\d{4}-\d{2}-\d{2} \d{4} v$/, "日期 時分 名稱");
  assert.equal(p.drive.root, undefined, "不把本機路徑給頁面");
  assert.match(fs.readFileSync(path.join(drive, folder, "summary.md"), "utf8"), /導言1/);
  await s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout" } });
  await s.req("POST", `/api/projects/${id}/recap`);
  p = await settled(id);
  for (let i = 0; i < 50 && !/導言2/.test(fs.readFileSync(path.join(drive, folder, "summary.md"), "utf8")); i += 1) await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(fs.readdirSync(drive), [folder], "同一支影片一直用同一個資料夾");
  assert.deepEqual(fs.readdirSync(path.join(drive, folder)).sort(), ["summary.md", "讓這場會議發芽.md"]);
  assert.match(fs.readFileSync(path.join(drive, folder, "summary.md"), "utf8"), /導言2/, "重新產生是覆蓋");
  assert.match(p.drive.where, /^學校 Drive／rt-studio-drive-/, "設定的名稱加上資料夾名");
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "drive" } });
  assert.equal(revealed.at(-1), path.join(drive, folder));
  // Drive 不在：總結照樣產生，記下原因；「再存一次」說清楚；Drive 回來就存得進去
  fs.renameSync(drive, `${drive}-away`);
  const offline = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(offline.status, 200, "存不了 Drive 不擋產生");
  p = await s.waitFor(id, (x) => x.drive && !x.drive.pending && x.drive.error);
  assert.match(p.drive.error, /找不到要存的 Drive 資料夾/);
  assert.equal(p.drive.folder, folder, "記得原本的資料夾");
  const retry = await s.req("POST", `/api/projects/${id}/drive`);
  assert.equal(retry.status, 502);
  assert.match(retry.json.error, /找不到要存的 Drive 資料夾/);
  fs.renameSync(`${drive}-away`, drive);
  const back = await s.req("POST", `/api/projects/${id}/drive`);
  assert.equal(back.status, 200, back.raw);
  assert.equal(back.json.drive.folder, folder);
  assert.match(fs.readFileSync(path.join(drive, folder, "summary.md"), "utf8"), /導言3/);
});

test("a Drive that hangs never blocks the Studio: the save times out and says so (#105)", async (t) => {
  let started = 0;
  const s = await startStudio(t, { env: { CYCLONE_STUDIO_DRIVE_DIR: "/somewhere" }, deps: {
    videoDurationMs: () => 10_000,
    async meetingRecap() { return { intro: "導言", full: "", short: "", chapters: [] }; },
    // 真的 Drive 卡住時：程序一直不回，逾時後結束它
    driveCopy: (job) => { started += 1; return copyToDriveIsolated(job, { timeoutMs: 300, script: HANG_SCRIPT }); },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const t0 = Date.now();
  const r = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 250, "產生的結果不用等 Drive");
  const busy = await s.req("GET", `/api/projects/${id}`);
  assert.equal(busy.json.drive.pending, true, "正在存");
  const p = await s.waitFor(id, (x) => x.drive && !x.drive.pending);
  assert.match(p.drive.error, /Google Drive 超過 0 秒沒有回應|Google Drive 超過 \d+ 秒沒有回應/);
  assert.equal(started, 1);
});

test("the mind map is saved as mindmap.md and mindmap.opml like the meeting app, copied to Drive, and can be revealed (#101)", async (t) => {
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-map-"));
  t.after(() => fs.rmSync(drive, { recursive: true, force: true }));
  const revealed = [];
  const s = await startStudio(t, { env: { CYCLONE_STUDIO_DRIVE_DIR: drive }, deps: {
    videoDurationMs: () => 10_000,
    reveal(f) { revealed.push(f); },
    async meetingModules() { return [{ id: "mindmap", title: "心智圖", description: "", output: "mindmap", options: [] }]; },
    async meetingModule(paras, mod) {
      assert.equal(mod.output, "mindmap");
      return { markdown: "# 心智圖：主題\n\n```mermaid\nmindmap\n```", title: "心智圖", mindmap: { center: "主題", branches: [{ label: "議題" }] }, mermaid: "mindmap\n  root((主題))", opml: "<?xml version=\"1.0\"?><opml/>" };
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const r = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "mindmap" } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.module.file, "mindmap.md");
  assert.equal(r.json.module.output, "mindmap");
  assert.deepEqual(r.json.module.mindmap, { center: "主題", branches: [{ label: "議題" }] });
  let p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(fs.readFileSync(path.join(p.folder, "mindmap.md"), "utf8"), "# 心智圖：主題\n\n```mermaid\nmindmap\n```\n", "App 的 markdown 原樣");
  assert.equal(fs.readFileSync(path.join(p.folder, "mindmap.opml"), "utf8"), "<?xml version=\"1.0\"?><opml/>");
  const done = await s.waitFor(id, (x) => x.drive && !x.drive.pending && x.drive.saved);
  assert.deepEqual(fs.readdirSync(path.join(drive, done.drive.folder)).sort(), ["mindmap.md", "mindmap.opml"], "兩個檔都存到 Drive");
  assert.equal(p.modules[0].mermaid, "mindmap\n  root((主題))");
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "module", key: "mindmap" } });
  assert.equal(path.basename(revealed.at(-1)), "mindmap.md");
  await s.req("POST", `/api/projects/${id}/reveal`, { body: { what: "module", key: "__proto__" } });
  assert.equal(path.basename(revealed.at(-1)), "subtitles.srt", "不認得的 key 不會打開別的檔");
});

test("the meeting app's shared components are served from its checkout, only by name (#111)", async (t) => {
  const scribe = fs.mkdtempSync(path.join(os.tmpdir(), "rt-scribe-shared-"));
  t.after(() => fs.rmSync(scribe, { recursive: true, force: true }));
  fs.mkdirSync(path.join(scribe, "web", "shared"), { recursive: true });
  fs.writeFileSync(path.join(scribe, "web", "shared", "md.js"), "window.MdView = 1;");
  fs.writeFileSync(path.join(scribe, "web", "shared", "secret.js"), "nope");
  const s = await startStudio(t, { env: { CYCLONE_MEETING_SCRIBE_DIR: scribe } });
  const ok = await s.req("GET", "/shared/md.js");
  assert.equal(ok.status, 200);
  assert.equal(ok.raw, "window.MdView = 1;");
  assert.match(ok.headers["content-type"], /javascript/);
  assert.equal((await s.req("GET", "/shared/ext.css")).status, 404, "清單上但檔案不在");
  assert.equal((await s.req("GET", "/shared/secret.js")).status, 404, "不在清單上的檔名不給");
  assert.equal((await s.req("GET", "/shared/../../etc/passwd")).status, 404);
});

test("an edited mind map is saved back as mindmap.md, .opml and .svg, checked first, and copied to Drive (#111)", async (t) => {
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-mapsave-"));
  t.after(() => fs.rmSync(drive, { recursive: true, force: true }));
  const s = await startStudio(t, { env: { CYCLONE_STUDIO_DRIVE_DIR: drive }, deps: {
    videoDurationMs: () => 10_000,
    async meetingModules() { return [{ id: "mindmap", title: "心智圖", description: "", output: "mindmap", options: [] }]; },
    async meetingModule() { return { markdown: "# 心智圖：主題", title: "心智圖", mindmap: { center: "主題", branches: [{ label: "議題" }] }, mermaid: "mindmap", opml: "<?xml version=\"1.0\"?><opml/>" }; },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  await s.req("POST", `/api/projects/${id}/module`, { body: { module: "mindmap" } });
  const body = { key: "mindmap", edited: true, mindmap: { center: "主題", branches: [{ label: "議題" }, { label: "新增的" }] }, markdown: "# 心智圖：主題\n\n- 新增的", opml: "<?xml version=\"1.0\"?><opml><body><outline text=\"新增的\"/></body></opml>", mermaid: "mindmap\n  root((主題))", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>主題</text></svg>" };
  const r = await s.req("POST", `/api/projects/${id}/mindmap`, { body });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.module.edited, true);
  assert.deepEqual(r.json.module.extra_files.sort(), ["mindmap.opml", "mindmap.svg"]);
  const p = await s.waitFor(id, (x) => x.drive && !x.drive.pending && x.drive.saved);
  assert.equal(fs.readFileSync(path.join(p.folder, "mindmap.md"), "utf8"), "# 心智圖：主題\n\n- 新增的\n");
  assert.match(fs.readFileSync(path.join(p.folder, "mindmap.opml"), "utf8"), /新增的/);
  assert.match(fs.readFileSync(path.join(p.folder, "mindmap.svg"), "utf8"), /^<svg/);
  assert.deepEqual(p.modules[0].mindmap.branches.map((b) => b.label), ["議題", "新增的"]);
  for (let i = 0; i < 50 && fs.readdirSync(path.join(drive, p.drive.folder)).length < 3; i += 1) await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(fs.readdirSync(path.join(drive, p.drive.folder)).sort(), ["mindmap.md", "mindmap.opml", "mindmap.svg"]);
  // 不收：不是心智圖的 key、壞掉的圖、帶 script 的 SVG、空的文字版
  assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, key: "sprout" } })).status, 404);
  assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, key: "__proto__" } })).status, 404);
  assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, mindmap: { center: "x", branches: [] } } })).status, 400);
  for (const svg of ["<svg><script>alert(1)</script></svg>", "<svg onload=\"x()\"></svg>", "<svg><rect/onload=\"x()\"/></svg>", "<html></html>", "<svg><a href=\"javascript:x\"/></svg>",
    "<svg><image href=\"http://x\"/></svg>", "<svg><style>@import url(http://x)</style></svg>", "<svg><text>&#106;</text></svg>", "<svg><rect fill=\"url(http://x)\"/></svg>", "<svg><g>"]) {
    assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, svg } })).status, 400, svg);
  }
  assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, markdown: " " } })).status, 400);
  assert.match(fs.readFileSync(path.join(p.folder, "mindmap.svg"), "utf8"), /<text>主題<\/text>/, "不收的沒有寫進去");
  assert.equal((await s.req("POST", `/api/projects/${id}/mindmap`, { body: { ...body, svg: "<svg><rect fill=\"url(#g)\"/></svg>" } })).status, 200, "url(#…) 指向自己可以");
});

test("without the App's shared file format nothing is generated or written, and the version check compares this checkout with the host (#116)", async (t) => {
  let asked = 0;
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 10_000,
    recapFiles: () => { throw new Error("找不到會議轉錄 App 的共用存檔格式（這台的 meeting-scribe 程式），先不寫檔"); },
    async meetingRecap() { asked += 1; return { intro: "導言", full: "", short: "", chapters: [] }; },
    async meetingModules() { return [{ id: "sprout", title: "讓這場會議發芽", description: "", output: "markdown", options: [] }, { id: "mindmap", title: "心智圖", description: "", output: "mindmap", options: [] }]; },
    async meetingModule(paras, mod) { asked += 1; return mod.output === "mindmap" ? { markdown: "# 心智圖：主題\n", title: "心智圖", mindmap: { center: "主題", branches: [{ label: "議題" }] }, mermaid: "mindmap", opml: "" } : { markdown: "內容", title: mod.title }; },
    async sharedBuilds() { return { local: "aaaa1111", remote: "bbbb2222" }; },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const r = await s.req("POST", `/api/projects/${id}/recap`);
  assert.equal(r.status, 502);
  assert.match(r.json.error, /找不到會議轉錄 App 的共用存檔格式/);
  const m = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "sprout" } });
  assert.equal(m.status, 502);
  assert.equal(asked, 0, "存不了檔就不花 AI");
  const map = await s.req("POST", `/api/projects/${id}/module`, { body: { module: "mindmap" } });
  assert.equal(map.status, 200, "心智圖的檔名與內容是元件給的，不用存檔格式");
  const p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(fs.readFileSync(path.join(p.folder, "mindmap.md"), "utf8"), "# 心智圖：主題\n", "結尾只有一個換行");
  const v = await s.req("GET", "/api/shared-version");
  assert.deepEqual(v.json, { local: "aaaa1111", remote: "bbbb2222", same: false });
});

test("the real RecapFiles from this Mac's meeting-scribe checkout, when present, gives the same summary.md and -2 names (#116)", async (t) => {
  const scribe = scribeDir();
  if (!fs.existsSync(path.join(scribe, "web", "shared", "recap-files.js"))) return t.skip("這台沒有 meeting-scribe 的 recap-files.js");
  const { loadRecapFiles } = await import("../lib/shared-components.mjs");
  const rf = loadRecapFiles(scribe);
  const s = await startStudio(t, { deps: {
    videoDurationMs: () => 10_000, recapFiles: () => rf,
    async meetingRecap() { return { intro: "導言", full: "## 核心結論\n結論", short: "短", chapters: [{ t_ms: 0, title: "開場" }] }; },
    async meetingModules() { return [{ id: "a", title: "同名", description: "", output: "markdown", options: [] }, { id: "b", title: "同名", description: "", output: "markdown", options: [] }]; },
    async meetingModule() { return { markdown: "## 內容\n- 一", title: "同名" }; },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  assert.equal((await s.req("POST", `/api/projects/${id}/recap`)).status, 200);
  const p = (await s.req("GET", `/api/projects/${id}`)).json;
  const md = fs.readFileSync(path.join(p.folder, "summary.md"), "utf8");
  assert.ok(md.startsWith("# 會後總結\n\n會議：v\n\n## 簡介\n\n導言"), md.slice(0, 80));
  assert.match(md, /## 完整總結\n\n### 核心結論/, "完整總結的標題降一級");
  assert.match(md, /## 逐字稿\n\n\[00:00:00\] 今天我們來談/);
  assert.equal((await s.req("POST", `/api/projects/${id}/module`, { body: { module: "a" } })).json.module.file, "同名.md");
  assert.equal((await s.req("POST", `/api/projects/${id}/module`, { body: { module: "b" } })).json.module.file, "同名-2.md");
});

test("a failed upload tells which step and that nothing was charged (#121)", async (t) => {
  const s = await startStudio(t, { deps: {
    async prepareSubtitles(o, { onStep }) {
      onStep("asr");
      throw Object.assign(new Error("上傳聲音到 Soniox：太久沒有回應（網路太慢或中斷）"), { notCharged: true, code: "UND_ERR_HEADERS_TIMEOUT", report: { steps: { extract_s: 3.7 } } });
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const p = await s.waitFor(id, (x) => x.status === "failed");
  assert.equal(p.error, "上傳聲音到 Soniox：太久沒有回應（網路太慢或中斷）。還沒開始辨識，沒有花到 Soniox 或 AI 的額度，網路穩了按「重試」");
});

// ---- 交給 agent 寫 wiki（#49）----
test("without icloud_inbox the page has no hand-off button and a hand-off is refused", async (t) => {
  const saved = process.env.CYCLONE_ASR_PROFILE_USER;
  process.env.CYCLONE_ASR_PROFILE_USER = "";
  resetAsrProfileCache();
  t.after(() => { process.env.CYCLONE_ASR_PROFILE_USER = saved; resetAsrProfileCache(); });
  const s = await startStudio(t, { description: "簡介\n" });
  const page = await s.req("GET", "/", { headers: { "X-Studio-Token": "" } });
  assert.match(page.raw, /<meta name="studio-features" content="">/);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const r = await s.req("POST", `/api/projects/${id}/handoff`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /icloud_inbox/);
});

test("handing a project to the wiki queue writes a handoff, asks before a second one, and refuses without iCloud", async (t) => {
  const icloud = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-icloud-"));
  t.after(() => fs.rmSync(icloud, { recursive: true, force: true }));
  let root = icloud;
  const s = await startStudio(t, { description: "簡介\n\n00:00 開場\n・重點\n", deps: { icloudRoot: () => root } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  assert.match((await s.req("GET", "/", { headers: { "X-Studio-Token": "" } })).raw, /<meta name="studio-features" content="handoff[ "]/, "有設定才顯示交接按鈕");
  const first = await s.req("POST", `/api/projects/${id}/handoff`);
  assert.equal(first.status, 200, first.raw);
  assert.match(first.json.folder, /^iCloud Drive\/Inbox\/to-wiki\/\d{4}-\d{2}-\d{2}--v$/);
  const toWiki = path.join(icloud, "Inbox", "to-wiki");
  const h = fs.readFileSync(path.join(toWiki, first.json.handoff.name, "handoff.md"), "utf8");
  assert.ok(h.includes("00:00 開場\n・重點"), h);
  assert.ok(h.includes("AI 校對把「Cloud Code」改成「Claude Code」"), h);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.handoff.name, first.json.handoff.name);

  const again = await s.req("POST", `/api/projects/${id}/handoff`);
  assert.equal(again.status, 409, "交過一次，先讓頁面問");
  assert.equal(again.json.handoff.name, first.json.handoff.name);
  assert.equal(fs.readdirSync(toWiki).length, 1);
  const forced = await s.req("POST", `/api/projects/${id}/handoff`, { body: { force: true } });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.handoff.name, `${first.json.handoff.name}-2`);
  assert.equal(fs.readFileSync(path.join(toWiki, first.json.handoff.name, "handoff.md"), "utf8"), h, "the first one is not overwritten");

  root = path.join(icloud, "missing");
  const none = await s.req("POST", `/api/projects/${id}/handoff`, { body: { force: true } });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /找不到 iCloud Drive/);
  assert.equal(fs.existsSync(root), false);
});

test("the wiki handoff waits while the description is being rewritten", async (t) => {
  let release = () => {};
  const s = await startStudio(t, { deps: {
    icloudRoot: () => { throw new Error("must not be called"); },
    describe: () => new Promise((resolve) => { release = () => resolve({ text: "新\n", chapters: [], suggest: { title: "", tags: [] }, usage: null }); }),
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const pending = s.req("POST", `/api/projects/${id}/describe`);
  await s.waitFor(id, (x) => x.job?.kind === "describe");
  try {
    const r = await s.req("POST", `/api/projects/${id}/handoff`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /說明欄還在重新寫/);
  } finally {
    release();   // 斷言失敗也要放行，不然關不掉工作室
  }
  assert.equal((await pending).status, 200);
});

// ---- 直式短片（recording-transcriber#54）----
const aiShort = (over = {}) => ({ id: "r-1", start: 0, end: 4000, title: "AI 挑的一段", reason: "完整的觀點", by: "ai", ...over });

test("shorts: AI picks a list, edits save without bumping the subtitle revision, and the page cannot write output records", async (t) => {
  const seen = {};
  const s = await startStudio(t, { deps: {
    async suggestShorts(c, o) { seen.cues = c.length; seen.cuts = o.cuts; seen.chapters = o.chapters; return { items: [aiShort({ id: o.makeId(0) })], usage: null }; },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.shorts, null);
  const r = await s.req("POST", `/api/projects/${id}/shorts/suggest`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.added, 1);
  assert.equal(seen.cues, 3);
  assert.equal(seen.chapters, "簡介", "說明欄給 AI 當參考");
  const [item] = r.json.shorts.items;
  assert.equal(item.n, 1);
  assert.equal(item.file, "v-短片-01.mp4");
  assert.equal(item.output, null);

  const put = await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [{ ...item, title: "改過的標題", output: { file: "../../evil.mp4", key: "x" }, export: { status: "done" } }] } });
  assert.equal(put.status, 200, put.raw);
  assert.equal(put.json.shorts.items[0].title, "改過的標題");
  const stored = readProject(projectDirFor(fs.realpathSync(s.video))).shorts.items[0];
  assert.equal(stored.output, undefined, "輸出紀錄只能由伺服器寫");
  assert.equal(stored.export, undefined);
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.rev, p.rev, "改片段不動字幕版本（燒好的影片不會被當成過期）");
  assert.equal((await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [{ ...item, end: item.start + 500 }] } })).status, 400, "太短");
  assert.equal((await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: "x" } })).status, 400);
  assert.equal((await s.req("POST", `/api/projects/${id}/shorts/nope/export`)).status, 404);
  assert.equal((await s.req("GET", `/api/projects/${id}/shorts/suggest`)).status, 405);
});

test("shorts: exporting records the output, edits mark it stale, a new AI pick keeps it and numbers on, and clearing moves it out", async (t) => {
  const renders = [];
  const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trash-"));
  t.after(() => fs.rmSync(trashDir, { recursive: true, force: true }));
  let round = 0;
  const s = await startStudio(t, { deps: {
    async suggestShorts(c, o) { round += 1; return { items: [aiShort({ id: o.makeId(0), title: `第 ${round} 輪` })], usage: null }; },
    videoSize: () => ({ w: 1920, h: 1080 }),
    videoDurationMs: () => 4000,
    async renderShort(o) {
      renders.push({ ...o, ass: fs.readFileSync(o.ass, "utf8") });
      o.onProgress(0.5);
      fs.writeFileSync(o.target, "short");
    },
    async trash(f) { fs.renameSync(f, path.join(trashDir, path.basename(f))); },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  let p = await s.waitFor(id, (x) => x.status === "ready");
  // 剪掉中間：第二句整句剪掉，片段照剪輯接起來
  const put = await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  assert.equal(put.status, 200, put.raw);
  const [item] = (await s.req("POST", `/api/projects/${id}/shorts/suggest`)).json.shorts.items;
  assert.equal((await s.req("POST", `/api/projects/${id}/shorts/${item.id}/export`)).status, 200);
  p = await s.waitFor(id, (x) => !x.job && x.shorts.items[0].output);
  const out = p.shorts.items[0].output;
  assert.equal(out.file, "v-短片-01.mp4");
  assert.equal(out.fresh, true);
  assert.equal(p.shorts.items[0].export.status, "done");
  const folder = projectDirFor(fs.realpathSync(s.video));
  assert.equal(fs.readFileSync(path.join(folder, "v-短片-01.mp4"), "utf8"), "short");
  assert.deepEqual(renders[0].keep, [[0, 1100], [2100, 4000]], "剪掉的區段不放進短片");
  assert.match(renders[0].ass, /^Dialogue: 0,0:00:00\.00,0:00:03\.00,Title,,0,0,0,,第 1 輪$/m, "標題從頭到尾（剪完 3 秒）");
  assert.doesNotMatch(renders[0].ass, /Claude Code/, "整句剪掉的字幕不出現");
  assert.match(renders[0].ass, /^Dialogue: 1,0:00:02\.00,0:00:03\.00,BoxText,,0,0,0,,\{[^}]*\}怎麼用$/m, "後面的字幕往前移（預設圓角底框）");
  assert.ok(!fs.readdirSync(folder).some((n) => n.startsWith(".burn-")), "暫存資料夾刪掉了");

  await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [{ ...p.shorts.items[0], title: "改標題" }] } });
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.shorts.items[0].output.fresh, false, "改了標題：要重新輸出");

  const again = await s.req("POST", `/api/projects/${id}/shorts/suggest`);
  assert.deepEqual(again.json.shorts.items.map((x) => [x.n, x.title, Boolean(x.output)]), [[1, "改標題", true], [2, "第 2 輪", false]], "輸出過的留著，新的序號接著編");
  const third = await s.req("POST", `/api/projects/${id}/shorts/suggest`);
  assert.deepEqual(third.json.shorts.items.map((x) => x.n), [1, 3], "沒輸出的換掉；序號不重用，不會蓋掉別的檔");

  const cleared = await s.req("POST", `/api/projects/${id}/clear`, { body: {} });
  assert.equal(cleared.status, 200, cleared.raw);
  assert.deepEqual(cleared.json.moved, ["v-短片-01.mp4"], "短片和其他輸出一樣先搬出來");
  assert.ok(fs.existsSync(path.join(path.dirname(fs.realpathSync(s.video)), "v-短片-01.mp4")));
});

test("shorts: an export can be stopped, a crash mid-export is marked failed, and AI picking can be stopped", async (t) => {
  let aiStarted = false;
  const s = await startStudio(t, { deps: {
    videoSize: () => ({ w: 1920, h: 1080 }),
    renderShort: ({ signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))); }),
    suggestShorts: (c, { signal }) => {
      if (!aiStarted) { aiStarted = true; return { items: [aiShort()], usage: null }; }
      return new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new Error("cancelled"))); });
    },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const [item] = (await s.req("POST", `/api/projects/${id}/shorts/suggest`)).json.shorts.items;
  await s.req("POST", `/api/projects/${id}/shorts/${item.id}/export`);
  let p = await s.waitFor(id, (x) => x.job?.kind === "short");
  assert.equal(p.job.short, item.id);
  assert.equal(p.shorts.items[0].export.status, "running");
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 409, "同時只跑一個工作");
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  p = await s.waitFor(id, (x) => !x.job);
  assert.equal(p.shorts.items[0].export.status, "cancelled");
  assert.equal(p.shorts.items[0].output, null);
  const folder = projectDirFor(fs.realpathSync(s.video));
  assert.ok(!fs.readdirSync(folder).some((n) => n.startsWith("v-短片") || n.startsWith(".burn-")), "沒有成品也沒有暫存");

  // Studio 在輸出中被關掉：下次讀到時標成失敗
  const pj = readProject(folder);
  pj.shorts.items[0].export = { status: "running" };
  writeProject(folder, pj);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.equal(p.shorts.items[0].export.status, "failed");
  assert.match(p.shorts.items[0].export.error, /被關掉/);

  const pending = s.req("POST", `/api/projects/${id}/shorts/suggest`);
  await s.waitFor(id, (x) => x.job?.kind === "shorts");
  try {
    assert.equal((await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [] } })).status, 409, "AI 挑的時候不能改清單");
    assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  } finally {
    const r = await pending;
    assert.equal(r.status, 409);
    assert.match(r.json.error, /停止/);
  }
  assert.equal((await s.req("GET", `/api/projects/${id}`)).json.shorts.items.length, 1, "停止後清單不變");
});

test("shorts: numbers of deleted shorts are never reused, and an export never overwrites a file it does not own", async (t) => {
  const s = await startStudio(t, { deps: {
    async suggestShorts(c, o) { return { items: [aiShort({ id: o.makeId(0) })], usage: null }; },
    videoSize: () => ({ w: 1920, h: 1080 }),
    async renderShort(o) { fs.writeFileSync(o.target, `short ${path.basename(o.target)}`); },
  } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.status === "ready");
  const folder = projectDirFor(fs.realpathSync(s.video));
  const [first] = (await s.req("POST", `/api/projects/${id}/shorts/suggest`)).json.shorts.items;
  await s.req("POST", `/api/projects/${id}/shorts/${first.id}/export`);
  await s.waitFor(id, (x) => !x.job && x.shorts.items[0].output);
  // 刪掉已輸出的那段（檔案留在資料夾），再加一段：頁面送來的序號就算撞到也會被改成往後編
  const del = await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [] } });
  assert.equal(del.json.shorts.max_n, 1);
  const add = await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [{ id: "u-new", n: 1, title: "新的", start: 0, end: 4000, by: "user" }] } });
  assert.equal(add.status, 200, add.raw);
  assert.equal(add.json.shorts.items[0].n, 2, "不重用刪掉那段的序號");
  const again = await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [{ ...add.json.shorts.items[0], n: 9 }] } });
  assert.equal(again.json.shorts.items[0].n, 2, "已經有的片段，序號不能從頁面改");
  await s.req("PUT", `/api/projects/${id}/shorts`, { body: { items: [] } });
  const ai = await s.req("POST", `/api/projects/${id}/shorts/suggest`);
  assert.deepEqual(ai.json.shorts.items.map((x) => x.n), [3], "清單清空後 AI 重新挑，也接在用過的最大序號後面");

  // 保險：資料夾裡已經有別人留下的同名檔，輸出失敗、不蓋掉
  const target = path.join(folder, "v-短片-03.mp4");
  fs.writeFileSync(target, "someone else's");
  await s.req("POST", `/api/projects/${id}/shorts/${ai.json.shorts.items[0].id}/export`);
  const p = await s.waitFor(id, (x) => !x.job && ["done", "failed"].includes(x.shorts.items[0].export?.status));
  assert.equal(p.shorts.items[0].export.status, "failed", "同名檔不是自己的：不輸出");
  assert.match(p.shorts.items[0].export.error, /沒有蓋掉/);
  assert.equal(fs.readFileSync(target, "utf8"), "someone else's");
  assert.equal(fs.readFileSync(path.join(folder, "v-短片-01.mp4"), "utf8"), "short short.mp4", "第一支還在");
});

// ---- 外語影片雙語字幕（#56）：假的 yt-dlp、作者字幕、翻譯 ----
const YT = "abcdefghijk";
async function startYt(t, { captions = "author" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-yt-"));
  const dl = path.join(dir, "YouTube 下載");
  const y = { info: 0, video: 0, captions: 0, fromCaptions: [], translate: [], round: 0, trashed: [], before: null, after: null, dlGate: null };
  const s = await startStudio(t, {
    dir,
    deps: {
      hasYtDlp: () => true,
      downloadDir: () => dl,
      async fetchInfo(id) {
        y.info += 1;
        return pickInfo({ id, title: "A Talk", uploader: "Someone", language: "en", subtitles: captions === "author" ? { en: [], "zh-TW": [] } : {}, automatic_captions: { "en-orig": [] } });
      },
      async fetchVideo(id, tmp, { signal, onProgress }) {
        y.video += 1;
        onProgress(0.5);
        if (y.dlGate) await Promise.race([y.dlGate, new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true }))]);
        const f = path.join(tmp, `A Talk [${id}].mp4`);
        fs.writeFileSync(f, "mp4");
        return f;
      },
      async fetchCaptions(id, track, d) {
        y.captions += 1;
        y.track = track;
        const f = path.join(d, `captions.${track}.vtt`);
        fs.writeFileSync(f, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n\n00:00:01.000 --> 00:00:02.000\nGood morning\n");
        return f;
      },
      async prepareFromCaptions(o, { cues }) {
        y.fromCaptions.push({ o, cues });
        return { cues, applied: [], rejected: [], description: "說明", chapters: [], suggest: null, timing: null, report: { engine: "youtube-captions" } };
      },
      taiwanConverter: async () => (x) => x,
      async translateCues(todo, { onBatch, signal, lang }) {
        const round = ++y.round;
        y.translate.push({ texts: todo.map((c) => c.text), lang });
        if (y.before) await y.before;
        if (signal.aborted) throw new Error("cancelled");
        await onBatch(0, todo.map((c) => `譯${round}:${c.text}`));
        if (y.after) await y.after;
        return { done: todo.length, usage: { calls: 1, cost_usd: 0 } };
      },
      async trash(f) { y.trashed.push(f); fs.rmSync(f, { recursive: true, force: true }); },
    },
  });
  const waitImport = async (key, pred) => {
    for (let i = 0; i < 200; i++) {
      const r = await s.req("GET", `/api/import/${key}`);
      if (pred(r.json)) return r.json;
      await new Promise((x) => setTimeout(x, 20));
    }
    throw new Error("import timed out");
  };
  return { ...s, dl, y, waitImport };
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return [p, open]; };

test("a YouTube video with author captions downloads, skips recognition and is translated automatically", async (t) => {
  const s = await startYt(t);
  assert.equal((await s.req("POST", "/api/import", { body: { url: "https://vimeo.com/1" } })).status, 400);
  assert.equal((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}`, lang: "EN!" } })).status, 400);
  const r = await s.req("POST", "/api/import", { body: { url: `https://www.youtube.com/watch?v=${YT}&t=3s` } });
  assert.equal(r.status, 200, r.raw);
  const imp = await s.waitImport(r.json.import, (x) => x.status !== "running");
  assert.equal(imp.status, "done", imp.error);
  assert.equal(imp.captions, "author");
  assert.equal(imp.abort, undefined, "不把內部函式送給頁面");
  const p = await s.waitFor(imp.project, (x) => x.status === "ready" && !x.job && x.translate?.status === "done");
  assert.equal(s.calls.prepare, 0, "作者字幕不送辨識");
  assert.equal(s.y.track, "en", "用和影片同語言的那一軌，不是作者上傳的中文翻譯");
  assert.deepEqual(s.y.fromCaptions[0].cues.map((c) => c.text), ["Hello there", "Good morning"]);
  assert.equal(s.y.fromCaptions[0].o.lang, "en");
  assert.deepEqual(p.cues.map((c) => [c.text, c.tr]), [["Hello there", "譯1:Hello there"], ["Good morning", "譯1:Good morning"]]);
  assert.equal(s.y.translate[0].lang, "en");
  assert.equal(p.lang, "en");
  assert.equal(p.foreign, true);
  assert.equal(p.lang_mode, "both");
  assert.equal(p.source.url, "https://www.youtube.com/watch?v=abcdefghijk".replace("abcdefghijk", YT));
  assert.equal(p.source.uploader, "Someone");
  assert.equal(p.source.downloaded, true);
  assert.equal(fs.realpathSync(path.dirname(p.video)), fs.realpathSync(s.dl), "影片放在下載資料夾");
  assert.ok(!fs.readdirSync(s.dl).some((n) => n.startsWith(".dl-")), "下載的暫存資料夾收掉了");
  assert.ok(fs.existsSync(path.join(p.folder, "captions.en.vtt")));
  assert.match(fs.readFileSync(path.join(p.folder, "subtitles.zh-TW.srt"), "utf8"), /譯1:Hello there/);
  // 首頁的影片清單看得到下載資料夾
  const home = (await s.req("GET", "/api/home")).json;
  assert.ok(home.recent.some((x) => x.id === imp.project && x.downloaded && x.foreign));
  // 同一支再貼一次：不重新下載，直接打開
  const again = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  assert.equal(again.status, "done");
  assert.equal(again.reopened, true);
  assert.equal(again.project, imp.project);
  assert.equal(s.y.video, 1);
});

test("a YouTube video with only auto captions goes to Soniox with its language; a download can be stopped", async (t) => {
  const s = await startYt(t, { captions: "auto" });
  const [hold, open] = gate();
  s.y.dlGate = hold;
  const first = (await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import;
  await s.waitImport(first, (x) => x.step === "download");
  assert.equal((await s.req("POST", `/api/import/${first}/cancel`)).status, 200);
  const stopped = await s.waitImport(first, (x) => x.status !== "running");
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.project, undefined);
  assert.deepEqual(fs.readdirSync(s.dl), [], "停止後沒有留下半個檔");
  assert.equal((await s.req("POST", `/api/import/${first}/cancel`)).status, 409);
  open();
  s.y.dlGate = null;
  const imp = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  assert.equal(imp.captions, "auto");
  const p = await s.waitFor(imp.project, (x) => x.status === "ready" && !x.job);
  assert.equal(s.y.captions, 0, "自動字幕不下載");
  assert.equal(s.calls.prepare, 1, "送辨識");
  assert.equal(s.calls.prepareOpts.lang, "en", "照影片的語言辨識");
  assert.ok(p.cues.every((c) => c.tr), "辨識完一樣自動翻譯");
});

test("saving while translating keeps new translations and the user's own edits", async (t) => {
  const s = await startYt(t);
  const imp = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  const id = imp.project;
  let p = await s.waitFor(id, (x) => x.translate?.status === "done" && !x.job);
  // 頁面送來的字幕沒有 tr（例如舊頁面）：伺服器上的譯文留著
  const bare = p.cues.map(({ tr, ...c }) => c);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: bare } })).status, 200);
  p = (await s.req("GET", `/api/projects/${id}`)).json;
  assert.deepEqual(p.cues.map((c) => c.tr), ["譯1:Hello there", "譯1:Good morning"]);
  // 全部重翻；翻好一批後停住，這時頁面用舊譯文存檔，第二句是使用者自己改的
  const [after, open] = gate();
  s.y.after = after;
  assert.equal((await s.req("POST", `/api/projects/${id}/translate`, { body: { all: true } })).status, 200);
  await s.waitFor(id, (x) => x.translate?.status === "running" && x.cues[0].tr === "譯2:Hello there");
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 409, "翻譯中不能燒");
  assert.equal((await s.req("POST", `/api/projects/${id}/translate`)).status, 409);
  const stale = [{ ...p.cues[0], tr: "譯1:Hello there" }, { ...p.cues[1], tr: "我改的" }];
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: stale } })).status, 200);
  open();
  p = await s.waitFor(id, (x) => x.translate?.status === "done" && !x.job);
  assert.deepEqual(p.cues.map((c) => c.tr), ["譯2:Hello there", "我改的"], "舊譯文換成新的，自己改的留著");
  // 只翻沒翻的：清空一句再翻，只送那一句
  s.y.after = null;
  const cleared = [p.cues[0], { ...p.cues[1], tr: "" }];
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cues: cleared } })).status, 200);
  const [before, go] = gate();
  s.y.before = before;
  assert.equal((await s.req("POST", `/api/projects/${id}/translate`, { body: {} })).status, 200);
  await s.waitFor(id, (x) => x.job?.kind === "translate");
  assert.deepEqual(s.y.translate.at(-1).texts, ["Good morning"]);
  // 停止：沒寫入，記成停止
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  go();
  p = await s.waitFor(id, (x) => !x.job && x.translate?.status !== "running");
  assert.equal(p.translate.status, "cancelled");
  assert.deepEqual(p.cues.map((c) => c.tr), ["譯2:Hello there", ""]);
});

test("bilingual burns follow the language mode; ASS export; relayout and translate guards", async (t) => {
  const s = await startYt(t);
  const imp = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  const id = imp.project;
  let p = await s.waitFor(id, (x) => x.translate?.status === "done" && !x.job);
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  p = await s.waitFor(id, (x) => x.burn?.status === "done");
  assert.match(s.calls.srt, /\}譯1:Hello there$/m, "雙語：中文");
  assert.match(s.calls.srt, /\\b0\}Hello there$/m, "雙語：原文在下、不加粗");
  assert.equal(p.burn.lang_mode, "both");
  assert.equal(p.outputs.burn.lang_mode, "both");
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, lang_mode: "nope" } })).status, 400);
  assert.equal((await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, lang_mode: "zh" } })).status, 200);
  assert.equal((await s.req("POST", `/api/projects/${id}/burn`)).status, 200);
  p = await s.waitFor(id, (x) => x.burn?.status === "done" && x.burn.lang_mode === "zh");
  assert.doesNotMatch(s.calls.srt, /\}Hello there$/m, "只放中文");
  assert.equal(p.lang_mode, "zh");
  // 雙語 ASS 字幕檔
  const ass = await s.req("POST", `/api/projects/${id}/subtitle-file`);
  assert.equal(ass.status, 200, ass.raw);
  const file = path.join(p.folder, ass.json.file);
  assert.equal(ass.json.file, "A Talk [abcdefghijk]-雙語.ass".replace("abcdefghijk", YT));
  assert.match(fs.readFileSync(file, "utf8"), /\\b0\}Good morning$/m);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await s.req("POST", `/api/projects/${id}/relayout`)).status, 409, "外語影片不重新排字幕");
  // 中文影片：不能翻譯、沒有 ASS 匯出、存檔時 lang_mode 不寫進去
  const zh = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } });
  const zp = await s.waitFor(zh.json.id, (x) => x.status === "ready");
  assert.equal(zp.foreign, false);
  assert.equal(zp.lang_mode, null);
  assert.equal((await s.req("POST", `/api/projects/${zh.json.id}/translate`)).status, 409);
  assert.equal((await s.req("POST", `/api/projects/${zh.json.id}/subtitle-file`)).status, 409);
  assert.equal((await s.req("PUT", `/api/projects/${zh.json.id}`, { body: { rev: zp.rev, lang_mode: "zh" } })).status, 200);
  assert.equal(readProject(zp.folder).lang_mode, undefined);
});

test("a local foreign-language video is recognised in its language and translated; bad languages are refused", async (t) => {
  const s = await startYt(t);
  assert.equal((await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", lang: "english" } })).status, 400);
  const r = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", lang: "ja" } });
  assert.equal(r.status, 200, r.raw);
  const p = await s.waitFor(r.json.id, (x) => x.status === "ready" && x.translate?.status === "done" && !x.job);
  assert.equal(s.calls.prepareOpts.lang, "ja");
  assert.equal(s.y.translate[0].lang, "ja");
  assert.equal(p.lang, "ja");
  assert.ok(p.cues.every((c) => c.tr.startsWith("譯1:")));
  assert.equal(p.source, null);
});

test("clearing a downloaded video can trash the download too, and never touches other videos", async (t) => {
  const s = await startYt(t);
  const imp = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  const p = await s.waitFor(imp.project, (x) => x.translate?.status === "done" && !x.job);
  const r = await s.req("POST", `/api/projects/${imp.project}/clear`, { body: { trashVideo: true } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.video_trashed, true);
  assert.deepEqual(s.y.trashed.map((f) => path.basename(f)), [path.basename(p.folder), path.basename(p.video)]);
  // 本機影片（不是下載的）：就算帶了 trashVideo 也不動原片；放在下載資料夾裡、但不是工作室下載的也一樣
  for (const video of [s.video, path.join(s.dl, "my own.mp4")]) {
    if (!fs.existsSync(video)) fs.writeFileSync(video, "mine");
    const zh = await s.req("POST", "/api/open", { body: { video, privacy: "public" } });
    await s.waitFor(zh.json.id, (x) => x.status === "ready");
    const r2 = await s.req("POST", `/api/projects/${zh.json.id}/clear`, { body: { trashVideo: true } });
    assert.equal(r2.json.video_trashed, undefined);
    assert.ok(fs.existsSync(video), `原片還在：${path.basename(video)}`);
  }
  // 下載的專案，但影片被搬到別的資料夾：不動
  const moved = await s.waitImport((await s.req("POST", "/api/import", { body: { url: `https://youtu.be/${YT}` } })).json.import, (x) => x.status !== "running");
  const mp = await s.waitFor(moved.project, (x) => x.translate?.status === "done" && !x.job);
  const pj = readProject(mp.folder);
  const elsewhere = path.join(s.dir, "elsewhere.mp4");
  fs.copyFileSync(pj.video, elsewhere);
  pj.video = elsewhere;
  writeProject(mp.folder, pj);
  const r3 = await s.req("POST", `/api/projects/${moved.project}/clear`, { body: { trashVideo: true } });
  assert.equal(r3.json.video_trashed, undefined);
  assert.ok(fs.existsSync(elsewhere), "下載資料夾以外的檔不丟");
});

test("installing yt-dlp while the studio runs is picked up without a restart", async (t) => {
  let have = false;
  const s = await startStudio(t, { deps: { hasYtDlp: () => have } });
  assert.equal((await s.req("GET", "/api/home")).json.tools.ytdlp, false);
  assert.equal((await s.req("POST", "/api/import", { body: { url: "https://youtu.be/abcdefghijk" } })).status, 409);
  have = true;
  assert.equal((await s.req("GET", "/api/home")).json.tools.ytdlp, true);
});

// 辨識與校對可以停止（#67）：假的 prepareSubtitles 和真的一樣，收到停止就丟 cancelled
function stoppablePrepare(seen) {
  return (o, { onStep, signal }) => new Promise((resolve, reject) => {
    seen.push(o);
    onStep("proofread");
    if (seen.release) return resolve(seen.release());
    signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { cancelled: true, report: { steps: { asr_s: 1 } } })));
  });
}

test("stopping recognition marks the project stopped, not failed, and it can start again (#67)", async (t) => {
  const seen = [];
  const errors = t.mock.method(console, "error", () => {});
  const s = await startStudio(t, { deps: { prepareSubtitles: stoppablePrepare(seen) } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  await s.waitFor(id, (x) => x.job?.kind === "prepare" && x.job.step === "proofread");
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 200);
  const p = await s.waitFor(id, (x) => x.status !== "processing");
  assert.equal(p.status, "cancelled");
  assert.equal(p.error, "");
  assert.equal(p.stopped_at, "proofread", "記下停在哪一步");
  assert.equal(p.job, null);
  assert.ok(!errors.mock.calls.some((c) => /processing failed/.test(String(c.arguments[0]))), "自己停的不寫錯誤 log");
  assert.equal((await s.req("POST", `/api/projects/${id}/cancel`)).status, 409, "沒有在跑就沒有東西可停");

  seen.release = () => ({ cues: cues(), applied: [], rejected: [], description: "簡介", chapters: [], timing: [], report: {} });
  assert.equal((await s.req("POST", `/api/projects/${id}/retry`)).status, 200, "停止過的可以重新開始");
  const ready = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(ready.stopped_at, "");
  assert.equal(seen.length, 2);
});

test("stopping a reprocess keeps the subtitles that were there (#67)", async (t) => {
  const seen = [];
  const s = await startStudio(t, { deps: { prepareSubtitles: stoppablePrepare(seen) } });
  seen.release = () => ({ cues: cues(), applied: [], rejected: [], description: "簡介", chapters: [], timing: [], report: {} });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const before = await s.waitFor(id, (x) => x.status === "ready");
  delete seen.release;
  assert.equal((await s.req("POST", `/api/projects/${id}/reprocess`)).status, 200);
  await s.waitFor(id, (x) => x.job?.kind === "prepare");
  await s.req("POST", `/api/projects/${id}/cancel`);
  const after = await s.waitFor(id, (x) => x.status !== "processing");
  assert.equal(after.status, "ready", "原本的字幕還在，回到可以編輯");
  assert.deepEqual(after.cues, before.cues);
  assert.equal(after.rev, before.rev, "什麼都沒換掉");
});

// ---- Discord 分軌（#129）：開始處理前加分軌、補回沒錄到的聲音、標講者 ----
function craigZipIn(dir, { name = "craig-test.aac.zip", start = new Date().toISOString() } = {}) {
  const src = fs.mkdtempSync(path.join(dir, "zsrc-"));
  fs.writeFileSync(path.join(src, "info.txt"), `Recording X\n\nStart time:\t${start}\n\nTracks:\n\talice#0 (1111111111111111111)\n\t.bob#0 (2222222222222222222)\n`);
  for (const n of ["1-alice.aac", "2-_bob.aac"]) fs.writeFileSync(path.join(src, n), "x");
  const zip = path.join(dir, name);
  assert.equal(spawnSync("zip", ["-q", "-j", zip, ...["info.txt", "1-alice.aac", "2-_bob.aac"].map((n) => path.join(src, n))]).status, 0);
  fs.rmSync(src, { recursive: true, force: true });
  return zip;
}

// 3 分鐘：alice 隨機講，0–1 秒、3–4 秒也是她；bob 在 1.2–2 秒和 60–70 秒講，但影片裡沒有他的聲音
function craigEnvs(seed = 1) {
  let x = seed >>> 0;
  const rnd = () => { x = (x + 0x6d2b79f5) >>> 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = 18_000, alice = new Float32Array(n), bob = new Float32Array(n);
  for (let i = 500; i < n; i += 20) if (rnd() < 0.45) for (let q = i; q < i + 20; q++) alice[q] = 1e5 + rnd() * 5e6;
  const span = (a, s, e, v) => { for (let i = s; i < e; i++) a[i] = v; };
  span(alice, 0, 100, 2e6); span(alice, 100, 300, 0); span(alice, 300, 400, 2e6); span(alice, 6000, 7000, 0);
  span(bob, 120, 200, 2e6); span(bob, 6000, 7000, 2e6);
  const video = Float32Array.from(alice, (v) => v + 100);
  const filled = Float32Array.from(video, (v, i) => v + bob[i]);
  return { alice, bob, video, filled };
}

function craigDeps(s0, e, calls) {
  return {
    craigDirs: () => [s0],
    async envelopeOf(file) {
      const b = path.basename(file);
      if (b === "1-alice.aac") return e.alice;
      if (b === "2-_bob.aac") return e.bob;
      return b.includes("補音") ? e.filled : e.video;
    },
    async fillVoices(args) {
      calls.push(["fill", args]);
      fs.writeFileSync(args[args.length - 1], "filled-video");
    },
  };
}

test("Discord tracks: preview finds the zip, processing fills the missing voice and labels speakers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const e = craigEnvs(), order = [];
  const zip = craigZipIn(dir);
  craigZipIn(dir, { name: "craig-old.aac.zip", start: "2020-01-01T00:00:00Z" });   // 別場：時間對不上
  const s = await startStudio(t, { dir, deps: { ...craigDeps(dir, e, order),
    async prepareSubtitles(o, { onStep }) { order.push(["asr", o.video]); onStep("asr"); return { cues: cues(), applied: [], rejected: [], description: "簡介", chapters: [], timing: [], report: {} }; } } });

  const pv = await s.req("POST", "/api/preview", { body: { video: s.video } });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.craig.file, "craig-test.aac.zip", "挑時間對得上的那個");
  assert.deepEqual(pv.json.craig.tracks.map((x) => x.user), ["alice", ".bob"]);
  assert.ok(!pv.raw.includes("1111111111"), "不給頁面 Discord ID");

  const bad = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", tracks: { zip: path.join(dir, "nope.zip") } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /找不到這個 zip/);

  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", tracks: { zip, fill: true, names: { alice: "愛麗絲", ".bob": "鮑伯", mallory: "不在這場" } } } });
  assert.equal(open.status, 200);
  const p = await s.waitFor(open.json.id, (x) => x.status === "ready");
  assert.deepEqual(order.map((x) => x[0]), ["fill", "asr"], "先補聲音再辨識");
  const fillArgs = order[0][1];
  assert.ok(fillArgs.some((a) => /2-_bob\.aac$/.test(a)) && !fillArgs.some((a) => /1-alice\.aac$/.test(a)), "只補沒錄到的 bob");
  const patched = path.join(fs.realpathSync(dir), "v-字幕", "v-補音.mp4");
  assert.equal(order[1][1], patched, "辨識用補好的那支");
  assert.equal(p.video, patched);
  assert.equal(p.video_original, fs.realpathSync(s.video));
  assert.deepEqual(p.tracks.filled, ["鮑伯"]);
  assert.deepEqual(p.cues.map((c) => c.text), ["【愛麗絲】今天我們來談", "【鮑伯】Claude Code", "【愛麗絲】怎麼用"]);
  assert.deepEqual(p.speakers.missing, [], "補過了就不算漏錄");
  assert.deepEqual(p.speakers.tracks, [{ user: "alice", name: "愛麗絲" }, { user: ".bob", name: "鮑伯" }]);
  assert.match(fs.readFileSync(path.join(dir, "v-字幕", "subtitles.srt"), "utf8"), /【鮑伯】Claude Code/);
  const names = JSON.parse(fs.readFileSync(path.join(dir, "state", "speakers.json"), "utf8")).names;
  assert.deepEqual(names, { alice: "愛麗絲", ".bob": "鮑伯" }, "記下這場有的帳號，別場的不收");
  // 名冊的「最近出現」記的是 Craig 開始錄的那天（本機日期，#132；測試的 zip 是現在開始錄的）
  const met = new Date();
  const metDay = `${met.getFullYear()}-${String(met.getMonth() + 1).padStart(2, "0")}-${String(met.getDate()).padStart(2, "0")}`;
  assert.deepEqual((await s.req("GET", "/api/speakers")).json.people.map((x) => [x.user, x.seen]), [[".bob", metDay], ["alice", metDay]]);
  assert.ok(!fs.readFileSync(path.join(dir, "v-字幕", "project.json"), "utf8").includes("1111111111"), "專案裡沒有 Discord ID");

  // 編輯頁：改名字重標；rev 不對就擋
  const id = open.json.id;
  const g = await s.req("GET", `/api/projects/${id}/speakers`);
  assert.equal(g.json.craig.file, "craig-test.aac.zip");
  assert.deepEqual(g.json.craig.tracks.map((x) => x.name), ["愛麗絲", "鮑伯"]);
  assert.equal((await s.req("POST", `/api/projects/${id}/speakers`, { body: { zip, names: { ".bob": "Bob" }, rev: p.rev - 1 } })).status, 409);
  const r = await s.req("POST", `/api/projects/${id}/speakers`, { body: { zip, names: { ".bob": "Bob" }, rev: p.rev } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.counts, { 愛麗絲: 2, Bob: 1 });
  assert.deepEqual(r.json.missing, []);
  const p2 = await s.waitFor(id, (x) => x.rev === r.json.rev);
  assert.deepEqual(p2.cues.map((c) => c.text), ["【愛麗絲】今天我們來談", "【Bob】Claude Code", "【愛麗絲】怎麼用"], "舊標籤換掉，不疊兩層");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state", "speakers.json"), "utf8")).names[".bob"], "Bob");
});

test("speaker roster API (#132): list, add before a meeting, rename, refuse bad input, remove", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const s = await startStudio(t, { dir });
  assert.deepEqual((await s.req("GET", "/api/speakers")).json, { people: [] });
  const add = await s.req("POST", "/api/speakers", { body: { user: "dave", name: "大衛" } });
  assert.equal(add.status, 200);
  assert.deepEqual(add.json.people, [{ user: "dave", name: "大衛", seen: "" }]);
  assert.equal((await s.req("POST", "/api/speakers", { body: { user: "dave", name: "Dave" } })).json.people[0].name, "Dave");
  const empty = await s.req("POST", "/api/speakers", { body: { user: "eve", name: " " } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /名字要填/);
  assert.equal((await s.req("POST", "/api/speakers", { body: { name: "x" } })).status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state", "speakers.json"), "utf8")).names, { dave: "Dave" });
  assert.equal((await s.req("POST", "/api/speakers/remove", { body: { user: "nobody" } })).status, 404);
  assert.deepEqual((await s.req("POST", "/api/speakers/remove", { body: { user: "dave" } })).json, { people: [] });
});

test("Discord tracks: a zip from another meeting does not block subtitles, it just skips the labels", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const e = craigEnvs(), other = craigEnvs(99), order = [];
  const zip = craigZipIn(dir);
  const deps = craigDeps(dir, e, order);
  const s = await startStudio(t, { dir, deps: { ...deps, envelopeOf: async (f) => (f.endsWith(".aac") ? deps.envelopeOf(f) : other.video) } });
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", tracks: { zip, fill: true, names: {} } } });
  const p = await s.waitFor(open.json.id, (x) => x.status === "ready");
  assert.deepEqual(order, [], "沒有補聲音");
  assert.match(p.tracks.error, /對不起來/);
  assert.equal(p.speakers, null);
  assert.equal(p.video_original, "");
  assert.deepEqual(p.cues.map((c) => c.text), cues().map((c) => c.text), "字幕照樣做好、沒有標籤");
  const r = await s.req("POST", `/api/projects/${open.json.id}/speakers`, { body: { zip, names: {}, rev: p.rev } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /對不起來/);
});

test("Discord tracks page: found zip fills the table and is sent with start; the speakers panel posts the zip and rev", async () => {
  const vm = await import("node:vm");
  const { doc, stub, $ } = fakePage();
  const calls = [];
  const replies = {
    "POST /api/projects/0123456789abcdef/speakers": { rev: 9, counts: { 愛麗絲: 2, 鮑伯: 0 }, unlabeled: 0, missing: ["鮑伯"] },
    "PUT /api/projects/0123456789abcdef": { rev: 8, updated: new Date().toISOString() },
    "POST /api/speakers": { people: [{ user: "dave", name: "大衛", seen: "" }, { user: "<x>", name: "", seen: "2026-10-30" }] },
  };
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    if (!replies[key]) return new Promise(() => {});
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => replies[key] };
  };
  const ctx = vm.createContext({ document: doc, location: { hash: "" }, history: stub, fetch, setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, AbortController, URL, URLSearchParams, TextEncoder,
    console, ResizeObserver: stub, Image: stub, navigator: stub, matchMedia: stub, getComputedStyle: stub,
    ops, cutOps: await import("../lib/cuts.mjs"), shortOps: await import("../lib/shorts.mjs") });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  for (const x of pageScripts().slice(1)) {
    new vm.Script(fs.readFileSync(new URL(`../web${x.src}`, import.meta.url), "utf8"), { filename: x.src }).runInContext(ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  const craig = { zip: "/Users/x/Downloads/craig-a.zip", file: "craig-a.zip", start: Date.parse("2026-10-30T13:00:49Z"), tracks: [{ user: "alice", name: "愛麗絲" }, { user: "<b>", name: "" }] };
  run(`trkShow(${JSON.stringify(craig)})`);
  assert.equal($("#trkBody").hidden, false);
  assert.match($("#trkFound").textContent, /craig-a\.zip.*2 個人/);
  assert.match($("#trkRows").innerHTML, /value="愛麗絲"/);
  assert.match($("#trkRows").innerHTML, /&lt;b&gt;/, "帳號名稱要跳脫");
  // 認得的人收成一行，新帳號照樣列出來填（#132）
  assert.equal($("#trkKnown").hidden, false);
  assert.match($("#trkKnown").innerHTML, /認得 1 位：<\/span><span class="spk-chip">愛麗絲<\/span><span>新來的 1 位請在下面填名字<\/span><button[^>]*class="btn sm spk-edit">修改名字/);
  assert.match($("#trkRows").innerHTML, /<tr data-known><td>alice/);
  assert.match($("#trkRows").innerHTML, /<tr><td>&lt;b&gt;/);
  run(`trkShow(${JSON.stringify({ ...craig, tracks: [{ user: "<i>", name: "" }] })})`);
  assert.equal($("#trkKnown").hidden, true, "全部是新帳號就不多一行摘要");
  run(`trkShow(${JSON.stringify(craig)})`);
  $("#trkFill").checked = false;
  assert.deepEqual(JSON.parse(run("JSON.stringify(trkPayload())")), { zip: craig.zip, names: {}, fill: false });
  run("trkShow(null)");
  assert.equal(run("trkPayload()"), undefined, "不用分軌就不帶");
  assert.equal($("#trkBody").hidden, true);

  run(`state.id = "0123456789abcdef"; state.rev = 8; state.p = { rev: 8, speakers: null }; spkSet(${JSON.stringify(craig)})`);
  assert.equal($("#spkApply").disabled, false);
  assert.equal($("#spkApply").textContent, "標上講者");
  run("$('#spkApply').onclick()");   // 送出後會重新載入專案（假伺服器不回），所以不等它做完
  for (let i = 0; i < 50 && !calls.some((c) => c.key.endsWith("/speakers")); i++) await new Promise((r) => setImmediate(r));
  const post = calls.find((c) => c.key === "POST /api/projects/0123456789abcdef/speakers");
  assert.ok(post, "送出標講者");
  assert.equal(post.body.zip, craig.zip);
  assert.equal(post.body.rev, 8);

  // 設定裡的名冊（#132）：加新成員送帳號和名字，表格列出名字、出現日期，帳號要跳脫
  $("#rosterUser").value = " dave ";
  $("#rosterName").value = "大衛";
  await run("$('#rosterAdd').onclick()");
  assert.deepEqual(calls.find((c) => c.key === "POST /api/speakers").body, { user: "dave", name: "大衛" });
  assert.equal($("#rosterUser").value, "", "加好就清空");
  assert.equal($("#rosterTable").hidden, false);
  assert.equal($("#rosterEmpty").hidden, true);
  assert.match($("#rosterRows").innerHTML, /<td>dave<\/td>[\s\S]*value="大衛"[\s\S]*<td>—<\/td>/);
  assert.match($("#rosterRows").innerHTML, /&lt;x&gt;[\s\S]*還沒取名[\s\S]*<td>10\/30<\/td>/);
  assert.match($("#rosterNote").textContent, /已經把 dave 加進名冊/);
});

test("Discord tracks: with a filled-in copy, clearing moves outputs next to the original and trashes the original recording (#129)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trash-"));
  t.after(() => fs.rmSync(trashDir, { recursive: true, force: true }));
  const e = craigEnvs(), order = [], trashed = [];
  const zip = craigZipIn(dir);
  const { s } = await connectedStudio(t, { dir, deps: { ...craigDeps(dir, e, order), async trash(f) {
    trashed.push(path.basename(f));
    fs.renameSync(f, path.join(trashDir, `${trashed.length}-${path.basename(f)}`));
  } } });
  const original = fs.readFileSync(s.video);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", tracks: { zip, fill: true, names: {} } } })).json.id;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  assert.match(p.video, /v-補音\.mp4$/);
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "t", subtitles: "burned", alsoCc: false } });
  await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  const home = (await s.req("GET", "/api/home")).json.recent[0];
  assert.equal(home.original_bytes, original.length, "原始錄影的大小，不是補音版");
  const outs = home.outputs;
  assert.ok(outs.length, "有燒好的影片");
  const r = await s.req("POST", `/api/projects/${id}/clear`, { body: { trashOriginal: true } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(trashed, ["v-字幕", "v.mp4"], "補音版跟著資料夾走，丟的是原始錄影");
  for (const f of outs) assert.ok(fs.existsSync(path.join(dir, f)), `${f} 搬到原始錄影旁邊`);
});

test("Discord tracks added after processing: labels now, and reprocessing fills the missing voice (#129)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-studio-"));
  const e = craigEnvs(), order = [];
  const zip = craigZipIn(dir);
  const s = await startStudio(t, { dir, deps: { ...craigDeps(dir, e, order),
    async prepareSubtitles(o, { onStep }) { order.push(["asr", o.video]); onStep("asr"); return { cues: cues(), applied: [], rejected: [], description: "簡介", chapters: [], timing: [], report: {} }; } } });
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public" } })).json.id;
  const p = await s.waitFor(id, (x) => x.status === "ready");
  assert.equal(p.tracks, null);
  const r = await s.req("POST", `/api/projects/${id}/speakers`, { body: { zip, names: { alice: "A", ".bob": "B" }, rev: p.rev } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json.missing, ["B"], "影片裡沒有 bob 的聲音：提醒");
  const p2 = await s.waitFor(id, (x) => x.rev === r.json.rev);
  assert.deepEqual(p2.cues.map((c) => c.text), ["【A】今天我們來談", "【B】Claude Code", "【A】怎麼用"]);
  assert.equal(p2.tracks.file, "craig-test.aac.zip", "分軌記進專案");
  order.length = 0;
  assert.equal((await s.req("POST", `/api/projects/${id}/reprocess`)).status, 200);
  const p3 = await s.waitFor(id, (x) => x.status === "ready" && x.rev > p2.rev);
  assert.deepEqual(order.map((x) => x[0]), ["fill", "asr"], "重新處理：先補聲音再辨識");
  assert.match(p3.video, /v-補音\.mp4$/);
  assert.deepEqual(p3.tracks.filled, ["B"]);
  assert.deepEqual(p3.speakers.missing, []);
  assert.deepEqual(p3.cues.map((c) => c.text), ["【A】今天我們來談", "【B】Claude Code", "【A】怎麼用"]);
});

// 用已經有的字幕檔（#148）：不送辨識、不做 AI 校對，走作者字幕的路（中文只轉台灣用語與標點，再寫說明欄）
test("start from an existing SRT/VTT: nearby files suggested, no recognition, bad files refused", async (t) => {
  const seen = { captions: [], preflight: [] };
  const s = await startStudio(t, { deps: {
    preflight(o) { seen.preflight.push(o); },
    async prepareFromCaptions(o, { cues: c, onStep }) {
      seen.captions.push({ o, cues: c });
      onStep("describe");
      return { cues: c, description: "我的簡介", chapters: [], applied: [], rejected: [], timing: null, report: { steps: {} } };
    },
    async pickSubtitles() { return path.join(s.dir, "picked.vtt"); },
  } });
  const srt = "\uFEFF1\r\n00:00:00,000 --> 00:00:01,500\r\n<i>大家好</i>\r\n\r\n2\r\n00:00:01,500 --> 00:00:03,000\r\n今天介紹 {\\an8}<font color=\"#fff\">字幕工作室</font>\r\n\r\n3\r\n00:00:03,000 --> 00:00:04,000\r\n當 x < 5 時輸入 <command>\r\n";
  fs.writeFileSync(path.join(s.dir, "v.srt"), srt);
  fs.writeFileSync(path.join(s.dir, "v.zh_TW.srt"), srt);
  fs.writeFileSync(path.join(s.dir, "other.srt"), srt);
  fs.writeFileSync(path.join(s.dir, "v.en.vtt"), "WEBVTT\n");
  const pv = (await s.req("POST", "/api/preview", { body: { video: s.video } })).json;
  assert.deepEqual(pv.subtitles.map((x) => x.name), ["v.srt", "v.zh_TW.srt", "v.en.vtt"], "只列同名的字幕檔；沒標語言的先、中文其次、其他語言最後");
  assert.equal(pv.subtitles[0].path, path.join(fs.realpathSync(s.dir), "v.srt"));

  const bad = async (body, re, why) => {
    const r = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", ...body } });
    assert.equal(r.status, 400, why);
    assert.match(r.json.error, re, why);
  };
  fs.writeFileSync(path.join(s.dir, "notes.txt"), srt);
  await bad({ subtitles: path.join(s.dir, "notes.txt") }, /SRT|VTT/, "只收 .srt／.vtt");
  await bad({ subtitles: path.join(s.dir, "nope.srt") }, /找不到/, "檔案不存在");
  fs.writeFileSync(path.join(s.dir, "empty.srt"), "1\nnot a cue\n");
  await bad({ subtitles: path.join(s.dir, "empty.srt") }, /讀不到/, "沒有任何一句");
  fs.writeFileSync(path.join(s.dir, "big.srt"), "x".repeat(2 * 1024 * 1024 + 1));
  await bad({ subtitles: path.join(s.dir, "big.srt") }, /2 MB/, "太大");
  fs.writeFileSync(path.join(s.dir, "big5.srt"), Buffer.concat([Buffer.from("1\n00:00:00,000 --> 00:00:01,000\n"), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from("\n")]));
  await bad({ subtitles: path.join(s.dir, "big5.srt") }, /UTF-8/, "Big5 讀成亂碼就說清楚");
  await bad({ subtitles: path.join(s.dir, "v.srt"), tracks: { zip: "/x.zip", names: {} } }, /分軌/, "字幕檔和 Discord 分軌不能一起用");
  assert.equal(s.calls.prepare, 0);

  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", subtitles: path.join(s.dir, "v.zh_TW.srt") } });
  assert.equal(open.status, 200, open.raw);
  const p = await s.waitFor(open.json.id, (x) => x.status === "ready");
  assert.equal(s.calls.prepare, 0, "不送辨識");
  assert.equal(seen.preflight.at(-1).engine, "none", "不需要 Soniox 金鑰");
  assert.deepEqual(seen.captions[0].cues.map((c) => c.text), ["大家好", "今天介紹 字幕工作室", "當 x < 5 時輸入 <command>"], "字幕檔的格式標記拿掉，本來的角括號留著；BOM 與 CRLF 讀得懂");
  assert.deepEqual(p.cues.map((c) => [c.start, c.end]), [[0, 1500], [1500, 3000], [3000, 4000]]);
  assert.equal(p.source.captions, "file");
  assert.equal(p.source.file_name, "v.zh_TW.srt");
  const folder = projectDirFor(fs.realpathSync(s.video));
  assert.equal(fs.readFileSync(path.join(folder, p.source.captions_file), "utf8"), srt.replace(/^\uFEFF/, ""), "字幕檔複製一份進專案");
  // 原檔搬走了，重新處理照樣用專案裡那份
  fs.rmSync(path.join(s.dir, "v.zh_TW.srt"));
  assert.equal((await s.req("POST", `/api/projects/${open.json.id}/reprocess`, { body: {} })).status, 200);
  const again = await s.waitFor(open.json.id, (x) => x.status === "ready" && seen.captions.length === 2);
  assert.deepEqual(again.cues.map((c) => c.text), ["大家好", "今天介紹 字幕工作室", "當 x < 5 時輸入 <command>"], "重新處理讀專案裡的副本");
  assert.equal(s.calls.prepare, 0, "重新處理也不送辨識");
  assert.equal(seen.preflight.at(-1).engine, "none", "重新處理也不需要 Soniox 金鑰");
  assert.equal(fs.readFileSync(path.join(folder, "youtube-description.md"), "utf8"), "我的簡介");

  await bad({ subtitles: path.join(s.dir, "v.srt") }, /整理/, "做過字幕的影片不換字幕來源");

  // VTT 也可以；選檔窗只挑字幕檔
  const v2 = path.join(s.dir, "w.mp4");
  fs.writeFileSync(v2, Buffer.from("0123456789abcdef"));
  fs.writeFileSync(path.join(s.dir, "picked.vtt"), "WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n");
  const picked = (await s.req("POST", "/api/pick-subtitles")).json;
  assert.equal(picked.path, path.join(s.dir, "picked.vtt"));
  const o2 = await s.req("POST", "/api/open", { body: { video: v2, privacy: "public", subtitles: picked.path } });
  const p2 = await s.waitFor(o2.json.id, (x) => x.status === "ready");
  assert.deepEqual(p2.cues.map((c) => c.text), ["Hello"]);
});

// ---- 不要字幕（recording-transcriber#158）：demo 影片直接上傳，不辨識、不校對、不掛 CC ----
test("no subtitles (#158): ready at once, nothing recognized, conflicting options refused", async (t) => {
  const seen = { preflight: [] };
  const { s } = await connectedStudio(t, { deps: { preflight(o) { seen.preflight.push(o); } } });
  const bad = async (body, re, why) => {
    const r = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", noSubtitles: true, ...body } });
    assert.equal(r.status, 400, why);
    assert.match(r.json.error, re, why);
  };
  await bad({ tracks: { zip: "/x.zip", names: {} } }, /分軌/, "沒有字幕就沒有講者可標");
  await bad({ subtitles: path.join(s.dir, "v.srt") }, /不能同時/, "不要字幕和字幕檔二選一");
  assert.equal(s.calls.prepare, 0);
  const open = await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", noSubtitles: true } });
  assert.equal(open.status, 200, open.raw);
  const p = (await s.req("GET", `/api/projects/${open.json.id}`)).json;
  assert.equal(p.status, "ready", "不用等處理");
  assert.deepEqual(p.cues, []);
  assert.equal(p.source.captions, "none");
  assert.equal(s.calls.prepare, 0, "不送辨識");
  assert.equal(seen.preflight.at(-1).engine, "none", "不需要 Soniox 金鑰");
  // 沒有字幕可處理的動作都擋下來
  for (const action of ["reprocess", "retry", "describe", "relayout"]) {
    assert.equal((await s.req("POST", `/api/projects/${open.json.id}/${action}`, { body: {} })).status, 409, `${action} 沒有字幕可做`);
  }
  assert.equal((await s.req("POST", `/api/projects/${open.json.id}/burn`, { body: {} })).status, 409, "沒有字幕可燒");
  assert.equal((await s.req("POST", `/api/projects/${open.json.id}/suggest`, { body: {} })).status, 409, "沒有逐字稿，AI 剪輯建議做不了");
  assert.equal((await s.req("POST", `/api/projects/${open.json.id}/suggest`, { body: { ai: false } })).status, 200, "本機靜音與黑畫面偵測不需要字幕");
});

test("no subtitles (#158): upload sends the original, never captions; with cuts only a cut export", async (t) => {
  const { s, g } = await connectedStudio(t);
  const id = (await s.req("POST", "/api/open", { body: { video: s.video, privacy: "public", noSubtitles: true } })).json.id;
  // 就算頁面或頻道預設要 CC／燒字幕，沒有字幕的專案一律不掛、不燒
  const r = await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "demo", privacy: "private", subtitles: "burned", alsoCc: true } });
  assert.equal(r.status, 200, r.raw);
  let p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done");
  assert.equal(s.calls.burn, 0, "沒有剪輯：原片直接上傳，不輸出");
  assert.deepEqual(Buffer.concat(g.received), fs.readFileSync(s.video));
  assert.equal(g.captions.length, 0, "不掛 CC 字幕");
  assert.equal(p.youtube.subtitles, "none");
  assert.equal(p.youtube.url, "https://youtu.be/VID123");
  assert.equal(g.meta.snippet.description, "", "沒給說明欄就是空的，不去寫");
  // 不用補 CC：首頁不提示，補 CC 的路擋掉
  const recent = (await s.req("GET", "/api/home")).json.recent.find((x) => x.id === id);
  assert.equal(recent.youtube.needs_cc, false);
  assert.equal((await s.req("POST", `/api/projects/${id}/captions`)).status, 409);
  assert.equal(needsCc({ video_id: "x", status: "cancelled", subtitles: "none" }), false, "停在半路的無字幕上傳也不用補 CC");
  assert.equal(needsCc({ video_id: "x", status: "cancelled", subtitles: "cc" }), true, "有字幕的照舊");
  // 有剪輯：先輸出不燒字幕的剪接版再傳，一樣不掛字幕
  await s.req("PUT", `/api/projects/${id}`, { body: { rev: p.rev, cuts: [{ start: 1100, end: 2100, by: "user" }] } });
  await s.req("POST", `/api/projects/${id}/youtube`, { body: { channel: "UC123", title: "demo", subtitles: "cc" } });
  p = await s.waitFor(id, (x) => !x.job && x.youtube?.status === "done" && x.youtube.cuts !== undefined && x.outputs?.cut);
  assert.equal(s.calls.burn, 1);
  assert.equal(s.calls.subtitles, false, "只剪接，不燒字幕");
  assert.equal(p.outputs.cut.file, "v-剪輯.mp4");
  assert.equal(g.captions.length, 0);
});

test("the Studio page has no inline script or inline handler, so script-src can stay 'self' (#163)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = ["web/studio.html", ...fs.readdirSync(path.join(root, "web", "studio")).filter((f) => f.endsWith(".js")).map((f) => `web/studio/${f}`)];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    if (f.endsWith(".html") && /<script(?![^>]*\ssrc=)[^>]*>/i.test(text)) hits.push(`${f}: inline <script>`);
    if (/\son[a-z]+\s*=\s*["'`]/i.test(text)) hits.push(`${f}: inline event handler`);
    if (/javascript:/i.test(text)) hits.push(`${f}: javascript: URL`);
  }
  assert.deepEqual(hits, []);
});
