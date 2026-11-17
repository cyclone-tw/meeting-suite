// 編輯頁三欄的寬度（#170）：拖哪一條分隔線，都要讓中間的影片至少留 CENTER_MIN。
// 伺服器不用；頁面經 web/studio/libs.mjs 掛成 window.layoutOps。

export const CENTER_MIN = 360;   // 中間影片欄最少的寬度
export const GUTTERS = 12;       // 兩條分隔線各 6px

// 一欄能拉到多寬：自己的上下限，再扣掉「對面那一欄」與中間要留的寬度。對面的欄收起來時 otherW 是 0。
export function splitBounds({ editorW, otherW, min, max, centerMin = CENTER_MIN, gutters = GUTTERS }) {
  const room = editorW - otherW - centerMin - gutters;
  return { min, max: Math.max(min, Math.min(max, room)) };
}

export const clampWidth = (px, bounds) => Math.round(Math.max(bounds.min, Math.min(bounds.max, px)));
