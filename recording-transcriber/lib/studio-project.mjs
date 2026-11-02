// Subtitle Studio 的專案檔。
// 一支影片一個專案，放在影片旁邊的「<名稱>-字幕/」（和 pnpm run subtitle 同一個資料夾）：
//   project.json           字幕、說明欄、狀態（含逐字內容，0600）
//   subtitles.srt          每次儲存都更新
//   youtube-description.md 每次儲存都更新
//   timing.json            辨識後每個字的原片時間（含逐字內容，0600；給 AI 剪輯建議用）
// 有剪輯（project.cuts）時，SRT 與說明欄的章節時間換算成剪輯後的時間，對得上剪好的影片（recording-transcriber#4）。
// 外語影片（project.lang 不是 zh，#56）：subtitles.srt 是原文，另外寫 subtitles.zh-TW.srt（中文譯文）。
//   <名稱>-字幕.mp4        燒字幕後的影片
// 最近開過的專案清單只記路徑與名稱，放 ~/.local/state/cyclone-subtitle-studio/recent.json。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { toSrt } from "./subtitle-text.mjs";
import { icloudInboxDir } from "./asr-profile.mjs";
import { normalizeCuts, remapCues, remapDescription } from "./cuts.mjs";

export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
export const BROWSER_PLAYABLE = new Set([".mp4", ".mov", ".m4v"]);
const MAX_CUES = 20000, MAX_TEXT = 200, MAX_DESCRIPTION = 20000, MAX_MS = 48 * 3600 * 1000, MAX_CUTS = 5000;

export function projectDirFor(video) {
  const v = path.resolve(video);
  return path.join(path.dirname(v), `${path.basename(v, path.extname(v))}-字幕`);
}

// iCloud 還沒下載到這台的檔案只有佔位：有大小、但不佔磁碟（recording-transcriber#20）
export const isOffline = (st) => st.size > 0 && st.blocks === 0;

// 多台 Mac 共用的 iCloud 資料夾（設定 icloud_inbox 才有）：一台丟進去，另一台的字幕工作室就看得到
export const icloudStudioDir = (home = os.homedir(), profile) => icloudInboxDir("studio", { home, profile });

export const projectId = (dir) => createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);

export function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readProject(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
}

// 原始錄影（#129）：加了 Discord 分軌、補回沒錄到的聲音時，project.video 換成資料夾裡的「<名稱>-補音.mp4」，
// 原檔記在 video_original。丟垃圾桶、看錄影時間、整理時搬輸出檔都要用原檔
export const sourceVideo = (p) => p?.video_original || p?.video || "";

// 外語影片（#56）：要翻成中文、可以做雙語字幕
export const isForeign = (p) => Boolean(p?.lang) && p.lang !== "zh";

// 存專案；字幕與說明欄的輸出檔一起更新，這樣隨時關掉都有最新的 SRT
export function writeProject(dir, project) {
  writePrivate(path.join(dir, "project.json"), JSON.stringify(project, null, 1) + "\n");
  if (project.status === "ready") {
    const cuts = project.cuts || [];
    writePrivate(path.join(dir, "subtitles.srt"), toSrt(remapCues(project.cues.filter((c) => c.text.trim()), cuts, cuts.length ? undefined : 0)));
    if (isForeign(project)) {
      const zh = project.cues.filter((c) => String(c.tr || "").trim()).map((c) => ({ start: c.start, end: c.end, text: c.tr }));
      writePrivate(path.join(dir, "subtitles.zh-TW.srt"), toSrt(remapCues(zh, cuts, cuts.length ? undefined : 0)));
    }
    if (project.description) writePrivate(path.join(dir, "youtube-description.md"), remapDescription(project.description, cuts));
  }
}

// 從瀏覽器收到的剪輯區段：檢查型別與範圍，再排序合併
export function validateCuts(cuts, durationMs) {
  if (cuts === undefined || cuts === null) return [];
  if (!Array.isArray(cuts) || cuts.length > MAX_CUTS) throw new Error("剪輯格式不對");
  for (const c of cuts) {
    const start = Number(c?.start), end = Number(c?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > MAX_MS || end <= start) throw new Error("剪輯時間不對");
    if (c.reason !== undefined && (typeof c.reason !== "string" || [...c.reason].length > 120)) throw new Error("剪輯說明太長");
  }
  return normalizeCuts(cuts, durationMs || MAX_MS);
}

// 從瀏覽器收到的字幕：檢查型別、範圍、長度，照時間排序
export function validateCues(cues) {
  if (!Array.isArray(cues) || cues.length > MAX_CUES) throw new Error("字幕格式不對");
  const out = cues.map((c) => {
    const start = Number(c?.start), end = Number(c?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > MAX_MS || end < start) throw new Error("字幕時間不對");
    if (typeof c.text !== "string" || [...c.text].length > MAX_TEXT) throw new Error("字幕文字太長");
    const cue = { start: Math.round(start), end: Math.round(end), text: c.text.replace(/[\r\n]+/g, " ").replace(/\s+/gu, " ").trim() };
    // 外語影片的中文譯文（#56）；空字串也留著，代表使用者把譯文清掉了
    if (c.tr !== undefined) {
      if (typeof c.tr !== "string" || [...c.tr].length > MAX_TEXT) throw new Error("譯文太長");
      cue.tr = c.tr.replace(/[\r\n]+/g, " ").replace(/\s+/gu, " ").trim();
    }
    if (Array.isArray(c.ai)) {
      const ai = c.ai.filter((e) => typeof e?.find === "string" && typeof e?.replace === "string").slice(0, 10)
        .map((e) => ({ find: e.find.slice(0, 80), replace: e.replace.slice(0, 80) }));
      if (ai.length) cue.ai = ai;
    }
    // 分軌標的講者（#126）；名字已經寫在字幕文字裡，這裡只留著給重標用
    if (typeof c.spk === "string" && c.spk.trim()) cue.spk = [...c.spk.trim()].slice(0, 12).join("");
    return cue;
  });
  out.sort((a, b) => a.start - b.start);
  return out;
}

// 頁面送來的字幕沒有 tr 欄位（例如翻譯還在跑、頁面還沒拿到新的譯文）：
// 同一句（開始時間與原文都一樣）伺服器上已經有的譯文留著，不要被存檔蓋掉（#56）
export function keepTranslations(incoming, current) {
  const known = new Map((current || []).filter((c) => c.tr !== undefined).map((c) => [`${c.start}\u0000${c.text}`, c.tr]));
  if (!known.size) return incoming;
  return incoming.map((c) => (c.tr === undefined && known.has(`${c.start}\u0000${c.text}`) ? { ...c, tr: known.get(`${c.start}\u0000${c.text}`) } : c));
}

export function validateDescription(text) {
  if (typeof text !== "string" || text.length > MAX_DESCRIPTION) throw new Error("說明欄格式不對");
  return text;
}

// AI 改過的字標在含有修正結果的字幕上，讓校對時先看這些
export function markAiCues(cues, applied) {
  return cues.map((c) => {
    const ai = applied.filter((e) => e.replace && c.text.includes(e.replace.replace(/[，。、！？；：]/gu, " ").trim()));
    return ai.length ? { ...c, ai: ai.map(({ find, replace }) => ({ find, replace })) } : c;
  });
}

// 讀 pnpm run subtitle 產生的 SRT，讓 CLI 跑過的影片也能在 Studio 打開接著改
export function parseSrt(text) {
  const cues = [];
  const t = (s) => { const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s); return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, "0") : NaN; };
  for (const block of String(text).replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = t(a), end = t(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: lines.slice(i + 1).join(" ").trim() });
  }
  return cues;
}

export function stateDir(env = process.env) {
  return env.CYCLONE_STUDIO_STATE || path.join(os.homedir(), ".local", "state", "cyclone-subtitle-studio");
}

export function loadRecent(env = process.env) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(stateDir(env), "recent.json"), "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x?.dir === "string" && fs.existsSync(path.join(x.dir, "project.json"))) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(entry, env = process.env) {
  const dir = stateDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const list = [{ ...entry, at: new Date().toISOString() }, ...loadRecent(env).filter((x) => x.dir !== entry.dir)].slice(0, 20);
  writePrivate(path.join(dir, "recent.json"), JSON.stringify(list, null, 1) + "\n");
}

export function forgetRecent(projectDir, env = process.env) {
  const dir = stateDir(env);
  if (!fs.existsSync(dir)) return;
  writePrivate(path.join(dir, "recent.json"), JSON.stringify(loadRecent(env).filter((x) => x.dir !== projectDir), null, 1) + "\n");
}

// 常放錄影的資料夾裡最新的影片（OBS 預設存到「影片」）
export function recentVideos(dirs, limit = 12) {
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".") || !VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase()) || /-字幕\.mp4$/u.test(n)) continue;
      const file = path.join(d, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) out.push({ path: file, name: n, size: st.size, mtime: st.mtimeMs });
      } catch { /* 讀不到就略過 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
