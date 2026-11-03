// 使用者自己的字幕檔（recording-transcriber#148）：選好影片後改用已經有的 SRT／VTT，不用重新辨識。
//
//   nearbySubtitles(video)  → 影片旁邊同名的字幕檔 [{ name, path }]（影片.srt、影片.zh_TW.srt、影片.en.vtt…）
//   readSubtitleFile(file)  → { file, ext, raw, cues }；cues 已拿掉格式標記（<i>、{\an8}）與空句。
//                             檔案不對就丟出給使用者看的錯誤訊息
import fs from "node:fs";
import path from "node:path";
import { parseSrt } from "./studio-project.mjs";
import { parseVtt } from "./youtube-source.mjs";

export const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nearbySubtitles(video) {
  const dir = path.dirname(video), base = path.basename(video, path.extname(video));
  const re = new RegExp(`^${escRe(base)}(\\.[\\w-]{1,20})?\\.(srt|vtt)$`, "i");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  // 先沒有語言標記的（影片.srt），再中文（影片.zh_TW.srt），其他語言最後：預設語言是中文，前端會先帶第一個
  const rank = (n) => { const tag = (re.exec(n)[1] || "").slice(1).toLowerCase(); return !tag ? 0 : /^(zh|cmn|chi)\b|^zh[-_]/.test(tag) ? 1 : 2; };
  return names.filter((n) => re.test(n)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name, path: path.join(dir, name) }))
    .filter((x) => { try { return fs.statSync(x.path).isFile(); } catch { return false; } });
}

// 字幕檔常見的格式標記：已知的樣式標籤（<i>、<font color=…>、VTT 的 <c>、<v 講者>、<00:00:01.000>）與 ASS 位置碼（{\an8}）。
// 只拿掉這些，字幕裡本來的「x < 5」「<command>」照留
const TAGS = /<\/?(?:i|b|u|s|font|c|v|ruby|rt|lang)(?:[\s.][^>\n]*)?>|<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/gi;
const clean = (t) => String(t).replace(TAGS, "").replace(/\{\\[^}\n]*\}/g, "").replace(/\s+/g, " ").trim();

export function readSubtitleFile(value) {
  const raw0 = String(value || "").trim().replace(/^file:\/\//, "");
  if (!raw0 || !path.isAbsolute(raw0)) throw new Error("字幕檔路徑要是完整路徑");
  const ext = path.extname(raw0).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(ext)) throw new Error("字幕檔只收 SRT 或 VTT（.srt、.vtt）");
  if (!fs.existsSync(raw0) || !fs.statSync(raw0).isFile()) throw new Error("找不到這個字幕檔");
  const file = fs.realpathSync(raw0);
  if (fs.statSync(file).size > MAX_SUBTITLE_BYTES) throw new Error("字幕檔超過 2 MB，看起來不是字幕檔");
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  // Big5、UTF-16 這類讀成 UTF-8 會變亂碼：直接說清楚，不要做出一份亂碼專案
  if (raw.includes("\uFFFD") || raw.includes("\u0000")) throw new Error("字幕檔不是 UTF-8 編碼；請用文字編輯器另存成 UTF-8 再選一次");
  return { file, ext, raw, cues: parseSubtitleText(raw, ext) };
}

// 專案資料夾裡複製的那份，重新處理時用同樣的規則讀
export function parseSubtitleText(raw, ext) {
  const parsed = ext === ".srt" ? parseSrt(raw) : parseVtt(raw);
  const cues = parsed.map((c) => ({ ...c, text: clean(c.text) })).filter((c) => c.text && c.end > c.start);
  if (!cues.length) throw new Error("字幕檔讀不到任何一句（格式要是 SRT 或 WebVTT）");
  return cues;
}
