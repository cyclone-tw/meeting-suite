// 時間軸章節（#170）：說明欄或會後總結的章節換成時間軸上的分段
import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterAt, chapterSpans, parseChapters, pickChapters } from "../lib/chapters.mjs";

const DESC = `這支影片介紹資源班的一天。

00:00 開場
・老師自我介紹
01:30 晨間活動
・點名
1:02:03 收尾與回家作業
不是章節的 12:30 那一行`;

test("parseChapters reads MM:SS and H:MM:SS lines with a title, in time order", () => {
  assert.deepEqual(parseChapters(DESC), [
    { ms: 0, title: "開場" },
    { ms: 90_000, title: "晨間活動" },
    { ms: 3_723_000, title: "收尾與回家作業" },
  ]);
});

test("parseChapters skips bullets, bare times, bad clocks and duplicates", () => {
  const text = "05:00 後面\n00:00 前面\n05:00 重複的時間只留第一個\n03:75 秒數不對\n02:00\n・01:00 重點不是章節\n  04:00   前面有空白也算  ";
  assert.deepEqual(parseChapters(text), [
    { ms: 0, title: "前面" },
    { ms: 240_000, title: "前面有空白也算" },
    { ms: 300_000, title: "後面" },
  ]);
  assert.deepEqual(parseChapters(""), []);
  assert.deepEqual(parseChapters(undefined), []);
});

test("parseChapters caps long titles", () => {
  const [c] = parseChapters(`00:00 ${"長".repeat(200)}`);
  assert.equal([...c.title].length, 80);
});

test("pickChapters prefers the description and falls back to recap chapters", () => {
  const recap = [{ t_ms: 0, title: "總結一" }, { t_ms: 60_000, title: "總結二" }];
  assert.deepEqual(pickChapters(DESC, recap).map((c) => c.title), ["開場", "晨間活動", "收尾與回家作業"]);
  assert.deepEqual(pickChapters("00:00 只有一章", recap), [{ ms: 0, title: "總結一" }, { ms: 60_000, title: "總結二" }], "說明欄不到兩章就用會後總結");
  assert.deepEqual(pickChapters("", [{ t_ms: 0, title: "只有一章" }]), [], "都不到兩章就不顯示");
  assert.deepEqual(pickChapters("", [{ t_ms: "x", title: "壞的" }, { t_ms: 0, title: "" }, null]), []);
});

test("chapterSpans runs each chapter to the next one and drops ones past the end", () => {
  const spans = chapterSpans([{ ms: 0, title: "A" }, { ms: 90_000, title: "B" }, { ms: 500_000, title: "超過片長" }], 300_000);
  assert.deepEqual(spans, [
    { start: 0, end: 90_000, title: "A" },
    { start: 90_000, end: 300_000, title: "B" },
  ]);
  assert.deepEqual(chapterSpans([{ ms: 0, title: "A" }], 0), [], "片長未知就不畫");
});

test("chapterAt finds the chapter under a time", () => {
  const spans = chapterSpans([{ ms: 10_000, title: "A" }, { ms: 90_000, title: "B" }], 300_000);
  assert.equal(chapterAt(spans, 0), -1, "第一章之前沒有章節");
  assert.equal(chapterAt(spans, 10_000), 0);
  assert.equal(chapterAt(spans, 89_999), 0);
  assert.equal(chapterAt(spans, 90_000), 1);
  assert.equal(chapterAt(spans, 300_000), 1, "片尾算最後一章");
  assert.equal(chapterAt([], 5), -1);
});
