// Hand-off to a coding agent (optional): the transcript becomes a small folder in
// iCloud Drive "<icloud_inbox>/to-wiki/<date--title>/" that a coding agent later
// turns into notes. Off unless the user profile sets icloud_inbox.
//   handoff.md     one page: basics, chapter highlights, what to double-check, where the full data is
//   transcript.md  full text with timestamps, read only to check details
// Existing folders are never overwritten (the next number is used); without iCloud Drive it fails
// instead of writing somewhere else.

import fs from "node:fs";
import path from "node:path";
import { icloudRoot } from "./paths.mjs";
import { readManifest } from "./manifest.mjs";
import { icloudInboxName } from "./asr-profile.mjs";

export const handoffSubdir = (inbox = icloudInboxName()) => (inbox ? path.join(inbox, "to-wiki") : "");
export const handoffEnabled = (inbox = icloudInboxName()) => Boolean(handoffSubdir(inbox));
const MAX_SLUG = 60;

export const handoffRoot = (icloud = icloudRoot(), inbox = icloudInboxName()) => (inbox ? path.join(icloud, handoffSubdir(inbox)) : "");

export function hms(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

// 資料夾名稱：保留中文，拿掉路徑與 Finder 不允許的字元
export function slugify(title) {
  const s = String(title || "").normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return [...s].slice(0, MAX_SLUG).join("").replace(/[-.]+$/, "") || "recording";
}

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 字幕與 Whisper 的句子常沒有句尾標點：前一句不是標點收尾就空一格，免得兩句黏在一起
const joinText = (a, b) => (/[，。、！？；：,.!?;:」』）)…]$/.test(a) ? a + b : `${a} ${b}`);

// 把短句併成段落：停頓 3 秒以上、段落超過 280 字或 90 秒就換段；segments 的時間是秒
export function paragraphs(segments) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const text = String(s.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = Number(s.start) || 0, end = Number(s.end) || start;
    if (!cur || start - cur.end >= 3 || cur.text.length >= 280 || start - cur.start >= 90) {
      cur = { start, end, text };
      out.push(cur);
    } else {
      cur.text = joinText(cur.text, text);
      cur.end = Math.max(cur.end, end);
    }
  }
  return out;
}

export function renderTranscript({ title, segments }) {
  const lines = [`# 逐字稿：${title}`, "", "時間以原始錄音／影片為準。", ""];
  for (const p of paragraphs(segments)) lines.push(`**[${hms(p.start)}]** ${p.text}`, "");
  return lines.join("\n").trimEnd() + "\n";
}

const yaml = (v) => JSON.stringify(v ?? "");
const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

export function renderHandoff(raw) {
  // 標題與來源可能來自檔名或 YouTube 標題，含換行會弄壞 Markdown 標題
  const h = { ...raw, title: oneLine(raw.title), source: oneLine(raw.source) };
  const front = [
    "---",
    "handoff_version: 1",
    `title: ${yaml(h.title)}`,
    `source: ${yaml(h.source)}`,
    `event_date: ${yaml(h.date)}`,
    `duration_s: ${Math.round(Number(h.durationSec) || 0)}`,
    `language: ${yaml(h.language || "unknown")}`,
    `engine: ${yaml(h.engine || "")}`,
    `producer: ${yaml(h.producer)}`,
    `package: ${yaml(h.packagePath || "")}`,
    `created_at: ${yaml(h.createdAt || new Date().toISOString())}`,
    "---",
  ];
  const checks = (h.checks || []).filter(Boolean);
  const body = [
    "",
    `# 交接單：${h.title}`,
    "",
    "給「處理待寫 wiki」流程用：先讀這頁判斷要寫到 wiki 哪裡；要核對原話再翻同資料夾的 `transcript.md`。",
    "",
    "## 基本資料",
    "",
    `- 來源：${h.source}`,
    `- 日期：${h.date}`,
    `- 長度：${hms(h.durationSec)}`,
    `- 語言：${h.language || "unknown"}`,
    `- 轉錄方式：${h.engine || "unknown"}`,
    `- 產生自：${h.producer}`,
    ...(h.notes || []).map((n) => `- ${n}`),
    "",
    "## 分章重點",
    "",
    h.summary?.trim() || "（這次沒有分章重點，請從 `transcript.md` 整理。）",
    "",
    "## 要核對的地方",
    "",
    ...(checks.length ? checks.map((c) => `- ${c}`) : ["（工具沒有標出；人名、數字、日期請對照 `transcript.md`。）"]),
    "",
    "## 完整資料在哪",
    "",
    "- 全文：同資料夾的 `transcript.md`",
    ...(h.packagePath ? [`- ${h.packageLabel || "轉錄包"}：${h.packagePath}${h.packageNote ?? "（還沒歸檔到 Drive；歸檔後以 Drive 路徑為準）"}`] : []),
  ];
  return [...front, ...body].join("\n").trimEnd() + "\n";
}

// 寫一份交接單，回傳 { dir, name }。to-wiki 與 done 裡已有的名稱都跳過，不覆蓋
export function writeHandoff({ date, title, handoff, transcript }, { icloud = icloudRoot(), inbox = icloudInboxName() } = {}) {
  if (!inbox) throw new Error("沒有設定 icloud_inbox，交接單沒有寫");
  if (!fs.existsSync(icloud)) throw new Error(`找不到 iCloud Drive（${icloud}），交接單沒有寫`);
  const root = handoffRoot(icloud, inbox);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = `${date}--${slugify(title)}`;
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (fs.existsSync(path.join(root, "done", name))) continue;
    const dir = path.join(root, name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(path.join(dir, "transcript.md"), transcript, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "handoff.md"), handoff, { mode: 0o600 });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });   // 寫一半的不留，免得 agent 拿到殘缺的交接單
      throw e;
    }
    return { dir, name };
  }
  throw new Error(`「${base}」的交接單太多份了，請先整理 to-wiki`);
}

function readSegments(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.segments;
  if (!Array.isArray(list)) throw new Error("segments.json 格式不對");
  return list;
}

// 轉錄包（pnpm run transcript／remote）→ 交接單。只用包裡已有的東西，不呼叫 AI，所以沒有分章重點
export function handoffFromPackage(pkg, { source, icloud = icloudRoot(), inbox = icloudInboxName(), now = new Date() } = {}) {
  const manifest = readManifest(pkg);
  const candidates = manifest.transcription_candidates || [];
  const pick = [...candidates].reverse().find((c) => c.output_segments_json && fs.existsSync(path.resolve(pkg, c.output_segments_json)));
  const segFile = pick ? path.resolve(pkg, pick.output_segments_json)
    : manifest.transcripts?.segments_json ? path.resolve(pkg, manifest.transcripts.segments_json) : "";
  if (!segFile || !fs.existsSync(segFile)) throw new Error("轉錄包裡找不到 segments.json");
  const segments = readSegments(segFile);
  const meta = manifest.source_meta || {};
  const youtube = manifest.recording_kind === "youtube";
  let date = /^\d{4}-\d{2}-\d{2}$/.test(meta.upload_date || "") ? meta.upload_date : "";
  if (!date && !youtube && source) {
    try { date = localDate(fs.statSync(source).birthtime); } catch { /* 原檔不在就用今天 */ }
  }
  date ||= localDate(now);
  const title = youtube ? (meta.title || meta.id || "YouTube") : path.basename(source || meta.title || "recording", path.extname(source || meta.title || ""));
  const durationSec = segments.reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  const engine = pick ? [pick.engine, pick.model].filter((x, i, a) => x && a.indexOf(x) === i).join(" / ") : manifest.engine_used || "";
  const fallbacks = (manifest.engine_fallbacks || []).map((f) => `${f.from} → ${f.to}（${f.reason}）`);
  const handoff = renderHandoff({
    title, date, durationSec, engine,
    source: youtube ? (meta.webpage_url || source) : (source || meta.title || ""),
    language: pick?.language || "unknown",
    producer: "pnpm run transcript",
    notes: [
      ...(youtube && meta.uploader ? [`頻道：${meta.uploader}`] : []),
      ...(fallbacks.length ? [`引擎改用：${fallbacks.join("；")}`] : []),
    ],
    checks: pick?.engine === "youtube-captions" ? ["用的是 YouTube 字幕，可能是自動字幕；專有名詞請對照影片"] : [],
    packagePath: path.resolve(pkg),
    packageLabel: "轉錄包",
    createdAt: now.toISOString(),
  });
  return writeHandoff({ date, title, handoff, transcript: renderTranscript({ title, segments }) }, { icloud, inbox });
}

// 字幕工作室的專案 → 交接單。沿用專案已有的說明欄（簡介、章節、每章重點）；AI 校對改過的地方列為要核對的地方
export function handoffFromStudio(p, { dir, icloud = icloudRoot(), inbox = icloudInboxName(), now = new Date() } = {}) {
  const cues = (p.cues || []).filter((c) => String(c.text || "").trim());
  if (!cues.length) throw new Error("沒有字幕，沒東西可以交");
  let date = "";
  const video = p.video_original || p.video;   // 補過聲音的（#129）看原始錄影
  try { date = localDate(fs.statSync(video).birthtime); } catch { /* 原片不在就用今天 */ }
  date ||= localDate(now);
  const checks = cues.filter((c) => c.ai?.length).slice(0, 15)
    .map((c) => `[${hms(c.start / 1000)}] AI 校對把${c.ai.map((e) => `「${e.find}」改成「${e.replace}」`).join("、")}`);
  const handoff = renderHandoff({
    title: p.name, date,
    source: p.source?.url || video,
    durationSec: (p.duration_ms || cues[cues.length - 1].end) / 1000,
    language: p.lang && p.lang !== "zh" ? p.lang : "unknown",   // 中文專案照舊
    // 外語影片（#56）：逐字稿是原文，中文譯文在專案資料夾的 subtitles.zh-TW.srt
    engine: p.source?.captions === "author" ? "YouTube 作者字幕" : p.source?.captions === "file" ? "使用者提供的字幕檔" : p.lang && p.lang !== "zh" ? "Soniox（原文，未校對）" : `Soniox＋${p.proofreader || "claude"} 校對`,
    producer: "字幕工作室",
    notes: [
      ...(p.cuts?.length ? ["有剪輯：這裡的時間都是原片時間，剪好的影片時間會不同"] : []),
      ...(p.lang && p.lang !== "zh" ? ["外語影片：transcript.md 是原文；中文譯文在字幕專案資料夾的 subtitles.zh-TW.srt"] : []),
      ...(p.source?.uploader ? [`影片作者：${p.source.uploader}（別人的影片，筆記請註明出處）`] : []),
    ],
    summary: p.description || "",
    checks,
    packagePath: dir,
    packageLabel: "字幕專案資料夾",
    packageNote: "（影片旁邊；字幕檔是 subtitles.srt）",
    createdAt: now.toISOString(),
  });
  const segments = cues.map((c) => ({ start: c.start / 1000, end: c.end / 1000, text: c.text }));
  return writeHandoff({ date, title: p.name, handoff, transcript: renderTranscript({ title: p.name, segments }) }, { icloud, inbox });
}
