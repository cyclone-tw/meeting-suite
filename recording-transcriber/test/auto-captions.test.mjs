// YouTube 連結專案沒有作者字幕（#182）：自動字幕 json3 → 字幕、只抓音檔與自動字幕的 yt-dlp 參數、辨識快取用影片 id
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cuesToVtt, json3Cues, tidyText, vttTime } from "../lib/auto-captions.mjs";
import { autoOrigTrack, fetchAudio, fetchAutoCaptions, parseVtt } from "../lib/youtube-source.mjs";
import { asrCached, sonioxPendingKey } from "../scripts/subtitle-run.mjs";

const JSON3 = { events: [
  { tStartMs: 0, dDurationMs: 999999, id: 1 },
  { tStartMs: 100, dDurationMs: 4500, segs: [{ utf8: "大家" }, { utf8: "好" }] },
  { tStartMs: 2311, dDurationMs: 2289, aAppend: 1, segs: [{ utf8: "\n" }] },
  { tStartMs: 2321, dDurationMs: 1000, segs: [{ utf8: "今天  講" }, { utf8: "\n資源班" }] },
  { tStartMs: 9000, dDurationMs: 0, segs: [{ utf8: "長度是零" }] },
  { tStartMs: 9500, dDurationMs: 1500, segs: [{ utf8: "  " }] },
  { tStartMs: "x", segs: [{ utf8: "壞的" }] },
] };

test("json3Cues keeps text events, skips line-break and empty ones, and ends each cue before the next starts", () => {
  assert.deepEqual(json3Cues(JSON3), [
    { start: 100, end: 2321, text: "大家好" },
    { start: 2321, end: 3321, text: "今天講資源班" },                 // 中文字之間的換行不變成空白（#186）
    { start: 9000, end: 10000, text: "長度是零" },                    // 沒有長度：給最短 1 秒（#186；後面那段只有空白，不算）
  ]);
  assert.deepEqual(json3Cues(null), []);
  assert.deepEqual(json3Cues({ events: "x" }), []);
});

// #186：起點一樣的兩段併成一句（原本前一段會變 0 長度被丟掉）；最後一段沒有長度給 1 秒；英文、韓文的空白照留
test("json3Cues merges events that start together, gives zero-length ones a minimum, and only drops spaces between CJK characters", () => {
  const cues = json3Cues({ events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "第一段" }] },
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "同時開始" }] },
    { tStartMs: 4000, segs: [{ utf8: "hello\nworld" }] },
  ] });
  assert.deepEqual(cues, [
    { start: 0, end: 3000, text: "第一段同時開始" },
    { start: 4000, end: 5000, text: "hello world" },
  ]);
  assert.equal(tidyText("今天 講\n資源班 OK 嗎？ 好的"), "今天講資源班 OK 嗎？好的");
  assert.equal(tidyText("ひらがな カタカナ 漢字"), "ひらがなカタカナ漢字");
  assert.equal(tidyText("안녕 하세요"), "안녕 하세요", "韓文用空白分詞，不動");
});

test("cuesToVtt writes a VTT that the caption parser reads back", () => {
  assert.equal(vttTime(3_723_004), "01:02:03.004");
  const cues = json3Cues(JSON3);
  const vtt = cuesToVtt(cues);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.100 --> 00:00:02\.321\n大家好\n/);
  assert.deepEqual(parseVtt(vtt).map((c) => [c.start, c.end, c.text]), cues.map((c) => [c.start, c.end, c.text]));
});

test("autoOrigTrack only takes the original-language track", () => {
  const info = { automatic_captions: { "en-orig": true, "zh-Hant": true, "zh-Hant-orig": true, ja: true } };
  assert.equal(autoOrigTrack(info, "zh"), "zh-Hant-orig");
  assert.equal(autoOrigTrack(info, "en"), "en-orig");
  assert.equal(autoOrigTrack(info, "ja"), "", "日文那軌是機器翻譯，不用");
  assert.equal(autoOrigTrack({}, "zh"), "");
});

test("audio-only and auto-caption downloads ask yt-dlp for just that, with the url after --", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-auto-"));
  const calls = [];
  const run = async (args, { onLine } = {}) => {
    calls.push(args);
    if (args.includes("--write-auto-subs")) fs.writeFileSync(path.join(dir, "auto-captions.zh-Hant-orig.json3"), "{}");
    else { const f = path.join(dir, "audio.m4a"); fs.writeFileSync(f, "a"); onLine?.("PROG 50 100 NA"); onLine?.(`FILE ${f}`); }
    return { code: 0, stdout: "", stderr: "" };
  };
  const seen = [];
  assert.equal(await fetchAudio("qeFmbs9XaVg", dir, { run, onProgress: (x) => seen.push(x) }), path.join(dir, "audio.m4a"));
  assert.deepEqual(calls[0].slice(-2), ["--", "https://www.youtube.com/watch?v=qeFmbs9XaVg"]);
  assert.equal(calls[0][calls[0].indexOf("-f") + 1], "bestaudio[ext=m4a]/bestaudio", "只要音軌");
  assert.deepEqual(seen, [0.5, 1]);
  assert.equal(path.basename(await fetchAutoCaptions("qeFmbs9XaVg", "zh-Hant-orig", dir, { run })), "auto-captions.zh-Hant-orig.json3");
  assert.ok(calls[1].includes("--skip-download") && calls[1].includes("json3"));
  assert.deepEqual(calls[1].slice(-2), ["--", "https://www.youtube.com/watch?v=qeFmbs9XaVg"]);
  await assert.rejects(fetchAutoCaptions("qeFmbs9XaVg", "zh,.*", dir, { run }), /字幕軌的名稱不對/);
  await assert.rejects(fetchAudio("--exec", dir, { run }), /影片網址的格式不對/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the recognition cache can be keyed by the YouTube id, so the deleted audio is not needed again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-cache-"));
  const file = path.join(dir, "asr.json");
  assert.equal(asrCached(file, { cacheId: "youtube:qeFmbs9XaVg" }), false, "沒有快取檔");
  fs.writeFileSync(file, JSON.stringify({ key: JSON.stringify({ source: "youtube:qeFmbs9XaVg", engine: "soniox" }), keep: null, chars: [["今", 0, 100, null]] }));
  assert.equal(asrCached(file, { cacheId: "youtube:qeFmbs9XaVg" }), true);
  assert.equal(asrCached(file, { cacheId: "youtube:abcdefghijk" }), false, "別支影片不算");
  assert.equal(asrCached(file, { cacheId: "youtube:qeFmbs9XaVg", lang: "en" }), false, "外語片的鍵帶語言");
  fs.rmSync(dir, { recursive: true, force: true });
});

// #186：斷線中斷的辨識接回去用的鍵：有 cacheId 時和暫存音檔的路徑無關（每次都在新的工作資料夾），沒有時照舊用影片
test("the Soniox pending key uses the cache id, not the throwaway audio path", () => {
  const o = { engine: "soniox", lang: "zh", cacheId: "youtube:qeFmbs9XaVg" };
  const a = sonioxPendingKey("/tmp/x/.work-aaa/audio.m4a", o, null);
  assert.equal(a, sonioxPendingKey("/tmp/x/.work-bbb/audio.m4a", o, null), "換了暫存資料夾也對得上");
  assert.doesNotMatch(a, /audio\.m4a/);
  assert.match(a, /youtube:qeFmbs9XaVg/);
  assert.notEqual(a, sonioxPendingKey("/tmp/x/.work-aaa/audio.m4a", { ...o, cacheId: "youtube:abcdefghijk" }, null), "別支影片不共用");
  assert.match(sonioxPendingKey("/tmp/v.mp4", { engine: "soniox", lang: "zh" }, [[0, 1000]]), /\/tmp\/v\.mp4.*\[\[0,1000\]\]/, "沒有 cacheId：用影片與剪輯範圍");
});
