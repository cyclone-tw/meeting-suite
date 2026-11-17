// 學習筆記（#172）：專案資料夾的 notes.md，一則一段「## 時間」標題，底下是 Markdown 內容。
// 伺服器存讀、頁面顯示共用這份（頁面經 web/studio/libs.mjs 掛成 window.notesOps）。手改的檔也讀得回來。
//
//   # 學習筆記：影片名稱
//
//   ## 1:05
//   筆記內容……
//
//   ## 1:02:03
//   ……

export const NOTE_MAX = 5000;          // 每則最多幾個字
export const NOTES_MAX = 300;          // 最多幾則
export const FILE_MAX = 1024 * 1024;   // notes.md 最大 1 MB

const HEAD = /^##[ \t]+(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[ \t]*$/;
// 內容裡「零到多個反斜線＋時間標題」的行：寫檔時多加一個反斜線，讀回只拿掉一個，來回一定一致（#175）
const ANY_HEAD = /^\\*##[ \t]+(?:\d{1,2}:)?\d{1,2}:\d{2}[ \t]*$/;
const ESCAPED_HEAD = /^\\(\\*##[ \t]+(?:\d{1,2}:)?\d{1,2}:\d{2}[ \t]*)$/;
const chars = (s) => [...String(s)].length;

// 一小時以內 M:SS，以上 H:MM:SS
export function noteTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), p = (n) => String(n).padStart(2, "0");
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}` : `${Math.floor(t / 60)}:${p(t % 60)}`;
}

// notes.md → [{ t_ms, text }]，依時間排序（同一時間照檔案順序）。第一個時間標題之前的內容（大標題）不算；空的筆記不要。
export function parseNotes(md) {
  const notes = [];
  let cur = null;
  for (const line of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = HEAD.exec(line);
    if (m && Number(m[3]) <= 59 && (m[1] === undefined || Number(m[2]) <= 59)) {
      cur = { t_ms: ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000, lines: [] };
      notes.push(cur);
    } else if (cur) cur.lines.push(line.replace(ESCAPED_HEAD, "$1"));
  }
  return notes.map((n, i) => ({ t_ms: n.t_ms, text: n.lines.join("\n").trim(), i }))
    .filter((n) => n.text)
    .sort((a, b) => a.t_ms - b.t_ms || a.i - b.i)
    .map(({ t_ms, text }) => ({ t_ms, text }));
}

// [{ t_ms, text }] → notes.md。筆記內容裡長得像時間標題的行（含本來就有反斜線的）多加一個反斜線，讀回來時拿掉一個。
export function formatNotes(notes, { title = "" } = {}) {
  const name = String(title).replace(/\s+/g, " ").trim();
  const body = [...notes].sort((a, b) => a.t_ms - b.t_ms).map((n) => {
    const text = String(n.text).replace(/\r\n?/g, "\n").trim().split("\n").map((l) => (ANY_HEAD.test(l) ? `\\${l}` : l)).join("\n");
    return `## ${noteTime(n.t_ms)}\n${text}\n`;
  });
  return `# 學習筆記${name ? `：${name}` : ""}\n\n${body.join("\n")}`;
}

// 頁面送來的整份筆記：格式不對的回錯誤代碼，伺服器換成訊息
export function cleanNotes(raw, { durationMs = Infinity } = {}) {
  if (!Array.isArray(raw)) return { error: "bad" };
  if (raw.length > NOTES_MAX) return { error: "too-many" };
  const notes = [];
  for (const n of raw) {
    if (!n || typeof n.text !== "string" || !Number.isFinite(n.t_ms) || n.t_ms < 0) return { error: "bad" };
    const text = n.text.replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    if (chars(text) > NOTE_MAX) return { error: "too-long" };
    // notes.md 只記到秒：這裡就取整秒，回給頁面的和重新整理讀回的一樣（#175）
    notes.push({ t_ms: Math.floor(Math.min(n.t_ms, durationMs) / 1000) * 1000, text });
  }
  return { notes: notes.sort((a, b) => a.t_ms - b.t_ms) };
}
