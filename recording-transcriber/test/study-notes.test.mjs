// 學習筆記（#172）：notes.md 的讀寫，手改的檔也讀得回來
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTE_MAX, NOTES_MAX, cleanNotes, formatNotes, noteTime, parseNotes } from "../lib/study-notes.mjs";

test("noteTime is M:SS under an hour and H:MM:SS above", () => {
  assert.equal(noteTime(0), "0:00");
  assert.equal(noteTime(65_400), "1:05");
  assert.equal(noteTime(3_599_999), "59:59");
  assert.equal(noteTime(3_723_000), "1:02:03");
});

test("formatNotes writes a title and one ## time section per note, in time order", () => {
  const md = formatNotes([{ t_ms: 3_723_000, text: "最後" }, { t_ms: 65_000, text: "**重點**\n- 一\n- 二" }], { title: "  資源班 的一天 " });
  assert.equal(md, "# 學習筆記：資源班 的一天\n\n## 1:05\n**重點**\n- 一\n- 二\n\n## 1:02:03\n最後\n");
  assert.equal(formatNotes([]), "# 學習筆記\n\n");
});

test("parseNotes reads it back, including hand-edited files", () => {
  const notes = [{ t_ms: 65_000, text: "**重點**\n\n### 小標題\n- 一" }, { t_ms: 3_723_000, text: "最後" }];
  assert.deepEqual(parseNotes(formatNotes(notes, { title: "v" })), notes, "來回一致");
  const hand = "# 我的標題\n前言不算\n\n## 12:30  \n手改的\r\n\n##  0:05\n前面的\n## 2:61\n秒數不對就不是標題\n## 空的\n\n## 3:00\n\n   \n";
  assert.deepEqual(parseNotes(hand), [
    { t_ms: 5000, text: "前面的\n## 2:61\n秒數不對就不是標題\n## 空的" },
    { t_ms: 750_000, text: "手改的" },
  ], "照時間排、空的不要、不是時間的 ## 留在內容裡");
  assert.deepEqual(parseNotes(""), []);
  assert.deepEqual(parseNotes(undefined), []);
});

test("a note that contains a time-like heading line is escaped and comes back unchanged", () => {
  const notes = [{ t_ms: 1000, text: "第一段\n## 1:05\n還是同一則" }];
  const md = formatNotes(notes);
  assert.match(md, /^\\## 1:05$/m);
  assert.deepEqual(parseNotes(md), notes);
  // 本來就寫了反斜線的也一樣（#175）：寫檔多加一個、讀回拿掉一個
  const tricky = [{ t_ms: 1000, text: "\\## 1:05\n\\\\## 2:61 不是時間也照樣\n\\\\## 0:03" }];
  assert.deepEqual(parseNotes(formatNotes(tricky)), tricky);
});

test("cleanNotes validates what the page sends", () => {
  assert.deepEqual(cleanNotes([{ t_ms: 9999.6, text: " b \r\n" }, { t_ms: 1000, text: "a" }, { t_ms: 5, text: "   " }]),
    { notes: [{ t_ms: 1000, text: "a" }, { t_ms: 9000, text: "b" }] }, "排序、去空白、空的不要、取整秒（notes.md 只記到秒）");
  assert.deepEqual(cleanNotes([{ t_ms: 99_000, text: "x" }], { durationMs: 60_000 }).notes, [{ t_ms: 60_000, text: "x" }], "時間不超過片長");
  assert.deepEqual(cleanNotes("x"), { error: "bad" });
  assert.deepEqual(cleanNotes([{ t_ms: -1, text: "x" }]), { error: "bad" });
  assert.deepEqual(cleanNotes([{ t_ms: 1, text: 3 }]), { error: "bad" });
  assert.deepEqual(cleanNotes([{ t_ms: 1, text: "長".repeat(NOTE_MAX + 1) }]), { error: "too-long" });
  assert.deepEqual(cleanNotes(Array.from({ length: NOTES_MAX + 1 }, () => ({ t_ms: 1, text: "x" }))), { error: "too-many" });
});
