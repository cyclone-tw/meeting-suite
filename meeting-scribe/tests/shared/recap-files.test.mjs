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
