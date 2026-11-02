// AI 剪輯建議（recording-transcriber#6）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SUGGEST_RETRY, detectBlack, detectSilence, mergeSuggestions, parseBlack, parseSilence, phrasesFromTiming, rangesToSuggestions, suggestFromTranscript, validateSuggestions,
} from "../lib/cut-suggest.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const timingOf = (parts) => parts.flatMap(([text, start, step = 100]) => [...text].map((c, i) => [c, start + i * step, start + (i + 1) * step]));

test("ffmpeg detector output is parsed into source-time ranges", () => {
  const silence = "[silencedetect @ 0x1] silence_start: 2.5\n[silencedetect @ 0x1] silence_end: 6.25 | silence_duration: 3.75\n[silencedetect @ 0x1] silence_start: 58\n";
  assert.deepEqual(parseSilence(silence, 60_000), [{ start: 2500, end: 6250 }, { start: 58_000, end: 60_000 }], "靜音到片尾也算");
  assert.deepEqual(parseSilence("silence_start: -0.01\nsilence_end: 1.5", 9000), [{ start: 0, end: 1500 }]);
  assert.deepEqual(parseBlack("[blackdetect @ 0x2] black_start:0 black_end:3.2 black_duration:3.2\n"), [{ start: 0, end: 3200 }]);
});

test("detected ranges become padded suggestions; short leftovers are dropped", () => {
  const s = rangesToSuggestions([{ start: 0, end: 3000 }, { start: 10_000, end: 14_000 }, { start: 20_000, end: 21_200 }, { start: 58_000, end: 60_000 }], "silence", { durationMs: 60_000 });
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 2700], [10_300, 13_700], [58_300, 60_000]], "開頭與片尾不留邊；1.2 秒的留邊後太短");
  assert.equal(s[1].reason, "靜音 4 秒");
  assert.ok(s.every((x) => x.by === "ai" && x.kind === "silence"));
});

test("the transcript is split into numbered phrases at sentence ends and pauses", () => {
  const phrases = phrasesFromTiming(timingOf([["今天我們來談。", 0], ["嗯嗯", 2000], ["那個", 5000]]));
  assert.deepEqual(phrases.map((p) => [p.id, p.text, p.start, p.end]), [["P1", "今天我們來談。", 0, 700], ["P2", "嗯嗯", 2000, 2200], ["P3", "那個", 5000, 5200]]);
  assert.deepEqual(phrasesFromTiming([["x", "bad", 1], null, ["好", 0, 100]]).map((p) => p.text), ["好"]);
});

test("Claude's suggestions are trusted only for phrase ids and kinds; times come from the transcript", () => {
  const phrases = phrasesFromTiming(timingOf([["我們先看第一個。", 0], ["不對不對我重講。", 1500], ["我們先看第一個例子。", 3500], ["等一下我開一下檔案", 6000], ["好", 9000]]));
  const out = validateSuggestions({ cuts: [
    { from: "P1", to: "P2", kind: "retake", reason: "講錯重講" },
    { from: "P4", kind: "offtopic", reason: "操作電腦" },
    { from: "P3", to: "P1", kind: "retake" },
    { from: "P9", kind: "filler" },
    { from: "P5", kind: "delete_everything" },
    { from: "P5", kind: "silence" },
  ] }, phrases);
  assert.deepEqual(out.map((x) => [x.start, x.end, x.kind]), [[0, 2450, "retake"], [5850, 7050, "offtopic"]], "只有前兩條合格");
  assert.equal(out[0].reason, "口誤重講：講錯重講");
  assert.ok(out[0].end <= phrases[2].start, "不會切到下一句");
  assert.ok(out[1].start >= phrases[2].end && out[1].end <= phrases[4].start);
  assert.deepEqual(validateSuggestions({ nope: 1 }, phrases), []);
  assert.deepEqual(validateSuggestions({ cuts: [{ from: "P1", to: "P5", kind: "filler", reason: "x".repeat(200) }] }, phrases)[0].reason.length, 3 + 30);
});

test("suggestions from the transcript go through a proofreader session and come back validated", async () => {
  const asked = [];
  const session = { usage: { calls: 1 }, async ask(prompt) { asked.push(prompt); return '{"cuts":[{"from":"P2","kind":"filler","reason":"只有贅詞"}]}'; }, close() {} };
  const r = await suggestFromTranscript(timingOf([["開始上課。", 0], ["嗯嗯嗯", 2000], ["今天講分數。", 4000]]), { session });
  assert.match(asked[0], /\[P2 0:02\] 嗯嗯嗯/);
  assert.deepEqual(r.suggestions.map((x) => [x.start, x.end, x.kind]), [[1850, 2450, "filler"]]);
  assert.deepEqual((await suggestFromTranscript([], { session })).suggestions, []);
});

test("merging skips what is already cut, overlaps, and an implausible batch", () => {
  const sil = [{ start: 1000, end: 4000, by: "ai", kind: "silence", reason: "靜音" }];
  const ai = [{ start: 1500, end: 3500, by: "ai", kind: "filler", reason: "贅詞" }, { start: 10_000, end: 12_000, by: "ai", kind: "retake", reason: "重講" }, { start: 20_000, end: 21_000, by: "ai", kind: "offtopic", reason: "離題" }];
  const r = mergeSuggestions([sil, ai], [{ start: 19_900, end: 21_100 }], 60_000);
  assert.deepEqual(r.suggestions.map((x) => x.kind), ["silence", "retake"], "和靜音重疊的、已經剪掉的都不再建議");
  const greedy = mergeSuggestions([[{ start: 0, end: 50_000, by: "ai", kind: "offtopic", reason: "全部" }], sil], [], 60_000);
  assert.deepEqual(greedy.suggestions.map((x) => x.kind), ["silence"]);
  assert.match(greedy.dropped, /超過一半/);
});

test("silence and black frames are found in a real clip", { skip: !hasFfmpeg && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-suggest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, "v.mp4");
  // 0–3 秒黑畫面；聲音 4–8 秒安靜
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x120:r=10:d=12,drawbox=enable='lt(t,3)':c=black:t=fill",
    "-f", "lavfi", "-i", "sine=f=440:d=12,volume='if(between(t,4,8),0,1)':eval=frame", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const silence = await detectSilence(video, { durationMs: 12_000 });
  assert.equal(silence.length, 1);
  assert.ok(Math.abs(silence[0].start - 4000) < 150 && Math.abs(silence[0].end - 8000) < 150, JSON.stringify(silence));
  const black = await detectBlack(video);
  assert.equal(black.length, 1);
  assert.ok(black[0].start < 100 && Math.abs(black[0].end - 3000) < 150, JSON.stringify(black));
});

test("black detection retries without hardware decoding when this ffmpeg cannot use it", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-suggest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-hwaccel*) echo "Unrecognized hwaccel: videotoolbox" >&2; exit 1;; esac\necho "[blackdetect @ 0x1] black_start:0 black_end:2.5 black_duration:2.5" >&2\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  assert.deepEqual(await detectBlack("/dev/null"), [{ start: 0, end: 2500 }]);
});

test("stopping closes the agent between chunks; chunk edges still respect the neighbouring phrases", async () => {
  const timing = timingOf([["第一句。", 0], ["第二句。", 1000], ["第三句。", 2000]]);
  let closed = 0;
  const ac = new AbortController();
  const session = { usage: null, close() { closed += 1; }, async ask() { ac.abort(); return '{"cuts":[]}'; } };
  await assert.rejects(suggestFromTranscript(timing, { session, chunk: 1, signal: ac.signal }), /cancelled/);
  assert.equal(closed, 1, "停止時關掉 agent");
  // 一次只送一句：第二句的建議往前留邊時，不能超過第一句的結尾
  const one = { usage: null, close() {}, async ask(prompt) { return prompt.includes("P2") ? '{"cuts":[{"from":"P2","kind":"filler","reason":"x"}]}' : '{"cuts":[]}'; } };
  const r = await suggestFromTranscript(timingOf([["第一句。", 0], ["嗯。", 450], ["第三句。", 2000]]), { session: one, chunk: 1 });
  assert.deepEqual(r.suggestions.map((x) => [x.start, x.end]), [[400, 800]], "前面夾在第一句結尾（400），不是往前多留 150 ms");
});


test("one malformed reply is asked again, then skipped; the other chunks keep their suggestions (#36)", async () => {
  const timing = timingOf([["第一句。", 0], ["嗯。", 1000], ["第三句。", 2000], ["呃。", 3000]]);
  const good = (id) => `{"cuts":[{"from":"${id}","kind":"filler","reason":"只有贅詞"}]}`;
  const broken = '{"cuts":[{"from":"P2","kind":"filler","reason":"只說了"嗯","嗯"}]}';   // reason 裡的半形引號
  // 第二批第一次壞掉、重送後好了：建議完整
  let asked = [];
  let session = { usage: null, close() {}, async ask(prompt) {
    asked.push(prompt);
    if (prompt === SUGGEST_RETRY) return good("P4");
    return prompt.includes("P2") ? good("P2") : prompt.includes("P4") ? broken : '{"cuts":[]}';
  } };
  let r = await suggestFromTranscript(timing, { session, chunk: 2 });
  assert.equal(asked.filter((x) => x === SUGGEST_RETRY).length, 1, "壞的那批重送一次");
  assert.deepEqual(r.suggestions.map((x) => x.text), ["嗯。", "呃。"]);
  assert.deepEqual([r.chunks, r.failed], [2, []]);
  // 重送也壞：只缺那一批，另一批照常，failed 記下那批的時間
  session = { usage: null, close() {}, async ask(prompt) { return prompt.includes("P2") ? good("P2") : "抱歉，" + broken; } };
  r = await suggestFromTranscript(timing, { session, chunk: 2 });
  assert.deepEqual(r.suggestions.map((x) => x.text), ["嗯。"], "第一批的建議沒有被丟掉");
  assert.deepEqual(r.failed, [{ start: 2000, end: 3200 }]);
  // 不是格式問題（逾時、程式結束）照樣往外丟
  session = { usage: null, close() {}, async ask() { throw new Error("Claude timed out"); } };
  await assert.rejects(suggestFromTranscript(timing, { session, chunk: 2 }), /timed out/);
});
