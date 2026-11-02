// 剪接輸出與只辨識保留段（recording-transcriber#4）：用 ffmpeg 合成的假影片實際跑一次
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { burnSubtitles, ffmpegFull, isTrimmed, keepFilter, prepareSubtitles, videoDurationMs } from "../scripts/subtitle-run.mjs";
import { keepSegments, normalizeCuts, remapCues } from "../lib/cuts.mjs";
import { toSrt } from "../lib/subtitle-text.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// 每秒換一個顏色：第 0 秒紅、1 秒綠、2 秒藍、3 秒紅……，加一段 440 Hz 的聲音
function makeVideo(dir, seconds = 6) {
  const file = path.join(dir, "colors.mp4");
  const geq = "geq=r='255*eq(mod(floor(T),3),0)':g='255*eq(mod(floor(T),3),1)':b='255*eq(mod(floor(T),3),2)'";
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=160x120:r=10:d=${seconds},${geq}`,
    "-f", "lavfi", "-i", `sine=f=440:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return file;
}

// 某個時間點左上角的顏色：回傳 "r"、"g" 或 "b"
function colorAt(file, sec) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(sec), "-i", file, "-frames:v", "1", "-vf", "crop=16:16:0:0,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.equal(r.status, 0, String(r.stderr));
  const [R, G, B] = r.stdout;
  return R > G && R > B ? "r" : G > B ? "g" : "b";
}

test("a full keep counts as no edit", () => {
  assert.equal(isTrimmed([[0, 6000]], 6000), false);
  assert.equal(isTrimmed([], 6000), false);
  assert.equal(isTrimmed([[0, 5000]], 6000), true);
  assert.equal(isTrimmed([[500, 6000]], 6000), true);
  assert.equal(keepFilter([[0, 1000], [2000, 6000]], { video: false }),
    "[0:a:0]asplit=2[as0][as1];[as0]atrim=start=0.000:end=1.000,asetpts=PTS-STARTPTS[a0];[as1]atrim=start=2.000:end=6.000,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[aout]");
});

test("only the kept parts go to speech recognition", { skip: !hasFfmpeg && "no ffmpeg" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = makeVideo(dir);
  const keep = keepSegments([{ start: 1000, end: 2000 }, { start: 4500, end: 6000 }], 6000);
  const audio = path.join(dir, "a.mp3");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-filter_complex", keepFilter(keep, { video: false }), "-map", "[aout]",
    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", audio], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Math.abs(videoDurationMs(audio) - 3500) < 120, `音訊長度 ${videoDurationMs(audio)} ms，應該約 3500`);
});

test("the edited video joins the kept parts and burns subtitles at the edited times", { skip: (!hasFfmpeg || !ffmpegFull()) && "no ffmpeg with libass" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = makeVideo(dir);
  const cuts = normalizeCuts([{ start: 1000, end: 2000 }], 6000);   // 剪掉綠色的第 1 秒
  const keep = keepSegments(cuts, 6000);
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "subs.srt"), toSrt(remapCues([{ start: 2200, end: 2800, text: "藍色" }], cuts)));
  const out = path.join(dir, "out.mp4");
  let last = 0;
  await burnSubtitles({ video, srt: path.join(work, "subs.srt"), target: out, keep, onProgress: (x) => { last = x; } });
  assert.equal(last, 1);
  assert.ok(Math.abs(videoDurationMs(out) - 5000) < 150, `輸出長度 ${videoDurationMs(out)} ms，應該約 5000`);
  assert.equal(colorAt(out, 0.5), "r");
  assert.equal(colorAt(out, 1.5), "b", "剪掉的綠色那一秒不見了，接著就是藍色");
  assert.equal(colorAt(out, 2.5), "r");
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out], { encoding: "utf8" });
  assert.equal(probe.stdout.trim(), "aac", "聲音也一起剪接");
});

test("recognised words come back at source times when only the kept parts were sent", { skip: !hasFfmpeg && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = makeVideo(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // 假的 mlx_whisper：記下送來的音檔長度，回一句在接起來的音檔 1.2–1.8 秒講的話；假的 pi：不改字
  fs.writeFileSync(path.join(bin, "mlx_whisper"), `#!/bin/sh\nffprobe -v error -show_entries format=duration -of csv=p=0 "$1" > "${dir}/sent.txt"\nwhile [ "$1" != "--output-dir" ]; do shift; done\nprintf '{"segments":[{"words":[{"word":"接縫後面","start":1.2,"end":1.8}]}]}' > "$2/audio.json"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\necho '{"edits":[]}'\n`, { mode: 0o755 });
  const corr = path.join(dir, "corr.json");
  fs.writeFileSync(corr, JSON.stringify({ hints: [], fixed: [] }));
  const saved = { PATH: process.env.PATH, CYCLONE_CORRECTIONS_FILE: process.env.CYCLONE_CORRECTIONS_FILE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CYCLONE_CORRECTIONS_FILE = corr;
  t.after(() => { process.env.PATH = saved.PATH; if (saved.CYCLONE_CORRECTIONS_FILE === undefined) delete process.env.CYCLONE_CORRECTIONS_FILE; else process.env.CYCLONE_CORRECTIONS_FILE = saved.CYCLONE_CORRECTIONS_FILE; });
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  // 剪掉 1–3 秒：接起來的音檔 1.2 秒，是原片的 3.2 秒
  const keep = keepSegments([{ start: 1000, end: 3000 }], 6000);
  const r = await prepareSubtitles({ video, privacy: "public", engine: "whisper", proofreader: "pi", terms: [], keep, durationMs: 6000 }, { work });
  assert.ok(Math.abs(Number(fs.readFileSync(path.join(dir, "sent.txt"), "utf8")) - 4) < 0.1, "只送了保留的 4 秒");
  assert.equal(r.report.kept_ms, 4000);
  assert.equal(r.cues[0].start, 3200);
  assert.equal(r.cues[0].end, 3800);
  assert.deepEqual(r.timing[0], ["接", 3200, 3350]);
});

test("cut only: the kept parts are joined without burning subtitles", { skip: !hasFfmpeg && "no ffmpeg" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-trim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = makeVideo(dir);
  const keep = keepSegments([{ start: 1000, end: 2000 }], 6000);
  const out = path.join(dir, "cut.mp4");
  await burnSubtitles({ video, srt: path.join(dir, "none.srt"), target: out, keep, subtitles: false });
  assert.ok(Math.abs(videoDurationMs(out) - 5000) < 150);
  assert.equal(colorAt(out, 1.5), "b");
  await assert.rejects(burnSubtitles({ video, srt: path.join(dir, "none.srt"), target: out, keep: [[0, 6000]], subtitles: false }), /nothing to cut/);
});

