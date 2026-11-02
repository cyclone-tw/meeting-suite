#!/usr/bin/env node
// Unified transcript orchestrator. Decides the source type (YouTube URL vs local
// audio), routes to an engine (captions / apify / groq / mlx / whisper / auto), runs
// post-processing, and lays out a transcript package:
//   <out>/{manifest.json, source/, transcripts/<engine>/, outputs/}
//
// This is the engine + packaging layer. Drive upload, wiki summary, and
// the Notion draft are produced by the transcript-pipeline SKILL (stage PR2).
//
// Engine selection (auto) is an ordered candidate list; a failing candidate
// falls through to the next and the reason is recorded in
// manifest.engine_fallbacks:
//   YouTube, MLX available: mlx (shared ASR profile on every host) -> captions
//   YouTube, no MLX:        captions -> apify (token hosts) -> groq
//   Local file:             mlx when available, otherwise groq.
//   Explicit --engine:      exactly that engine, no fallback.
// Groq is never an automatic fallback once a local engine exists.
//
// Media retention: downloaded or copied media is removed when the run ends
// (success, failure or interrupt) unless --keep-media; see lib/media-cleanup.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isYouTubeUrl, getVideoMetadata, listSubs, downloadCaptions, downloadAudio } from "./download-yt.mjs";
import { fetchApifyTranscript, isApifyAvailable } from "./transcribe-apify.mjs";
import { postprocessSegments } from "./postprocess-text.mjs";
import { diarizeSegments } from "./diarize.mjs";
import { readManifest, writeManifest } from "../lib/manifest.mjs";
import { handoffEnabled, handoffFromPackage, handoffSubdir } from "../lib/wiki-handoff.mjs";
import { normalizeLanguage, runtimeIdentity } from "../lib/asr-profile.mjs";
import {
  CLEANUP_RECEIPT,
  cleanupRunMedia,
  snapshotMedia,
  summarizeCleanup,
  writeCleanupReceipt,
} from "../lib/media-cleanup.mjs";
import { resolveFfmpegCommand } from "../lib/local-tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const VALID_ENGINES = new Set(["auto", "captions", "apify", "groq", "mlx", "whisper"]);

// --- args / usage ---

function parseArgs(argv) {
  const args = argv.slice(2).filter((a) => a !== "--");
  const positional = [];
  const opts = {
    engine: "auto",
    vad: false,
    opencc: true,
    diarize: false,
    out: "",
    model: "",
    mlxConditionOnPreviousText: "",
    force: false,
    groqDryRun: false,
    groqMaxCostUsd: "",
    language: "",
    keepMedia: false,
    handoff: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Value flags use args[++i] so the outer loop index advances past the value;
    // a closure like `(i) => args[++i]` would mutate a copy and silently swallow
    // the value (leaving it to be parsed as the positional source).
    if (a === "--engine") opts.engine = args[++i];
    else if (a.startsWith("--engine=")) opts.engine = a.slice(9);
    else if (a === "--privacy") i++; // 舊參數：已無作用，接受但忽略
    else if (a.startsWith("--privacy=")) continue;
    else if (a === "--out") opts.out = args[++i];
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a === "--model") opts.model = args[++i];
    else if (a.startsWith("--model=")) opts.model = a.slice(8);
    else if (a === "--condition-on-previous-text") opts.mlxConditionOnPreviousText = args[++i];
    else if (a.startsWith("--condition-on-previous-text=")) opts.mlxConditionOnPreviousText = a.slice(29);
    else if (a === "--force") opts.force = true;
    else if (a === "--groq-dry-run") opts.groqDryRun = true;
    else if (a === "--groq-max-cost-usd") opts.groqMaxCostUsd = args[++i];
    else if (a.startsWith("--groq-max-cost-usd=")) opts.groqMaxCostUsd = a.slice(20);
    else if (a === "--language") {
      opts.language = args[++i];
      if (!opts.language || opts.language.startsWith("--")) throw usageError("--language needs a value");
    }
    else if (a.startsWith("--language=")) opts.language = a.slice(11);
    else if (a === "--keep-media") opts.keepMedia = true;
    else if (a === "--no-handoff") opts.handoff = false;
    else if (a === "--vad") opts.vad = true;
    else if (a === "--no-opencc") opts.opencc = false;
    else if (a === "--diarize") opts.diarize = true;
    else if (a.startsWith("--vocab=")) opts.vocabPath = a.slice(8);
    else if (!a.startsWith("--")) positional.push(a);
  }
  opts.source = positional[0] || "";
  return opts;
}

function usageError(message) {
  const error = new Error(message);
  error.usageError = true;
  return error;
}

function usage() {
  console.error(`Usage: pnpm run transcript -- <source> [options]

Source:
  <youtube-url>   YouTube video / shorts URL
  <local-file>    path to a local audio file (m4a/mp3/wav/flac)

Options:
  --engine <auto|captions|apify|groq|mlx|whisper> default: auto
  --out <package-dir>                            default: ./transcript-package-<timestamp>
  --model <model>                                ASR model override (MLX/Groq)
  --language <auto|en|zh|...>                    default: config/asr-profile.json (auto = detect)
  --keep-media                                   keep downloaded/copied media (default: removed at end)
  --no-handoff                                   do not write the agent handoff to iCloud <icloud_inbox>/to-wiki
  --condition-on-previous-text <true|false>      MLX previous-text conditioning (default: false)
  --groq-max-cost-usd <amount>                   Groq per-run cap (default: 0.35)
  --groq-dry-run                                 estimate Groq cost without API calls
  --force                                        intentionally re-run / override Groq cost guard
  --vad                                          VAD silence removal (compresses timeline)
  --no-opencc                                    disable OpenCC 簡→繁 + vocabulary
  --diarize                                      attempt speaker diarization (graceful no-op)
  --vocab=<path>                                 load vocabulary JSON ({from:to}) into manifest`);
}

// --- package layout / manifest ---

function resolveOutputDirectory(opts) {
  return opts.out
    ? path.resolve(opts.out)
    : path.resolve(process.cwd(), `transcript-package-${Date.now()}`);
}

function ensurePackage(outDir) {
  for (const sub of ["source", "transcripts", "outputs"]) {
    fs.mkdirSync(path.join(outDir, sub), { recursive: true, mode: 0o700 });
  }
  return outDir;
}

function initManifest(outDir, opts, extra = {}) {
  let manifest = {};
  if (fs.existsSync(path.join(outDir, "manifest.json"))) {
    manifest = readManifest(outDir);
  }
  manifest.package_id = manifest.package_id || path.basename(outDir);
  manifest.recording_kind = manifest.recording_kind || (isYouTubeUrl(opts.source) ? "youtube" : "local-audio");
  manifest.updated_at = new Date().toISOString();
  // Fallbacks describe this run only; a re-run starts a fresh list.
  manifest.engine_fallbacks = [];
  if (!manifest.source_files) manifest.source_files = [];
  if (!manifest.transcription_candidates) manifest.transcription_candidates = [];
  if (!manifest.transcripts) manifest.transcripts = {};
  if (opts.vocabPath && fs.existsSync(opts.vocabPath)) {
    manifest.vocabulary = JSON.parse(fs.readFileSync(opts.vocabPath, "utf8"));
  }
  Object.assign(manifest, extra);
  writeManifest(outDir, manifest);
  return manifest;
}

function addSourceFile(manifest, relPath, extra = {}) {
  if (relPath && !manifest.source_files.some((f) => f.path === relPath)) {
    manifest.source_files.push({ path: relPath, ...extra });
  }
}

function addCandidate(manifest, candidate) {
  manifest.transcription_candidates = manifest.transcription_candidates || [];
  candidate.started_at = candidate.started_at || new Date().toISOString();
  candidate.finished_at = candidate.finished_at || new Date().toISOString();
  manifest.transcription_candidates.push(candidate);
}

// --- engine planning & source prep ---

export function planEngine(source, opts) {
  return planEngineCandidates(source, opts)[0];
}

export function planEngineCandidates(source, opts) {
  validateEngine(opts);
  if (opts.engine !== "auto") return [opts.engine];
  const mlx = isMlxAvailable();
  if (isYouTubeUrl(source)) {
    if (mlx) return ["mlx", "captions"];
    const candidates = ["captions"];
    if (isApifyAvailable()) candidates.push("apify");
    candidates.push("groq");
    return candidates;
  }
  return [mlx ? "mlx" : "groq"];
}

function validateEngine(opts) {
  if (!VALID_ENGINES.has(opts.engine)) {
    throw new Error("unknown transcript engine; refusing source processing");
  }
  normalizeLanguage(opts.language || "auto");
}

function isMlxAvailable() {
  const command = process.env.TRANSCRIBE_MLX_COMMAND || "mlx_whisper";
  if (command.includes(path.sep)) return fs.existsSync(command);
  const result = spawnSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function prepareSource(source, outDir, opts, needAudio) {
  if (isYouTubeUrl(source)) {
    const meta = getVideoMetadata(source);
    if (!needAudio) return { meta, sourceFile: null, rel: "" };
    const dl = downloadAudio(source, path.join(outDir, "source"));
    if (!dl.ok) throw new Error("YouTube audio download failed: " + dl.error);
    const audioFile = dl.files[0];
    return { meta, sourceFile: audioFile, rel: path.relative(outDir, audioFile) };
  }
  const ext = path.extname(source) || ".m4a";
  const dest = path.join(outDir, "source", `original${ext}`);
  // Clone on APFS (instant, no extra disk) and fall back to a copy elsewhere;
  // either way the package copy is removed by the end-of-run cleanup.
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE);
  return {
    meta: { title: path.basename(source) },
    sourceFile: dest,
    rel: path.relative(outDir, dest),
  };
}

// --- captions engine ---

export function vttTimeToSec(t) {
  const [h, m, s] = t.split(":").map(Number);
  return Math.round((h * 3600 + m * 60 + s) * 1000) / 1000;
}

export function cleanVtt(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const segments = [];
  let curStart = 0, curEnd = 0, curText = [];
  const flush = () => {
    const text = curText.join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) segments.push({ speaker: "Speaker", start: curStart, end: curEnd, text });
    curText = [];
  };
  for (const line of lines) {
    const m = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (m) { flush(); curStart = vttTimeToSec(m[1]); curEnd = vttTimeToSec(m[2]); }
    else if (/^(WEBVTT|NOTE\b)|^\s*\d+\s*$/.test(line.trim())) continue;
    else if (line.trim() === "") continue;
    else curText.push(line);
  }
  flush();
  // Collapse YouTube auto-caption artifacts: exact-duplicate cues, and the
  // roll-up pattern where each progressive cue rebuilds on the previous one
  // (e.g. "Hello" -> "Hello world"). Merge when the new text starts with the
  // previous text and the cues are adjacent in time.
  const dedup = [];
  for (const s of segments) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.text === s.text) { prev.end = s.end; continue; }
    if (prev && s.text !== prev.text && s.text.startsWith(prev.text) && s.start <= prev.end + 1.5) {
      prev.text = s.text;
      prev.end = s.end;
      continue;
    }
    dedup.push({ ...s });
  }
  return { segments: dedup, text: dedup.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim() };
}

// yt-dlp names captions <id>.<lang>.vtt with our "%(id)s.%(ext)s" template.
// Prefer the original-language auto caption (en-orig) over translations: an
// English video also offers auto-translated zh captions, and picking those
// first was the captions-route twin of the "English forced into Chinese" bug.
// Without en-orig the original language is unknown; zh stays ahead of plain en
// on purpose (the default audience), and captions are only a fallback
// behind MLX now.
function pickBestCaption(files) {
  for (const re of [/\.en-orig\./i, /zh-Hant|zh-Hans|\.zh\b/i, /\.en\b/i, /\.ja\b/i, /\.ko\b/i]) {
    const f = files.find((x) => re.test(x));
    if (f) return f;
  }
  return files[0];
}

export function captionLanguage(file) {
  const match = path.basename(file).match(/\.([A-Za-z]{2,3})(?:-[A-Za-z0-9]+)*\.(?:vtt|srt)$/);
  return match ? match[1].toLowerCase() : "";
}

function renderSegmentsMd(title, meta, segments) {
  const lines = [`# ${title}`, ""];
  if (meta) {
    if (meta.title) lines.push(`- Title: ${meta.title}`);
    if (meta.uploader) lines.push(`- Uploader: ${meta.uploader}`);
    if (meta.webpage_url) lines.push(`- URL: ${meta.webpage_url}`);
    lines.push("");
  }
  lines.push("## Segments", "");
  for (const s of segments) {
    lines.push(`**[${fmt(s.start)}-${fmt(s.end)}]** ${s.text}`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function fmt(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = String(Math.floor(t / 3600)).padStart(2, "0");
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function runCaptions(source, outDir, manifest, opts) {
  if (opts.engine === "auto" && !listSubs(source).available) {
    throw new Error("no en/zh/ja/ko captions listed for this video");
  }
  const meta = getVideoMetadata(source);
  const dl = downloadCaptions(source, path.join(outDir, "source"));
  if (!dl.ok) throw new Error("caption download failed: " + firstLine(dl.error));
  const vttFile = pickBestCaption(dl.files);
  const language = captionLanguage(vttFile);
  const { segments } = cleanVtt(fs.readFileSync(vttFile, "utf8"));
  const processed = opts.opencc ? await postprocessSegments(segments, manifest, { language }) : segments;
  const sub = path.join(outDir, "transcripts", "captions");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "segments.json"), JSON.stringify({ segments: processed }, null, 2) + "\n");
  fs.writeFileSync(path.join(sub, "transcript.md"), renderSegmentsMd("YouTube Caption Transcript", meta, processed), "utf8");
  addSourceFile(manifest, path.relative(outDir, vttFile), { kind: "youtube-captions", url: meta.webpage_url });
  addCandidate(manifest, {
    engine: "youtube-captions", model: "youtube-captions", cloud_api_used: false,
    language: language || "unknown", runtime: runtimeIdentity(),
    segment_count: processed.length, caption_file: path.relative(outDir, vttFile),
    output_md: path.relative(outDir, path.join(sub, "transcript.md")),
    output_segments_json: path.relative(outDir, path.join(sub, "segments.json")),
  });
  return { segments: processed };
}

async function runApify(source, outDir, manifest, opts) {
  const meta = getVideoMetadata(source);
  const res = await fetchApifyTranscript(source);
  if (!res.ok) throw new Error("apify failed: " + res.reason);
  const processed = opts.opencc ? await postprocessSegments(res.segments, manifest, {}) : res.segments;
  const sub = path.join(outDir, "transcripts", "apify");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "segments.json"), JSON.stringify({ segments: processed }, null, 2) + "\n");
  fs.writeFileSync(path.join(sub, "transcript.md"), renderSegmentsMd("Apify YouTube Transcript", meta, processed), "utf8");
  addSourceFile(manifest, "", { kind: "youtube", url: meta.webpage_url });
  addCandidate(manifest, {
    engine: "apify-youtube-transcript-scraper", model: "apify", cloud_api_used: true,
    segment_count: processed.length,
    output_md: path.relative(outDir, path.join(sub, "transcript.md")),
    output_segments_json: path.relative(outDir, path.join(sub, "segments.json")),
  });
  return { segments: processed };
}

// transcribe-package.mjs (whisper) expects audio/extracted.mp3 (or
// manifest.audio.extracted_mp3), unlike the groq engine which reads
// source_files. Materialize an MP3 there from the package source audio so the
// local Whisper engine can run without a meeting-style pre-extracted layout.
// OpenCC/vocabulary post-processing runs inside transcribe-package.mjs (#620);
// VAD is still Groq-only.
function ensureWhisperAudio(outDir, manifest) {
  const srcRel = manifest.source_files?.[0]?.path;
  const src = srcRel ? path.join(outDir, srcRel) : "";
  if (!src || !fs.existsSync(src)) {
    throw new Error("whisper engine needs a source audio file in the package (source_files[0].path)");
  }
  fs.mkdirSync(path.join(outDir, "audio"), { recursive: true });
  const dest = path.join(outDir, "audio", "extracted.mp3");
  if (!fs.existsSync(dest)) {
    const ffmpeg = resolveFfmpegCommand();
    if (!ffmpeg) throw new Error("trusted local ffmpeg executable is unavailable");
    const r = spawnSync(ffmpeg, ["-y", "-i", src, "-vn", "-acodec", "libmp3lame", "-q:a", "2", dest], { encoding: "utf8" });
    if (r.status !== 0 || !fs.existsSync(dest)) {
      throw new Error("ffmpeg mp3 extraction for whisper failed: " + (r.stderr || "").split("\n").slice(-2).join(" "));
    }
  }
  manifest.audio = manifest.audio || {};
  manifest.audio.extracted_mp3 = "audio/extracted.mp3";
  writeManifest(outDir, manifest);
}

function runSpawnEngine(scriptName, outDir, opts) {
  const env = { ...process.env };
  if (opts.vad) env.GROQ_VAD = "1";
  if (opts.opencc) env.GROQ_OPENCC = "1";
  env.TRANSCRIBE_OPENCC = opts.opencc ? "1" : "0";
  if (opts.model && scriptName === "transcribe-groq.mjs") env.GROQ_TRANSCRIBE_MODEL = opts.model;
  else if (opts.model) env.TRANSCRIBE_MLX_MODEL = opts.model;
  if (opts.mlxConditionOnPreviousText) {
    env.TRANSCRIBE_MLX_CONDITION_ON_PREVIOUS_TEXT = opts.mlxConditionOnPreviousText;
  }
  if (opts.language) env.TRANSCRIBE_LANGUAGE = opts.language;
  if (opts.groqMaxCostUsd) env.GROQ_TRANSCRIBE_MAX_COST_USD = opts.groqMaxCostUsd;
  if (opts.groqDryRun) env.GROQ_TRANSCRIBE_DRY_RUN = "1";
  if (opts.force) env.GROQ_TRANSCRIBE_FORCE = "1";
  const r = spawnSync("node", [path.join("scripts", scriptName), outDir], {
    cwd: TOOL_ROOT,
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`${scriptName} failed (exit ${r.status})`);
  }
}

// --- main ---

const AUDIO_ENGINES = new Set(["groq", "mlx", "whisper"]);

function firstLine(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean)
    .find((line) => /error/i.test(line)) || String(value || "").split("\n")[0].trim();
}

async function runEngine(engine, outDir, manifest, opts) {
  if (engine === "captions") return runCaptions(opts.source, outDir, manifest, opts);
  if (engine === "apify") return runApify(opts.source, outDir, manifest, opts);
  if (engine === "groq") { runSpawnEngine("transcribe-groq.mjs", outDir, opts); return {}; }
  if (engine === "mlx") { runSpawnEngine("transcribe-mlx.mjs", outDir, opts); return {}; }
  if (engine === "whisper") {
    ensureWhisperAudio(outDir, manifest);
    runSpawnEngine("transcribe-package.mjs", outDir, opts);
    return {};
  }
  throw new Error("unknown engine: " + engine);
}

// Runs once per process: from the finally block, or from a signal handler when
// the run is interrupted between synchronous steps.
let pendingCleanup = null;

function runPendingCleanup() {
  const cleanup = pendingCleanup;
  pendingCleanup = null;
  return cleanup ? cleanup() : null;
}

// Signals are only delivered between synchronous steps: during a long
// spawnSync engine run, Ctrl-C reaches the child first and cleanup runs once
// the child exits (via the finally block).
function installSignalCleanup() {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(signal, () => {
      try {
        runPendingCleanup();
      } finally {
        process.exit(code);
      }
    });
  }
}

function makeCleanup(outDir, preMedia, opts) {
  return () => {
    const receipt = cleanupRunMedia(outDir, preMedia, { keepMedia: opts.keepMedia, allowTrash: true });
    writeCleanupReceipt(outDir, receipt);
    if (fs.existsSync(path.join(outDir, "manifest.json"))) {
      const manifest = readManifest(outDir);
      manifest.media_retention = {
        keep_media: Boolean(opts.keepMedia),
        receipt: CLEANUP_RECEIPT,
        cleaned_at: receipt.finished_at,
      };
      writeManifest(outDir, manifest);
    }
    console.error(summarizeCleanup(receipt));
    return receipt;
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.source) { usage(); process.exit(2); }

  validateEngine(opts);
  const outDir = resolveOutputDirectory(opts);
  const candidates = planEngineCandidates(opts.source, opts);
  ensurePackage(outDir);
  pendingCleanup = makeCleanup(outDir, snapshotMedia(outDir), opts);
  installSignalCleanup();
  try {
  let manifest = initManifest(outDir, opts);
  console.error(`[transcript] engines=${candidates.join(">")} source=${opts.source} -> ${outDir}`);

  let prepared = null;
  let result = {};
  let engine = "";
  const fallbacks = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const needAudio = AUDIO_ENGINES.has(candidate);
      if (!prepared || (needAudio && !prepared.sourceFile)) {
        prepared = prepareSource(opts.source, outDir, opts, needAudio);
        if (prepared.meta) manifest.source_meta = prepared.meta;
        addSourceFile(manifest, prepared.rel, {
          kind: isYouTubeUrl(opts.source) ? (needAudio ? "youtube-audio" : "youtube") : "local-audio",
          url: prepared.meta?.webpage_url,
        });
        writeManifest(outDir, manifest);
      }
      result = await runEngine(candidate, outDir, manifest, opts);
      engine = candidate;
      break;
    } catch (error) {
      if (index === candidates.length - 1) throw error;
      const next = candidates[index + 1];
      const reason = firstLine(error?.message || error);
      fallbacks.push({ from: candidate, to: next, reason, at: new Date().toISOString() });
      console.error(`[transcript] ${candidate} failed, falling back to ${next}: ${reason}`);
      manifest = readManifest(outDir);
      manifest.engine_fallbacks = [...(manifest.engine_fallbacks || []), fallbacks[fallbacks.length - 1]];
      writeManifest(outDir, manifest);
    }
  }

  // groq/whisper wrote candidates themselves; captions/apify wrote above. Reload
  // and optionally diarize the in-memory segments we have.
  if (opts.diarize && result.segments) {
    result.segments = diarizeSegments(result.segments, prepared?.sourceFile).segments;
  }

  manifest = readManifest(outDir);
  manifest.updated_at = new Date().toISOString();
  manifest.engine_used = engine;
  writeManifest(outDir, manifest);

  const receipt = runPendingCleanup();
  const summary = {
    engine,
    fallbacks: fallbacks.map(({ from, to, reason }) => ({ from, to, reason })),
    segmentCount: result.segments?.length,
    candidates: manifest.transcription_candidates.length,
    cleanup: receipt && {
      keep_media: receipt.keep_media,
      deleted: receipt.deleted.length,
      trashed: receipt.trashed.length,
      leftovers: receipt.leftovers.length,
      bytes_deleted: receipt.bytes_deleted,
      bytes_trashed: receipt.bytes_trashed,
    },
    runtime: runtimeIdentity(),
    handoff: opts.handoff && handoffEnabled() ? writeWikiHandoff(outDir, opts.source) : { skipped: true },
  };
  Object.assign(summary, {
    outDir,
    manifest: path.relative(process.cwd(), path.join(outDir, "manifest.json")),
    meta: manifest.source_meta,
  });
  console.log(JSON.stringify(summary, null, 2));
  } finally {
    runPendingCleanup();
  }
}

// 交給 coding agent 的交接單（有設定 icloud_inbox 才寫）；寫不成只報錯，轉錄結果照樣算數
function writeWikiHandoff(outDir, source) {
  try {
    const { name } = handoffFromPackage(outDir, { source: isYouTubeUrl(source) ? source : path.resolve(source) });
    console.error(`[handoff] wrote iCloud Drive/${handoffSubdir()}/${name}`);
    return { ok: true, name };
  } catch (error) {
    const message = firstLine(error?.message || error);
    console.error(`[handoff] FAILED, no wiki handoff written: ${message}`);
    return { ok: false, error: message };
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e?.usageError ? String(e.message) : String(e?.stack || e));
    process.exit(1);
  });
}
