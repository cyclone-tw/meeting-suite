import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyVad } from "./vad.mjs";
import { postprocessSegments } from "./postprocess-text.mjs";
import { resolveLanguage, runtimeIdentity } from "../lib/asr-profile.mjs";
import { makeRunTempDir } from "../lib/run-temp.mjs";

// 必須在任何 top-level await（下方的 runTranscription 呼叫）之前初始化，
// 否則 shouldChunk() 讀到 TDZ 會 ReferenceError。
const CHUNK_MAX_MB = Number(process.env.GROQ_TRANSCRIBE_CHUNK_MAX_MB || "24");

const packagePathInput = process.argv.slice(2).find((arg) => arg !== "--");
const packagePath = packagePathInput ? path.resolve(packagePathInput) : "";
if (!packagePath) {
  console.error("Usage: pnpm run transcribe:groq -- /path/to/transcript-package");
  process.exit(2);
}

const manifestPath = path.join(packagePath, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Missing manifest: ${manifestPath}`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sourceFile = resolvePackagePath(
  [
    manifest.source_files?.[0]?.path,
    manifest.source_files?.[0]?.drive_path,
    "source/original.m4a",
  ],
  manifest,
);
if (!sourceFile || !fs.existsSync(sourceFile)) {
  console.error(`Missing source audio. Checked manifest source path, drive_path, and source/original.m4a.`);
  process.exit(2);
}

const model = process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3";
const outputDir = path.join(packagePath, "transcripts", `groq-${model}`);
fs.mkdirSync(outputDir, { recursive: true });

const jsonPath = path.join(outputDir, "transcript.json");
const mdPath = path.join(outputDir, "transcript.md");
const segmentsPath = path.join(outputDir, "segments.json");
const forceRun = parseBooleanEnv(process.env.GROQ_TRANSCRIBE_FORCE, false);

if (!forceRun && hasUsableExistingOutput(segmentsPath)) {
  console.log(JSON.stringify({
    model,
    skipped: true,
    reason: "existing-output",
    output: path.relative(packagePath, mdPath),
    segments: countExistingSegments(segmentsPath),
    hint: "Set GROQ_TRANSCRIBE_FORCE=1 only when you intentionally want to spend on a re-run.",
  }, null, 2));
  process.exit(0);
}

// Optional VAD pre-processing (timeline-compressing silence removal). Off by
// default to preserve original timestamps; enable via GROQ_VAD=1 (the unified
// transcript CLI forwards this from --vad). See scripts/vad.mjs for caveats.
let activeSourceFile = sourceFile;
let vadApplied = false;
if (process.env.GROQ_VAD === "1") {
  const vad = applyVad(sourceFile);
  activeSourceFile = vad.path;
  vadApplied = vad.vadApplied;
}

const preflight = planGroqRun(activeSourceFile, model);
if (process.env.GROQ_TRANSCRIBE_DRY_RUN === "1") {
  console.log(JSON.stringify({
    model,
    dryRun: true,
    ...preflight.estimate,
  }, null, 2));
  cleanupPreflight(preflight);
  process.exit(0);
}

if (!forceRun && preflight.estimate.maxCostUsd !== null && preflight.estimate.estimatedCostUsd > preflight.estimate.maxCostUsd) {
  cleanupPreflight(preflight);
  console.error(
    `Refusing Groq transcription: estimated $${preflight.estimate.estimatedCostUsd.toFixed(4)} ` +
    `exceeds GROQ_TRANSCRIBE_MAX_COST_USD=$${preflight.estimate.maxCostUsd.toFixed(4)}. ` +
    "Use MLX/local first, raise --groq-max-cost-usd, or set GROQ_TRANSCRIBE_FORCE=1 intentionally.",
  );
  process.exit(3);
}

const apiKey = getGroqApiKey();
if (!apiKey) {
  cleanupPreflight(preflight);
  console.error(
    "Groq API key was not found in GROQ_API_KEY, macOS Keychain (service groq-api-key), or GROQ_CONFIG_JSON.",
  );
  console.error("Set GROQ_API_KEY, use macOS Keychain, or set GROQ_CONFIG_JSON to a local JSON config.");
  process.exit(2);
}

const { default: OpenAI } = await import("openai");
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

const prompt = process.env.GROQ_TRANSCRIBE_PROMPT || "";
// "" = let the API detect the language instead of forcing Chinese (#620).
let requestedLanguage;
try {
  requestedLanguage = resolveLanguage();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(2);
}

const startedAt = new Date();
let { segments, fullText, chunkCount, detectedLanguage } = await runTranscription(client, activeSourceFile, model, prompt, preflight, requestedLanguage);
const effectiveLanguage = requestedLanguage || detectedLanguage;
const finishedAt = new Date();

// Post-processing: OpenCC 簡→繁 + manifest.vocabulary replacement. Opt-in via
// GROQ_OPENCC=1 (default-safe: existing transcribe:groq callers see no change).
// The unified transcript CLI injects GROQ_OPENCC=1 unless --no-opencc. fullText
// is rebuilt from segments only when text actually changed.
let postprocessApplied = false;
if (process.env.GROQ_OPENCC === "1") {
  const beforeTexts = segments.map((s) => s.text);
  const processed = await postprocessSegments(segments, manifest, { language: effectiveLanguage });
  const changed = processed.some((s, i) => s.text !== beforeTexts[i]);
  if (changed) {
    segments = processed;
    fullText = segments.map((s) => s.text).join("\n");
    postprocessApplied = true;
  }
}

const serializableShape = { text: fullText, segments };
fs.writeFileSync(jsonPath, JSON.stringify(serializableShape, null, 2) + "\n", "utf8");

fs.writeFileSync(segmentsPath, JSON.stringify({ segments }, null, 2) + "\n", "utf8");
fs.writeFileSync(mdPath, renderMarkdown(model, fullText, segments), "utf8");

manifest.transcription_candidates = manifest.transcription_candidates || [];
manifest.transcription_candidates.push({
  engine: "groq-openai-compatible-audio-transcriptions",
  model,
  cloud_api_used: true,
  prompt_used: Boolean(prompt),
  chunked: chunkCount > 1,
  chunk_count: chunkCount,
  duration_seconds: preflight.estimate.audioDurationSeconds,
  estimated_billed_seconds: preflight.estimate.estimatedBilledSeconds,
  estimated_cost_usd: preflight.estimate.estimatedCostUsd,
  max_cost_usd: preflight.estimate.maxCostUsd,
  price_per_hour_usd: preflight.estimate.pricePerHourUsd,
  cost_guard_source: preflight.estimate.priceSource,
  force_run: forceRun,
  vad_applied: vadApplied,
  postprocess_opencc_applied: postprocessApplied,
  language: effectiveLanguage || "unknown",
  language_requested: requestedLanguage || "auto",
  runtime: runtimeIdentity(),
  source_audio: manifest.source_files?.[0]?.drive_path || manifest.source_files?.[0]?.path || "",
  output_json: path.relative(packagePath, jsonPath),
  output_md: path.relative(packagePath, mdPath),
  output_segments_json: path.relative(packagePath, segmentsPath),
  segment_count: segments.length,
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
});
manifest.updated_at = finishedAt.toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  model,
  output: path.relative(packagePath, mdPath),
  segments: segments.length,
  textLength: fullText.length,
  chunked: chunkCount > 1,
  chunkCount,
  estimatedCostUsd: preflight.estimate.estimatedCostUsd,
}, null, 2));

function audioSizeMb(filePath) {
  return fs.statSync(filePath).size / (1024 * 1024);
}

function probeDurationSeconds(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8" });
  if (result.status !== 0) return 0;
  return Number((result.stdout || "").trim()) || 0;
}

function shouldChunk(filePath) {
  return audioSizeMb(filePath) > CHUNK_MAX_MB;
}

function planGroqRun(filePath, modelName) {
  const duration = probeDurationSeconds(filePath);
  if (!duration) {
    if (forceRun) {
      const price = groqPricePerHourUsd(modelName);
      return {
        chunks: null,
        tmpDir: "",
        estimate: {
          audioDurationSeconds: 0,
          requestCount: 1,
          estimatedBilledSeconds: 0,
          pricePerHourUsd: price.amount,
          priceSource: `${price.source}-duration-unavailable`,
          maxCostUsd: parseOptionalNumber(process.env.GROQ_TRANSCRIBE_MAX_COST_USD, 0.35),
          estimatedCostUsd: 0,
          unavailable: true,
        },
      };
    }
    throw new Error(
      `Cannot estimate Groq transcription cost because ffprobe could not determine duration for ${filePath}. ` +
      "Use MLX/local first, or set GROQ_TRANSCRIBE_FORCE=1 only if you intentionally accept unknown Groq cost.",
    );
  }

  if (!shouldChunk(filePath)) {
    const estimate = buildCostEstimate(modelName, duration, [duration], 1);
    return { chunks: null, tmpDir: "", estimate };
  }

  const tmpDir = makeRunTempDir("groq-transcribe-");
  try {
    const chunks = chunkAudio(filePath, tmpDir);
    if (chunks.length === 0) throw new Error("chunking produced no chunks");
    const chunkDurations = chunks.map((chunk) => chunk.duration_seconds || probeDurationSeconds(chunk.path));
    const estimate = buildCostEstimate(modelName, duration, chunkDurations, chunks.length);
    return { chunks, tmpDir, estimate };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function buildCostEstimate(modelName, durationSeconds, requestDurations, requestCount) {
  const price = groqPricePerHourUsd(modelName);
  const billedSeconds = requestDurations.reduce((sum, seconds) => sum + Math.max(10, Number(seconds) || 0), 0);
  const maxCostUsd = parseOptionalNumber(process.env.GROQ_TRANSCRIBE_MAX_COST_USD, 0.35);
  return {
    audioDurationSeconds: roundSeconds(durationSeconds),
    requestCount,
    estimatedBilledSeconds: roundSeconds(billedSeconds),
    pricePerHourUsd: price.amount,
    priceSource: price.source,
    maxCostUsd,
    estimatedCostUsd: roundMoney((billedSeconds / 3600) * price.amount),
  };
}

function groqPricePerHourUsd(modelName) {
  const override = parseOptionalNumber(process.env.GROQ_TRANSCRIBE_PRICE_PER_HOUR_USD, null);
  if (override !== null) return { amount: override, source: "GROQ_TRANSCRIBE_PRICE_PER_HOUR_USD" };

  const defaults = new Map([
    ["whisper-large-v3", 0.111],
    ["whisper-large-v3-turbo", 0.04],
  ]);
  if (!defaults.has(modelName)) {
    throw new Error(
      `Unknown Groq transcription model for cost guard: ${modelName}. ` +
      "Use whisper-large-v3, whisper-large-v3-turbo, or set GROQ_TRANSCRIBE_PRICE_PER_HOUR_USD explicitly.",
    );
  }
  return {
    amount: defaults.get(modelName),
    source: "groq-pricing-2026-07",
  };
}

function parseOptionalNumber(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got: ${value}`);
  }
  return parsed;
}

function cleanupPreflight(preflight) {
  if (preflight?.tmpDir) fs.rmSync(preflight.tmpDir, { recursive: true, force: true });
}

function hasUsableExistingOutput(filePath) {
  return countExistingSegments(filePath) > 0;
}

function countExistingSegments(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed.segments) ? parsed.segments.length : 0;
  } catch {
    return 0;
  }
}

// 用 ffmpeg -c copy 切段（不重編碼，保留原始品質），每段低於 CHUNK_MAX_MB。
// Groq 單檔上限約 25MB；超過就切成多段逐段上傳，再依 offset 合併 timestamps。
function chunkAudio(filePath, tmpDir) {
  const sizeMb = audioSizeMb(filePath);
  const duration = probeDurationSeconds(filePath);
  if (!duration) throw new Error(`ffprobe could not determine duration for ${filePath}`);
  // 0.85 safety margin + 最短 15s。-c copy 切段大小只是推估，下方會逐一驗證實際 size。
  const segmentTime = Math.max(15, Math.floor((duration * (CHUNK_MAX_MB / sizeMb)) * 0.85));
  const ext = path.extname(filePath) || ".m4a";
  const pattern = path.join(tmpDir, `chunk-%03d${ext}`);
  const result = spawnSync("ffmpeg", [
    "-y", "-i", filePath,
    "-f", "segment", "-segment_time", String(segmentTime),
    "-c", "copy", pattern,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg segment failed: ${result.stderr || result.stdout}`);
  }
  const chunks = [];
  let offset = 0;
  const files = fs.readdirSync(tmpDir).filter((f) => /^chunk-\d{3}/.test(f)).sort();
  for (const f of files) {
    const p = path.join(tmpDir, f);
    const chunkMb = audioSizeMb(p);
    if (chunkMb > CHUNK_MAX_MB) {
      throw new Error(
        `chunk ${p} is ${chunkMb.toFixed(1)}MB > ${CHUNK_MAX_MB}MB after -c copy segment; ` +
        `lower GROQ_TRANSCRIBE_CHUNK_MAX_MB or re-encode the source.`
      );
    }
    const durationSeconds = probeDurationSeconds(p);
    chunks.push({ path: p, offset_seconds: Number(offset.toFixed(3)), duration_seconds: durationSeconds });
    offset += durationSeconds;
  }
  return chunks;
}

async function transcribeOnce(client, filePath, model, prompt, language) {
  const stream = fs.createReadStream(filePath);
  try {
    const request = {
      file: stream,
      model,
      ...(language ? { language } : {}),
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      temperature: 0,
    };
    if (prompt) request.prompt = prompt;
    const transcript = await client.audio.transcriptions.create(request);
    return JSON.parse(JSON.stringify(transcript));
  } finally {
    stream.destroy();
  }
}

async function runTranscription(client, sourceFile, model, prompt, preflight, language) {
  if (!preflight.chunks) {
    const result = await transcribeOnce(client, sourceFile, model, prompt, language);
    const segments = normalizeSegments(result, sourceFile);
    return { segments, fullText: result.text || "", chunkCount: 1, detectedLanguage: result.language || "" };
  }
  try {
    const allSegments = [];
    const textParts = [];
    let detectedLanguage = "";
    for (const chunk of preflight.chunks) {
      const result = await transcribeOnce(client, chunk.path, model, prompt, language);
      detectedLanguage = detectedLanguage || result.language || "";
      const segs = normalizeSegments(result, sourceFile).map((s) => ({
        ...s,
        start: Math.round((s.start + chunk.offset_seconds) * 1000) / 1000,
        end: Math.round((s.end + chunk.offset_seconds) * 1000) / 1000,
      }));
      allSegments.push(...segs);
      if (result.text) textParts.push(result.text);
    }
    return { segments: allSegments, fullText: textParts.join("\n"), chunkCount: preflight.chunks.length, detectedLanguage };
  } finally {
    cleanupPreflight(preflight);
  }
}

function getGroqApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  const result = spawnSync("security", [
    "find-generic-password",
    "-a",
    "cyclone",
    "-s",
    "groq-api-key",
    "-w",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) return result.stdout.trim();
  return getGroqApiKeyFromConfig();
}

function resolvePackagePath(values, manifestData) {
  for (const value of values.filter(Boolean)) {
    const direct = resolveCandidatePath(value);
    if (direct && fs.existsSync(direct)) return direct;

    const portable = resolvePortablePackagePath(value, manifestData);
    if (portable && fs.existsSync(portable)) return portable;
  }

  return "";
}

function resolveCandidatePath(value) {
  if (path.isAbsolute(value)) return value;
  return path.join(packagePath, value);
}

function resolvePortablePackagePath(value, manifestData) {
  const packageId = manifestData.package_id;
  const drivePath = manifestData.drive_path || manifestData.asset_package?.drive_path;
  const markers = [drivePath, packageId].filter(Boolean);

  for (const marker of markers) {
    const markerWithSlash = `${marker}/`;
    const index = value.indexOf(markerWithSlash);
    if (index === -1) continue;
    const relative = value.slice(index + markerWithSlash.length);
    return path.join(packagePath, relative);
  }

  return "";
}

function getGroqApiKeyFromConfig() {
  const candidates = [
    process.env.GROQ_CONFIG_JSON,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const filePath = expandHome(candidate);
    if (!fs.existsSync(filePath)) continue;

    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const value = config.apiKey || config.api_key || config.GROQ_API_KEY;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Ignore malformed config and continue to the next source.
    }
  }

  return "";
}

function expandHome(value) {
  if (!value.startsWith("~/")) return value;
  return path.join(process.env.HOME || "", value.slice(2));
}

function normalizeSegments(result, source) {
  const sourceSegments = Array.isArray(result.segments) ? result.segments : [];
  if (sourceSegments.length === 0 && result.text) {
    return [{
      speaker: "Speaker",
      start: 0,
      end: 0,
      text: normalizeText(result.text),
      source,
    }];
  }

  return sourceSegments
    .map((segment) => ({
      speaker: "Speaker",
      start: roundSeconds(segment.start || 0),
      end: roundSeconds(segment.end || segment.start || 0),
      text: normalizeText(segment.text || ""),
      source,
      avg_logprob: segment.avg_logprob,
      compression_ratio: segment.compression_ratio,
      no_speech_prob: segment.no_speech_prob,
    }))
    .filter((segment) => segment.text);
}

function renderMarkdown(model, text, segments) {
  const lines = [
    "# Groq Transcription",
    "",
    `- Model: \`${model}\``,
    "- Engine: Groq OpenAI-compatible audio transcriptions",
    "- Source: `source/original.m4a`",
    "",
  ];

  if (segments.length > 0) {
    lines.push("## Segments", "");
    for (const segment of segments) {
      lines.push(`**[${formatTime(segment.start)}-${formatTime(segment.end)}]** ${segment.text}`);
      lines.push("");
    }
  } else {
    lines.push("## Transcript", "", normalizeText(text), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function normalizeText(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function roundMoney(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
