// 從 YouTube 下載外語影片做雙語字幕（recording-transcriber#56）：網址檢查、影片資訊、字幕來源判斷、
// 作者字幕（VTT）解析、下載影片與字幕。全部走本機的 yt-dlp；網址只接受 YouTube，傳給 yt-dlp 前換成標準格式，
// 而且一律放在 `--` 後面，不會被當成參數。
//
// 字幕來源（yt-dlp -J 的兩個欄位不一樣）：
//   subtitles           作者（或頻道）自己上傳的字幕：品質最好，直接用，不送辨識
//   automatic_captions  YouTube 自動產生的字幕：品質不穩，不用，改送 Soniox 辨識
// 自動字幕裡帶「-orig」的那一軌是影片原本的語言，可以拿來判斷影片說的是什麼語言。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ID = /^[A-Za-z0-9_-]{11}$/;

// 網址 → 影片 id；不是 YouTube 單支影片就回傳空字串
export function youtubeId(value) {
  let u;
  try { u = new URL(String(value || "").trim()); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.split("/")[1] || "";
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : "";
    }
  }
  return ID.test(id) ? id : "";
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// 語言代碼只留主要部分：en-US → en、zh-Hant → zh
export const baseLang = (code) => String(code || "").toLowerCase().split(/[-_]/)[0].replace(/[^a-z]/g, "");

// 軌名會原樣交給 yt-dlp 的 --sub-langs（那裡當 regex 與逗號清單），只收正常的語言代碼
const usableTrack = (key) => /^[A-Za-z0-9_-]{2,20}$/.test(key || "") && key !== "live_chat" && !/^(und|zxx)$/i.test(baseLang(key));

// 判斷字幕來源與影片的語言。want 是使用者指定的語言（空字串＝自動判斷）。
// 回傳 { kind: "author" | "auto" | "none", track: "en-US"（author 才有）, lang: "en" }
export function captionSource(info, want = "") {
  const author = Object.keys(info?.subtitles || {}).filter(usableTrack);
  const auto = Object.keys(info?.automatic_captions || {}).filter(usableTrack);
  const orig = auto.find((k) => /-orig$/i.test(k));
  // 都不知道影片的語言：只有一軌作者字幕就是它；有英文那一軌就當英文（舊影片常沒有語言資訊。就算猜錯，
  // 英文字幕翻成中文意思還是對的，只是「原文」那行會是英文）
  let lang = baseLang(want) || baseLang(info?.language) || baseLang(orig)
    || (author.length === 1 ? baseLang(author[0]) : author.some((k) => baseLang(k) === "en") ? "en" : "");
  // 作者字幕要和影片同一種語言（作者常另外上傳別種語言的翻譯）
  const track = lang ? author.find((k) => k.toLowerCase() === lang) || author.find((k) => baseLang(k) === lang) : "";
  lang ||= "en";
  if (track) return { kind: "author", track, lang };
  return { kind: auto.length ? "auto" : "none", track: "", lang };
}

// 只留需要的影片資訊（yt-dlp -J 的輸出很大，含所有格式）
export function pickInfo(raw) {
  return {
    id: String(raw?.id || ""), title: String(raw?.title || raw?.id || "").replace(/\s+/g, " ").trim().slice(0, 200),
    uploader: String(raw?.uploader || raw?.channel || "").slice(0, 120), duration_s: Number(raw?.duration) || 0,
    language: raw?.language || "", url: raw?.webpage_url || (raw?.id ? watchUrl(raw.id) : ""),
    subtitles: Object.fromEntries(Object.keys(raw?.subtitles || {}).map((k) => [k, true])),
    automatic_captions: Object.fromEntries(Object.keys(raw?.automatic_captions || {}).map((k) => [k, true])),
    is_live: Boolean(raw?.is_live), live_status: raw?.live_status || "",
  };
}

// ---- VTT ----
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };
const vttMs = (t) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(t.trim());
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0")) : NaN;
};

// 作者字幕 → [{ start, end, text }]（毫秒）：拿掉樣式標籤與位置設定、多行併成一行、重複與捲動式字幕合併、前後不重疊。
// 一行一行讀，看到時間行就開始新的一句（有些檔的句子之間沒有空行）；NOTE、STYLE 區塊略過
export function parseVtt(text) {
  const raw = [];
  let cur = null, skip = false;
  const flush = () => { if (cur?.lines.length) raw.push(cur); cur = null; };
  for (const line of String(text).replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n")) {
    if (line.includes("-->")) {
      flush();
      skip = false;
      const [a, b] = line.split("-->");
      const start = vttMs(a), end = vttMs(String(b).trim().split(/\s+/)[0]);
      cur = Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end, lines: [] } : null;
      continue;
    }
    if (!line.trim()) { flush(); skip = false; continue; }
    if (!cur && /^(NOTE|STYLE|REGION)\b/.test(line)) { skip = true; continue; }   // 只在句子外面算；字幕本身以 NOTE 開頭不能被吃掉
    if (skip || !cur) continue;   // 檔頭（WEBVTT、Kind、Language）與句子編號
    cur.lines.push(line);
  }
  flush();
  const out = [];
  for (const c of raw) {
    const body = c.lines.join(" ")
      .replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|lrm|rlm);/g, (e) => ENTITIES[e])
      .replace(/\s+/g, " ").trim();
    if (!body) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === body && c.start <= prev.end + 50) { prev.end = Math.max(prev.end, c.end); continue; }
    // 捲動式（下一句把上一句整句帶著再多幾個字）：留下最長的那句
    if (prev && body.startsWith(prev.text) && c.start <= prev.end + 50) { prev.text = body.slice(0, 200); prev.end = Math.max(prev.end, c.end); continue; }
    out.push({ start: c.start, end: c.end, text: body.slice(0, 200) });
  }
  out.sort((x, y) => x.start - y.start);
  for (let k = 1; k < out.length; k++) if (out[k - 1].end > out[k].start) out[k - 1].end = Math.max(out[k - 1].start + 1, out[k].start);
  return out;
}

// ---- 執行 yt-dlp ----
// run(args, { signal, onLine }) → Promise<{ code, stdout, stderr }>；測試可以換掉
export function runYtDlp(args, { signal, onLine = () => {}, bin = "yt-dlp" } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "", err = "", buf = "";
    proc.stdout.on("data", (d) => {
      out = (out + d).slice(-64 * 1024 * 1024);
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) onLine(l);
    });
    proc.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    proc.on("error", (e) => reject(signal?.aborted ? new Error("cancelled") : e));
    proc.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

const lastError = (r) => String(r.stderr || "").trim().split("\n").filter((l) => /ERROR/.test(l)).pop()?.replace(/^ERROR:\s*/, "").slice(0, 200) || `yt-dlp exit ${r.code}`;

export async function fetchInfo(id, { run = runYtDlp, signal } = {}) {
  const r = await run(["-J", "--no-warnings", "--no-playlist", "--skip-download", "--", watchUrl(id)], { signal });
  if (signal?.aborted) throw new Error("cancelled");
  if (r.code !== 0) throw new Error(`讀不到這支影片的資訊：${lastError(r)}`);
  return pickInfo(JSON.parse(r.stdout));
}

// 下載作者字幕的一軌到 dir/captions.<track>.vtt，回傳檔案路徑
export async function fetchCaptions(id, track, dir, { run = runYtDlp, signal } = {}) {
  const r = await run(["--no-warnings", "--no-playlist", "--skip-download", "--write-subs", "--sub-langs", track, "--sub-format", "vtt",
    "-o", path.join(dir, "captions.%(ext)s"), "--", watchUrl(id)], { signal });
  if (signal?.aborted) throw new Error("cancelled");
  const file = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((f) => /^captions\..+\.vtt$/.test(path.basename(f)));
  if (r.code !== 0 || !file) throw new Error(`作者字幕下載不下來：${r.code !== 0 ? lastError(r) : "沒有字幕檔"}`);
  return file;
}

// 下載影片（最高 1080p、mp4）到 dir，回傳最後的檔案路徑。onProgress(0..1)：影像與聲音分開下載時，
// 照 format_id 分辨現在是第幾個檔（影像佔前 90%、聲音佔後 10%；只有一個檔就是 0–100%）。進度只會往前
export async function fetchVideo(id, dir, { run = runYtDlp, signal, onProgress = () => {} } = {}) {
  const parts = [];
  let shown = 0, final = "";
  const r = await run([
    "--no-warnings", "--no-playlist", "--newline", "--progress",
    "-f", "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b",
    "--merge-output-format", "mp4",
    "--progress-template", "download:PROG %(info.format_id)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
    "--print", "after_move:FILE %(filepath)s",
    "-o", path.join(dir, "%(title).80B [%(id)s].%(ext)s"), "--", watchUrl(id),
  ], {
    signal,
    onLine: (line) => {
      const m = /^PROG (\S+) (\d+) (\S+) (\S+)/.exec(line);
      if (m) {
        if (!parts.includes(m[1])) parts.push(m[1]);
        const k = parts.indexOf(m[1]);
        const total = Number(m[3]) || Number(m[4]) || 0;
        const frac = total ? Math.min(1, Number(m[2]) / total) : 0;
        const x = k === 0 ? frac * 0.9 : 0.9 + frac * 0.1;
        if (x > shown) { shown = Math.min(0.99, x); onProgress(shown); }
      }
      const f = /^FILE (.+)$/.exec(line);
      if (f) final = f[1].trim();
    },
  });
  if (signal?.aborted) throw new Error("cancelled");
  if (r.code !== 0) throw new Error(`影片下載不下來：${lastError(r)}`);
  if (!final || !fs.existsSync(final)) throw new Error("影片下載不下來：找不到下載好的檔案");
  onProgress(1);
  return final;
}
