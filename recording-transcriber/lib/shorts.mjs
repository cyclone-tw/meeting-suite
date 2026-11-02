// 長片切直式短片（recording-transcriber#54）：Subtitle Studio 的瀏覽器端、伺服器與測試共用，不能用 node 專屬的模組。
//
// 片段 item = { id, n, title, reason, start, end, by }：start／end 是原片時間（毫秒），對齊字幕句子的開頭與結尾。
// 片段裡有剪掉的區段（cuts）時，照剪輯接起來；整句都被剪掉的字幕不能當片段的開頭或結尾。
// 輸出的直式影片：上方大字標題、中間原片等比縮放（不裁切）、下方大字幕，背景是原片模糊放大。

import { cutShare, keptDuration, normalizeCuts } from "./cuts.mjs";
import { assText, assTime, boxDialogues, boxStyles, cueBoxLines, displayText } from "./subtitle-box.mjs";

export const AI_MIN_MS = 15_000;      // AI 挑的片段剪完比這短的不要
export const AI_TARGET_MAX_MS = 90_000;
export const MIN_MS = 3_000;          // 使用者微調後的上下限
export const MAX_MS = 180_000;        // YouTube Shorts 最長 3 分鐘
export const MAX_ITEMS = 12;
export const TITLE_MAX = 30;
export const ADD_TARGET_MS = 45_000;  // 「從目前位置加一段」先抓的長度

export const W = 1080, H = 1920;
export const TITLE_FS = 96, SUB_FS = 76;   // libass 字級（PlayRes 就是輸出解析度，所以單位是像素）
const GAP = 48;                             // 標題、字幕和影片之間的距離

const oneLine = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
export const cleanTitle = (x, max = TITLE_MAX) => [...oneLine(x)].slice(0, max).join("");

// 還留著的字幕：有字、而且沒有大半被剪掉
export const liveCues = (cues, cuts = []) => (cues || []).filter((c) => String(c.text || "").trim() && cutShare(cuts, c.start, c.end) < 0.5);

// 片段實際播出的區段（原片時間）：[start, end] 扣掉剪輯，太短的碎片不要
export function shortKeep({ start, end }, cuts = []) {
  const keep = [];
  let at = start;
  for (const c of normalizeCuts(cuts)) {
    if (c.end <= at) continue;
    if (c.start >= end) break;
    if (c.start > at) keep.push([at, c.start]);
    at = Math.max(at, c.end);
  }
  if (end > at) keep.push([at, end]);
  return keep.filter(([a, b]) => b - a >= 100);
}

export const shortLength = (item, cuts = []) => keptDuration(shortKeep(item, cuts));

// 原片時間 → 短片裡的時間
function toShort(ms, keep) {
  let t = 0;
  for (const [a, b] of keep) {
    if (ms <= a) break;
    t += Math.min(ms, b) - a;
  }
  return t;
}

// 短片裡的字幕（短片時間）：只留片段內的部分，換算後太短的不要
export function shortCues(item, cues, cuts = []) {
  const keep = shortKeep(item, cuts);
  const out = [];
  for (const c of cues || []) {
    if (!String(c.text || "").trim() || c.end <= item.start || c.start >= item.end) continue;
    const start = toShort(Math.max(c.start, item.start), keep), end = toShort(Math.min(c.end, item.end), keep);
    if (end - start >= 200) out.push({ start, end, text: c.text, ...(c.tr !== undefined ? { tr: c.tr } : {}) });
  }
  return out;
}

// 對齊到字幕句子：開頭對到「包含或在 start 之後」的第一句，結尾對到「包含或在 end 之前」的最後一句
export function snapRange(start, end, cues, cuts = []) {
  const live = liveCues(cues, cuts);
  const si = live.findIndex((c) => c.end > start);
  let ei = -1;
  for (let i = live.length - 1; i >= 0; i--) if (live[i].start < end) { ei = i; break; }
  if (si < 0 || ei < si) return null;
  return { start: live[si].start, end: live[ei].end };
}

// 太長就從結尾一句一句拿掉（至少留一句）
export function fitLength(range, cues, cuts = [], max = AI_TARGET_MAX_MS) {
  const live = liveCues(cues, cuts).filter((c) => c.start >= range.start && c.end <= range.end);
  let r = { ...range };
  while (live.length > 1 && shortLength(r, cuts) > max) {
    live.pop();
    r = { ...r, end: live[live.length - 1].end };
  }
  return r;
}

// 開頭或結尾往前、往後移一句（dir = -1 早一句、+1 晚一句）。移不動或會變得太短、太長就回傳 null
export function moveEdge(item, which, dir, cues, cuts = []) {
  const live = liveCues(cues, cuts);
  let next;
  if (which === "start") {
    const i = live.findIndex((c) => c.start >= item.start - 1);
    const j = (i < 0 ? live.length : i) + dir;
    if (j < 0 || j >= live.length) return null;
    next = { ...item, start: live[j].start };
  } else {
    let i = -1;
    for (let k = live.length - 1; k >= 0; k--) if (live[k].end <= item.end + 1) { i = k; break; }
    const j = i + dir;
    if (j < 0 || j >= live.length) return null;
    next = { ...item, end: live[j].end };
  }
  if (next.end <= next.start) return null;
  const len = shortLength(next, cuts);
  if (len < MIN_MS || len > MAX_MS) return null;
  return next;
}

// 從某個時間點加一段：從那裡（或之後）的第一句開始，往後加句子到大約 ADD_TARGET_MS
export function rangeFrom(ms, cues, cuts = [], target = ADD_TARGET_MS) {
  const live = liveCues(cues, cuts);
  const i = live.findIndex((c) => c.end > ms);
  if (i < 0) return null;
  let r = { start: live[i].start, end: live[i].end };
  for (let k = i + 1; k < live.length && shortLength(r, cuts) < target; k++) {
    const next = { ...r, end: live[k].end };
    if (shortLength(next, cuts) > AI_TARGET_MAX_MS) break;
    r = next;
  }
  return r;
}

export const nextN = (items) => (items || []).reduce((n, x) => Math.max(n, Number(x.n) || 0), 0) + 1;

const parseClock = (s) => {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?$/.exec(String(s ?? "").trim());
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
};

// AI 的建議整理成片段：對齊句子、太長的截短、太短或重疊的不要，依時間排好，最多 max 段
export function shortsFromAi(list, cues, cuts = [], { max = 5, makeId = (i) => `s${i}` } = {}) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const a = parseClock(x?.start), b = parseClock(x?.end);
    const title = cleanTitle(x?.title, 20);
    if (a === null || b === null || b <= a || !title) continue;
    const snapped = snapRange(a, b, cues, cuts);
    if (!snapped) continue;
    const r = fitLength(snapped, cues, cuts);
    if (shortLength(r, cuts) < AI_MIN_MS) continue;
    if (out.some((o) => Math.min(o.end, r.end) - Math.max(o.start, r.start) > 0)) continue;
    out.push({ ...r, title, reason: cleanTitle(x?.reason, 60), by: "ai" });
    if (out.length >= max) break;
  }
  return out.sort((p, q) => p.start - q.start).map((x, i) => ({ id: makeId(i), ...x }));
}

// 從頁面收到的片段清單：檢查格式、重新對齊句子、檢查長度。輸出紀錄（output、export）只由伺服器寫，這裡不收
export function validateShorts(raw, cues, cuts = []) {
  if (!Array.isArray(raw)) throw new Error("片段格式不對");
  if (raw.length > MAX_ITEMS) throw new Error(`最多 ${MAX_ITEMS} 段`);
  const seen = new Set(), ns = new Set();
  return raw.map((x) => {
    const id = String(x?.id || "");
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) throw new Error("片段編號不對");
    seen.add(id);
    const n = Number(x.n);
    if (!Number.isInteger(n) || n < 1 || n > 999 || ns.has(n)) throw new Error("片段序號不對");
    ns.add(n);
    const start = Math.round(Number(x.start)), end = Math.round(Number(x.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("片段的時間不對");
    const r = snapRange(start, end, cues, cuts);
    if (!r) throw new Error("這段已經沒有字幕了（可能被剪掉），請刪掉它");
    const len = shortLength(r, cuts);
    if (len < MIN_MS || len > MAX_MS) throw new Error(`每段要在 ${MIN_MS / 1000} 秒到 ${MAX_MS / 60000} 分鐘之間`);
    return { id, n, title: cleanTitle(x.title), reason: cleanTitle(x.reason, 120), by: x.by === "ai" ? "ai" : "user", ...r };
  });
}

// 版面：原片等比縮放到寬 1080（直式或接近正方形的影片縮到放得進畫面），垂直置中。
// 上下留得夠，就把標題放在影片上方、字幕放在影片下方；不夠（直式影片）就疊在影片上
export function shortLayout(srcW, srcH) {
  const even = (x) => Math.max(2, 2 * Math.round(x / 2));
  const ratio = srcW > 0 && srcH > 0 ? srcH / srcW : 9 / 16;
  let vw = W, vh = even(W * ratio);
  if (vh > H) { vh = H; vw = even(H / ratio); }
  const top = Math.round((H - vh) / 2);
  const roomy = top >= 320;
  return {
    vw, vh, x: Math.round((W - vw) / 2), top,
    // libass：Alignment 2 是下緣置中、8 是上緣置中；MarginV 是距離畫面下緣／上緣
    title: roomy ? { align: 2, marginV: H - top + GAP } : { align: 8, marginV: 160 },
    sub: roomy ? { align: 8, marginV: top + vh + GAP } : { align: 2, marginV: 260 },
  };
}

// 短片的 ASS 字幕：一行從頭到尾的標題，加上換算成短片時間的字幕。
// style 是 "box"（圓角底框，#55）或 "outline"（白字黑邊）；adv 是量過的字寬（見 subtitle-box.mjs）；
// mode 是外語影片的中文／原文／雙語（#56，一般影片沒有譯文，不受影響）
export function shortAss({ title, cues, durationMs, layout, style: subStyle = "box", adv = {}, advSub, mode }) {
  const box = subStyle === "box";
  const anchor = layout.sub.align === 8 ? { x: W / 2, top: layout.sub.marginV } : { x: W / 2, bottom: H - layout.sub.marginV };
  const subs = box
    ? cues.flatMap((c) => boxDialogues({ start: c.start, end: c.end, lines: cueBoxLines(c, { fs: SUB_FS, maxWidthPx: W - 140, adv, advSub, mode }), anchor, adv }))
    : cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Sub,,0,0,0,,${assText(displayText(c, mode))}`);
  const style = (name, fs, colour, outline, { align, marginV }, bold) =>
    `Style: ${name},PingFang TC,${fs},${colour},&H00FFFFFF,&H00000000,&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},0,${align},70,70,${marginV},1`;
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Title", TITLE_FS, "&H0046D7FF", 6, layout.title, true),
    style("Sub", SUB_FS, "&H00FFFFFF", 5, layout.sub, false),
    ...(box ? boxStyles(SUB_FS) : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...(oneLine(title) ? [`Dialogue: 0,${assTime(0)},${assTime(durationMs)},Title,,0,0,0,,${assText(oneLine(title))}`] : []),
    ...subs,
    "",
  ].join("\n");
}
