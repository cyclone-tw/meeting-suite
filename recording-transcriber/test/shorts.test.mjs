// 長片切直式短片（recording-transcriber#54）：片段對齊、剪輯換算、版面、ASS、ffmpeg 指令、AI 建議整理
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AI_TARGET_MAX_MS, H, MAX_MS, W, fitLength, liveCues, moveEdge, nextN, rangeFrom, shortAss, shortCues, shortKeep, shortLayout, shortLength,
  shortsFromAi, snapRange, validateShorts,
} from "../lib/shorts.mjs";
import { ffmpegFull, renderShort, shortArgs, videoSize } from "../scripts/subtitle-run.mjs";
import { suggestShorts } from "../lib/subtitle-ai.mjs";

// 每句 10 秒：第 i 句是 [i*10s+500, i*10s+9500]
const cues = (n = 30) => Array.from({ length: n }, (_, i) => ({ start: i * 10_000 + 500, end: i * 10_000 + 9500, text: `第${i}句` }));

test("a range snaps to whole sentences and skips sentences that were cut", () => {
  const c = cues();
  assert.deepEqual(snapRange(12_000, 38_000, c), { start: 10_500, end: 39_500 }, "從句中開始也對到那句的開頭，結尾對到包含它的那句結尾");
  assert.deepEqual(snapRange(9_700, 20_200, c), { start: 10_500, end: 19_500 }, "落在兩句之間：開頭往後、結尾往前");
  const cuts = [{ start: 10_000, end: 20_000 }];
  assert.deepEqual(liveCues(c, cuts).slice(0, 2).map((x) => x.text), ["第0句", "第2句"], "整句剪掉的不算");
  assert.deepEqual(snapRange(12_000, 38_000, c, cuts), { start: 20_500, end: 39_500 }, "開頭不能是被剪掉的句子");
  assert.equal(snapRange(400_000, 500_000, c), null, "片尾之後沒有字幕");
});

test("a short joins around cuts, and its subtitles move to short time", () => {
  const c = cues();
  const item = { start: 10_500, end: 39_500 };
  const cuts = [{ start: 19_500, end: 20_500 }, { start: 25_000, end: 26_000 }, { start: 50_000, end: 60_000 }];
  assert.deepEqual(shortKeep(item, cuts), [[10_500, 19_500], [20_500, 25_000], [26_000, 39_500]]);
  assert.equal(shortLength(item, cuts), 27_000);
  const sc = shortCues(item, c, cuts);
  assert.deepEqual(sc[0], { start: 0, end: 9000, text: "第1句" });
  assert.deepEqual(sc[1], { start: 9000, end: 17_000, text: "第2句" }, "第 2 句中間被剪掉一秒：長度少一秒");
  assert.equal(sc.at(-1).end, 27_000, "最後一句收在短片結尾");
  assert.deepEqual(shortKeep(item, []), [[10_500, 39_500]]);
});

test("moving edges goes sentence by sentence and refuses to go too short or too long", () => {
  const c = cues();
  const item = { id: "a", start: 10_500, end: 39_500 };
  assert.equal(moveEdge(item, "start", -1, c).start, 500, "開頭早一句");
  assert.equal(moveEdge(item, "start", 1, c).start, 20_500, "開頭晚一句");
  assert.equal(moveEdge(item, "end", 1, c).end, 49_500);
  assert.equal(moveEdge(item, "end", -1, c).end, 29_500);
  assert.equal(moveEdge({ start: 500, end: 9500 }, "start", -1, c), null, "已經是第一句");
  assert.equal(moveEdge({ start: 10_500, end: 19_500 }, "end", -1, c), null, "結尾不能早過開頭");
  const long = { start: 500, end: (MAX_MS / 10_000 - 1) * 10_000 + 9500 };
  assert.equal(moveEdge(long, "end", 1, c), null, "超過 3 分鐘");
  assert.equal(moveEdge(item, "start", 1, c, [{ start: 20_000, end: 30_000 }]).start, 30_500, "晚一句時跳過被剪掉的句子");
});

test("adding from the playhead starts at the next sentence and grows to about 45 seconds", () => {
  const c = cues();
  const r = rangeFrom(12_000, c);
  assert.equal(r.start, 10_500);
  assert.ok(shortLength(r) >= 45_000 && shortLength(r) <= AI_TARGET_MAX_MS, String(shortLength(r)));
  assert.equal(rangeFrom(9_800, c).start, 10_500, "兩句之間：從下一句開始");
  assert.equal(rangeFrom(999_000, c), null);
  assert.equal(nextN([{ n: 3 }, { n: 7 }]), 8);
  assert.equal(nextN([]), 1);
});

test("AI suggestions are snapped, shortened, de-overlapped, sorted and capped", () => {
  const c = cues(40);
  const items = shortsFromAi([
    { start: "00:03:00", end: "00:04:00", title: "第二段", reason: "完整的例子" },
    { start: "00:00:12", end: "00:03:30", title: "  太長的一段  要截短 ", reason: "x" },   // 3 分多：截到 90 秒內
    { start: "00:03:20", end: "00:03:50", title: "和第二段重疊", reason: "" },
    { start: "00:05:00", end: "00:05:05", title: "太短", reason: "" },
    { start: "bad", end: "00:01:00", title: "格式錯" },
    { start: "00:06:00", end: "00:07:00", title: "" },
    { start: "5:40", end: "5:59", title: "沒有小時的時間也可以，標題超過二十個字會被截掉喔喔喔喔", reason: "r" },
  ], c, [], { makeId: (i) => `x${i}` });
  assert.deepEqual(items.map((x) => x.title), ["太長的一段 要截短", "第二段", "沒有小時的時間也可以，標題超過二十個字會"]);
  assert.deepEqual(items.map((x) => x.id), ["x0", "x1", "x2"], "照時間排好再編號");
  assert.equal(items[0].start, 10_500);
  assert.ok(shortLength(items[0]) <= AI_TARGET_MAX_MS);
  assert.equal(items[1].start, 180_500);
  assert.ok(items.every((x) => x.by === "ai"));
  assert.equal(shortsFromAi(Array.from({ length: 9 }, (_, i) => ({ start: `00:0${i}:00`, end: `00:0${i}:50`, title: `t${i}` })), c).length, 5, "最多 5 段");
  assert.deepEqual(fitLength({ start: 500, end: 9500 }, c), { start: 500, end: 9500 }, "只有一句就不截");
});

test("the AI step sees only kept sentences and stops on abort", async () => {
  const c = cues(12);
  let asked = "";
  const session = { usage: null, async ask(q) { asked = q; return JSON.stringify({ shorts: [{ start: "00:00:30", end: "00:01:05", title: "重點", reason: "好" }] }); }, close() {} };
  const r = await suggestShorts(c, { cuts: [{ start: 40_000, end: 50_000 }], chapters: "00:00 開場", session, makeId: (i) => `k${i}` });
  assert.doesNotMatch(asked, /第4句/, "剪掉的句子不給 AI");
  assert.match(asked, /第3句/);
  assert.match(asked, /00:00 開場/);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, "k0");
  const ac = new AbortController();
  const slow = { usage: null, ask: () => new Promise((_, rej) => { slow.close = () => rej(new Error("closed")); }), close() {} };
  const p = suggestShorts(c, { session: slow, signal: ac.signal });
  ac.abort();
  slow.close();
  await assert.rejects(p, /cancelled/);
});

test("the page's list is validated and re-snapped; it cannot set output records", () => {
  const c = cues();
  const ok = validateShorts([{ id: "a-1", n: 1, title: " 標題 ", start: 12_000, end: 41_000, by: "ai", output: { file: "../../x.mp4" } }], c);
  assert.deepEqual(ok, [{ id: "a-1", n: 1, title: "標題", reason: "", by: "ai", start: 10_500, end: 49_500 }]);
  assert.throws(() => validateShorts("x", c), /格式/);
  assert.throws(() => validateShorts([{ id: "A B", n: 1, start: 0, end: 20_000 }], c), /編號/);
  assert.throws(() => validateShorts([{ id: "a", n: 1, start: 0, end: 20_000 }, { id: "a", n: 2, start: 0, end: 20_000 }], c), /編號/);
  assert.throws(() => validateShorts([{ id: "a", n: 1, start: 0, end: 20_000 }, { id: "b", n: 1, start: 0, end: 20_000 }], c), /序號/);
  assert.throws(() => validateShorts([{ id: "a", n: 1, start: 0, end: 290_000 }], c), /之間/, "超過 3 分鐘");
  assert.throws(() => validateShorts([{ id: "a", n: 1, start: 10_000, end: 20_000 }], c, [{ start: 0, end: 100_000 }]), /沒有字幕/);
  assert.throws(() => validateShorts(Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, n: i + 1, start: 0, end: 20_000 })), c), /最多/);
});

test("layout puts the title above and subtitles below a landscape video, and overlays them on a portrait one", () => {
  const wide = shortLayout(1920, 1080);
  assert.deepEqual([wide.vw, wide.vh, wide.x, wide.top], [1080, 608, 0, 656]);
  assert.deepEqual(wide.title, { align: 2, marginV: H - 656 + 48 });
  assert.deepEqual(wide.sub, { align: 8, marginV: 656 + 608 + 48 });
  const four3 = shortLayout(1440, 1080);
  assert.equal(four3.vh, 810);
  assert.equal(four3.title.align, 2);
  const tall = shortLayout(1080, 1920);
  assert.deepEqual([tall.vw, tall.vh, tall.top], [W, H, 0]);
  assert.equal(tall.title.align, 8, "直式影片：標題疊在上方");
  assert.equal(tall.sub.align, 2);
  const odd = shortLayout(0, 0);
  assert.equal(odd.vh % 2, 0, "讀不到尺寸：當 16:9");
});

test("the ASS file escapes control characters and keeps the title up for the whole short", () => {
  const ass = shortAss({ title: "標題 {\\b1}", cues: [{ start: 0, end: 1500, text: "第一行\n第二行 {x}" }], durationMs: 61_230, layout: shortLayout(1920, 1080), style: "outline" });
  assert.match(ass, /^PlayResX: 1080$/m);
  assert.match(ass, /^PlayResY: 1920$/m);
  assert.match(ass, /^Dialogue: 0,0:00:00\.00,0:01:01\.23,Title,,0,0,0,,標題 ｛＼b1｝$/m);
  assert.match(ass, /^Dialogue: 0,0:00:00\.00,0:00:01\.50,Sub,,0,0,0,,第一行\\N第二行 ｛x｝$/m);
  assert.match(ass, /^Style: Title,PingFang TC,96,.*,2,70,70,1312,1$/m);
  assert.doesNotMatch(shortAss({ title: "  ", cues: [], durationMs: 1000, layout: shortLayout(1920, 1080) }), /,Title,,/, "沒有標題就不放");
});

test("the ffmpeg command joins kept parts, blurs a background, overlays the video and burns the ASS in one pass", () => {
  const args = shortArgs({ video: "/v/a.mp4", keep: [[1000, 5000], [6000, 9000]], layout: shortLayout(1920, 1080), ass: "short.ass", audio: true, target: "/out/s.mp4" });
  const f = args[args.indexOf("-filter_complex") + 1];
  assert.match(f, /^\[0:v:0\]split=2\[vs0\]\[vs1\];/);
  assert.match(f, /\[vs0\]trim=start=1\.000:end=5\.000/);
  assert.match(f, /\[vs1\]trim=start=6\.000:end=9\.000/);
  assert.match(f, /\[bgsrc\]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=/);
  assert.match(f, /\[fgsrc\]scale=1080:608,setsar=1\[fg\];\[bg\]\[fg\]overlay=0:656,subtitles=short\.ass\[vsub\]$/);
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "[vsub]", "-map", "[aout]"]);
  assert.ok(args.includes("h264_videotoolbox"));
  assert.equal(args.filter((x) => x === "-i").length, 1, "只讀一次原片");
  const silent = shortArgs({ video: "/v/a.mp4", keep: [[0, 3000]], layout: shortLayout(1920, 1080), ass: "short.ass", audio: false, target: "/out/s.mp4" });
  assert.ok(silent.includes("-an"));
  assert.doesNotMatch(silent[silent.indexOf("-filter_complex") + 1], /asplit|aout/);
});

// 真的編一支：8 秒的合成影片，中間剪掉 0.5 秒，輸出 1080×1920、含聲音、長度對
test("a real short encodes to 1080x1920 with audio and the kept length", { skip: !ffmpegFull() && "no ffmpeg-full" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-short-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, "src.mp4");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src], { encoding: "utf8" });
  assert.equal(mk.status, 0, mk.stderr);
  const item = { start: 1000, end: 7000, title: "合成影片測試" };
  const cuts = [{ start: 3000, end: 3500 }];
  const keep = shortKeep(item, cuts);
  const layout = shortLayout(videoSize(src).w, videoSize(src).h);
  const ass = path.join(dir, "short.ass");
  fs.writeFileSync(ass, shortAss({ title: item.title, cues: shortCues(item, [{ start: 1200, end: 6800, text: "字幕" }], cuts), durationMs: shortLength(item, cuts), layout }));
  let progress = 0;
  await renderShort({ video: src, ass, target: path.join(dir, "out.mp4"), keep, layout, onProgress: (x) => { progress = x; } });
  assert.equal(progress, 1);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path.join(dir, "out.mp4")], { encoding: "utf8" });
  const info = JSON.parse(probe.stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(info.format.duration) - 5.5) < 0.2, info.format.duration);
  // 停止：signal 一中止，ffmpeg 就結束、不留成品
  const ac = new AbortController();
  const p = renderShort({ video: src, ass, target: path.join(dir, "stop.mp4"), keep, layout, signal: ac.signal });
  ac.abort();
  await assert.rejects(p);
});
