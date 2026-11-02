#!/usr/bin/env node
// 一支影片的字幕流程，在跑的那台主機上執行（本機，或 --remote 時遠端 Mac 的 job）：
//
//   node scripts/subtitle-run.mjs <video> --out <dir> [--privacy public|sensitive|student-private]
//     [--engine soniox|whisper] [--proofreader claude|codex|cursor|grok|pi] [--burn] [--size small|medium|large] [--terms 詞1,詞2]
//
// 抽音訊 → 辨識（Soniox 檔案轉錄，取回即刪；或本機 Whisper large-v3）→ 簡轉繁 →
// 逐字校對（只修錯字，不潤飾）→ SRT → YouTube 說明欄 →（--burn）燒字幕影片。
// 輸出：subtitles.srt、youtube-description.md、edits.json、report.json、<名稱>-字幕.mp4。
// 暫存的音訊與辨識原檔做完就刪；最後一行印出 report 的 JSON。

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCues, charsFromSoniox, charsFromWhisper, cueOptsFor, fullWidthPunct, realign, realignBySegment, textOf, tidyZhText, toSrt } from "../lib/subtitle-text.mjs";
import { asrTerms, describe, verbatimFix } from "../lib/subtitle-ai.mjs";
import { correctionsSummary, syncCorrections } from "../lib/corrections-sync.mjs";
import { resolveSonioxKey, transcribeFile, SONIOX_ASYNC_USD_PER_HOUR } from "../lib/soniox-async.mjs";
import { loadAsrProfile, profileVocabulary, sharedVocabulary } from "../lib/asr-profile.mjs";
import { newUsage } from "../lib/claude-stream.mjs";
import { checkProofreader, proofreaderAvailable } from "../lib/proofreaders.mjs";
import { charsToSource, keptDuration } from "../lib/cuts.mjs";
import { boxAss, DEFAULT_STYLE, displayText, SUBTITLE_STYLES } from "../lib/subtitle-box.mjs";
import { measureAdvances } from "../lib/text-measure.mjs";

const VALID_PRIVACY = new Set(["public", "sensitive", "student-private"]);
const VALID_ENGINE = new Set(["soniox", "whisper"]);
// 燒錄字幕的字級（libass 以影片高 288 為基準；Subtitle Studio 預覽用同一組比例）
export const SUBTITLE_SIZES = { small: 16, medium: 20, large: 24 };

process.env.PATH = [path.join(process.env.HOME || "", ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || "/usr/bin:/bin"].join(":");

export function parseArgs(argv) {
  const o = { video: "", out: "", privacy: "public", engine: "soniox", proofreader: "claude", burn: false, size: "medium", style: DEFAULT_STYLE, terms: [] };
  const a = argv.filter((x) => x !== "--");
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "--out") o.out = a[++i] || "";
    else if (x === "--privacy") o.privacy = a[++i] || "";
    else if (x === "--engine") o.engine = a[++i] || "";
    else if (x === "--burn") o.burn = true;
    else if (x === "--style") o.style = a[++i] || "";
    else if (x === "--size") o.size = a[++i] || "";
    else if (x === "--proofreader") o.proofreader = a[++i] || "";
    else if (x === "--terms") o.terms = String(a[++i] || "").split(/[,，、]/u).map((s) => s.trim()).filter(Boolean);
    else if (x.startsWith("--")) throw new Error(`unknown option: ${x}`);
    else if (!o.video) o.video = x;
    else throw new Error("only one video is allowed");
  }
  if (!o.video || !o.out) throw new Error("usage: subtitle-run.mjs <video> --out <dir> [--privacy <class>] [--engine soniox|whisper] [--burn]");
  if (!VALID_PRIVACY.has(o.privacy)) throw new Error("--privacy must be public, sensitive or student-private");
  if (!VALID_ENGINE.has(o.engine)) throw new Error("--engine must be soniox or whisper");
  if (!Object.hasOwn(SUBTITLE_SIZES, o.size)) throw new Error("--size must be small, medium or large");
  if (!SUBTITLE_STYLES.includes(o.style)) throw new Error("--style must be box or outline");
  checkProofreader(o.proofreader, o.privacy);
  return o;
}

export function ffmpegFull(env = process.env) {
  const candidates = [env.CYCLONE_FFMPEG_FULL, "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" });
    if (r.status === 0 && / subtitles /.test(r.stdout)) return bin;
  }
  return "";
}

function run(bin, args, what) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.error?.message || "").trim().split("\n").pop()}`);
  return r;
}

export async function taiwanConverter() {
  const imported = await import("opencc-js");
  return (imported.default || imported).Converter({ from: "cn", to: "twp" });
}

function videoBitrate(video) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate", "-of", "csv=p=0", video], { encoding: "utf8" });
  const n = Number(String(r.stdout || "").trim());
  return Number.isFinite(n) && n > 500_000 ? Math.min(n, 20_000_000) : 6_000_000;
}

export function videoDurationMs(video) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" });
  const n = Number(String(r.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

export function hasAudioStream(video) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", video], { encoding: "utf8" });
  return r.status === 0 && String(r.stdout).trim() !== "";
}

// 有沒有真的剪掉東西：keep 只有一段、而且從 0 到片尾，就和沒剪一樣（recording-transcriber#4）
export const isTrimmed = (keep, durationMs) => Array.isArray(keep) && keep.length > 0 &&
  !(keep.length === 1 && keep[0][0] <= 0 && (!durationMs || keep[0][1] >= durationMs));

// 只把保留段（原片時間 [[start, end], ...]，毫秒）接起來：trim／atrim 加 concat，取樣精準、不累積誤差。
// 輸出標籤 [vout]、[aout]。
export function keepFilter(keep, { video = true, audio = true } = {}) {
  const sec = (ms) => (ms / 1000).toFixed(3);
  const n = keep.length, parts = [];
  if (video) parts.push(`[0:v:0]split=${n}${keep.map((_, i) => `[vs${i}]`).join("")}`);
  if (audio) parts.push(`[0:a:0]asplit=${n}${keep.map((_, i) => `[as${i}]`).join("")}`);
  keep.forEach(([a, b], i) => {
    if (video) parts.push(`[vs${i}]trim=start=${sec(a)}:end=${sec(b)},setpts=PTS-STARTPTS[v${i}]`);
    if (audio) parts.push(`[as${i}]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const inputs = keep.map((_, i) => `${video ? `[v${i}]` : ""}${audio ? `[a${i}]` : ""}`).join("");
  parts.push(`${inputs}concat=n=${n}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${video ? "[vout]" : ""}${audio ? "[aout]" : ""}`);
  return parts.join(";");
}

const timer = () => { const t = Date.now(); return () => Math.round((Date.now() - t) / 100) / 10; };

// 跑之前先確認這台主機有需要的東西；在建任何資料夾之前做，失敗不留空資料夾（#830）。
export function preflight(o) {
  checkProofreader(o.proofreader, o.privacy);
  if (!proofreaderAvailable(o.proofreader)) throw new Error(`${o.proofreader} is not installed on this host`);
  if (o.engine === "soniox" && !resolveSonioxKey()) throw new Error("no Soniox API key on this host");
  if (o.burn && !ffmpegFull()) throw new Error("--burn needs an ffmpeg with libass (brew install ffmpeg-full)");
}

// 辨識＋校對＋說明欄。work 是暫存資料夾（呼叫端負責刪）；onStep(name) 給介面顯示進度。
// o.keep（原片時間的保留段）有剪掉東西時，只把保留段送辨識，時間再換回原片時間（recording-transcriber#4）。
// 回傳 { cues, applied, rejected, description, chapters, timing, report }，不寫任何輸出檔；
// timing 是校對後每個字的原片時間 [[字, 開始, 結束], ...]，給 AI 剪輯建議用。
// signal：使用者按停止（#67）。停下來時丟 cancelled 錯誤（e.cancelled），已經存進 asrCache 的辨識結果照樣留著。
export async function prepareSubtitles(o, { work, onStep = () => {}, signal } = {}) {
  const report = { engine: o.engine, proofreader: o.proofreader, privacy: o.privacy, steps: {}, claude: newUsage(), soniox: null, corrections: null, edits: {} };
  return stoppable(signal, report, () => prepareInner(o, { work, onStep, signal, report }));
}

// 使用者按停止：不管停在哪一步（ffmpeg 被結束、agent 被關掉、Soniox 被打斷），都換成同一個 cancelled 錯誤
const cancelled = () => Object.assign(new Error("cancelled"), { cancelled: true });
function checkStop(signal) { if (signal?.aborted) throw cancelled(); }
async function stoppable(signal, report, fn) {
  try {
    checkStop(signal);
    return await fn();
  } catch (e) {
    if (signal?.aborted) throw Object.assign(cancelled(), { report: e.report || report, sonioxDeleted: e.sonioxDeleted });
    throw e;
  }
}

async function prepareInner(o, { work, onStep, signal, report }) {
  const video = path.resolve(o.video);
  const trimmed = isTrimmed(o.keep, o.durationMs);
  const keep = trimmed ? o.keep : null;
  // 辨識結果存在 o.asrCache（Studio 是專案裡的 asr.json）：出錯重試、重新處理、剪得更短，
  // 都直接用存著的，不再付一次辨識費（#28、#30）
  const cacheKey = asrCacheKey(video, o.engine, o.lang);
  const cached = readAsrCache(o.asrCache, cacheKey, keep);
  const synced = await syncCorrections();
  report.corrections = correctionsSummary(synced);
  const corrections = synced.corrections;
  // 共用用詞正本（#84）：一定替換、口述替換、誤聽對照都給 AI 當參考，同一個錯誤寫法只留一次
  const shared = sharedVocabulary();
  const known = new Set(corrections.hints.map(([w]) => w));
  for (const pair of [...Object.entries(profileVocabulary()), ...Object.entries(shared.dictation), ...shared.hints]) {
    if (!known.has(pair[0])) { known.add(pair[0]); corrections.hints.push(pair); }
  }
  checkStop(signal);
  let chars;
  if (cached) {
    chars = cached.chars;
    report.asr_cached = true;
    if (cached.soniox) report.soniox = { ...cached.soniox, cost_usd: 0, reused: true };
  } else {
    chars = await recognise(o, { video, work, trimmed, corrections, report, onStep, signal });
    if (chars.length) writeAsrCache(o.asrCache, cacheKey, keep, chars, report.soniox);   // 空的不存，重試才會重新辨識
  }
  if (trimmed) report.kept_ms = keptDuration(o.keep);
  if (!chars.length) throw Object.assign(new Error("no speech recognised"), { report });
  checkStop(signal);
  return finishSubtitles(o, { chars, corrections, report, onStep, signal });
}

// 快取的 key：影片（路徑、大小、修改時間）和引擎；影片換了就重新辨識。
// 外語影片（#56）另外帶語言：改了語言要重新辨識（中文影片的 key 不變，舊的快取照樣用得到）
function asrCacheKey(video, engine, lang) {
  let st = { size: 0, mtimeMs: 0 };
  try { st = fs.statSync(video); } catch { /* 讀不到就不會對上 */ }
  return JSON.stringify({ video, size: st.size, mtime: Math.round(st.mtimeMs), engine, ...(foreign(lang) ? { lang } : {}) });
}
const foreign = (lang) => Boolean(lang) && lang !== "zh";

// 存著的是原片時間的字。這次要的範圍（keep，null 是整支）都在上次辨識過的範圍裡，
// 就只留這次範圍裡的字；有超出的部分才重新辨識。
const inside = (ms, ranges) => ranges.some(([a, b]) => ms >= a && ms < b);
const covered = (want, had) => !had || (want && want.every(([a, b]) => had.some(([c, d]) => a >= c && b <= d)));

function readAsrCache(file, key, keep) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.key !== key || !Array.isArray(c.chars) || !covered(keep, c.keep || null)) return null;
    let chars = c.chars.map(([ch, s, e, spk]) => ({ c: ch, s, e, spk: spk ?? null }));
    if (keep) chars = chars.filter((x) => inside(Math.round((x.s + x.e) / 2), keep));
    return { chars, soniox: c.soniox || null };
  } catch { return null; }
}

// 存不了（磁碟滿、沒權限）就算了：不能因為快取把已經付費的辨識結果丟掉
function writeAsrCache(file, key, keep, chars, soniox) {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ key, keep, soniox, chars: chars.map((x) => [x.c, x.s, x.e, x.spk ?? null]) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(`[subtitle] could not keep the recognition result for a retry: ${e.code || e.message}`);
  }
}

// 抽音、送辨識，回傳原片時間的字（還沒簡轉繁）
async function recognise(o, { video, work, trimmed, corrections, report, onStep, signal }) {
  let t = timer();
  onStep("extract");
  // 送 Soniox 的用 Opus 32 kbps（#121）：語音用的格式，大小約 mp3 64k 的一半，網路上傳慢時差很多
  // （42 分鐘約 9 MB；實測同一分鐘兩種格式的辨識幾乎一樣）。本機 Whisper 照舊用 mp3
  const opus = o.engine !== "whisper";
  const audio = path.join(work, opus ? "audio.ogg" : "audio.mp3");
  const select = trimmed ? ["-filter_complex", keepFilter(o.keep, { video: false }), "-map", "[aout]"] : ["-vn"];
  const codec = opus ? ["-c:a", "libopus", "-b:a", "32k", "-application", "voip"] : ["-c:a", "libmp3lame", "-b:a", "64k"];
  // 非同步跑（#67）：長片抽音要幾十秒，同步跑會卡住整個工作室，也停不下來
  await runFfmpeg("ffmpeg", ["-v", "error", "-y", "-i", video, ...select, "-ac", "1", "-ar", "16000", ...codec, audio], { cwd: work, signal, what: "audio extraction" });
  checkStop(signal);
  report.steps.extract_s = t();
  const terms = asrTerms(corrections, [...(o.terms || []), ...sharedVocabulary().terms]);   // 正本的專有名詞排在錯字表前面（Whisper 只吃前 30 個）

  t = timer();
  onStep("asr");
  let chars;
  if (o.engine === "soniox") {
    const key = resolveSonioxKey();
    if (!key) throw new Error("no Soniox API key on this host");
    // 斷線中斷的辨識記在快取旁邊，重試時接回去（#64）；key 含影片與這次的剪輯範圍
    const pending = o.asrCache ? { file: path.join(path.dirname(o.asrCache), "soniox-pending.json"), key: JSON.stringify({ video: asrCacheKey(video, o.engine, o.lang), keep: trimmed ? o.keep : null }) } : null;
    let r;
    try {
      r = await transcribeFile(audio, { key, terms, pending, signal, ...(foreign(o.lang) ? { languageHints: [o.lang] } : {}) });
    } catch (e) {
      report.soniox = { cloud_copies_deleted: e.sonioxDeleted || null, pending: Boolean(e.sonioxPending), ...(e.cancelled ? { cancelled: true } : {}) };
      if (!e.sonioxPending && e.sonioxDeleted && !(e.sonioxDeleted.file && e.sonioxDeleted.transcription)) {
        console.error("[cleanup] Soniox copies not deleted yet; they will be retried on the next recognition");
      }
      e.report = report;
      throw e;
    }
    chars = charsFromSoniox(r.tokens);
    report.soniox = { audio_ms: r.audio_ms, cost_usd: r.resumed ? 0 : Math.round((r.audio_ms / 3600000) * SONIOX_ASYNC_USD_PER_HOUR * 10000) / 10000, cloud_copies_deleted: r.deleted, ...(r.resumed ? { resumed: true } : {}) };
    // 已經付費拿到的結果不丟：刪不掉的雲端副本記在 leftovers，下次辨識前補刪
    if (!r.deleted.file || !r.deleted.transcription) console.error("[cleanup] Soniox copies not deleted yet; they will be retried on the next recognition");
  } else {
    const model = loadAsrProfile().profile.mlx_model || "mlx-community/whisper-large-v3-mlx";
    run("mlx_whisper", [audio, "--model", model, "--language", "zh", "--word-timestamps", "True", "--condition-on-previous-text", "False",
      "--initial-prompt", terms.slice(0, 30).join("、"), "--output-format", "json", "--output-dir", work], "mlx_whisper");
    chars = charsFromWhisper(JSON.parse(fs.readFileSync(path.join(work, "audio.json"), "utf8")));
    chars = realignBySegment(chars, fullWidthPunct);
  }
  fs.rmSync(audio, { force: true });
  if (trimmed) chars = charsToSource(chars, o.keep);
  report.steps.asr_s = t();
  return chars;
}

// 簡轉繁、校對、切字幕、寫說明欄。外語影片（#56）不簡轉繁、不做中文校對，照原文切句（保留標點）
async function finishSubtitles(o, { chars, corrections, report, onStep, signal }) {
  let t = timer();
  onStep("proofread");
  let fixed = { applied: [], rejected: [], usage: null };
  if (!foreign(o.lang)) {
    // 簡轉繁一句一句做；整份 diff 換掉的字太多，會對錯位置（#30）
    report.align = {};
    chars = realignBySegment(chars, await taiwanConverter());
    fixed = await verbatimFix(textOf(chars), corrections, { proofreader: o.proofreader, signal });
    chars = realign(chars, fixed.text, report.align);
  } else report.lang = o.lang;
  const cues = buildCues(chars, cueOptsFor(o.lang));
  report.steps.proofread_s = t();
  report.edits = { applied: fixed.applied.length, rejected: fixed.rejected.length };
  addUsage(report.claude, fixed.usage);
  report.cues = cues.length;
  checkStop(signal);
  return { ...await describeStep(o, { cues, report, onStep, signal }), applied: fixed.applied, rejected: fixed.rejected, timing: chars.map((c) => [c.c, c.s, c.e]) };
}

// 用作者上傳的字幕（#56，YouTube 影片）：不辨識、不校對，中文字幕簡轉繁；接著一樣寫說明欄
export async function prepareFromCaptions(o, { cues, onStep = () => {}, signal } = {}) {
  const report = { engine: "youtube-captions", proofreader: o.proofreader, privacy: o.privacy, steps: {}, claude: newUsage(), soniox: null, corrections: null, edits: { applied: 0, rejected: 0 }, lang: o.lang || "" };
  return stoppable(signal, report, () => captionsInner(o, { cues, onStep, signal, report }));
}

async function captionsInner(o, { cues, onStep, signal, report }) {
  onStep("proofread");
  let out = cues;
  if (!foreign(o.lang)) {
    const conv = await taiwanConverter();
    out = cues.map((c) => ({ ...c, text: tidyZhText(fullWidthPunct(conv(c.text))) })).filter((c) => c.text);
  }
  report.cues = out.length;
  if (!out.length) throw Object.assign(new Error("作者字幕是空的"), { report });
  return { ...await describeStep(o, { cues: out, report, onStep, signal }), applied: [], rejected: [], timing: null };
}

async function describeStep(o, { cues, report, onStep, signal }) {
  const t = timer();
  onStep("describe");
  let description = "", chapters = [], suggest = null;
  try {
    const d = await describe(cues, { proofreader: o.proofreader, signal });
    description = d.text;
    chapters = d.chapters;
    suggest = d.suggest;
    addUsage(report.claude, d.usage);
  } catch (e) {
    if (signal?.aborted) throw cancelled();   // 停止不是「說明欄沒寫成」
    report.description_error = String(e.message || e);
  }
  report.chapters = chapters.length;
  report.steps.describe_s = t();
  report.claude.cost_usd = Math.round(report.claude.cost_usd * 10000) / 10000;
  return { cues, description, chapters, suggest, report };
}

// 燒錄用的字幕檔：圓角底框寫 ASS（依影片解析度、量過的字寬），白字黑邊寫 SRT。回傳檔案路徑。
// mode：外語影片顯示中文、原文或雙語（#56）；一般影片沒有譯文，不受影響
export function writeBurnSubtitles({ dir, cues, video, size = "medium", style = DEFAULT_STYLE, measure = measureAdvances, dims, mode, name = "subs" }) {
  if (style !== "box") {
    const file = path.join(dir, `${name}.srt`);
    fs.writeFileSync(file, toSrt(cues.map((c) => ({ ...c, text: displayText(c, mode) })).filter((c) => c.text)), { mode: 0o600 });
    return file;
  }
  const { w, h } = dims || videoSize(video);
  const fs_ = Math.round((SUBTITLE_SIZES[size] || SUBTITLE_SIZES.medium) * h / 288);
  const file = path.join(dir, `${name}.ass`);
  fs.writeFileSync(file, boxAss({ cues, width: w, height: h, fs: fs_, mode, adv: measure(cues.flatMap((c) => (c.tr ? [c.text, c.tr] : [c.text]))), advSub: subAdvances(cues, mode, measure) }), { mode: 0o600 });
  return file;
}

// 雙語時原文那行是細體（#56）：另外量細體的字寬，框才不會偏寬
export function subAdvances(cues, mode, measure = measureAdvances) {
  const texts = cues.filter((c) => String(c.tr || "").trim()).map((c) => c.text);
  return mode === "both" && texts.length ? measure(texts, { bold: false }) : undefined;
}

// ASS（圓角底框，#55）自帶樣式與位置；SRT（白字黑邊）照字級套 force_style
export const subtitlesFilter = (file, size = "medium") =>
  /\.ass$/i.test(file) ? `subtitles=${path.basename(file)}` : `subtitles=${path.basename(file)}:force_style='${burnStyle(size)}'`;

export function burnStyle(size = "medium") {
  return `FontName=PingFang TC,FontSize=${SUBTITLE_SIZES[size] || SUBTITLE_SIZES.medium},Outline=2,Shadow=0,MarginV=28`;
}

// 把 SRT 燒進影片（Mac 硬體編碼）。srt 要放在 cwd（ffmpeg filter 的路徑不好跳脫）；
// onProgress(0..1) 給介面顯示進度。
// keep（原片時間的保留段）有剪掉東西時，剪接和燒字幕在同一次編碼完成；srt 要是剪輯後的時間。
// subtitles 為 false 時只剪接、不燒字幕（一定要有剪輯）。
export function burnSubtitles({ video, srt, target, size = "medium", onProgress = () => {}, signal, keep, subtitles = true }) {
  const bin = subtitles ? ffmpegFull() : "ffmpeg";
  if (!bin) return Promise.reject(new Error("burning subtitles needs an ffmpeg with libass (brew install ffmpeg-full)"));
  const sourceMs = videoDurationMs(video);
  const trimmed = isTrimmed(keep, sourceMs);
  if (!subtitles && !trimmed) return Promise.reject(new Error("nothing to cut"));
  const durationMs = trimmed ? keptDuration(keep) : sourceMs;
  const cwd = path.dirname(srt);
  const subs = subtitlesFilter(srt, size);
  const audio = trimmed && hasAudioStream(video);
  const filter = trimmed
    ? ["-filter_complex", subtitles ? `${keepFilter(keep, { audio })};[vout]${subs}[vsub]` : keepFilter(keep, { audio }),
      "-map", subtitles ? "[vsub]" : "[vout]", ...(audio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"] : [])]
    : ["-vf", subs, "-c:a", "copy"];
  const args = ["-v", "error", "-nostats", "-progress", "pipe:1", "-y", "-i", path.resolve(video), ...filter,
    "-c:v", "h264_videotoolbox", "-b:v", String(videoBitrate(video)), "-movflags", "+faststart", path.resolve(target)];
  return runFfmpeg(bin, args, { cwd, durationMs, signal, onProgress, what: "burn-in" });
}

// 跑 ffmpeg 並從 -progress 讀進度（onProgress 0..1）；signal 中止時 ffmpeg 會被結束
export function runFfmpeg(bin, args, { cwd, durationMs, signal, onProgress = () => {}, what }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    let err = "", buf = "";
    proc.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    proc.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && durationMs) onProgress(Math.min(1, Number(m[1]) / 1000 / durationMs));
      }
    });
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0) { onProgress(1); resolve(); } else reject(new Error(`${what} failed: ${err.trim().split("\n").pop() || `exit ${code}`}`));
    });
  });
}

export function videoSize(video) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", video], { encoding: "utf8" });
  const [w, h] = String(r.stdout || "").trim().split("x").map(Number);
  return w > 0 && h > 0 ? { w, h } : { w: 1920, h: 1080 };
}

// 直式短片（#54）的 filter：保留段接起來 → 一份縮小、模糊、調暗再放大當背景，一份等比縮放疊在中間 → 燒 ASS（標題＋字幕）。
// 縮小再模糊比直接模糊 1080×1920 快很多。ass 要放在 cwd（filter 的路徑不好跳脫）
export function shortFilter({ keep, layout, ass, audio }) {
  return `${keepFilter(keep, { audio })};[vout]split=2[bgsrc][fgsrc];` +
    "[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,eq=brightness=-0.22,scale=1080:1920,setsar=1[bg];" +
    `[fgsrc]scale=${layout.vw}:${layout.vh},setsar=1[fg];[bg][fg]overlay=${layout.x}:${layout.top},subtitles=${ass}[vsub]`;
}

export function shortArgs({ video, keep, layout, ass, audio, target }) {
  return ["-v", "error", "-nostats", "-progress", "pipe:1", "-y", "-i", path.resolve(video),
    "-filter_complex", shortFilter({ keep, layout, ass, audio }), "-map", "[vsub]",
    ...(audio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-c:v", "h264_videotoolbox", "-b:v", "8000000", "-movflags", "+faststart", path.resolve(target)];
}

// 輸出一支直式短片：keep 是原片時間的保留段（片段扣掉剪輯），ass 是短片時間的字幕檔
export function renderShort({ video, ass, target, keep, layout, signal, onProgress = () => {} }) {
  const bin = ffmpegFull();
  if (!bin) return Promise.reject(new Error("making shorts needs an ffmpeg with libass (brew install ffmpeg-full)"));
  if (!keep?.length) return Promise.reject(new Error("nothing to export"));
  const args = shortArgs({ video, keep, layout, ass: path.basename(ass), audio: hasAudioStream(video), target });
  return runFfmpeg(bin, args, { cwd: path.dirname(ass), durationMs: keptDuration(keep), signal, onProgress, what: "short export" });
}

export async function runSubtitle(o) {
  const video = path.resolve(o.video), out = path.resolve(o.out);
  if (!fs.statSync(video).isFile()) throw new Error("video not found");
  preflight(o);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(out, ".work-"));
  const base = path.basename(video, path.extname(video));
  let report = { engine: o.engine, proofreader: o.proofreader, privacy: o.privacy, steps: {}, outputs: [], cleanup: {} };
  try {
    let prepared;
    try { prepared = await prepareSubtitles(o, { work }); } catch (e) { if (e.report) Object.assign(report, e.report); throw e; }
    report = { ...report, ...prepared.report, outputs: [], cleanup: {} };
    const srt = path.join(out, "subtitles.srt");
    fs.writeFileSync(srt, toSrt(prepared.cues), { mode: 0o600 });
    fs.writeFileSync(path.join(out, "edits.json"), JSON.stringify({ applied: prepared.applied, rejected: prepared.rejected }, null, 2) + "\n", { mode: 0o600 });
    report.outputs.push("subtitles.srt", "edits.json");
    if (prepared.description) {
      fs.writeFileSync(path.join(out, "youtube-description.md"), prepared.description, { mode: 0o600 });
      report.outputs.push("youtube-description.md");
    }
    if (o.burn) {
      const t = timer();
      const subs = writeBurnSubtitles({ dir: work, cues: prepared.cues, video, size: o.size, style: o.style });
      const target = path.join(out, `${base}-字幕.mp4`);
      await burnSubtitles({ video, srt: subs, target, size: o.size });
      report.outputs.push(path.basename(target));
      report.steps.burn_s = t();
    }
  } finally {
    const removed = fs.readdirSync(work).length;
    fs.rmSync(work, { recursive: true, force: true });
    report.cleanup = { work_files_removed: removed, work_dir_left: fs.existsSync(work) };
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  report.outputs.push("report.json");
  return report;
}

function addUsage(total, u) {
  for (const k of Object.keys(total)) total[k] += Number(u?.[k]) || 0;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
  try {
    const report = await runSubtitle(o);
    console.log(JSON.stringify({ ok: true, ...report }));
  } catch (e) {
    console.error(`[subtitle] ${e.message || e}`);
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
