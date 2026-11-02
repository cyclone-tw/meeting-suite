import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { postprocessSegments } from "./postprocess-text.mjs";
import { writeManifest } from "../lib/manifest.mjs";
import { loadAsrProfile, resolveLanguage, runtimeIdentity } from "../lib/asr-profile.mjs";
import {
  DEFAULT_MLX_MODEL,
} from "../lib/local-tools.mjs";
import { loadPackageForLocalTool } from "../lib/package-security.mjs";
import { makeRunTempDir } from "../lib/run-temp.mjs";

const packagePathInput = process.argv.slice(2).find((arg) => arg !== "--");
if (!packagePathInput) {
  console.error("Usage: pnpm run transcribe:mlx -- /path/to/transcript-package");
  process.exit(2);
}

let loadedPackage;
try {
  loadedPackage = loadPackageForLocalTool(packagePathInput);
} catch (error) {
  console.error(String(error?.message || "Invalid transcript package."));
  process.exit(2);
}
const packagePath = loadedPackage.root;
const manifest = loadedPackage.manifest;

const asrProfile = loadAsrProfile().profile;
const requestedModel = process.env.TRANSCRIBE_MLX_MODEL || asrProfile.mlx_model || DEFAULT_MLX_MODEL;
const modelPath = requestedModel;
if (!modelPath) {
  console.error("Trusted local MLX Whisper model cache is unavailable.");
  process.exit(2);
}
const modelLabel = requestedModel;
// "" means auto-detect: mlx_whisper gets no --language and reports what it heard.
let requestedLanguage;
try {
  requestedLanguage = resolveLanguage();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(2);
}
const conditionOnPreviousText = parseBooleanEnv(
  process.env.TRANSCRIBE_MLX_CONDITION_ON_PREVIOUS_TEXT,
  asrProfile.condition_on_previous_text === true,
);
const openccRequested = process.env.TRANSCRIBE_OPENCC !== "0";

const startedAt = new Date();
const mlxCommand = process.env.TRANSCRIBE_MLX_COMMAND || "mlx_whisper";
if (!mlxCommand) {
  console.error("Trusted local MLX Whisper executable is unavailable.");
  process.exit(2);
}
const sourceFile = resolvePackagePath(
  [
    manifest.source_files?.[0]?.path,
    manifest.source_files?.[0]?.drive_path,
    "source/original.m4a",
    "source/original.mp4",
    "source/original.wav",
    "source/original.mp3",
    "source/original.flac",
  ],
  manifest,
);

if (!sourceFile || !fs.existsSync(sourceFile)) {
  console.error("Missing source audio. Checked manifest source path, drive_path, and source/original.*.");
  process.exit(2);
}

const outputDir = path.join(packagePath, "transcripts", `mlx-${modelSlug(modelLabel)}`);
fs.mkdirSync(outputDir, { recursive: true });

const tmpDir = makeRunTempDir("mlx-transcribe-");
const rawOutputName = "raw";
const rawJsonPath = path.join(tmpDir, `${rawOutputName}.json`);

try {
  runMlxWhisper({
    command: mlxCommand,
    sourceFile,
    tmpDir,
    outputName: rawOutputName,
    model: modelPath,
    language: requestedLanguage,
    conditionOnPreviousText,
  });

  if (!fs.existsSync(rawJsonPath)) {
    throw new Error(`mlx-whisper did not produce JSON output: ${rawJsonPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(rawJsonPath, "utf8"));
  const sourceLabel = sourceFile;
  const detectedLanguage = String(raw.language || "").trim();
  const effectiveLanguage = requestedLanguage || detectedLanguage;
  let segments = normalizeSegments(raw, sourceLabel);
  const beforeTexts = segments.map((segment) => segment.text);
  if (openccRequested) {
    segments = await postprocessSegments(segments, manifest, { language: effectiveLanguage });
  }
  const postprocessApplied = openccRequested && segments.some((segment, index) =>
    segment.text !== beforeTexts[index]
  );
  const text = segments.map((segment) => segment.text).join("\n");

  const jsonPath = path.join(outputDir, "transcript.json");
  const segmentsPath = path.join(outputDir, "segments.json");
  const mdPath = path.join(outputDir, "transcript.md");
  const srtPath = path.join(outputDir, "subtitles.srt");
  const vttPath = path.join(outputDir, "subtitles.vtt");

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ text, segments, language: effectiveLanguage || "unknown" }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(segmentsPath, JSON.stringify({ segments }, null, 2) + "\n", "utf8");
  fs.writeFileSync(mdPath, renderMarkdown(modelLabel, sourceLabel, segments), "utf8");
  fs.writeFileSync(srtPath, renderSrt(segments), "utf8");
  fs.writeFileSync(vttPath, renderVtt(segments), "utf8");

  const finishedAt = new Date();
  manifest.transcription_candidates = manifest.transcription_candidates || [];
  manifest.transcription_candidates.push({
    engine: "mlx-whisper",
    model: modelLabel,
    model_cache: "caller-selected",
    cloud_api_used: false,
    command: mlxCommand,
    language: effectiveLanguage || "unknown",
    language_requested: requestedLanguage || "auto",
    language_detected: detectedLanguage || "",
    requires_metal: true,
    condition_on_previous_text: conditionOnPreviousText,
    postprocess_opencc_requested: openccRequested,
    postprocess_opencc_applied: postprocessApplied,
    quality_warnings: detectQualityWarnings(segments),
    sandbox_note: "Codex sandbox may not expose Metal; run mlx_whisper through an approved unsandboxed command.",
    source_audio: path.relative(packagePath, sourceFile),
    output_json: path.relative(packagePath, jsonPath),
    output_md: path.relative(packagePath, mdPath),
    output_segments_json: path.relative(packagePath, segmentsPath),
    output_srt: path.relative(packagePath, srtPath),
    output_vtt: path.relative(packagePath, vttPath),
    segment_count: segments.length,
    runtime: runtimeIdentity(),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
  });
  manifest.updated_at = finishedAt.toISOString();
  writeManifest(packagePath, manifest);

  console.log(JSON.stringify({
    model: modelLabel,
    output: path.relative(packagePath, mdPath),
    subtitles: {
      srt: path.relative(packagePath, srtPath),
      vtt: path.relative(packagePath, vttPath),
    },
    segments: segments.length,
    textLength: text.length,
    language: effectiveLanguage || "unknown",
    conditionOnPreviousText,
  }, null, 2));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runMlxWhisper({ command, sourceFile, tmpDir, outputName, model, language, conditionOnPreviousText }) {
  const childEnv = { ...process.env };
  const result = spawnSync(command, [
    sourceFile,
    ...(language ? ["--language", language] : []),
    "--output-format", "json",
    "--output-dir", tmpDir,
    "--output-name", outputName,
    "--model", model,
    "--condition-on-previous-text", conditionOnPreviousText ? "True" : "False",
  ], {
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) return;

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const stderr = result.stderr || "";
  if (stderr.includes("No Metal device available")) {
    throw new Error(
      "mlx_whisper could not access the Metal GPU. Run this command outside the Codex sandbox or approve an unsandboxed mlx_whisper execution.",
    );
  }
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `mlx-whisper command not found: ${command}. Install with \`pipx install --python /usr/local/bin/python3.13 mlx-whisper\`.`,
    );
  }
  throw new Error(`${command} failed with exit code ${result.status}`);
}

function normalizeSegments(raw, source) {
  const rawSegments = Array.isArray(raw?.segments) ? raw.segments : [];
  if (rawSegments.length === 0 && raw?.text) {
    return [{
      speaker: "Speaker",
      start: 0,
      end: 0,
      text: normalizeText(raw.text),
      source,
    }];
  }

  return rawSegments
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

function renderMarkdown(modelName, source, segments) {
  const lines = [
    "# MLX Whisper Transcription",
    "",
    `- Model: \`${modelName}\``,
    "- Engine: `mlx-whisper`",
    `- Source: \`${source}\``,
    "",
    "## Segments",
    "",
  ];

  for (const segment of segments) {
    lines.push(`**[${formatTime(segment.start)}-${formatTime(segment.end)}]** ${segment.text}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderSrt(segments) {
  return segments
    .map((segment, index) => [
      String(index + 1),
      `${formatSubtitleTime(segment.start, ",")} --> ${formatSubtitleTime(segment.end, ",")}`,
      segment.text,
      "",
    ].join("\n"))
    .join("\n");
}

function renderVtt(segments) {
  return "WEBVTT\n\n" + segments
    .map((segment) => [
      `${formatSubtitleTime(segment.start, ".")} --> ${formatSubtitleTime(segment.end, ".")}`,
      segment.text,
      "",
    ].join("\n"))
    .join("\n");
}

function detectQualityWarnings(segments) {
  const warnings = [];
  let previousText = "";
  let repeatCount = 0;
  let maxRepeatCount = 0;

  for (const segment of segments) {
    if (segment.text === previousText) {
      repeatCount += 1;
    } else {
      repeatCount = 1;
      previousText = segment.text;
    }
    maxRepeatCount = Math.max(maxRepeatCount, repeatCount);
  }

  if (maxRepeatCount >= 5) {
    warnings.push(`adjacent_repeat_loop:${maxRepeatCount}`);
  }
  return warnings;
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

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  return defaultValue;
}

function modelSlug(value) {
  return String(value)
    .replace(/^mlx-community\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatSubtitleTime(seconds, separator) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hh = String(Math.floor(totalMs / 3600000)).padStart(2, "0");
  const mm = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, "0");
  const ss = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, "0");
  const ms = String(totalMs % 1000).padStart(3, "0");
  return `${hh}:${mm}:${ss}${separator}${ms}`;
}
