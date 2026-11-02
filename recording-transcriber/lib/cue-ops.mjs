// 字幕編輯的純函式：Subtitle Studio 的瀏覽器端與測試共用。
// 時間一律毫秒；cues 是 [{ start, end, text, ai? }]，函式都回傳新陣列，不改原本的。

export const MAX_LINE = 16;          // 和 subtitle-text.mjs 的 SUBTITLE_DEFAULTS.maxLine 一致
export const MIN_CUE_MS = 200;

// 英數算半格
export function cueWidth(text) {
  let w = 0;
  for (const ch of String(text || "")) if (ch.trim()) w += ch.charCodeAt(0) < 128 ? 0.5 : 1;
  return w;
}

export const tooLong = (text) => cueWidth(text) > MAX_LINE + 2;

// 目前時間落在哪一句；兩句之間的空檔回傳 -1
export function cueIndexAt(cues, ms) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < cues[mid].start) hi = mid - 1;
    else if (ms >= cues[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// 目前時間之後（含）最近的一句；用在空檔時「下一句」
export function nextCueIndex(cues, ms) {
  for (let i = 0; i < cues.length; i++) if (cues[i].end > ms) return i;
  return cues.length - 1;
}

const clone = (cues) => cues.map((c) => ({ ...c }));

// 在第 pos 個字切開，時間依字數比例分
export function splitCue(cues, i, pos) {
  const c = cues[i];
  if (!c) return cues;
  const chars = [...c.text];
  if (pos <= 0 || pos >= chars.length) return cues;
  const a = chars.slice(0, pos).join("").trim(), b = chars.slice(pos).join("").trim();
  if (!a || !b) return cues;
  const at = Math.round(c.start + ((c.end - c.start) * cueWidth(a)) / Math.max(0.5, cueWidth(a) + cueWidth(b)));
  const out = clone(cues);
  // 有譯文（外語影片，#56）：譯文留在前半句，後半句的譯文空著，之後再補或重翻
  out.splice(i, 1, { ...c, end: at, text: a }, { ...c, start: at, text: b, ...(c.tr !== undefined ? { tr: "" } : {}) });
  return out;
}

// 和下一句合併
export function mergeNext(cues, i) {
  if (i < 0 || i >= cues.length - 1) return cues;
  const a = cues[i], b = cues[i + 1];
  const ai = [...(a.ai || []), ...(b.ai || [])];
  const out = clone(cues);
  // 兩句之間原本是停頓或逗號，台灣字幕慣例用空格隔開
  const tr = a.tr !== undefined || b.tr !== undefined ? { tr: `${a.tr || ""} ${b.tr || ""}`.trim() } : {};
  out.splice(i, 2, { start: a.start, end: b.end, text: `${a.text} ${b.text}`.trim(), ...tr, ...(ai.length ? { ai } : {}) });
  return out;
}

// 設定起點或終點，不跟前後句重疊、不短於 MIN_CUE_MS
export function setTime(cues, i, which, ms) {
  const c = cues[i];
  if (!c) return cues;
  const prevEnd = i > 0 ? cues[i - 1].end : 0, nextStart = i < cues.length - 1 ? cues[i + 1].start : Infinity;
  const out = clone(cues);
  // 不跟前後句重疊優先；空間不夠時才讓這句短於 MIN_CUE_MS
  if (which === "start") out[i].start = Math.round(Math.max(prevEnd, Math.min(ms, c.end - MIN_CUE_MS)));
  else out[i].end = Math.round(Math.min(nextStart, Math.max(ms, c.start + MIN_CUE_MS)));
  if (out[i].start < 0) out[i].start = 0;
  return out;
}

export const nudge = (cues, i, which, delta) => setTime(cues, i, which, cues[i][which] + delta);

// 在目前時間插入一句空白字幕（落在某句裡就不插）
export function insertAt(cues, ms, durationMs = 1500) {
  if (cueIndexAt(cues, ms) !== -1) return { cues, index: -1 };
  const n = nextCueIndex(cues, ms);
  const after = cues[n] && cues[n].start > ms ? n : cues.length;
  const end = Math.min(ms + durationMs, after < cues.length ? cues[after].start : Infinity);
  if (end - ms < MIN_CUE_MS) return { cues, index: -1 };
  const out = clone(cues);
  out.splice(after, 0, { start: Math.round(ms), end: Math.round(end), text: "" });
  return { cues: out, index: after };
}

export function removeCue(cues, i) {
  const out = clone(cues);
  out.splice(i, 1);
  return out;
}

export function setText(cues, i, text) {
  const out = clone(cues);
  out[i].text = String(text).replace(/\s+/gu, " ").trim();
  return out;
}

// 改字後猜「錯 → 對」：去掉前後相同的部分，剩下中間那段。太長或只是加減空白就不提示。
export function correctionFromEdit(before, after) {
  const a = [...String(before)], b = [...String(after)];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // 往外擴成完整英文單字，避免 "Clode"→"Claude" 只抓到中間幾個字母
  while (p > 0 && /[A-Za-z0-9]/.test(a[p - 1]) && (/[A-Za-z0-9]/.test(a[p] ?? "") || /[A-Za-z0-9]/.test(b[p] ?? ""))) p--;
  while (s > 0 && /[A-Za-z0-9]/.test(a[a.length - s]) && (/[A-Za-z0-9]/.test(a[a.length - s - 1] ?? "") || /[A-Za-z0-9]/.test(b[b.length - s - 1] ?? ""))) s--;
  const mid = (x) => x.slice(p, x.length - s).join("").trim();
  if (!mid(a) || !mid(b)) return null;   // 純加字或純刪字不是錯字
  // 中文只差一個字（學長→學障）：帶上前一個字（沒有就後一個），錯字表才是一個詞
  const one = (x) => [...x.slice(p, x.length - s).join("").trim()].length < 2;
  while ((one(a) || one(b)) && p > 0 && /\p{Script=Han}/u.test(a[p - 1])) p--;
  while ((one(a) || one(b)) && s > 0 && /\p{Script=Han}/u.test(a[a.length - s])) s--;
  const wrong = a.slice(p, a.length - s).join("").trim(), right = b.slice(p, b.length - s).join("").trim();
  if (!wrong || !right || wrong === right) return null;
  if ([...wrong].length > 12 || [...right].length > 12) return null;
  return { wrong, right };
}

// 全片取代（不含 except 那一句）；回傳新陣列與改了幾處
export function replaceAll(cues, find, rep, except = -1) {
  if (!find) return { cues, count: 0 };
  let count = 0;
  const out = cues.map((c, i) => {
    if (i === except || !c.text.includes(find)) return c;
    count += c.text.split(find).length - 1;
    return { ...c, text: c.text.split(find).join(rep) };
  });
  return { cues: out, count };
}

// AI 更正名字（#60）：一次套用好幾組「錯 → 對」。每句從頭掃一遍，同一個位置先比長的錯字
// （「王詩語」先於「詩語」）；換上去的字不再被別組比對，不會連鎖替換。
// 每改一處加一筆 ai 標記（{find: 錯, replace: 對}），「AI 改過」篩選和「改回原字」照常可用；
// 原本的標記留著，每句最多 maxAi 筆。改完超過 maxText 字的句子不改（存檔會被擋），算在 skipped。
// perPair 依傳入的順序回報每組改了幾處。
export function applyNamePairs(cues, pairs, { maxText = 200, maxAi = 10 } = {}) {
  const list = pairs.map((p, k) => ({ ...p, k })).filter((p) => p.wrong && p.wrong !== p.right)
    .sort((a, b) => [...b.wrong].length - [...a.wrong].length);
  const perPair = pairs.map(() => 0), changed = [];
  let count = 0, skipped = 0;
  const out = cues.map((c, i) => {
    const text = String(c.text || ""), hits = [];
    let next = "";
    for (let at = 0; at < text.length;) {
      const p = list.find((x) => text.startsWith(x.wrong, at));
      if (p) { next += p.right; hits.push(p); at += p.wrong.length; } else { next += text[at]; at += 1; }
    }
    if (!hits.length) return c;
    if ([...next].length > maxText) { skipped += 1; return c; }
    count += hits.length;
    changed.push(i);
    for (const p of hits) perPair[p.k] += 1;
    const ai = [...(c.ai || []).map((e) => ({ ...e })), ...hits.map((p) => ({ find: p.wrong, replace: p.right }))].slice(0, maxAi);
    return { ...c, text: next, ai };
  });
  return { cues: out, count, changed, skipped, perPair };
}

// 第一個出現 find 的句子，前後各帶 pad 個字（預覽用）
export function contextOf(cues, find, pad = 8) {
  if (!find) return null;
  for (let i = 0; i < cues.length; i++) {
    const at = cues[i].text.indexOf(find);
    if (at < 0) continue;
    const before = [...cues[i].text.slice(0, at)].slice(-pad).join(""), after = [...cues[i].text.slice(at + find.length)].slice(0, pad).join("");
    return { i, before, hit: find, after };
  }
  return null;
}

export function countIn(cues, find, except = -1) {
  if (!find) return 0;
  return cues.reduce((n, c, i) => (i === except ? n : n + c.text.split(find).length - 1), 0);
}

export function fmtTime(ms, withMs = false) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const base = h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  return withMs ? `${base}.${String(Math.floor((t % 1000) / 100))}` : base;
}
