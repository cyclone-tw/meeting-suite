// 剪輯區段與時間換算（recording-transcriber#4）：Subtitle Studio 的瀏覽器端、伺服器與測試共用。
//
// 專案裡的時間一律是「原片時間」（毫秒）。剪輯只是記錄剪掉的區段 cuts = [{ start, end, by, reason? }]，
// 原檔不動；輸出時才把字幕、章節換算成「剪輯後時間」。保留段 keep = [[start, end], ...] 是 cuts 的補集。

export const MIN_CUT_MS = 100;       // 比這短的剪輯沒有意義（約三格）
export const MIN_KEPT_CUE_MS = 200;  // 換算後短於這個的字幕不輸出（和 cue-ops 的 MIN_CUE_MS 一致）

// 排序、裁到片長內、合併重疊或相連的區段、丟掉太短的。合併時只要有一段是使用者剪的就算使用者的。
export function normalizeCuts(cuts, durationMs = Infinity) {
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => ({ ...c, start: Math.max(0, Math.round(Number(c?.start))), end: Math.min(durationMs, Math.round(Number(c?.end))) }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      if (c.by === "user") last.by = "user";
      if (!last.reason && c.reason) last.reason = c.reason;
    } else {
      out.push({ start: c.start, end: c.end, by: c.by === "ai" ? "ai" : "user", ...(c.reason ? { reason: String(c.reason) } : {}) });
    }
  }
  return out.filter((c) => c.end - c.start >= MIN_CUT_MS);
}

export function keepSegments(cuts, durationMs) {
  const keep = [];
  let at = 0;
  for (const c of normalizeCuts(cuts, durationMs)) {
    if (c.start > at) keep.push([at, c.start]);
    at = Math.max(at, c.end);
  }
  if (durationMs > at) keep.push([at, durationMs]);
  return keep;
}

// 從剪輯裡挖掉 [a, b]（「恢復這一句」用）：跨過它的剪輯拆成左右兩段
export function subtractRange(cuts, a, b) {
  const out = [];
  for (const c of cuts) {
    if (c.end <= a || c.start >= b) { out.push(c); continue; }
    if (c.start < a) out.push({ ...c, end: a });
    if (c.end > b) out.push({ ...c, start: b });
  }
  return out.filter((c) => c.end - c.start >= MIN_CUT_MS);
}

// 這一段有多少被剪掉了：0 沒剪、1 整段剪掉
export function cutShare(cuts, a, b) {
  if (!(b > a)) return 0;
  let n = 0;
  for (const c of cuts) n += Math.max(0, Math.min(b, c.end) - Math.max(a, c.start));
  return n / (b - a);
}

export const keptDuration = (keep) => keep.reduce((n, [a, b]) => n + (b - a), 0);

// 落在哪一段剪輯裡（播放時跳過用）；不在剪輯裡回傳 null
export function cutAt(cuts, ms) {
  for (const c of cuts) {
    if (ms < c.start) return null;
    if (ms < c.end) return c;
  }
  return null;
}

// 原片時間 → 剪輯後時間。落在剪掉的區段裡的，算在那段剪輯的位置（也就是下一個保留段的開頭）。
export function toEdited(ms, cuts) {
  let removed = 0;
  for (const c of cuts) {
    if (ms <= c.start) break;
    if (ms < c.end) return c.start - removed;
    removed += c.end - c.start;
  }
  return ms - removed;
}

// 剪輯後時間（或「只把保留段接起來的音檔」的時間）→ 原片時間。
// 剛好在兩段的接縫上時，開始時間算下一段的開頭，結束時間（atEnd）算上一段的結尾。
export function toSource(ms, keep, { atEnd = false } = {}) {
  let offset = 0;
  for (let i = 0; i < keep.length; i++) {
    const [a, b] = keep[i], len = b - a;
    if (ms < offset + len || (atEnd && ms === offset + len) || i === keep.length - 1) return a + Math.min(Math.max(ms - offset, 0), len);
    offset += len;
  }
  return ms;
}

// 字幕換算成剪輯後的時間：整句被剪掉的不輸出，跨過剪輯的併成一段，剩下太短的不輸出。
export function remapCues(cues, cuts, minMs = MIN_KEPT_CUE_MS) {
  const out = [];
  for (const c of cues) {
    const start = toEdited(c.start, cuts), end = toEdited(c.end, cuts);
    if (end - start >= minMs) out.push({ ...c, start, end });
  }
  return out;
}

// 辨識結果（只送保留段時，時間是接起來的音檔的時間）換回原片時間
export const charsToSource = (chars, keep) => chars.map((c) => ({ ...c, s: toSource(c.s, keep), e: toSource(c.e, keep, { atEnd: true }) }));

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(\s+)/;
const BULLET = /^\s*[・•\-*]/;

export function fmtChapter(ms, long = false) {
  const t = Math.floor(ms / 1000), p = (n) => String(n).padStart(2, "0");
  return t >= 3600 || long ? `${Math.floor(t / 3600)}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`;
}

// 說明欄裡的章節時間（行首的 MM:SS 或 H:MM:SS）換算成剪輯後的時間。
// 整章都被剪掉的（剪完長度是 0）拿掉；剪完和前一章距離不到 10 秒的（YouTube 規定）併進前一章；第一章固定 00:00。
export function remapDescription(text, cuts) {
  const lines = String(text || "").split("\n");
  const chapters = [];
  lines.forEach((line, i) => {
    const m = TS.exec(line);
    if (m) chapters.push({ i, ms: toEdited(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000, cuts), rest: line.slice(m[0].length), gap: m[4] });
  });
  if (!chapters.length || !cuts.length) return String(text || "");
  const live = chapters.filter((c, k) => !chapters[k + 1] || chapters[k + 1].ms > c.ms);
  const keep = [];
  for (const c of live) if (!keep.length || c.ms - keep[keep.length - 1].ms >= 10_000) keep.push(c);
  if (keep.length) keep[0].ms = 0;
  const long = keep.some((c) => c.ms >= 3600_000);
  const byLine = new Map(keep.map((c) => [c.i, `${fmtChapter(c.ms, long)}${c.gap}${c.rest}`]));
  const chapterLines = new Set(chapters.map((c) => c.i));
  // 被剪掉而合併的章節：它底下「・」開頭的重點（#46）跟著拿掉，不會掛到上一章底下；
  // 章節之間的空行也只留一行
  const out = [];
  let dropping = false;
  lines.forEach((line, i) => {
    if (chapterLines.has(i)) {
      dropping = !byLine.has(i);
      if (!dropping) out.push(byLine.get(i));
      return;
    }
    if (dropping && BULLET.test(line)) return;
    if (dropping && !line.trim() && out.length && !out[out.length - 1].trim()) { dropping = false; return; }
    dropping = false;
    out.push(line);
  });
  return out.join("\n");
}
