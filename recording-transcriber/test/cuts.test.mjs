// 剪輯區段與時間換算（recording-transcriber#4）
import test from "node:test";
import assert from "node:assert/strict";
import { charsToSource, cutAt, cutShare, keepSegments, subtractRange, keptDuration, normalizeCuts, remapCues, remapDescription, toEdited, toSource } from "../lib/cuts.mjs";

const DUR = 60_000;
// 剪掉開頭 5 秒、20–30 秒、結尾 55 秒以後
const cuts = normalizeCuts([{ start: 55_000, end: 99_000 }, { start: 0, end: 5000 }, { start: 20_000, end: 30_000, by: "ai", reason: "靜音" }], DUR);

test("cuts are sorted, clipped to the video, merged and short ones dropped", () => {
  assert.deepEqual(cuts, [
    { start: 0, end: 5000, by: "user" },
    { start: 20_000, end: 30_000, by: "ai", reason: "靜音" },
    { start: 55_000, end: 60_000, by: "user" },
  ]);
  assert.deepEqual(normalizeCuts([{ start: 1000, end: 3000, by: "ai", reason: "a" }, { start: 2500, end: 4000, by: "user" }, { start: 4000, end: 5000, by: "ai" }]), [
    { start: 1000, end: 5000, by: "user", reason: "a" },
  ], "重疊或相連的合併；有使用者剪的就算使用者的");
  assert.deepEqual(normalizeCuts([{ start: 1000, end: 1050 }, { start: "x", end: 2 }, { start: 5, end: 1 }, null]), [], "太短、壞掉、反過來的都丟掉");
  assert.equal(normalizeCuts([{ start: 0, end: 1000, by: "evil" }])[0].by, "user");
});

test("keep segments are the complement of the cuts", () => {
  const keep = keepSegments(cuts, DUR);
  assert.deepEqual(keep, [[5000, 20_000], [30_000, 55_000]]);
  assert.equal(keptDuration(keep), 40_000);
  assert.deepEqual(keepSegments([], DUR), [[0, DUR]]);
  assert.deepEqual(keepSegments([{ start: 0, end: DUR }], DUR), []);
  assert.equal(cutAt(cuts, 25_000).reason, "靜音");
  assert.equal(cutAt(cuts, 30_000), null, "剪輯結尾那一刻已經是保留段");
  assert.equal(cutAt(cuts, 10_000), null);
});

test("source and edited times convert both ways", () => {
  const keep = keepSegments(cuts, DUR);
  assert.equal(toEdited(5000, cuts), 0);
  assert.equal(toEdited(2000, cuts), 0, "剪掉的開頭算在 0");
  assert.equal(toEdited(19_000, cuts), 14_000);
  assert.equal(toEdited(25_000, cuts), 15_000, "落在剪輯裡的算下一段開頭");
  assert.equal(toEdited(31_000, cuts), 16_000);
  assert.equal(toEdited(58_000, cuts), 40_000);
  for (const ms of [0, 7000, 14_999, 15_000, 16_000, 39_999]) assert.equal(toEdited(toSource(ms, keep), cuts), ms, `往返 ${ms}`);
  assert.equal(toSource(15_000, keep), 30_000, "接縫上的開始算下一段");
  assert.equal(toSource(15_000, keep, { atEnd: true }), 20_000, "接縫上的結束算上一段");
  assert.equal(toSource(99_000, keep), 55_000, "超過結尾停在最後");
});

test("transcribed characters from the joined audio go back to source times", () => {
  const keep = keepSegments(cuts, DUR);
  const chars = charsToSource([{ c: "前", s: 14_500, e: 15_000 }, { c: "後", s: 15_000, e: 15_400 }], keep);
  assert.deepEqual(chars, [{ c: "前", s: 19_500, e: 20_000 }, { c: "後", s: 30_000, e: 30_400 }]);
});

test("subtitles move with the edit: cut ones disappear, ones across a cut join up", () => {
  const out = remapCues([
    { start: 1000, end: 4000, text: "開頭被剪掉" },
    { start: 4000, end: 7000, text: "跨過開頭" },
    { start: 10_000, end: 12_000, text: "中間", ai: [{ find: "a", replace: "b" }] },
    { start: 19_000, end: 31_000, text: "跨過剪輯" },
    { start: 22_000, end: 25_000, text: "整句剪掉" },
    { start: 54_900, end: 59_000, text: "只剩一點點" },
  ], cuts);
  assert.deepEqual(out, [
    { start: 0, end: 2000, text: "跨過開頭" },
    { start: 5000, end: 7000, text: "中間", ai: [{ find: "a", replace: "b" }] },
    { start: 14_000, end: 16_000, text: "跨過剪輯" },
  ]);
  assert.deepEqual(remapCues([{ start: 1, end: 2, text: "x" }], [], 0), [{ start: 1, end: 2, text: "x" }], "沒有剪輯就不動");
});

test("YouTube chapters in the description follow the edit", () => {
  // 開場剪掉頭 5 秒後只剩 7 秒就到第一部分（不到 10 秒，第一部分併進開場）；
  // 「被剪掉的段落」22–28 秒整段在剪輯裡，拿掉；第二部分從 28 秒（剪輯中）算到下一段開頭
  const desc = "簡介第一段\n\n00:00 開場\n00:12 第一部分\n00:22 被剪掉的段落\n00:28 第二部分\n00:50 結尾\n\n#標籤";
  assert.equal(remapDescription(desc, cuts), "簡介第一段\n\n00:00 開場\n00:15 第二部分\n00:35 結尾\n\n#標籤");
  assert.equal(remapDescription(desc, []), desc, "沒有剪輯就不動");
  assert.equal(remapDescription("沒有章節", cuts), "沒有章節");
  const long = remapDescription("0:00 a\n1:30:00 b\n2:00:00 c", [{ start: 60_000, end: 120_000, by: "user" }]);
  assert.equal(long, "0:00:00 a\n1:29:00 b\n1:59:00 c", "超過一小時一律用 H:MM:SS");
});

test("key points under a chapter that the edit merges away go with it; one blank line stays between chapters (#46)", () => {
  // 同一份剪輯：「第一部分」併進開場、「被剪掉的段落」整段剪掉，它們底下的重點也跟著拿掉
  const desc = "簡介\n\n00:00 開場\n・開場重點\n\n00:12 第一部分\n・第一部分重點\n\n00:22 被剪掉的段落\n・剪掉的重點\n- 另一種寫法\n\n00:28 第二部分\n・第二部分重點\n\n00:50 結尾\n・結尾重點\n\n#標籤";
  assert.equal(remapDescription(desc, cuts),
    "簡介\n\n00:00 開場\n・開場重點\n\n00:15 第二部分\n・第二部分重點\n\n00:35 結尾\n・結尾重點\n\n#標籤");
  // 不是「・」開頭的字（使用者自己加的說明）不會被拿掉
  assert.equal(remapDescription("00:00 a\n00:12 b\n自己加的字\n00:30 c\n00:50 d", cuts), "00:00 a\n自己加的字\n00:15 c\n00:35 d");
});

test("restoring one sentence splits the cut around it; cut share tells how much of a range is gone", () => {
  const c = [{ start: 1000, end: 9000, by: "ai", reason: "離題" }, { start: 12_000, end: 13_000, by: "user" }];
  assert.deepEqual(subtractRange(c, 4000, 5000), [{ start: 1000, end: 4000, by: "ai", reason: "離題" }, { start: 5000, end: 9000, by: "ai", reason: "離題" }, { start: 12_000, end: 13_000, by: "user" }]);
  assert.deepEqual(subtractRange(c, 0, 8950), [{ start: 12_000, end: 13_000, by: "user" }], "剩下太短的不留");
  assert.equal(cutShare(c, 2000, 3000), 1);
  assert.equal(cutShare(c, 8000, 10_000), 0.5);
  assert.equal(cutShare(c, 10_000, 11_000), 0);
  assert.equal(cutShare(c, 5, 5), 0);
});

