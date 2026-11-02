import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BOX, EM, boxAss, boxDialogues, boxLayout, cueLines, roundedRect, styleOf, widthEm, wrapLine } from "../lib/subtitle-box.mjs";
import { measureAdvances } from "../lib/text-measure.mjs";
import { ffmpegFull, subtitlesFilter, writeBurnSubtitles } from "../scripts/subtitle-run.mjs";
import { shortAss, shortLayout } from "../lib/shorts.mjs";

test("a one-line box has equal padding above and below the text", () => {
  for (const fs_ of [56, 75, 90, 76]) {
    const b = boxLayout([{ text: "你現在感受到最大的壓力", fs: fs_ }]);
    const em = fs_ * EM;
    const above = b.lines[0].cy - em / 2, below = b.h - (b.lines[0].cy + em / 2);
    assert.ok(Math.abs(above - below) <= 1, `fs ${fs_}: 上 ${above} 下 ${below}`);
    assert.equal(b.w, Math.round(11 * em + 2 * b.padX), "中文字一個 1 em，左右各留 padX");
  }
});

test("a two-line box takes different sizes and colours per line (bilingual layout)", () => {
  const lines = [{ text: "你好", fs: 80, colour: BOX.zh }, { text: "Hello there", fs: 56, colour: BOX.en, bold: false }];
  const b = boxLayout(lines, { H: 0.7, e: 0.55, l: 0.25, o: 0.55, " ": 0.3, t: 0.33, h: 0.55, r: 0.35 });
  const padY = Math.round(80 * BOX.padY), gap = Math.round(80 * BOX.gap);
  assert.equal(b.h, Math.round(padY + 80 * EM + gap + 56 * EM + padY));
  assert.ok(b.lines[1].cy > b.lines[0].cy);
  const ev = boxDialogues({ start: 0, end: 1000, lines, anchor: { x: 960, bottom: 1000 } });
  assert.equal(ev.length, 3, "一個框加兩行字");
  assert.match(ev[0], /^Dialogue: 0,0:00:00\.00,0:00:01\.00,BoxBg,,0,0,0,,\{\\pos\(\d+,\d+\)\\p1\}m /);
  assert.match(ev[2], /\\fs56/, "第二行自己的字級");
  assert.match(ev[2], /\\1c&HDADADA&/, "第二行淺灰白");
  assert.match(ev[2], /\\b0/, "第二行不加粗");
  assert.doesNotMatch(ev[1], /\\fs|\\1c/, "第一行用樣式本身的字級與淡黃色");
  const top = Number(/\\pos\(\d+,(\d+)\)/.exec(ev[0])[1]);
  assert.equal(top + b.h, 1000, "框的下緣對齊 anchor.bottom");
});

test("long lines wrap by measured width and never split an English word", () => {
  assert.deepEqual(wrapLine("一二三四五六七八九十", 4), ["一二三四", "五六七八", "九十"]);
  const adv = Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz"].map((c) => [c, 0.5]));
  adv[" "] = 0.3;
  const out = wrapLine("where do you feel the most pressure", 6, adv);
  for (const l of out) assert.ok(widthEm(l, adv) <= 6, l);
  assert.equal(out.join(" "), "where do you feel the most pressure", "只在空白斷開");
  assert.deepEqual(cueLines("短\n第二行", { fs: 75, maxWidthPx: 1700 }).map((l) => l.text), ["短", "第二行"], "原本的換行保留");
});

test("the rounded rectangle path spans exactly w by h", () => {
  const d = roundedRect(300, 80, 12);
  assert.match(d, /^m 12 0 l 288 0 b /);
  const nums = d.replace(/[mlb]/g, " ").trim().split(/\s+/).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 300, 0, 80]);
  assert.equal(boxLayout([{ text: "字", fs: 400 }]).radius <= boxLayout([{ text: "字", fs: 400 }]).h / 2, true);
});

test("a full ASS uses the video resolution, sits above the bottom margin and escapes control characters", () => {
  const ass = boxAss({ cues: [{ start: 0, end: 2000, text: "測試 {\\b1}" }, { start: 2000, end: 3000, text: "  " }], width: 1920, height: 1080, fs: 75 });
  assert.match(ass, /^PlayResX: 1920$/m);
  assert.match(ass, /^PlayResY: 1080$/m);
  assert.match(ass, /^Style: BoxText,PingFang TC,75,&H008EE9F7,/m, "中文淡黃、粗體");
  assert.match(ass, /^Style: BoxBg,PingFang TC,75,&H52000000,/m, "黑色 68% 不透明");
  assert.match(ass, /測試 ｛＼b1｝$/m);
  assert.equal([...ass.matchAll(/,BoxBg,/g)].length, 1, "空白的字幕不畫框");
  const b = boxLayout([{ text: "測試 {\\b1}", fs: 75 }]);
  const top = Number(/BoxBg,,0,0,0,,\{\\pos\(\d+,(\d+)\)/.exec(ass)[1]);
  assert.equal(top + b.h, 1080 - Math.round(1080 * BOX.bottom));
});

test("old projects without a style get the new box style", () => {
  assert.equal(styleOf({}), "box");
  assert.equal(styleOf({ subtitle_style: "outline" }), "outline");
  assert.equal(styleOf({ subtitle_style: "weird" }), "box");
});

test("the burn file is ASS for the box style and SRT for the outline style", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-box-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cues = [{ start: 0, end: 1000, text: "字幕" }];
  let measured = null;
  const ass = writeBurnSubtitles({ dir, cues, video: "/nope.mp4", size: "large", style: "box", dims: { w: 3840, h: 2160 }, measure: (texts) => { measured = texts; return {}; } });
  assert.equal(path.basename(ass), "subs.ass");
  assert.deepEqual(measured, ["字幕"]);
  assert.match(fs.readFileSync(ass, "utf8"), /^Style: BoxText,PingFang TC,180,/m, "大字級 24／288 × 2160");
  assert.equal(subtitlesFilter(ass, "large"), "subtitles=subs.ass", "ASS 自帶樣式，不加 force_style");
  const srt = writeBurnSubtitles({ dir, cues, video: "/nope.mp4", style: "outline" });
  assert.equal(path.basename(srt), "subs.srt");
  assert.match(fs.readFileSync(srt, "utf8"), /00:00:00,000 --> 00:00:01,000/);
  assert.match(subtitlesFilter(srt, "large"), /^subtitles=subs\.srt:force_style='.*FontSize=24,Outline=2/);
});

test("shorts put the box under the video and keep the outline style on request", () => {
  const layout = shortLayout(1920, 1080);
  const box = shortAss({ title: "標題", cues: [{ start: 0, end: 1000, text: "怎麼用" }], durationMs: 1000, layout });
  const top = Number(/BoxBg,,0,0,0,,\{\\pos\(\d+,(\d+)\)/.exec(box)[1]);
  assert.equal(top, layout.sub.marginV, "框的上緣在影片下方");
  assert.doesNotMatch(box, /,Sub,,0,0,0,,怎麼用/);
  const tall = shortLayout(1080, 1920);
  const b2 = shortAss({ title: "", cues: [{ start: 0, end: 1000, text: "怎麼用" }], durationMs: 1000, layout: tall });
  const b = boxLayout([{ text: "怎麼用", fs: 76 }]);
  assert.equal(Number(/BoxBg,,0,0,0,,\{\\pos\(\d+,(\d+)\)/.exec(b2)[1]) + b.h, 1920 - tall.sub.marginV, "直式原片：框的下緣離畫面下緣 marginV");
  assert.match(shortAss({ title: "", cues: [{ start: 0, end: 1000, text: "怎麼用" }], durationMs: 1000, layout, style: "outline" }), /,Sub,,0,0,0,,怎麼用$/m);
});

test("measuring widths keeps sane numbers and falls back to nothing when osascript fails", () => {
  const ok = measureAdvances(["中a"], { run: () => ({ status: 0, stdout: JSON.stringify({ 中: 1, a: 0.56, x: -1, y: "z" }) }) });
  assert.deepEqual(ok, { 中: 1, a: 0.56 });
  assert.deepEqual(measureAdvances(["中"], { run: () => ({ status: 1, stdout: "" }) }), {});
  assert.deepEqual(measureAdvances(["中"], { run: () => { throw new Error("no osascript"); } }), {});
  assert.deepEqual(measureAdvances([""], { run: () => { throw new Error("not called"); } }), {});
});

// 實際用 libass 燒一格，量框與字的像素：只有中文時，字在框裡上下置中（差 ≤ 2px），左右也置中
function burnFrame({ w, h, ass, dir }) {
  fs.writeFileSync(path.join(dir, "t.ass"), ass);
  const r = spawnSync(ffmpegFull(), ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${w}x${h}:d=1`, "-vf", "subtitles=t.ass", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { cwd: dir, maxBuffer: w * h * 3 + 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
function bounds(buf, w, h, pred) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (pred(buf[i], buf[i + 1], buf[i + 2])) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x0, y0, x1, y1 };
}
const isYellow = (r, g, b) => r > 170 && g > 160 && b < 150;
const isBox = (r, g, b) => r < 60 && g < 60 && b < 60;

test("burned for real: Chinese-only text sits in the middle of the rounded box", { skip: !ffmpegFull() && "no ffmpeg-full" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-box-burn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    { w: 1920, h: 1080, fs: Math.round(16 * 1080 / 288), text: "你現在感受到最大的壓力來自哪裡" },
    { w: 1920, h: 1080, fs: Math.round(20 * 1080 / 288), text: "畫質只壓一次" },
    { w: 1920, h: 1080, fs: Math.round(24 * 1080 / 288), text: "今天我們來談談怎麼用字幕工作室" },
  ];
  const report = [];
  for (const c of cases) {
    const ass = boxAss({ cues: [{ start: 0, end: 5000, text: c.text }], width: c.w, height: c.h, fs: c.fs, adv: measureAdvances([c.text]) });
    const buf = burnFrame({ w: c.w, h: c.h, ass, dir });
    const box = bounds(buf, c.w, c.h, isBox), ink = bounds(buf, c.w, c.h, isYellow);
    const top = ink.y0 - box.y0, bottom = box.y1 - ink.y1, left = ink.x0 - box.x0, right = box.x1 - ink.x1;
    report.push({ fs: c.fs, top, bottom, left, right });
    assert.ok(Math.abs(top - bottom) <= 2, `fs ${c.fs}：上 ${top}px、下 ${bottom}px`);
    assert.ok(Math.abs(left - right) <= 3, `fs ${c.fs}：左 ${left}px、右 ${right}px`);
    assert.ok(left > c.fs * 0.3 && right > c.fs * 0.3, "左右留白不能被字吃掉");
  }
  t.diagnostic(JSON.stringify(report));
});
