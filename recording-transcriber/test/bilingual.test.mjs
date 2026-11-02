// 外語影片雙語字幕（recording-transcriber#56）：網址、字幕來源、VTT、翻譯、雙語版面、英文切句
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseLang, captionSource, fetchVideo, parseVtt, pickInfo, youtubeId } from "../lib/youtube-source.mjs";
import { batchPrompt, cleanTranslation, readBatch, translateCues } from "../lib/subtitle-translate.mjs";
import { BOX, boxAss, cueBoxLines, displayParts, displayText, EM, SUB_SCALE } from "../lib/subtitle-box.mjs";
import { buildCues, cueOptsFor } from "../lib/subtitle-text.mjs";
import { keepTranslations, readProject, validateCues, writeProject } from "../lib/studio-project.mjs";
import * as ops from "../lib/cue-ops.mjs";
import { shortAss, shortCues, shortLayout } from "../lib/shorts.mjs";
import { writeBurnSubtitles } from "../scripts/subtitle-run.mjs";

test("only single YouTube videos are accepted, and the id is extracted", () => {
  const id = "dQw4w9WgXcQ";
  for (const u of [`https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s&list=PL1`, `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://music.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/live/${id}`, ` https://youtu.be/${id} `]) assert.equal(youtubeId(u), id, u);
  for (const u of ["https://vimeo.com/123", `https://evil.example/watch?v=${id}`, `https://youtube.com.evil.example/watch?v=${id}`, "https://www.youtube.com/playlist?list=PL1",
    `javascript:alert(1)//youtu.be/${id}`, "https://youtu.be/short", "--exec=rm", "", `ftp://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}x`]) assert.equal(youtubeId(u), "", u);
  assert.equal(baseLang("en-US"), "en");
  assert.equal(baseLang("zh-Hant"), "zh");
});

test("author captions in the video's language are used; auto captions and translations are not", () => {
  const info = (o) => pickInfo({ id: "x", ...o });
  // 作者上傳英文字幕
  assert.deepEqual(captionSource(info({ language: "en", subtitles: { en: [], "zh-TW": [] }, automatic_captions: { "en-orig": [], ja: [] } })), { kind: "author", track: "en", lang: "en" });
  // 只有作者上傳的中文翻譯，影片是英文：不能拿翻譯當原文，改用 Soniox
  assert.deepEqual(captionSource(info({ language: "en", subtitles: { "zh-Hant": [] }, automatic_captions: { "en-orig": [], en: [] } })), { kind: "auto", track: "", lang: "en" });
  // en-US 的軌也算英文
  assert.deepEqual(captionSource(info({ language: "en", subtitles: { "en-US": [] } })), { kind: "author", track: "en-US", lang: "en" });
  // 不知道語言：從自動字幕的 -orig 判斷
  assert.deepEqual(captionSource(info({ automatic_captions: { "ja-orig": [], en: [] } })), { kind: "auto", track: "", lang: "ja" });
  // 不知道語言、只有一軌作者字幕：用它
  assert.deepEqual(captionSource(info({ subtitles: { ko: [] } })), { kind: "author", track: "ko", lang: "ko" });
  // 不知道語言、有好幾軌作者字幕：有英文就用英文
  assert.deepEqual(captionSource(info({ subtitles: { de: [], "en-GB": [] }, automatic_captions: { fr: [] } })), { kind: "author", track: "en-GB", lang: "en" });
  assert.deepEqual(captionSource(info({ subtitles: { de: [], fr: [] } })), { kind: "none", track: "", lang: "en" }, "猜不出來就送辨識");
  // 聊天室重播不是字幕
  assert.deepEqual(captionSource(info({ language: "en", subtitles: { live_chat: [] } })), { kind: "none", track: "", lang: "en" });
  // 使用者指定的語言優先
  assert.deepEqual(captionSource(info({ language: "en", subtitles: { en: [], ja: [] } }), "ja"), { kind: "author", track: "ja", lang: "ja" });
  assert.deepEqual(captionSource(info({})), { kind: "none", track: "", lang: "en" });
  const small = pickInfo({ id: "x", title: " a\nb ", formats: [{ big: 1 }], subtitles: { en: [{ url: "u" }] } });
  assert.deepEqual(small.subtitles, { en: true });
  assert.equal(small.title, "a b");
  assert.equal(small.formats, undefined, "不留整包格式清單");
});

test("author VTT becomes clean cues", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

1
00:00:01.000 --> 00:00:03.500 align:start position:0%
<c.colorE5E5E5>Hello</c> &amp; <i>welcome</i>
to the show

00:00:03.500 --> 00:00:04.000
to the show

NOTE this is a comment

00:00:05.000 --> 00:00:07.000
Rolling
00:00:06.000 --> 00:00:08.000
Rolling text

01:02:03.004 --> 01:02:04.5
Late &lt;tag&gt;

02:00.000 --> 02:01.000
Short form time
`;
  assert.deepEqual(parseVtt(vtt), [
    { start: 1000, end: 3500, text: "Hello & welcome to the show" },
    { start: 3500, end: 4000, text: "to the show" },
    { start: 5000, end: 8000, text: "Rolling text" },
    { start: 120000, end: 121000, text: "Short form time" },
    { start: 3723004, end: 3724500, text: "Late <tag>" },
  ]);
  // 重疊的句子：前一句的結束拉到下一句開始
  assert.deepEqual(parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA\n\n00:00:01.000 --> 00:00:03.000\nB\n").map((c) => [c.start, c.end]), [[0, 1000], [1000, 3000]]);
});

test("translations follow Taiwan subtitle conventions", () => {
  assert.equal(cleanTranslation(" 你好，世界。 "), "你好 世界");
  assert.equal(cleanTranslation("價格是 1,000 元、很便宜。"), "價格是 1,000 元 很便宜");
  assert.equal(cleanTranslation("真的嗎？"), "真的嗎？", "問號留著");
  assert.equal(cleanTranslation("版本 2.0"), "版本 2.0");
  assert.equal(cleanTranslation("软件", (x) => x.replace("软件", "軟體")), "軟體", "最後再簡轉繁、台灣用語");
  assert.deepEqual(readBatch('```json\n{"t": ["一", "二"]}\n```', 2), ["一", "二"]);
  assert.equal(readBatch('{"t": ["一"]}', 2), null, "句數不對");
  assert.equal(readBatch("not json", 1), null);
  assert.match(batchPrompt([{ text: "Hi" }], [{ text: "Before", tr: "之前" }], "en"), /前面幾句（參考用，不要翻）：\nBefore\n→ 之前[\s\S]*英文字幕，共 1 句：\n1\. Hi/);
});

// 假的 agent：照 reply(prompt) 回答；記下問了什麼
function fakeSession(reply) {
  const s = { prompts: [], closed: 0, usage: { calls: 0, cost_usd: 0 } };
  s.ask = async (p) => { s.prompts.push(p); s.usage.calls += 1; return reply(p, s.prompts.length); };
  s.close = () => { s.closed += 1; };
  return s;
}
const items = (n) => Array.from({ length: n }, (_, i) => ({ text: `line ${i + 1}` }));
const echo = (p) => {
  const lines = [...p.split("句：\n")[1].matchAll(/^\d+\. (.*)$/gm)].map((m) => `譯${m[1]}`);
  return JSON.stringify({ t: lines });
};

test("translation goes batch by batch with context, and every batch must line up", async () => {
  const s = fakeSession(echo);
  const got = [];
  const r = await translateCues(items(65), { session: s, batch: 30, onBatch: (from, trs) => got.push([from, trs.length, trs[0]]) });
  assert.equal(r.done, 65);
  assert.deepEqual(got, [[0, 30, "譯line 1"], [30, 30, "譯line 31"], [60, 5, "譯line 61"]]);
  assert.equal(s.prompts.length, 3);
  assert.doesNotMatch(s.prompts[0], /前面幾句/);
  assert.match(s.prompts[1], /前面幾句（參考用，不要翻）：\nline 27\n→ 譯line 27\n[\s\S]*line 30\n→ 譯line 30/, "帶前四句當上下文");
  assert.equal(s.closed, 0, "別人給的 session 不關");
});

test("a batch with the wrong number of lines is asked again, then split, never shifted", async () => {
  // 第一次少一句，第二次對了
  let s = fakeSession((p, n) => (n === 1 ? JSON.stringify({ t: ["只有一句"] }) : echo(p)));
  let out = [];
  await translateCues(items(3), { session: s, onBatch: (from, trs) => { out = trs; } });
  assert.equal(s.prompts.length, 2);
  assert.match(s.prompts[1], /請剛好輸出 3 句/);
  assert.deepEqual(out, ["譯line 1", "譯line 2", "譯line 3"]);
  // 4 句一直對不上 → 拆成 2＋2 各自問
  s = fakeSession((p) => {
    const n = [...p.split("句：\n")[1].matchAll(/^\d+\. /gm)].length;
    return n === 4 ? JSON.stringify({ t: ["合併成一句"] }) : echo(p);
  });
  await assert.doesNotReject(translateCues(items(4), { session: s, onBatch: (from, trs) => { out = trs; } }), "拆開來就讀得出來，不該報錯");
  assert.deepEqual(out, ["譯line 1", "譯line 2", "譯line 3", "譯line 4"], "一句對一句，沒有錯位");
  assert.equal(s.prompts.length, 4, "4 句問兩次，再拆成兩批");
  // 一句都讀不出來：報錯，不硬塞
  s = fakeSession(() => "壞掉的回覆");
  await assert.rejects(translateCues(items(1), { session: s, onBatch: () => assert.fail("不該寫入") }), /格式不對/);
});

test("stopping a translation closes the agent and writes nothing more", async () => {
  const ac = new AbortController();
  const s = fakeSession(async (p) => { ac.abort(); throw new Error("Claude process exited"); });
  const opened = { close: 0 };
  s.close = () => { opened.close += 1; };
  await assert.rejects(translateCues(items(40), { session: s, signal: ac.signal, onBatch: () => assert.fail("停了就不寫") }), /cancelled/);
  assert.equal(opened.close, 1, "按停止就關掉 agent");
});

test("display parts: Chinese, original or both; lines without a translation show the original", () => {
  const c = { text: "Hello there", tr: "你好" };
  assert.deepEqual(displayParts(c, "both"), [{ text: "你好", role: "main" }, { text: "Hello there", role: "sub" }]);
  assert.deepEqual(displayParts(c, "zh"), [{ text: "你好", role: "main" }]);
  assert.deepEqual(displayParts(c, "orig"), [{ text: "Hello there", role: "main" }]);
  assert.deepEqual(displayParts({ text: "No tr yet" }, "zh"), [{ text: "No tr yet", role: "main" }]);
  assert.deepEqual(displayParts({ text: "Blank tr", tr: "  " }, "both"), [{ text: "Blank tr", role: "main" }]);
  assert.deepEqual(displayParts({ text: "中文影片" }), [{ text: "中文影片", role: "main" }], "一般影片不受影響");
  assert.equal(displayText(c, "both"), "你好\nHello there");
});

test("bilingual box: one rounded box, Chinese on top, the original smaller, grey and not bold", () => {
  const lines = cueBoxLines({ text: "Hello there", tr: "你好" }, { fs: 100, maxWidthPx: 1700, mode: "both" });
  assert.deepEqual(lines, [{ text: "你好", fs: 100 }, { text: "Hello there", fs: Math.round(100 * SUB_SCALE), colour: BOX.en, bold: false }]);
  const ass = boxAss({ cues: [{ start: 0, end: 1000, text: "Hello there", tr: "你好" }], width: 1920, height: 1080, fs: 100, mode: "both" });
  const dlg = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(dlg.filter((l) => l.includes(",BoxBg,")).length, 1, "同一個框");
  const text = dlg.filter((l) => l.includes(",BoxText,"));
  assert.equal(text.length, 2);
  assert.match(text[0], /\{\\pos\(960,\d+\)\}你好$/, "中文用預設樣式（淡黃、粗）");
  assert.match(text[1], new RegExp(`\\\\fs${Math.round(100 * SUB_SCALE)}\\\\1c&HDADADA&\\\\b0\\}Hello there$`), "原文：小、淺灰、不加粗");
  const y = (l) => Number(/\\pos\(\d+,(\d+)\)/.exec(l)[1]);
  const top = Number(/BoxBg,,0,0,0,,\{\\pos\(\d+,(\d+)\)/.exec(dlg[0])[1]);
  const pad = Math.round(100 * BOX.padY), gap = Math.round(100 * BOX.gap);
  assert.equal(y(text[0]) - top, Math.round(pad + (100 * EM) / 2), "中文在框的上半");
  assert.equal(y(text[1]) - top, Math.round(pad + 100 * EM + gap + (Math.round(100 * SUB_SCALE) * EM) / 2), "原文在中文下面、隔一個行距");
  // 只放中文：只有一行，置中規則和 #55 一樣
  const zh = boxAss({ cues: [{ start: 0, end: 1000, text: "Hello there", tr: "你好" }], width: 1920, height: 1080, fs: 100, mode: "zh" });
  assert.equal(zh.split("\n").filter((l) => l.includes(",BoxText,")).length, 1);
  assert.doesNotMatch(zh, /Hello there/);
});

test("burn and short subtitles follow the language mode", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-bi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cues = [{ start: 0, end: 1000, text: "Hello", tr: "你好" }, { start: 1000, end: 2000, text: "Untranslated" }];
  const srt = fs.readFileSync(writeBurnSubtitles({ dir, cues, video: "/nope.mp4", style: "outline", mode: "both" }), "utf8");
  assert.match(srt, /00:00:00,000 --> 00:00:01,000\n你好\nHello\n/);
  assert.match(srt, /\nUntranslated\n/);
  let measured;
  const ass = fs.readFileSync(writeBurnSubtitles({ dir, cues, video: "/nope.mp4", style: "box", mode: "zh", dims: { w: 1920, h: 1080 }, measure: (x) => { measured = x; return {}; } }), "utf8");
  assert.deepEqual(measured, ["Hello", "你好", "Untranslated"], "原文和譯文的字都量");
  assert.doesNotMatch(ass, /\}Hello$/m);
  assert.match(ass, /\}你好$/m);
  // 雙語：原文那行是細體，框寬用細體的字寬（粗體量會偏寬，實測 1080p 差 44px）
  const calls = [];
  const fake = (texts, { bold = true } = {}) => { calls.push(bold); return { a: bold ? 1 : 0.5, 一: 1 }; };
  const both = fs.readFileSync(writeBurnSubtitles({ dir, cues: [{ start: 0, end: 1000, text: "aaaa", tr: "一" }], video: "/nope.mp4", style: "box", mode: "both", dims: { w: 1920, h: 1080 }, measure: fake }), "utf8");
  const boxW = Math.max(...[...both.match(/\\p1\}([^{]+)\{/)[1].matchAll(/(\d+) \d+/g)].map((m) => Number(m[1])));
  const fs75 = 75, small = Math.round(fs75 * 0.72);
  assert.deepEqual(calls, [true, false], "粗體量一次、細體量一次");
  assert.equal(boxW, Math.round(4 * 0.5 * small / 1.4 + 2 * Math.round(fs75 * 0.4)), "框寬照細體算");
  // 直式短片
  const item = { start: 0, end: 2000, title: "標題" };
  const sc = shortCues(item, cues, []);
  assert.equal(sc[0].tr, "你好", "短片字幕帶著譯文");
  const short = shortAss({ title: "標題", cues: sc, durationMs: 2000, layout: shortLayout(1920, 1080), style: "box", mode: "both" });
  assert.match(short, /\}你好$/m);
  assert.match(short, /\\b0\}Hello$/m);
  const plain = shortAss({ title: "標題", cues: sc, durationMs: 2000, layout: shortLayout(1920, 1080), style: "outline", mode: "orig" });
  assert.match(plain, /,Sub,,0,0,0,,Hello$/m);
});

test("English cues keep punctuation, break at sentence ends but not at Mr. or U.S.", () => {
  const chars = [];
  let t = 0;
  for (const ch of "Hello, Mr. Smith. I moved to the U.S. last year. Thanks!") { chars.push({ c: ch, s: t, e: t + 50, spk: 0 }); t += 50; }
  const cues = buildCues(chars, cueOptsFor("en"));
  assert.deepEqual(cues.map((c) => c.text), ["Hello, Mr. Smith.", "I moved to the U.S. last year.", "Thanks!"]);
  // 辨識的標點在停頓之後才到、數字被停頓切開：標點接回前一句，數字不切開（#56 實測）
  const late = [];
  const put = (txt, at) => { for (const ch of txt) { late.push({ c: ch, s: at, e: at + 40, spk: 0 }); at += 40; } return at; };
  let at = put("what are you waiting for", 0);
  at = put("?", at + 1500);
  at = put(" Write 1,6", at + 100);
  at = put("67 words.", at + 900);
  at = put(" Really?", at + 100);
  at = put("!", at + 2000);
  at = put(" Yes.", at + 100);
  assert.deepEqual(buildCues(late, cueOptsFor("en")).map((c) => c.text), ["what are you waiting for?", "Write 1,667 words.", "Really?!", "Yes."]);
  assert.deepEqual(cueOptsFor("zh"), {});
  assert.deepEqual(cueOptsFor("ja"), { keepPunct: true });
  // 中文照舊：句尾不加標點、逗號換空格
  const zh = [];
  for (const ch of "今天，我們來談。") zh.push({ c: ch, s: t, e: t + 50, spk: 0 });
  assert.deepEqual(buildCues(zh).map((c) => c.text), ["今天 我們來談"]);
});

test("translations are stored, kept on saves that do not carry them, and written as their own SRT", (t) => {
  assert.deepEqual(validateCues([{ start: 0, end: 1, text: "a", tr: " 你\n好 " }]), [{ start: 0, end: 1, text: "a", tr: "你 好" }]);
  assert.deepEqual(validateCues([{ start: 0, end: 1, text: "a", tr: "" }]), [{ start: 0, end: 1, text: "a", tr: "" }], "清空的譯文也留著");
  assert.throws(() => validateCues([{ start: 0, end: 1, text: "a", tr: 5 }]), /譯文/);
  assert.throws(() => validateCues([{ start: 0, end: 1, text: "a", tr: "字".repeat(201) }]), /譯文/);
  const server = [{ start: 0, end: 1, text: "a", tr: "甲" }, { start: 1, end: 2, text: "b", tr: "乙" }];
  assert.deepEqual(keepTranslations([{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b", tr: "改過" }, { start: 2, end: 3, text: "c" }], server),
    [{ start: 0, end: 1, text: "a", tr: "甲" }, { start: 1, end: 2, text: "b", tr: "改過" }, { start: 2, end: 3, text: "c" }]);
  assert.deepEqual(keepTranslations([{ start: 0, end: 1, text: "a edited" }], server), [{ start: 0, end: 1, text: "a edited" }], "原文改了就不算同一句");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-bi-p-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeProject(dir, { status: "ready", lang: "en", cues: [{ start: 0, end: 1000, text: "Hi", tr: "嗨" }, { start: 1000, end: 2000, text: "No tr" }], cuts: [] });
  assert.match(fs.readFileSync(path.join(dir, "subtitles.srt"), "utf8"), /Hi\n[\s\S]*No tr/);
  assert.equal(fs.readFileSync(path.join(dir, "subtitles.zh-TW.srt"), "utf8"), "1\n00:00:00,000 --> 00:00:01,000\n嗨\n");
  assert.equal(readProject(dir).cues[0].tr, "嗨");
  const zhDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-bi-z-"));
  t.after(() => fs.rmSync(zhDir, { recursive: true, force: true }));
  writeProject(zhDir, { status: "ready", cues: [{ start: 0, end: 1000, text: "中文" }], cuts: [] });
  assert.equal(fs.existsSync(path.join(zhDir, "subtitles.zh-TW.srt")), false, "中文影片不多寫一份");
});

test("splitting keeps the translation on the first half; merging joins both", () => {
  const c = [{ start: 0, end: 1000, text: "one two", tr: "一二" }, { start: 1000, end: 2000, text: "three", tr: "三" }];
  const s = ops.splitCue(c, 0, 3);
  assert.deepEqual(s.slice(0, 2).map((x) => [x.text, x.tr]), [["one", "一二"], ["two", ""]]);
  assert.deepEqual(ops.mergeNext(c, 0)[0], { start: 0, end: 2000, text: "one two three", tr: "一二 三" });
  assert.equal(ops.mergeNext([{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b" }], 0)[0].tr, undefined, "中文影片不多一個欄位");
  assert.equal(ops.splitCue([{ start: 0, end: 1000, text: "一二" }], 0, 1)[1].tr, undefined);
});

test("video download reports progress for the video and audio parts and returns the final file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-dl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const final = path.join(dir, "Title [abcdefghijk].mp4");
  let args;
  const run = async (a, { onLine }) => {
    args = a;
    for (const l of ["PROG 137 50 100 NA", "PROG 137 40 NA 100", "PROG 137 100 100 NA", "PROG 140 5 10 NA", "PROG 140 10 10 NA", `FILE ${final}`]) onLine(l);
    fs.writeFileSync(final, "mp4");
    return { code: 0, stdout: "", stderr: "" };
  };
  const seen = [];
  assert.equal(await fetchVideo("abcdefghijk", dir, { run, onProgress: (x) => seen.push(Math.round(x * 100)) }), final);
  assert.deepEqual(seen, [45, 90, 95, 99, 100], "影像佔 90%、聲音佔 10%，進度不倒退");
  assert.equal(args.at(-2), "--", "網址前面一定有 --");
  assert.equal(args.at(-1), "https://www.youtube.com/watch?v=abcdefghijk");
  await assert.rejects(fetchVideo("abcdefghijk", dir, { run: async () => ({ code: 1, stdout: "", stderr: "ERROR: [youtube] abc: Video unavailable\n" }) }), /Video unavailable/);
});

test("review fixes: handoff language, safe track names, Chinese author captions, NOTE lines in cue text", async (t) => {
  // 交接單：中文專案照舊 unknown；外語寫語言、來源網址與作者
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-bi-h-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const icloud = path.join(root, "icloud");
  fs.mkdirSync(icloud);
  const { handoffFromStudio } = await import("../lib/wiki-handoff.mjs");
  const base = { name: "片", video: "/nope.mp4", cues: [{ start: 0, end: 1000, text: "Hi", tr: "嗨" }] };
  const zh = fs.readFileSync(path.join(handoffFromStudio({ ...base, name: "中文片" }, { dir: root, icloud, inbox: "Inbox" }).dir, "handoff.md"), "utf8");
  assert.match(zh, /^language: "unknown"$/m);
  const en = fs.readFileSync(path.join(handoffFromStudio({ ...base, lang: "en", source: { url: "https://www.youtube.com/watch?v=abcdefghijk", uploader: "Someone", captions: "author" } }, { dir: root, icloud, inbox: "Inbox" }).dir, "handoff.md"), "utf8");
  assert.match(en, /^language: "en"$/m);
  assert.match(en, /^source: "https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk"$/m);
  assert.match(en, /YouTube 作者字幕/);
  assert.match(en, /影片作者：Someone/);
  // 軌名像 regex 或清單的不收（會被 --sub-langs 當成「全部」）
  const info = pickInfo({ id: "x", language: "en", subtitles: { "en,.*": [], all: [] }, automatic_captions: {} });
  assert.deepEqual(captionSource(info), { kind: "none", track: "", lang: "en" });
  // 字幕本身以 NOTE 開頭：照樣是字幕
  assert.deepEqual(parseVtt("WEBVTT\n\nNOTE header\n\n00:00:00.000 --> 00:00:01.000\nNOTE TO SELF\nbuy milk\n").map((c) => c.text), ["NOTE TO SELF buy milk"]);
  // 中文作者字幕：照台灣字幕慣例
  const { prepareFromCaptions } = await import("../scripts/subtitle-run.mjs");
  const { tidyZhText } = await import("../lib/subtitle-text.mjs");
  assert.equal(tidyZhText("大家好，今天來談 1,000 個字。"), "大家好 今天來談 1,000 個字");
  await assert.rejects(prepareFromCaptions({ lang: "zh", proofreader: "claude" }, { cues: [{ start: 0, end: 1, text: "。" }] }), /空的/, "只有標點的句子拿掉");
});
