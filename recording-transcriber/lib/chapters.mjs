// 時間軸章節（#170）：把說明欄的章節（行首 MM:SS 或 H:MM:SS，後面接標題）或會後總結的章節，
// 換成編輯頁時間軸上的分段。時間一律是原片時間，和時間軸、播放器一樣。
// 伺服器不用；頁面經 web/studio/libs.mjs 掛成 window.chapterOps。

const LINE = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(\S.*?)\s*$/;
const TITLE_MAX = 80;
const MIN_CHAPTERS = 2;   // 只有一章等於整支，畫了也沒用

const cap = (s) => [...s].slice(0, TITLE_MAX).join("");

// 說明欄 → [{ ms, title }]，依時間排序；同一個時間只留第一個；秒、分超過 59 的不算
export function parseChapters(text) {
  const out = [], seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [h, mm, ss] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
    if (ss > 59 || (m[1] !== undefined && mm > 59)) continue;
    const ms = ((h * 60 + mm) * 60 + ss) * 1000;
    if (seen.has(ms)) continue;
    seen.add(ms);
    out.push({ ms, title: cap(m[4]) });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

// 先用說明欄的章節（AI 寫的、使用者可以改）；不到兩章才用會後總結的章節（[{ t_ms, title }]）
export function pickChapters(description, recapChapters) {
  const fromDesc = parseChapters(description);
  if (fromDesc.length >= MIN_CHAPTERS) return fromDesc;
  const fromRecap = (Array.isArray(recapChapters) ? recapChapters : [])
    .filter((c) => c && Number.isFinite(c.t_ms) && c.t_ms >= 0 && typeof c.title === "string" && c.title.trim())
    .map((c) => ({ ms: Math.round(c.t_ms), title: cap(c.title.trim()) }))
    .sort((a, b) => a.ms - b.ms);
  return fromRecap.length >= MIN_CHAPTERS ? fromRecap : [];
}

// [{ ms, title }] → [{ start, end, title }]：每章到下一章開始（最後一章到片尾）；片長之外的不要
export function chapterSpans(chapters, durationMs) {
  if (!(durationMs > 0)) return [];
  const live = (chapters || []).filter((c) => c.ms < durationMs);
  return live.map((c, i) => ({ start: c.ms, end: i + 1 < live.length ? live[i + 1].ms : durationMs, title: c.title }));
}

// 這個時間在第幾章；第一章之前回 -1；分段一章接一章，片尾算最後一章
export function chapterAt(spans, ms) {
  for (let i = spans.length - 1; i >= 0; i--) if (ms >= spans[i].start) return i;
  return -1;
}
