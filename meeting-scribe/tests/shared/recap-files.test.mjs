// RecapFiles（web/shared/recap-files.js，#166）的測試：瀏覽器（window）與 Node（require）兩種載法同一份；存檔格式、檔名、撞名
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const FILE = new URL("../../web/shared/recap-files.js", import.meta.url);
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(FILE, "utf8"), ctx);
const R = ctx.window.RecapFiles;
const N = createRequire(import.meta.url)(fileURLToPath(FILE));

test("loads the same API in a browser and in Node without touching window/document", () => {
  assert.match(R.version, /^\d+\.\d+\.\d+$/);
  assert.equal(N.version, R.version);
  assert.deepEqual(Object.keys(N).sort(), Object.keys(R).sort());
  // Node 載入：沒有 window／document 也不會壞
  const bare = vm.createContext({ module: { exports: {} } });
  vm.runInContext(fs.readFileSync(FILE, "utf8"), bare);
  assert.equal(bare.module.exports.version, R.version);
});

test("summary.md: header, intro with chapters, full demoted one level, short, transcript", () => {
  const md = R.summaryMarkdown({ header: R.headerLines({ name: "IEP 會議", place: "" }), intro: "簡介",
    chapters: [{ t_ms: 0, title: "開場" }, { t_ms: 3723000, title: "結論" }], full: "## 核心結論\n- 重點", short: "短", transcript: "[00:00:01] 大家好" });
  assert.equal(md, "# 會後總結\n\n會議：IEP 會議\n\n## 簡介\n\n簡介\n\n[ 分段章節 ]\n00:00:00 開場\n01:02:03 結論\n\n## 完整總結\n\n### 核心結論\n- 重點\n\n## 短總結\n\n短\n\n## 逐字稿\n\n[00:00:01] 大家好\n");
  assert.equal(R.summaryMarkdown({ intro: "i", full: "f", short: "s", transcript: "t" }).split("\n").slice(0, 4).join("|"), "# 會後總結||## 簡介|");
  assert.equal(JSON.stringify(R.headerLines({ name: "會", place: "教室" })), JSON.stringify(["會議：會", "地點：教室"]));
  assert.equal(R.fmtHms(null), "--:--:--");
});

test("extension files: names follow the server rule, collisions get -2 against taken names (case-insensitive) and each other", () => {
  assert.equal(R.extraFileName("視角回饋（家長）"), "視角回饋（家長）.md");
  assert.equal(R.extraFileName("a/b\\c:d*e?f\"g<h>i|j\u0007"), "a_b_c_d_e_f_g_h_i_j_.md");
  assert.equal(R.extraFileName("..隱藏"), "隱藏.md");
  assert.equal(R.extraFileName("  "), "延伸.md");
  assert.equal(R.extraFileName("😀".repeat(100)), "😀".repeat(80) + ".md", "80 字照字算");
  const out = R.extraFiles([{ label: "Summary", markdown: "a" }, { label: "發芽", markdown: "b" }, { label: "發芽", markdown: "c" }, { label: "空", markdown: " " }],
    { header: ["會議：x"], taken: ["summary.md", "mindmap.md"] });
  assert.equal(out.map((f) => f.file).join("|"), "Summary-2.md|發芽.md|發芽-2.md");
  assert.equal(out[1].markdown, "# 發芽\n\n會議：x\n\nb\n");
  // macOS 檔名不分大小寫：已經有 MindMap.md，「mindmap」就要換成 -2
  assert.equal(R.extraFiles([{ label: "mindmap", markdown: "x" }], { taken: ["MindMap.md"] })[0].file, "mindmap-2.md");
  assert.equal(R.extraMarkdown({ label: "L", markdown: "# 標題\n內容" }), "# L\n\n## 標題\n內容\n");
});

// 讀回逐字稿（#174）
const plain = (x) => JSON.parse(JSON.stringify(x));

test("parseTranscript reads this app's transcript.txt: raw part only, times and speakers kept", () => {
  const txt = "﻿會議：週三個案會議\n地點：資源教室\n\n【優化逐字稿】\n\n改寫過的內容。\n\n【原始逐字稿】\n\n[講者 1]\r\n[00:00:05] 我們先看上週的作業。\n[00:01:02] 大家都交了。\n\n[講者 2]\n[01:02:03] 好，下週再談。\n[--:--:--] 沒有時間的一句\n";
  assert.equal(JSON.stringify(R.parseTranscript(txt)), JSON.stringify([
    { start: 5000, speaker: "1", text: "我們先看上週的作業。" },
    { start: 62000, speaker: "1", text: "大家都交了。" },
    { start: 3723000, speaker: "2", text: "好，下週再談。" },
    { start: null, speaker: "2", text: "沒有時間的一句" },
  ]));
  // 沒有優化版、沒有講者也行；summary.md 的章節行（沒有中括號）不算逐字稿
  assert.equal(JSON.stringify(R.parseTranscript("## 簡介\n\n[ 分段章節 ]\n00:00:05 開場\n\n## 逐字稿\n\n[00:00:05] 開場白")), JSON.stringify([{ start: 5000, speaker: null, text: "開場白" }]));
});

test("parseTranscript reads SRT and VTT cues with start times, dropping indices, headers and tags", () => {
  const srt = "1\n00:00:01,500 --> 00:00:03,000\n第一句\n第一句下半\n\n2\n01:00:00,000 --> 01:00:02,000\n<i>第二句</i> &amp; 更多\n";
  assert.equal(JSON.stringify(R.parseTranscript(srt)), JSON.stringify([
    { start: 1500, speaker: null, text: "第一句 第一句下半" },
    { start: 3600000, speaker: null, text: "第二句 & 更多" },
  ]));
  const vtt = "WEBVTT\n\nNOTE 這是註解\n\n00:05.250 --> 00:07.000 align:start\n<v 老師>大家好\n\n00:01:10.000 --> 00:01:12.000\n再見";
  assert.equal(JSON.stringify(R.parseTranscript(vtt)), JSON.stringify([
    { start: 5250, speaker: null, text: "大家好" },
    { start: 70000, speaker: null, text: "再見" },
  ]));
});

test("parseTranscript reads plain text and Markdown line by line, splitting long lines at sentence ends", () => {
  const long = "這是一句很長的話。".repeat(20);
  const got = plain(R.parseTranscript(`# 標題\n\n- 第一點\n> 引言\n\n${long}\n   \n`));
  assert.deepEqual(got.slice(0, 3), [{ start: null, speaker: null, text: "標題" }, { start: null, speaker: null, text: "第一點" }, { start: null, speaker: null, text: "引言" }]);
  assert.equal(got.length, 3 + 20, "長段落要在句號後切開");
  assert.ok(got.slice(3).every((x) => x.text === "這是一句很長的話。"));
  assert.deepEqual(plain(R.parseTranscript("")), []);
  assert.deepEqual(plain(R.parseTranscript(null)), []);
});

// 問 AI（#214）：ask.md 每題一節，問題壓成一行，回答標題降一級；沒有問答（或都是空的）回空字串，不存檔
test("askMarkdown writes one section per question and nothing when there are no answers", () => {
  assert.equal(R.askMarkdown({ header: ["會議：週三個案會議"], items: [{ q: "有哪些\n待辦？", a: "## 待辦\n- 導師交清單 [00:01:02]\n" }, { q: "", a: "沒有問題的不收" }, { q: "第二題", a: "回答" }] }),
    "# 問 AI\n\n會議：週三個案會議\n\n## 1. 有哪些 待辦？\n\n### 待辦\n- 導師交清單 [00:01:02]\n\n## 2. 第二題\n\n回答\n");
  assert.equal(R.askMarkdown({ items: [] }), "");
  assert.equal(R.askMarkdown({ items: [{ q: "問", a: "  " }] }), "");
  assert.equal(R.askMarkdown(), "");
  const long = R.askMarkdown({ items: [{ q: "問".repeat(130), a: "答" }] });
  assert.match(long, /^# 問 AI\n\n## 1\. 問{120}…\n/);
});

// 匯出（#215）：字幕的結束時間＝下一句開始，最長照字數估；沒有時間的句子不收；VTT 標講者並跳脫 < > &；讀回來時間一樣
test("srt and vtt end each cue at the next start (or a length guess), skip untimed lines, mark speakers in VTT and read back", () => {
  const segs = [
    { start: 5000, speaker: "1", text: "我們先看作業。" },
    { start: 6000, speaker: "1", text: "大家都交了 <很好> & 準時" },
    { start: null, speaker: "2", text: "沒有時間的一句" },
    { start: 30000, speaker: null, text: "一".repeat(60) },
    { start: 40000, speaker: "", text: "  " },
  ];
  assert.equal(JSON.stringify(R.subtitleCues(segs).map((c) => [c.start, c.end])), JSON.stringify([[5000, 6000], [6000, 9300], [30000, 37000]]),
    "下一句開始就結束；第二句 15 字照字數 3.3 秒；最後一句 60 字最長 7 秒");
  assert.equal(R.srt(segs).split("\n\n")[0], "1\n00:00:05,000 --> 00:00:06,000\n我們先看作業。");
  const vtt = R.vtt(segs);
  assert.match(vtt, /^WEBVTT\n\n00:00:05\.000 --> 00:00:06\.000\n<v 講者 1>我們先看作業。\n/);
  assert.match(vtt, /<v 講者 1>大家都交了 &lt;很好&gt; &amp; 準時\n/);
  assert.match(vtt, /00:00:30\.000 --> 00:00:37\.000\n一{60}\n/, "沒有講者不標");
  assert.equal(JSON.stringify(R.parseTranscript(vtt).map((x) => [x.start, x.text])), JSON.stringify([[5000, "我們先看作業。"], [6000, "大家都交了 <很好> & 準時"], [30000, "一".repeat(60)]]));
  assert.equal(JSON.stringify(R.parseTranscript(R.srt(segs)).map((x) => x.start)), JSON.stringify([5000, 6000, 30000]));
  assert.equal(R.srt([]), "");
  assert.equal(R.vtt([]), "WEBVTT\n\n");
  // 不是整秒的時間照毫秒寫（#217）
  assert.equal(R.srt([{ start: 61234, text: "一二三四五六" }, { start: 63007, text: "下一句" }]).split("\n").slice(0, 3).join("|"), "1|00:01:01,234 --> 00:01:02,554|一二三四五六");
  assert.match(R.vtt([{ start: 3723045, text: "x" }]), /\n01:02:03\.045 --> 01:02:04\.045\n/);
  // 兩句同一個時間開始：前一句照字數估，不會變成 0 長度
  assert.equal(JSON.stringify(R.subtitleCues([{ start: 0, text: "甲" }, { start: 0, text: "乙" }]).map((c) => c.end)), JSON.stringify([1000, 1000]));
});

test("documentMarkdown puts non-empty sections under the title, one level down", () => {
  assert.equal(R.documentMarkdown({ title: "週三個案會議", header: ["地點：資源班", "日期：2026-11-08"], sections: [
    { title: "完整總結", markdown: "## 閱讀\n- 進步" }, { title: "空的", markdown: "  " }, { title: "問 AI", markdown: R.askBody([{ q: "待辦？", a: "導師交清單" }]) },
  ] }), "# 週三個案會議\n\n地點：資源班\n日期：2026-11-08\n\n## 完整總結\n\n### 閱讀\n- 進步\n\n## 問 AI\n\n### 1. 待辦？\n\n導師交清單\n");
  assert.equal(R.documentMarkdown({ sections: [] }), "# 會議紀錄\n\n");
  assert.equal(R.askBody([]), "");
});
