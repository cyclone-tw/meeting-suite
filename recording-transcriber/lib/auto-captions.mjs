// YouTube 自動字幕（#182）：yt-dlp 抓下來的 json3 整理成一句一句的字幕，再寫成 VTT，
// 之後和作者字幕走同一條路（台灣用語、說明欄）。
//
// json3 的 events：每段有 tStartMs、dDurationMs、segs[].utf8；aAppend 的事件只是換行，跳過。
// 每句的結束時間不超過下一句的開始，免得字幕疊在一起。

const pad = (n, w = 2) => String(n).padStart(w, "0");
export function vttTime(ms) {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}`;
}

// 自動字幕的換行折成空白後，中文、日文字之間不該有空白（韓文本來就用空白分詞，不動）
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "gu");
export const tidyText = (s) => String(s).replace(/\s+/g, " ").trim().replace(CJK_GAP, "");
// 沒有長度（或長度是 0）的段：給最短顯示時間，再被下一句的起點截掉
export const MIN_CUE_MS = 1000;

export function json3Cues(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const raw = [];
  for (const e of events) {
    if (!Array.isArray(e?.segs) || e.aAppend) continue;
    const text = tidyText(e.segs.map((s) => String(s?.utf8 ?? "")).join(""));
    const start = Number(e.tStartMs);
    if (!text || !Number.isFinite(start) || start < 0) continue;
    const dur = Number(e.dDurationMs) > 0 ? Number(e.dDurationMs) : MIN_CUE_MS;
    raw.push({ start, end: start + dur, text });
  }
  raw.sort((a, b) => a.start - b.start);
  // 起點一樣的幾段併成一句（不然前一段會被下一段的起點截成 0 長度而不見）
  const merged = [];
  for (const c of raw) {
    const last = merged[merged.length - 1];
    if (last && last.start === c.start) Object.assign(last, { end: Math.max(last.end, c.end), text: tidyText(`${last.text} ${c.text}`) });
    else merged.push({ ...c });
  }
  const cues = [];
  merged.forEach((c, i) => {
    const next = merged[i + 1]?.start;
    const end = Math.min(c.end, Number.isFinite(next) ? next : Infinity);
    if (end > c.start) cues.push({ start: c.start, end, text: c.text });
  });
  return cues;
}

export function cuesToVtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join("\n")}`;
}
