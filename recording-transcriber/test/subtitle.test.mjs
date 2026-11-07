// 影片字幕流程
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyEdits, buildCues, charsFromSoniox, charsFromWhisper, chunkText, diffOps, fullWidthPunct, isPureDeletion, realign, realignBySegment, textOf, toSrt } from "../lib/subtitle-text.mjs";
import { asrTerms, cleanSuggestion, descriptionText, loadCorrections, snapChapters, verbatimFix } from "../lib/subtitle-ai.mjs";
import { transcribeFile } from "../lib/soniox-async.mjs";
import { addResultUsage, agentEnv, newUsage, openClaude } from "../lib/claude-stream.mjs";
import { parseArgs as cliArgs, cloudDirs, inCloudFolder, realDir } from "../scripts/subtitle-cli.mjs";
import { burnStyle, parseArgs as runArgs, prepareFromCaptions, prepareSubtitles, runSubtitle } from "../scripts/subtitle-run.mjs";
import { addCorrection, syncCorrections } from "../lib/corrections-sync.mjs";
import http from "node:http";
import { MAY_USE_CHINA_CLOUD_LLM, PRESETS, checkProofreader, codexDisableArgs, PROOFREADERS } from "../lib/proofreaders.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Soniox 補刪清單不碰真的狀態檔（#64）
process.env.CYCLONE_SONIOX_LEFTOVERS ||= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-left-")), "leftovers.json");

test("diffOps rebuilds the target for edits, inserts and deletes", () => {
  for (const [a, b] of [["abcdef", "abXdef"], ["", "abc"], ["abc", ""], ["隻有你", "只有你"], ["Code x聊", "Codex聊"], ["同一句", "同一句"]]) {
    let out = "";
    for (const [k, , , b1, b2] of diffOps([...a], [...b])) out += [...b].slice(b1, b2).join("");
    assert.equal(out, b);
  }
});

// ---- 長影片（recording-transcriber#28）----
// diffOps 的結果要能拼回兩邊：區段連續、涵蓋全部，標成相同的真的相同
function checkOps(ops, a, b) {
  let ai = 0, bi = 0;
  for (const [k, a1, a2, b1, b2] of ops) {
    assert.deepEqual([a1, b1], [ai, bi], "區段要連續");
    if (k === "equal") assert.deepEqual(a.slice(a1, a2), b.slice(b1, b2));
    ai = a2; bi = b2;
  }
  assert.deepEqual([ai, bi], [a.length, b.length], "要涵蓋兩邊全部");
}
const sameCount = (ops) => ops.reduce((n, [k, a1, a2]) => n + (k === "equal" ? a2 - a1 : 0), 0);

test("diffOps on a long transcript with many replaced characters stays fast and small", () => {
  const n = 30_000;   // 約 90 分鐘的中文逐字稿
  const a = Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 3000)));
  const changed = (i) => ((i * 2654435761) % 1000) < 400;   // 四成的字被換掉，像簡轉繁
  const b = a.map((c, i) => (changed(i) ? String.fromCharCode(0x9000 + (i % 500)) : c));
  const t0 = Date.now(), h0 = process.memoryUsage().heapUsed;
  const ops = diffOps(a, b);
  const ms = Date.now() - t0, grewMB = (process.memoryUsage().heapUsed - h0) / 1e6;
  checkOps(ops, a, b);
  assert.equal(sameCount(ops), a.filter((_, i) => !changed(i)).length, "沒換掉的字全部對上");
  assert.ok(ms < 20_000, `${ms} ms`);
  assert.ok(grewMB < 1000, `heap 多用了 ${Math.round(grewMB)} MB（整份做會到幾十 GB）`);
});

test("diffOps in windows still lines up inserts, deletes and long runs", () => {
  const rand = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const r = rand(7);
  const a = Array.from({ length: 5000 }, () => "甲乙丙丁戊己庚辛"[Math.floor(r() * 8)]);
  const b = [];
  for (const c of a) {
    const x = r();
    if (x < 0.05) continue;                         // 刪掉
    if (x < 0.10) { b.push("新", c); continue; }     // 前面插一個字
    b.push(x < 0.2 ? "改" : c);                     // 換掉
  }
  for (const win of [40, 300, 1000]) {
    const ops = diffOps(a, b, { win, maxD: 0 });   // maxD 0：強迫走分段
    checkOps(ops, a, b);
    assert.ok(sameCount(ops) >= 0.8 * sameCount(diffOps(a, b, { maxD: Infinity })), `視窗 ${win}：對上的字不能比整份做少太多`);
  }
  // 換成 Int32Array 之後，結果和原本的 Map 版一模一樣（拿舊版跑出來的值）
  assert.deepEqual(diffOps([..."今天天氣"], [..."今日天氣"]), [["equal", 0, 1, 0, 1], ["change", 1, 1, 1, 2], ["equal", 1, 2, 2, 3], ["change", 2, 3, 3, 3], ["equal", 3, 4, 3, 4]]);
  assert.deepEqual(diffOps([..."甲乙丙丁戊"], [..."甲丙丁己戊庚"]), [["equal", 0, 1, 0, 1], ["change", 1, 2, 1, 1], ["equal", 2, 4, 1, 3], ["change", 4, 4, 3, 4], ["equal", 4, 5, 4, 5], ["change", 5, 5, 5, 6]]);
  checkOps(diffOps([..."abc"], [...""], { win: 1, maxD: 0 }), [..."abc"], []);
  checkOps(diffOps([..."x".repeat(10)], [..."y".repeat(3000)], { win: 100, maxD: 0 }), [..."x".repeat(10)], [..."y".repeat(3000)]);
});

// #30：#29 的分段對齊遇到「幾乎一樣、只有零星修改」（校對後）會整塊 500 字平均分時間，字幕跟聲音脫軌
const irregular = (n, seed = 5) => {
  let clock = 0;
  const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, () => { const s = clock + Math.floor(r() * 120); const e = s + 80 + Math.floor(r() * 200); clock = e; return { c: String.fromCharCode(0x4e00 + Math.floor(r() * 3000)), s, e, spk: null }; });
};

test("a few scattered proofreading edits leave every other character on its own time", () => {
  const chars = irregular(8000);
  const b = chars.map((x) => x.c);
  for (const p of [400, 1300, 2290, 3333, 5100, 7777]) b[p] = "改";
  const stats = {};
  const out = realign(chars, b.join(""), stats);
  assert.equal(out.length, chars.length);
  assert.deepEqual(out.map((x) => [x.s, x.e]), chars.map((x) => [x.s, x.e]), "一字換一字：每個字都用自己原本的時間");
  assert.deepEqual(stats, {}, "整份精確對齊，沒有走分段");
  // 就算強迫分段，沒改的字也要全部對上（#29 在這裡會把整塊 500 字當成改掉）
  const ops = diffOps(chars.map((x) => x.c), b, { maxD: 0 });
  checkOps(ops, chars.map((x) => x.c), b);
  assert.equal(sameCount(ops), chars.length - 6);
});

test("Taiwan conversion is aligned sentence by sentence, so every character keeps its own time", async () => {
  const imported = await import("opencc-js");
  const conv = (imported.default || imported).Converter({ from: "cn", to: "twp" });
  const text = "我们今天来讲软件，这个软件很好用。老师说，鼠标要这样拿！然后打开文件夹，看一下里面的内容。";
  let clock = 0;
  const chars = [...text].map((c, i) => { const s = clock + (i % 3) * 37; const e = s + 90 + (i % 5) * 41; clock = e; return { c, s, e, spk: null }; });
  const out = realignBySegment(chars, conv);
  assert.equal(textOf(out), conv(text));
  for (let i = 1; i < out.length; i++) assert.ok(out[i].s >= out[i - 1].s, "時間不會倒退");
  const sameLen = [...conv(text)].length === chars.length;
  if (sameLen) assert.deepEqual(out.map((x) => x.s), chars.map((x) => x.s), "一字換一字的轉換：時間完全不動");
  const many = Array.from({ length: 60 }, () => chars).flat().map((x, i) => ({ ...x, s: x.s + i * 1000, e: x.e + i * 1000 }));
  const t0 = Date.now();
  assert.equal(realignBySegment(many, conv).length, [...conv(textOf(many))].length);
  assert.ok(Date.now() - t0 < 5000);
});

test("a failure after recognition keeps the result, so a retry does not pay Soniox again", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-cache-"));
  const video = path.join(dir, "v.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const soniox = fakeSoniox();
  let silent = false;   // true：Soniox 什麼都沒辨識到
  t.mock.method(globalThis, "fetch", async (url, opts = {}) => {
    if (!String(url).startsWith("https://api.soniox.com")) return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) };
    const r = await soniox.fetchImpl(String(url), { method: "GET", ...opts });
    return silent && String(url).endsWith("/transcript") ? { ...r, text: async () => JSON.stringify({ tokens: [] }) } : r;
  });
  const saved = { ...process.env };
  Object.assign(process.env, { SONIOX_API_KEY: "k", CYCLONE_CLAUDE_BIN: path.join(dir, "no-claude"), CYCLONE_MEETING_SCRIBE_URL: "http://127.0.0.1:9" });
  t.after(() => { for (const k of ["SONIOX_API_KEY", "CYCLONE_CLAUDE_BIN", "CYCLONE_MEETING_SCRIBE_URL"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(dir, { recursive: true, force: true }); });
  const cache = path.join(dir, "asr-cache.json");
  const uploads = () => soniox.calls.filter((c) => c === "POST /v1/files").length;
  const prepare = (keep) => prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], asrCache: cache, keep, durationMs: 3000 },
    { work: fs.mkdtempSync(path.join(dir, ".work-")) });
  await assert.rejects(prepare(), "沒有 Claude，校對那一步出錯（模擬辨識之後才當掉）");
  assert.equal(uploads(), 1);
  assert.ok(fs.existsSync(cache), "辨識結果先存下來");
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).chars, [["好", 0, 500, null]]);
  assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).keep, null, "整支辨識過");
  await assert.rejects(prepare());
  assert.equal(uploads(), 1, "重試直接用存下來的，不再送 Soniox");
  await assert.rejects(prepare([[0, 1500]]));
  assert.equal(uploads(), 1, "剪得更短：用存著的，只留範圍裡的字（#30）");
  fs.rmSync(cache);
  await assert.rejects(prepare([[0, 1500]]));
  assert.equal(uploads(), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).keep, [[0, 1500]]);
  await assert.rejects(prepare());
  assert.equal(uploads(), 3, "要的範圍比上次辨識過的大，就重新辨識");

  // 存不了快取（資料夾不存在）：照樣往下做，錯誤是後面校對的，不是存檔的
  const nowhere = path.join(dir, "gone", "asr-cache.json");
  const e = await prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], asrCache: nowhere, durationMs: 3000 },
    { work: fs.mkdtempSync(path.join(dir, ".work-")) }).catch((x) => x);
  assert.doesNotMatch(String(e?.message), /ENOENT.*asr-cache/);
  assert.equal(uploads(), 4);
  assert.equal(fs.existsSync(path.dirname(nowhere)), false);

  // 什麼都沒辨識到：不存快取，重試會重新辨識
  const empty = path.join(dir, "empty-cache.json");
  silent = true;
  await assert.rejects(prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], asrCache: empty, durationMs: 3000 },
    { work: fs.mkdtempSync(path.join(dir, ".work-")) }), /no speech recognised/);
  assert.equal(fs.existsSync(empty), false, "空的結果不存，不然重試永遠失敗");
});

test("realign keeps each character's time and gives replaced characters the old span", () => {
  const chars = charsFromSoniox([{ text: "今天", start_ms: 0, end_ms: 400 }, { text: "隻有", start_ms: 400, end_ms: 800 }, { text: "咳", start_ms: 900, end_ms: 950, is_audio_event: true }]);
  const r = realign(chars, "今天只有");
  assert.equal(textOf(r), "今天只有");
  assert.deepEqual(r.map((x) => x.s), [0, 200, 400, 600]);
});

test("whisper words become characters with millisecond times", () => {
  const chars = charsFromWhisper({ segments: [{ words: [{ word: "好,", start: 1, end: 1.5 }] }] });
  assert.equal(fullWidthPunct(textOf(chars)), "好，");
  assert.equal(chars[0].s, 1000);
});

test("edits that only delete Chinese words are rejected; real fixes apply once", () => {
  assert.equal(isPureDeletion("我是現在", "我現在"), true);
  assert.equal(isPureDeletion("Code x", "Codex"), false);
  assert.equal(isPureDeletion("隻有", "只有"), false);
  const r = applyEdits("就是隻有你，我是現在，是", [
    { find: "隻有你", replace: "只有你" },
    { find: "我是現在", replace: "我現在" },
    { find: "是", replace: "事" },
    { find: "不存在", replace: "x" },
    { find: "，", replace: "，好長好長好長的補充" },
    "垃圾",
  ]);
  assert.equal(r.text, "就是只有你，我是現在，是");
  assert.deepEqual(r.rejected.map((x) => x.why), ["deletes words", "matches 3 times", "matches 0 times", "matches 2 times", "no-op"]);
});

test("cues follow pauses and line width, keep English words whole and drop end punctuation", () => {
  const chars = charsFromSoniox([
    { text: "那我接下來就是，我有跟Codex聊了一下，然後接下來會把Obsidian當成是一個處理Markdown的。", start_ms: 0, end_ms: 8000 },
    { text: "嗯。", start_ms: 9000, end_ms: 9100 },
  ]);
  const cues = buildCues(chars);
  assert.ok(cues.every((c) => !/[，。]$/.test(c.text)));
  assert.ok(cues.some((c) => c.text.includes("Codex")) && cues.some((c) => c.text.includes("Markdown")));
  assert.equal(cues[cues.length - 1].text, "嗯");
  assert.ok(cues[cues.length - 1].end - cues[cues.length - 1].start >= 400, "短句至少顯示 0.4 秒");
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].end <= cues[i].start);
  assert.match(toSrt(cues), /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\n/);
});

// #33：太長要切成兩行時，切在自然的地方
const speak = (text, { pauseAfter = {} } = {}) => {
  let t = 0;
  return [...text].map((c, i) => { const s = t; t += 200; const x = { c, s, e: t - 20, spk: null }; t += pauseAfter[i] || 0; return x; });
};
const lines = (text, opts) => buildCues(speak(text, opts)).map((c) => c.text);

test("long stretches are split between words, not inside names or right before a title", () => {
  const a = lines("去年聽培芬還有聽洪昌老師還有鼎翔老師講述他們的工作內容的時候");
  assert.ok(a.every((l) => [...l.replace(/\s/g, "")].length <= 16), a.join(" / "));
  assert.ok(a.some((l) => l.includes("鼎翔老師")), `「鼎翔老師」要在同一行：${a.join(" / ")}`);
  assert.ok(!a.some((l) => /^老師/.test(l)), a.join(" / "));
  const b = lines("那我們先講一下鼎翔老師你可以先幫我把那個我們的活動記錄先把它demo給大家看", { pauseAfter: { 6: 250 } });
  assert.equal(b[0], "那我們先講一下", `停頓的地方切：${b.join(" / ")}`);
  assert.ok(b[1].startsWith("鼎翔老師"), b.join(" / "));
  const c = lines("大家是有一點就是感覺不要那麼的緊張，稍微relax一點");
  assert.ok(c.some((l) => l.endsWith("緊張")), `「緊張」不拆開：${c.join(" / ")}`);
  assert.ok(!c.some((l) => /^張/.test(l)), c.join(" / "));
  const d = lines("我覺得這個方法真的很不錯然後下學期再試試看別的");
  assert.equal(d.length, 2);
  assert.ok(d[1].startsWith("然後"), `連接詞放下一行開頭：${d.join(" / ")}`);
  assert.ok(Math.abs([...d[0]].length - [...d[1]].length) <= 6, `兩行差不多長：${d.join(" / ")}`);
});

test("splitting long stretches never breaks English words, numbers or times", () => {
  const out = lines("我們今天用Google Classroom派10:30要交的作業大家記得在明天早上8:00之前交回來喔");
  const all = out.join("|");
  for (const w of ["Google", "Classroom", "10:30", "8:00"]) assert.ok(out.some((l) => l.includes(w)), `${w} 被切開：${all}`);
});

test("numbers keep their , : . and are never split across cues", () => {
  const cues = buildCues(charsFromSoniox([{ text: "會議在明天早上10:30開始，預算大約是1,000元，版本3.5。", start_ms: 0, end_ms: 6000 }]));
  const all = cues.map((c) => c.text).join("|");
  assert.match(all, /10:30/);
  assert.match(all, /1,000/);
  assert.match(all, /3\.5/);
  assert.ok(!all.includes("，"), "中文逗號照樣換成空格");
});

test("a number at the line limit stays whole (10:30 never becomes 10 | :30)", () => {
  const cues = buildCues(charsFromSoniox([{ text: "一二三四五六七八九十一二三四五10:30開始", start_ms: 0, end_ms: 6000 }]));
  assert.ok(cues.some((c) => c.text.includes("10:30")), cues.map((c) => c.text).join("|"));
});

test("subtitle size maps to the burn style; unknown sizes are refused", () => {
  assert.match(burnStyle("large"), /FontSize=24/);
  assert.match(burnStyle(), /FontSize=20/);
  assert.equal(runArgs(["v.mp4", "--out", "o", "--privacy", "public", "--size", "small"]).size, "small");
  assert.throws(() => runArgs(["v.mp4", "--out", "o", "--privacy", "public", "--size", "huge"]), /--size/);
  assert.throws(() => cliArgs(["v.mp4", "--privacy", "public", "--size", "huge"]), /--size/);
});

test("a failed preflight leaves no output folder behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-pre-"));
  const video = path.join(dir, "v.mp4");
  fs.writeFileSync(video, "x");
  const saved = process.env.CYCLONE_CLAUDE_BIN;
  process.env.CYCLONE_CLAUDE_BIN = path.join(dir, "no-claude");
  try {
    await assert.rejects(runSubtitle({ video, out: path.join(dir, "out"), privacy: "public", engine: "soniox", proofreader: "claude" }), /not installed/);
  } finally {
    if (saved === undefined) delete process.env.CYCLONE_CLAUDE_BIN; else process.env.CYCLONE_CLAUDE_BIN = saved;
  }
  assert.equal(fs.existsSync(path.join(dir, "out")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 假的 meeting-scribe：GET/POST /api/corrections，記下收到的 POST
function fakeScribe(initial) {
  const state = { data: initial, posts: [] };
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/corrections") { res.writeHead(404).end(); return; }
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state.data)); return; }
    // 和真的會議 App 一樣：POST 沒帶 X-Meeting-Scribe 就 403（#124）
    if (req.headers["x-meeting-scribe"] !== "1") { res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "缺少必要標頭" })); return; }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      state.posts.push(JSON.parse(body));
      state.data = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("every host takes the correction list from meeting-scribe, caches it 0600, falls back to the cache, then the local copy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-sync-"));
  const fake = await fakeScribe({ hints: [["學長", "學障"]], fixed: [["記賬", "記帳"]] });
  const env = { CYCLONE_MEETING_SCRIBE_URL: fake.url, CYCLONE_CORRECTIONS_FILE: path.join(dir, "none.json"), CYCLONE_CORRECTIONS_CACHE: path.join(dir, "cache", "c.json") };
  // 主機連得上時以主機為準，就算本機有 meeting-scribe 的檔案（備援主機）也不讀
  fs.writeFileSync(path.join(dir, "stale.json"), JSON.stringify({ hints: [["舊的", "舊的對照"]], fixed: [] }));
  const live = await syncCorrections({ env: { ...env, CYCLONE_CORRECTIONS_FILE: path.join(dir, "stale.json") } });
  assert.equal(live.source, "meeting-scribe");
  assert.deepEqual(live.corrections.hints, [["學長", "學障"]]);
  const r = await syncCorrections({ env });
  assert.equal(r.source, "meeting-scribe");
  assert.deepEqual(r.corrections.fixed, [["記賬", "記帳"]]);
  assert.equal(fs.statSync(env.CYCLONE_CORRECTIONS_CACHE).mode & 0o777, 0o600);
  await new Promise((done) => fake.server.close(done));
  const offline = await syncCorrections({ env, timeoutMs: 1000 });
  assert.equal(offline.source, "cache");
  assert.ok(offline.error);
  assert.deepEqual(offline.corrections.hints, [["學長", "學障"]]);
  // 備援主機：主機連不上、也沒有快取時，才讀本機 meeting-scribe 備援那份
  fs.writeFileSync(path.join(dir, "local.json"), JSON.stringify({ hints: [["甲乙", "甲乙丙"]], fixed: [] }));
  const withLocal = { ...env, CYCLONE_CORRECTIONS_FILE: path.join(dir, "local.json") };
  assert.equal((await syncCorrections({ env: withLocal, timeoutMs: 1000 })).source, "cache");
  fs.rmSync(env.CYCLONE_CORRECTIONS_CACHE);
  const local = await syncCorrections({ env: withLocal, timeoutMs: 1000 });
  assert.equal(local.source, "local");
  assert.ok(local.error);
  assert.deepEqual(local.corrections.hints, [["甲乙", "甲乙丙"]]);
  assert.equal(fs.existsSync(env.CYCLONE_CORRECTIONS_CACHE), false);
  assert.equal((await syncCorrections({ env, timeoutMs: 1000 })).source, "none");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adding a correction posts meeting-scribe's own list plus the new pair, once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-add-"));
  const fake = await fakeScribe({ hints: [["學長", "學障"]], fixed: [] });
  const env = { CYCLONE_MEETING_SCRIBE_URL: fake.url, CYCLONE_CORRECTIONS_CACHE: path.join(dir, "c.json") };
  assert.deepEqual(await addCorrection("克勞德", "Claude", { env }), { added: true, hints: 2, fixed: 0 });
  assert.deepEqual(fake.state.posts[0], { hints: [["學長", "學障"], ["克勞德", "Claude"]], fixed: [] });
  assert.equal((await addCorrection("克勞德", "Claude", { env })).added, false);
  assert.equal(fake.state.posts.length, 1);
  await assert.rejects(addCorrection("他", "它", { env, kind: "fixed" }), /一定替換/);
  await assert.rejects(addCorrection("", "x", { env }), /都要填/);
  fake.state.data = { ...fake.state.data, recovered: true };
  await assert.rejects(addCorrection("甲", "乙", { env }), /損壞/);
  await new Promise((done) => fake.server.close(done));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("chunkText splits long unpunctuated text", () => {
  const parts = chunkText("一二三，四五六，七八九".repeat(200), 400, 100);
  assert.ok(parts.every((p) => [...p].length <= 100));
  assert.equal(parts.join(""), "一二三，四五六，七八九".repeat(200));
});

test("corrections load leniently; ASR terms are words only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-corr-"));
  const f = path.join(dir, "c.json");
  fs.writeFileSync(f, JSON.stringify({ hints: [["學長", "學障"], ["壞"], ["掌聲呢各位", "掌聲呢，各位"]], fixed: [["他", "它"], ["記賬", "記帳"]] }));
  const c = loadCorrections(f);
  assert.deepEqual(c.fixed, [["記賬", "記帳"]], "一個字的一定替換會改壞整份，略過");
  assert.deepEqual(asrTerms(c, ["IEP", "學障"]), ["IEP", "學障", "記帳"], "有標點的句子不放進 ASR 提示");
  assert.deepEqual(loadCorrections(path.join(dir, "none.json")), { hints: [], fixed: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("chapters snap to cue starts, start at zero and keep 10 s apart; fewer than 3 are left out", () => {
  const ch = snapChapters([{ t: "00:01:05", title: "B" }, { t: "00:00:20", title: "A" }, { t: "00:01:08", title: "太近" }, { t: "壞", title: "x" }, { t: "00:03:00", title: "C" }], [0, 60000, 64000, 170000]);
  assert.deepEqual(ch, [{ t_ms: 0, title: "A", points: [] }, { t_ms: 64000, title: "B", points: [] }, { t_ms: 170000, title: "C", points: [] }]);
  assert.equal(descriptionText("簡介", ch), "簡介\n\n00:00 A\n01:04 B\n02:50 C\n");
  assert.equal(descriptionText("簡介", ch.slice(0, 2)), "簡介\n");
});

test("each chapter carries its key points; a long description drops points before it passes YouTube's 5000 bytes (#46)", () => {
  const ch = snapChapters([
    { t: "00:00:00", title: "開場", points: ["・第一點", "第二點", "第三點", "第四點不要"] },
    { t: "00:01:00", title: "中段", points: ["  中段重點  ", "", 42] },
    { t: "00:02:00", title: "結尾", points: "不是陣列" },
  ], [0, 60000, 120000]);
  assert.deepEqual(ch.map((c) => c.points), [["第一點", "第二點", "第三點"], ["中段重點", "42"], []], "最多 3 條、去掉開頭的「・」和空白");
  assert.equal(descriptionText("簡介", ch), "簡介\n\n00:00 開場\n・第一點\n・第二點\n・第三點\n\n01:00 中段\n・中段重點\n・42\n\n02:00 結尾\n");
  // 太長：先每章只留 2 條、再 1 條，最後只留章節
  const full = descriptionText("簡介", ch);
  const two = descriptionText("簡介", ch, { maxBytes: Buffer.byteLength(full) - 1 });
  assert.equal(two, "簡介\n\n00:00 開場\n・第一點\n・第二點\n\n01:00 中段\n・中段重點\n・42\n\n02:00 結尾\n");
  assert.equal(descriptionText("簡介", ch, { maxBytes: 10 }), "簡介\n\n00:00 開場\n01:00 中段\n02:00 結尾\n");
});

test("title and tag suggestions are cleaned up and kept within YouTube's limits (#46)", () => {
  assert.deepEqual(cleanSuggestion({ title: "  AI   協作\n做字幕  ", tags: ["#特教", "特教", "AI, 字幕", "  ", "<b>", 7, "Claude Code"] }),
    { title: "AI 協作 做字幕", tags: ["特教", "AI 字幕", "b", "7", "Claude Code"] });
  assert.deepEqual(cleanSuggestion(null), { title: "", tags: [] });
  const many = cleanSuggestion({ title: "x".repeat(150), tags: Array.from({ length: 40 }, (_, i) => `標籤${"字".repeat(25)}${i}`) });
  assert.equal([...many.title].length, 100);
  const used = many.tags.reduce((n, t) => n + [...t].length, 0) + many.tags.length - 1;
  assert.ok(used <= 500 && many.tags.length <= 15, "總長不超過 500 字");
});

function fakeSoniox({ failOn = "" } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const p = url.replace("https://api.soniox.com", "");
    calls.push(`${opts.method} ${p}`);
    const json = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });
    if (failOn && p.includes(failOn) && opts.method === "GET") return json({}, 500);
    if (p === "/v1/files") return json({ id: "f1" });
    if (p === "/v1/transcriptions") return json({ id: "t1" });
    if (p === "/v1/transcriptions/t1") return json({ status: "completed" });
    if (p === "/v1/transcriptions/t1/transcript") return json({ tokens: [{ text: "好", start_ms: 0, end_ms: 500 }] });
    return json({});
  };
  return { calls, fetchImpl };
}

test("Soniox copies are deleted after success and after failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-snx-"));
  const audio = path.join(dir, "a.mp3");
  fs.writeFileSync(audio, "x");
  const ok = fakeSoniox();
  const r = await transcribeFile(audio, { key: "k", fetchImpl: ok.fetchImpl, sleep: async () => {} });
  assert.equal(r.audio_ms, 500);
  assert.deepEqual(r.deleted, { file: true, transcription: true });
  assert.ok(ok.calls.includes("DELETE /v1/transcriptions/t1") && ok.calls.includes("DELETE /v1/files/f1"));
  const bad = fakeSoniox({ failOn: "/transcript" });
  await assert.rejects(transcribeFile(audio, { key: "k", fetchImpl: bad.fetchImpl, sleep: async () => {} }), /HTTP 500/);
  assert.ok(bad.calls.includes("DELETE /v1/transcriptions/t1") && bad.calls.includes("DELETE /v1/files/f1"), "失敗也要刪雲端的檔案");
  await assert.rejects(transcribeFile(audio, { key: "" }), /no Soniox API key/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Claude usage adds tokens per call and only the per-process cost delta", () => {
  const u = newUsage(), st = { procCost: 0 };
  addResultUsage(u, { usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }, total_cost_usd: 0.01 }, st);
  addResultUsage(u, { usage: { output_tokens: 1 } }, st);
  addResultUsage(u, { usage: {}, total_cost_usd: 0.03 }, st);
  assert.deepEqual({ ...u, cost_usd: Math.round(u.cost_usd * 1000) / 1000 }, { calls: 3, input: 2, output: 4, cache_write: 10, cache_read: 5, cost_usd: 0.03 });
});

test("a missing Claude binary is reported, not a crash", async () => {
  const s = openClaude("x", { command: ["/nonexistent/claude-bin"] });
  await assert.rejects(s.ask("hi"), /could not start|exited/);
  s.close();
});

test("agents never inherit any ASR or download credential (#163)", () => {
  const creds = { SONIOX_API_KEY: "a", CYCLONE_SONIOX_KEY_FILE: "/k", GROQ_API_KEY: "b", APIFY_TOKEN: "c", GROQ_CONFIG_JSON: "/g.json", APIFY_CONFIG_JSON: "/a.json" };
  assert.deepEqual(agentEnv({ PATH: "/bin", HOME: "/h", ...creds }), { PATH: "/bin", HOME: "/h" });
});

test("agents never inherit the Soniox key", () => {
  const env = agentEnv({ PATH: "/bin", SONIOX_API_KEY: "secret", CYCLONE_SONIOX_KEY_FILE: "/k" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("iCloud and Drive sync folders are detected, even before the folder exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rt-home-"));
  fs.mkdirSync(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Desktop"), { recursive: true });
  fs.mkdirSync(path.join(home, "Desktop"));
  const dirs = cloudDirs(home);
  assert.ok(dirs.includes(fs.realpathSync(path.join(home, "Desktop"))), "iCloud 桌面開著時桌面也算");
  assert.equal(inCloudFolder(realDir(path.join(home, "Desktop", "新資料夾", "字幕")), dirs), true);
  assert.equal(inCloudFolder(realDir(path.join(home, "Movies", "字幕")), dirs), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("CLI --privacy defaults to public and the job defaults to running locally", () => {
  assert.equal(cliArgs(["v.mp4"]).privacy, "public");
  assert.throws(() => cliArgs(["v.mp4", "--privacy", "nope"]), /--privacy must be/);
  const o = cliArgs(["v.mp4", "--privacy", "student-private", "--burn"]);
  assert.equal(o.remote, false);
  assert.equal(cliArgs(["v.mp4", "--privacy", "public", "--remote", "--host", "studio-mac"]).remote, true);
  assert.throws(() => cliArgs(["v.mp4", "--privacy", "public", "--remote"]), /--remote needs a host/, "沒設定遠端主機就不能 --remote");
  assert.throws(() => cliArgs(["v.mp4", "--privacy", "public", "--host", "bad host"]), /invalid host/);
  assert.throws(() => runArgs(["v.mp4", "--out", "o", "--privacy", "public", "--engine", "groq"]), /--engine/);
  const home = os.homedir();
  assert.equal(inCloudFolder(path.join(home, "Library", "Mobile Documents", "x.mp4")), true);
  assert.equal(inCloudFolder(path.join(home, "Library", "CloudStorage", "GoogleDrive-a", "x.mp4")), true);
  assert.equal(inCloudFolder(path.join(home, "Movies", "x.mp4")), false);
});

test("content marked as personal data never goes to a proofreader that may use a mainland-China cloud model", () => {
  assert.deepEqual(PROOFREADERS, ["claude", "codex", "cursor", "grok", "pi"]);
  assert.deepEqual(MAY_USE_CHINA_CLOUD_LLM, ["pi"]);
  for (const name of PROOFREADERS) assert.doesNotThrow(() => checkProofreader(name, "public"));
  for (const name of ["claude", "codex", "cursor", "grok"]) {
    assert.doesNotThrow(() => checkProofreader(name, "student-private"), name);
    assert.doesNotThrow(() => checkProofreader(name, "sensitive"), name);
  }
  assert.throws(() => checkProofreader("pi", "student-private"), /mainland-China cloud language model.*use another proofreader/);
  assert.throws(() => checkProofreader("pi", "sensitive"), /mainland-China/);
  assert.throws(() => checkProofreader("gemini", "public"), /must be one of/);
  assert.throws(() => cliArgs(["v.mp4", "--privacy", "student-private", "--proofreader", "pi"]), /mainland-China/);
  assert.equal(cliArgs(["v.mp4", "--privacy", "student-private", "--proofreader", "grok"]).proofreader, "grok");
  assert.equal(cliArgs(["v.mp4", "--privacy", "public", "--proofreader", "codex"]).proofreader, "codex");
});

function jobCmd(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "transcript-job.mjs"), ...args], { encoding: "utf8", env: { ...process.env, CYCLONE_TRANSCRIPT_JOBS_ROOT: root, CYCLONE_SUBTITLE_RUN_SCRIPT: path.join(root, "fake-run.mjs") } });
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

// 假的 subtitle-run：等一下、寫一個輸出、印 ok
function fakeRun(root, ms) {
  fs.writeFileSync(path.join(root, "fake-run.mjs"), `import fs from "node:fs"; import path from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
await new Promise((r) => setTimeout(r, ${ms}));
fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "subtitles.srt"), "1\\n");
console.log(JSON.stringify({ ok: true, steps: {}, outputs: ["subtitles.srt"] }));`);
}

async function waitState(root, id, states) {
  for (let i = 0; i < 100; i++) {
    const st = jobCmd(root, "status", id);
    if (states.includes(st.state)) return st;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job never finished");
}

test("subtitle job deletes the uploaded video when it ends and refuses finish while running", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-jobs-"));
  fakeRun(root, 1500);
  const id = "sub-test-000002";
  const prep = jobCmd(root, "prepare", id);
  fs.writeFileSync(path.join(prep.input_dir, "source.mp4"), "video bytes");
  assert.equal(jobCmd(root, "subtitle", id, "--input", "source.mp4", "--privacy", "student-private").state, "queued");
  assert.match(jobCmd(root, "finish", id).error, /still running/);
  const st = await waitState(root, id, ["succeeded", "failed"]);
  assert.equal(st.state, "succeeded");
  assert.deepEqual(st.cleanup, { deleted: 1, bytes_deleted: 11, leftovers: 0 });
  assert.equal(fs.existsSync(path.join(prep.input_dir, "source.mp4")), false, "影片跑完就刪");
  assert.ok(fs.existsSync(path.join(root, id, "outputs", "subtitles.srt")));
  assert.equal(jobCmd(root, "finish", id).removed, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("subtitle jobs: prepare, refuse bad input names, finish removes everything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-jobs-"));
  const id = "sub-test-000001";
  const prep = jobCmd(root, "prepare", id);
  assert.equal(prep.state, "prepared");
  assert.equal(fs.statSync(prep.input_dir).mode & 0o777, 0o700);
  assert.match(jobCmd(root, "subtitle", id, "--input", "../x.mp4", "--privacy", "public").error, /source\.<ext>/);
  assert.match(jobCmd(root, "subtitle", id, "--input", "source.mp4", "--privacy", "public").error, /not been uploaded/);
  assert.match(jobCmd(root, "subtitle", id, "--input", "source.mp4", "--privacy", "nope").error, /privacy/);
  assert.match(jobCmd(root, "subtitle", id, "--input", "source.mp4", "--privacy", "student-private", "--proofreader", "pi").error, /mainland-China/);
  assert.equal(jobCmd(root, "finish", id).removed, true);
  assert.equal(fs.existsSync(path.join(root, id)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// 會斷線的假 Soniox（#64）：fail = { "GET /v1/transcriptions/t1/transcript": 次數 }，次數用完才正常；
// "net" 開頭的值丟連線錯誤，數字以外的寫法見下面
function flakySoniox({ fail = {}, gone = [], tid = "t1" } = {}) {
  const calls = [];
  const left = { ...fail };
  const fetchImpl = async (url, opts) => {
    const p = url.replace("https://api.soniox.com", "");
    const k = `${opts.method} ${p}`;
    calls.push(k);
    const json = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });
    if (left[k]) {
      left[k]--;
      if (fail.status?.[k]) return json({}, fail.status[k]);
      throw new TypeError("fetch failed");
    }
    if (gone.some((g) => p.startsWith(g))) return json({}, 404);
    if (p === "/v1/files") return json({ id: "f1" });
    if (p === "/v1/transcriptions") return json({ id: tid });
    if (p === `/v1/transcriptions/${tid}`) return json({ status: "completed" });
    if (p === `/v1/transcriptions/${tid}/transcript`) return json({ tokens: [{ text: "好", start_ms: 0, end_ms: 500 }] });
    return json({});
  };
  return { calls, fetchImpl, count: (k) => calls.filter((c) => c === k).length };
}

function snxDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-snx64-"));
  const audio = path.join(dir, "a.mp3");
  fs.writeFileSync(audio, "x");
  return { dir, audio, leftoversFile: path.join(dir, "state", "leftovers.json"), pending: { file: path.join(dir, "soniox-pending.json"), key: "video-A" } };
}

test("Soniox: a dropped connection while polling or fetching is retried, not fatal (#64)", async () => {
  const { dir, audio, leftoversFile } = snxDir();
  const s = flakySoniox({ fail: { "GET /v1/transcriptions/t1": 2, "GET /v1/transcriptions/t1/transcript": 3, "DELETE /v1/files/f1": 1 } });
  const waits = [];
  const r = await transcribeFile(audio, { key: "k", fetchImpl: s.fetchImpl, sleep: async (ms) => { waits.push(ms); }, leftoversFile });
  assert.equal(r.audio_ms, 500);
  assert.deepEqual(r.deleted, { file: true, transcription: true });
  assert.equal(s.count("GET /v1/transcriptions/t1/transcript"), 4);
  assert.deepEqual(waits.slice(0, 2), [2000, 5000], "退避重試");
  assert.equal(s.count("POST /v1/files"), 1, "上傳不重送");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: a 4xx other than 429 is not retried", async () => {
  const { dir, audio, leftoversFile } = snxDir();
  const k = "GET /v1/transcriptions/t1/transcript";
  const s = flakySoniox({ fail: { [k]: 1, status: { [k]: 400 } } });
  await assert.rejects(transcribeFile(audio, { key: "k", fetchImpl: s.fetchImpl, sleep: async () => {}, leftoversFile }), /HTTP 400/);
  assert.equal(s.count(k), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: when the result cannot be fetched, the job is kept and the retry resumes it without uploading (#64)", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  const k = "GET /v1/transcriptions/t1/transcript";
  const down = flakySoniox({ fail: { [k]: 99 } });
  const e = await transcribeFile(audio, { key: "k", fetchImpl: down.fetchImpl, sleep: async () => {}, leftoversFile, pending }).catch((x) => x);
  assert.equal(e.sonioxPending, true);
  assert.match(e.message, /不用重新上傳/);
  assert.equal(down.count("DELETE /v1/transcriptions/t1"), 0, "辨識結果留在雲端");
  assert.equal(down.count("DELETE /v1/files/f1"), 1, "音檔照樣刪");
  assert.equal(JSON.parse(fs.readFileSync(pending.file, "utf8")).tid, "t1");
  assert.equal(fs.statSync(pending.file).mode & 0o777, 0o600);
  const grace = JSON.parse(fs.readFileSync(leftoversFile, "utf8"));
  assert.ok(grace[0].id === "t1" && grace[0].not_before > Date.now(), "沒人接回去的話，三天後補刪");

  const up = flakySoniox();
  const r = await transcribeFile(audio, { key: "k", fetchImpl: up.fetchImpl, sleep: async () => {}, leftoversFile, pending });
  assert.equal(r.resumed, true);
  assert.equal(r.audio_ms, 500);
  assert.equal(up.count("POST /v1/files"), 0, "不重新上傳");
  assert.equal(up.count("POST /v1/transcriptions"), 0);
  assert.equal(up.count("DELETE /v1/transcriptions/t1"), 1, "接回去之後刪掉雲端那份");
  assert.equal(fs.existsSync(pending.file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: a pending job that is gone, or belongs to another video, starts over", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  fs.writeFileSync(pending.file, JSON.stringify({ key: pending.key, tid: "t0" }));
  const gone = flakySoniox({ gone: ["/v1/transcriptions/t0"] });
  const r = await transcribeFile(audio, { key: "k", fetchImpl: gone.fetchImpl, sleep: async () => {}, leftoversFile, pending });
  assert.ok(!r.resumed);
  assert.equal(gone.count("POST /v1/files"), 1);
  assert.equal(fs.existsSync(pending.file), false);

  fs.writeFileSync(pending.file, JSON.stringify({ key: "video-B", tid: "t9" }));
  const other = flakySoniox();
  await transcribeFile(audio, { key: "k", fetchImpl: other.fetchImpl, sleep: async () => {}, leftoversFile, pending });
  assert.equal(other.count("GET /v1/transcriptions/t9/transcript"), 0, "別支影片的不接");
  assert.equal(other.count("POST /v1/files"), 1);
  assert.equal(fs.existsSync(pending.file), false);

  // 接的時候還是斷線：留著 pending，不重新上傳
  fs.writeFileSync(pending.file, JSON.stringify({ key: pending.key, tid: "t1" }));
  const still = flakySoniox({ fail: { "GET /v1/transcriptions/t1": 99 } });
  const e = await transcribeFile(audio, { key: "k", fetchImpl: still.fetchImpl, sleep: async () => {}, leftoversFile, pending }).catch((x) => x);
  assert.equal(e.sonioxPending, true);
  assert.equal(still.count("POST /v1/files"), 0);
  assert.ok(fs.existsSync(pending.file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: copies that could not be deleted keep the result and are deleted next time", async () => {
  const { dir, audio, leftoversFile } = snxDir();
  const s = flakySoniox({ fail: { "DELETE /v1/transcriptions/t1": 99, "DELETE /v1/files/f1": 99 } });
  const r = await transcribeFile(audio, { key: "k", fetchImpl: s.fetchImpl, sleep: async () => {}, leftoversFile });
  assert.equal(r.audio_ms, 500, "付費拿到的結果不丟");
  assert.deepEqual(r.deleted, { file: false, transcription: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(leftoversFile, "utf8")).map((x) => x.id).sort(), ["f1", "t1"]);

  const next = flakySoniox({ tid: "t2" });
  await transcribeFile(audio, { key: "k", fetchImpl: next.fetchImpl, sleep: async () => {}, leftoversFile });
  assert.equal(next.count("DELETE /v1/transcriptions/t1"), 1, "下次辨識前補刪");
  assert.equal(next.count("DELETE /v1/files/f1"), 2, "上次的 f1，加上這次自己的 f1");
  assert.equal(fs.existsSync(leftoversFile), false);

  fs.mkdirSync(path.dirname(leftoversFile), { recursive: true });
  fs.writeFileSync(leftoversFile, JSON.stringify([{ kind: "transcription", id: "t7", not_before: Date.now() + 60_000 }]));
  const wait = flakySoniox({ tid: "t3" });
  await transcribeFile(audio, { key: "k", fetchImpl: wait.fetchImpl, sleep: async () => {}, leftoversFile });
  assert.equal(wait.count("DELETE /v1/transcriptions/t7"), 0, "還在等人按重試的不刪");
  assert.equal(JSON.parse(fs.readFileSync(leftoversFile, "utf8"))[0].id, "t7");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Studio retry after a dropped Soniox fetch resumes from the project, without a second upload (#64)", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-resume-"));
  const video = path.join(dir, "v.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  let s = flakySoniox({ fail: { "GET /v1/transcriptions/t1/transcript": 99 } });
  t.mock.method(globalThis, "fetch", async (url, opts = {}) => {
    if (!String(url).startsWith("https://api.soniox.com")) return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) };
    return s.fetchImpl(String(url), { method: "GET", ...opts });
  });
  const keys = ["SONIOX_API_KEY", "CYCLONE_CLAUDE_BIN", "CYCLONE_MEETING_SCRIBE_URL", "CYCLONE_SONIOX_RETRY_DELAYS", "CYCLONE_SONIOX_LEFTOVERS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SONIOX_API_KEY: "k", CYCLONE_CLAUDE_BIN: path.join(dir, "no-claude"), CYCLONE_MEETING_SCRIBE_URL: "http://127.0.0.1:9",
    CYCLONE_SONIOX_RETRY_DELAYS: "0,0", CYCLONE_SONIOX_LEFTOVERS: path.join(dir, "leftovers.json") });
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(dir, { recursive: true, force: true }); });
  const cache = path.join(dir, "asr.json");
  const prepare = () => prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], asrCache: cache, durationMs: 3000 },
    { work: fs.mkdtempSync(path.join(dir, ".work-")) });
  const e = await prepare().catch((x) => x);
  assert.equal(e.sonioxPending, true, String(e?.message));
  assert.ok(fs.existsSync(path.join(dir, "soniox-pending.json")), "記在專案資料夾");
  assert.equal(e.report.soniox.pending, true);

  s = flakySoniox();
  await assert.rejects(prepare(), "沒有 Claude，校對那一步出錯（辨識已經接回來了）");
  assert.equal(s.count("POST /v1/files"), 0, "重試沒有重新上傳");
  assert.equal(s.count("GET /v1/transcriptions/t1/transcript"), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).chars, [["好", 0, 500, null]], "接回來的結果存進快取");
  assert.equal(fs.existsSync(path.join(dir, "soniox-pending.json")), false);
});

// ---- 停止（#67） ----
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

test("Soniox: stopping while it is recognising deletes both cloud copies and keeps no pending job (#67)", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  const ac = new AbortController();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const p = url.replace("https://api.soniox.com", "");
    calls.push(`${opts.method} ${p}`);
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (p === "/v1/files") return json({ id: "f1" });
    if (p === "/v1/transcriptions") return json({ id: "t1" });
    if (p === "/v1/transcriptions/t1") {
      if (calls.filter((c) => c === "GET /v1/transcriptions/t1").length === 3) ac.abort();
      return json({ status: "processing" });
    }
    return json({});
  };
  const e = await transcribeFile(audio, { key: "k", fetchImpl, sleep: async () => {}, leftoversFile, pending, signal: ac.signal }).catch((x) => x);
  assert.equal(e.cancelled, true, String(e?.message));
  assert.ok(!e.sonioxPending, "使用者停的不是斷線，不留 pending");
  assert.deepEqual(e.sonioxDeleted, { file: true, transcription: true });
  assert.ok(calls.includes("DELETE /v1/transcriptions/t1") && calls.includes("DELETE /v1/files/f1"));
  assert.equal(fs.existsSync(pending.file), false);
  assert.equal(fs.existsSync(leftoversFile), false, "也沒有寬限期的殘留");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: stopping during the upload sends nothing more (#67)", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  const ac = new AbortController();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url.replace("https://api.soniox.com", "")}`);
    ac.abort();
    throw abortError();
  };
  const e = await transcribeFile(audio, { key: "k", fetchImpl, sleep: async () => {}, leftoversFile, pending, signal: ac.signal }).catch((x) => x);
  assert.equal(e.cancelled, true);
  assert.deepEqual(calls, ["POST /v1/files"]);
  await assert.rejects(transcribeFile(audio, { key: "k", fetchImpl, leftoversFile, signal: ac.signal }), /cancelled/, "已經停了就不開始");
  assert.equal(calls.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: stopping while resuming a kept job deletes it instead of keeping it (#67)", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  fs.writeFileSync(pending.file, JSON.stringify({ key: pending.key, tid: "t1" }));
  fs.mkdirSync(path.dirname(leftoversFile), { recursive: true });
  fs.writeFileSync(leftoversFile, JSON.stringify([{ kind: "transcription", id: "t1", not_before: Date.now() + 60_000 }]));
  const ac = new AbortController();
  const s = flakySoniox();
  const fetchImpl = async (url, opts) => {
    if (opts.method === "GET") { ac.abort(); throw abortError(); }
    return s.fetchImpl(url, opts);
  };
  const e = await transcribeFile(audio, { key: "k", fetchImpl, sleep: async () => {}, leftoversFile, pending, signal: ac.signal }).catch((x) => x);
  assert.equal(e.cancelled, true);
  assert.equal(s.count("DELETE /v1/transcriptions/t1"), 1);
  assert.equal(fs.existsSync(pending.file), false);
  assert.equal(fs.existsSync(leftoversFile), false, "刪掉了，寬限期那筆也拿掉");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: a copy that is already gone (404) counts as deleted (#66 review)", async () => {
  const { dir, audio, leftoversFile } = snxDir();
  const s = flakySoniox({ fail: { "DELETE /v1/transcriptions/t1": 1, "DELETE /v1/files/f1": 1, status: { "DELETE /v1/transcriptions/t1": 404, "DELETE /v1/files/f1": 404 } } });
  const r = await transcribeFile(audio, { key: "k", fetchImpl: s.fetchImpl, sleep: async () => {}, leftoversFile });
  assert.deepEqual(r.deleted, { file: true, transcription: true });
  assert.equal(fs.existsSync(leftoversFile), false, "不記成殘留");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Soniox: a successful resume removes its grace-period leftover entry (#66 review)", async () => {
  const { dir, audio, leftoversFile, pending } = snxDir();
  fs.writeFileSync(pending.file, JSON.stringify({ key: pending.key, tid: "t1" }));
  fs.mkdirSync(path.dirname(leftoversFile), { recursive: true });
  fs.writeFileSync(leftoversFile, JSON.stringify([{ kind: "transcription", id: "t1", not_before: Date.now() + 60_000 }, { kind: "file", id: "f9", not_before: Date.now() + 60_000 }]));
  const s = flakySoniox();
  const r = await transcribeFile(audio, { key: "k", fetchImpl: s.fetchImpl, sleep: async () => {}, leftoversFile, pending });
  assert.equal(r.resumed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(leftoversFile, "utf8")).map((x) => x.id), ["f9"], "只拿掉接回去的那筆");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AI proofreading stops when asked: the agent is closed and the step reports cancelled (#67)", async () => {
  let closed = 0, reject;
  const session = { usage: null, ask: () => new Promise((_, rj) => { reject = rj; }), close() { closed += 1; reject?.(new Error("agent closed")); } };
  const ac = new AbortController();
  const run = verbatimFix("今天天氣很好。", { hints: [], fixed: [] }, { session, signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await assert.rejects(run, /cancelled/);
  assert.equal(closed, 1, "停止就關掉 agent");
});

test("stopping during audio extraction, recognition or the description step rejects as cancelled (#67)", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-stop-"));
  const video = path.join(dir, "v.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const calls = [];
  let polls = 0, ac, finish = false;
  t.mock.method(globalThis, "fetch", async (url, opts = {}) => {
    if (!String(url).startsWith("https://api.soniox.com")) return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) };
    const p = String(url).replace("https://api.soniox.com", "");
    calls.push(`${opts.method || "GET"} ${p}`);
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (p === "/v1/files") return json({ id: "f1" });
    if (p === "/v1/transcriptions") return json({ id: "t1" });
    if (p === "/v1/transcriptions/t1") { if (finish) return json({ status: "completed" }); if (++polls === 2) ac.abort(); return json({ status: "processing" }); }
    if (p === "/v1/transcriptions/t1/transcript") return json({ tokens: [{ text: "好", start_ms: 0, end_ms: 500 }] });
    return json({});
  });
  const keys = ["SONIOX_API_KEY", "CYCLONE_CLAUDE_BIN", "CYCLONE_MEETING_SCRIBE_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SONIOX_API_KEY: "k", CYCLONE_CLAUDE_BIN: path.join(dir, "no-claude"), CYCLONE_MEETING_SCRIBE_URL: "http://127.0.0.1:9" });
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(dir, { recursive: true, force: true }); });
  const cache = path.join(dir, "asr.json");
  const prepare = (stopAt) => {
    ac = new AbortController();
    return prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], asrCache: cache, durationMs: 3000 },
      { work: fs.mkdtempSync(path.join(dir, ".work-")), signal: ac.signal, onStep: (s) => { if (s === stopAt) ac.abort(); } });
  };
  // 抽音時停：ffmpeg 被結束，沒有送 Soniox
  let e = await prepare("extract").catch((x) => x);
  assert.equal(e.cancelled, true, String(e?.message));
  assert.equal(calls.length, 0);
  // 辨識中停：雲端副本刪掉，沒有存快取、沒有 pending
  e = await prepare("none").catch((x) => x);
  assert.equal(e.cancelled, true, String(e?.message));
  assert.ok(calls.includes("DELETE /v1/transcriptions/t1") && calls.includes("DELETE /v1/files/f1"));
  assert.equal(e.report.soniox.cancelled, true);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(path.join(dir, "soniox-pending.json")), false);

  // 校對時停：辨識已經付費拿到，存著的結果要留下，重新開始不用再付
  finish = true;
  e = await prepare("proofread").catch((x) => x);
  assert.equal(e.cancelled, true, String(e?.message));
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).chars, [["好", 0, 500, null]]);

  // 作者字幕走說明欄那一步時停：是停止，不是「說明欄沒寫成」照樣做完
  const ac2 = new AbortController();
  const e2 = await prepareFromCaptions({ lang: "zh", proofreader: "claude" }, { cues: [{ start: 0, end: 1000, text: "大家好" }], signal: ac2.signal, onStep: (s) => { if (s === "describe") ac2.abort(); } }).catch((x) => x);
  assert.equal(e2?.cancelled, true, "停在說明欄要回報停止");
});

test("audio extraction runs in the background, so a stop can end ffmpeg midway (#67)", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, "long.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=600", "-c:a", "aac", video], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const work = fs.mkdtempSync(path.join(dir, ".work-"));
  const ac = new AbortController();
  let ticks = 0;
  const e = await prepareSubtitles({ video, privacy: "public", engine: "soniox", proofreader: "claude", terms: [], durationMs: 600_000 },
    { work, signal: ac.signal, onStep: (s) => { if (s === "extract") setTimeout(() => { ticks += 1; ac.abort(); }, 5); } }).catch((x) => x);
  assert.equal(e.cancelled, true, String(e?.message));
  assert.equal(ticks, 1);
  // 同步跑的話計時器要等抽完才輪得到，10 分鐘的聲音會整段抽完；背景跑會在中途被結束
  const audio = path.join(work, "audio.mp3");
  const size = fs.existsSync(audio) ? fs.statSync(audio).size : 0;
  assert.ok(size < 600 * 64_000 / 8 * 0.5, `ffmpeg 應該在中途被結束（寫了 ${size} bytes）`);
});

test("codex proofreading runs without shell, plugins or web search, like the meeting app (#165)", () => {
  const known = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "other_feature"];
  const args = codexDisableArgs(() => known);
  assert.deepEqual(args, ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser"].flatMap((n) => ["--disable", n]));
  // 這版 codex 不認得的名稱略過（不讓整個校對掛掉），但跑指令的開關一個都不認得就拒絕：寧可不校對也不開著 shell
  assert.deepEqual(codexDisableArgs(() => ["shell_tool", "plugins"]), ["--disable", "shell_tool", "--disable", "plugins"]);
  assert.throws(() => codexDisableArgs(() => ["plugins", "apps"]), /shell/i);
  // 查不到功能清單（舊版 codex、逾時、非 0）就拒絕：不能靠「名稱不對 codex 會自己報錯」這個假設，那版 codex 也可能只是略過
  assert.throws(() => codexDisableArgs(() => null), /cannot list/i);
});

test("the codex preset isolates the run: no user config or rules, no web search, tools disabled (#165)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-codex-"));
  const fake = path.join(dir, "codex");
  fs.writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = features ]; then printf 'shell_tool stable true\\nunified_exec stable true\\nplugins stable true\\n'; exit 0; fi\nexit 0\n", { mode: 0o755 });
  const prev = process.env.CYCLONE_CODEX_BIN;
  process.env.CYCLONE_CODEX_BIN = fake;
  try {
    const { args } = PRESETS.codex("prompt", dir, path.join(dir, "out.txt"));
    const joined = args.join(" ");
    for (const want of ["--sandbox read-only", "--ignore-user-config", "--ignore-rules", "web_search=\"disabled\"", "mcp_servers={}", "--disable shell_tool", "--disable unified_exec", "--disable plugins"]) {
      assert.ok(joined.includes(want), `缺 ${want}：${joined}`);
    }
  } finally {
    if (prev === undefined) delete process.env.CYCLONE_CODEX_BIN; else process.env.CYCLONE_CODEX_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed codex feature listing is not cached, so the next proofreading run tries again (#165)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-codex-cache-"));
  const fake = path.join(dir, "codex");
  const flag = path.join(dir, "ok");
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = features ]; then [ -e "${flag}" ] || exit 1; printf 'shell_tool stable true\\nplugins stable true\\n'; exit 0; fi\nexit 0\n`, { mode: 0o755 });
  const prev = process.env.CYCLONE_CODEX_BIN;
  process.env.CYCLONE_CODEX_BIN = fake;
  try {
    assert.throws(() => PRESETS.codex("p", dir, path.join(dir, "o")), /cannot list/i);
    fs.writeFileSync(flag, "");
    assert.ok(PRESETS.codex("p", dir, path.join(dir, "o")).args.includes("shell_tool"), "第二次要重新查，不是沿用第一次的失敗");
  } finally {
    if (prev === undefined) delete process.env.CYCLONE_CODEX_BIN; else process.env.CYCLONE_CODEX_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
