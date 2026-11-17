// 編輯頁三欄的寬度（#170）：分隔線拖到哪裡，中間的影片都至少留 360px
import { test } from "node:test";
import assert from "node:assert/strict";
import { CENTER_MIN, GUTTERS, clampWidth, splitBounds } from "../lib/studio-layout.mjs";

const LIB = { min: 200, max: 480 }, RIGHT = { min: 320, max: 900 };

test("the list can only grow into the room the right pane leaves", () => {
  // 編輯頁 1000px、右欄 360px：左欄最多 1000 − 360 − 360 − 12 = 268
  const b = splitBounds({ editorW: 1000, otherW: 360, ...LIB });
  assert.deepEqual(b, { min: 200, max: 268 });
  const lib = clampWidth(400, b);
  assert.equal(lib, 268);
  assert.ok(1000 - lib - 360 - GUTTERS >= CENTER_MIN, "中間至少留 360px");
});

test("the right pane reaches its own maximum on a wide screen, whatever its current width", () => {
  // 1400px、左欄 248px：右欄最多 1400 − 248 − 372 = 780，不會因為自己目前多寬而變
  assert.deepEqual(splitBounds({ editorW: 1400, otherW: 248, ...RIGHT }), { min: 320, max: 780 });
  assert.deepEqual(splitBounds({ editorW: 2400, otherW: 248, ...RIGHT }), { min: 320, max: 900 }, "夠寬時是自己的上限");
});

test("a collapsed list gives its room to the right pane", () => {
  assert.deepEqual(splitBounds({ editorW: 1200, otherW: 0, ...RIGHT }), { min: 320, max: 828 });
});

test("never below the pane's own minimum, even when the window is too narrow", () => {
  assert.deepEqual(splitBounds({ editorW: 800, otherW: 360, ...LIB }), { min: 200, max: 200 });
  assert.equal(clampWidth(150, { min: 200, max: 268 }), 200);
  assert.equal(clampWidth(233.6, { min: 200, max: 268 }), 234);
});
