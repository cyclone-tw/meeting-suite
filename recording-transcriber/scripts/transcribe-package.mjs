import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveFfmpegCommand } from "../lib/local-tools.mjs";
import { resolveLanguage, runtimeIdentity } from "../lib/asr-profile.mjs";
import { postprocessSegments } from "./postprocess-text.mjs";
import { loadPackageForLocalTool } from "../lib/package-security.mjs";
import { makeRunTempDir } from "../lib/run-temp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const packagePathInput = process.argv.slice(2).find((arg) => arg !== "--");
if (!packagePathInput) {
  console.error("Usage: pnpm run transcribe -- /path/to/transcript-package");
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
const manifestPath = path.join(packagePath, "manifest.json");
const model = process.env.TRANSCRIBE_MODEL || "Xenova/whisper-small";
// "" = let Whisper detect the language instead of forcing Chinese.
let language;
try {
  language = resolveLanguage();
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(2);
}
const openccRequested = process.env.TRANSCRIBE_OPENCC !== "0";
const chunkLength = Number(process.env.TRANSCRIBE_CHUNK_SECONDS || "30");
const strideLength = Number(process.env.TRANSCRIBE_STRIDE_SECONDS || "5");

const inputAudio = resolvePackagePath(
  [
    manifest.audio?.extracted_mp3,
    manifest.audio?.drive_path,
    "audio/extracted.mp3",
  ],
  manifest,
);
if (!inputAudio || !existsSync(inputAudio)) {
  console.error("Missing extracted audio. Checked manifest audio path, drive_path, and audio/extracted.mp3.");
  process.exit(2);
}

const transformers = await import("@huggingface/transformers");
const wavefileModule = await import("wavefile");
const { env, pipeline } = transformers;
const wavefile = wavefileModule.default;
env.cacheDir = path.join(toolRoot, "models");
env.allowLocalModels = true;
env.allowRemoteModels = true;

const tmp = makeRunTempDir("cyclone-transcribe-");
const wavPath = path.join(tmp, "input.wav");

try {
  const ffmpeg = resolveFfmpegCommand();
  if (!ffmpeg) throw new Error("Trusted local ffmpeg executable is unavailable.");
  run(ffmpeg, [
    "-y",
    "-i",
    inputAudio,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    wavPath,
  ]);

  const audioData = readWavAsFloat32(wavPath);
  const transcriber = await pipeline("automatic-speech-recognition", model);
  const result = await transcriber(audioData, {
    ...(language ? { language } : {}),
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: chunkLength,
    stride_length_s: strideLength,
  });

  const sourceLabel = inputAudio;
  const rawSegments = toSegments(result, sourceLabel);
  // Same post-processing as the MLX and Groq engines.
  const segments = openccRequested
    ? await postprocessSegments(rawSegments, manifest, { language })
    : rawSegments;
  const postprocessApplied = segments.some((segment, index) => segment.text !== rawSegments[index].text);
  const transcripts = normalizeTranscriptPaths(manifest);
  writeFileSync(
    transcripts.segments_json,
    JSON.stringify({ segments }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(transcripts.raw_md, renderMarkdown("Raw Transcript", segments, false), "utf8");
  writeFileSync(
    transcripts.cleaned_md,
    renderMarkdown("Cleaned Transcript", segments, true),
    "utf8",
  );

  manifest.transcription = {
    engine: "transformers.js",
    package_manager: "pnpm",
    model,
    language: language || "auto",
    postprocess_opencc_requested: openccRequested,
    postprocess_opencc_applied: postprocessApplied,
    runtime: runtimeIdentity(),
    chunk_length_s: chunkLength,
    stride_length_s: strideLength,
    cache_dir: path.relative(toolRoot, env.cacheDir),
  };
  manifest.transcripts.segment_count = segments.length;
  manifest.updated_at = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(transcripts.segments_json);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function normalizeTranscriptPaths(manifestData) {
  const transcripts = manifestData.transcripts || {};
  const normalized = {
    segments_json: resolveWritablePackagePath(transcripts.segments_json, manifestData, "transcripts/segments.json"),
    raw_md: resolveWritablePackagePath(transcripts.raw_md, manifestData, "transcripts/raw.md"),
    cleaned_md: resolveWritablePackagePath(transcripts.cleaned_md, manifestData, "transcripts/cleaned.md"),
  };

  for (const output of Object.values(normalized)) {
    mkdirSync(path.dirname(output), { recursive: true });
  }

  return normalized;
}

function resolvePackagePath(values, manifestData) {
  for (const value of values.filter(Boolean)) {
    const direct = resolveCandidatePath(value);
    if (direct && existsSync(direct)) return direct;

    const portable = resolvePortablePackagePath(value, manifestData);
    if (portable && existsSync(portable)) return portable;
  }

  return "";
}

function resolveWritablePackagePath(value, manifestData, fallback) {
  if (!value) return path.join(packagePath, fallback);

  const portable = resolvePortablePackagePath(value, manifestData);
  if (portable) return portable;

  return path.isAbsolute(value) ? value : path.join(packagePath, value);
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

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function readWavAsFloat32(filePath) {
  const wav = new wavefile.WaveFile(readFileSync(filePath));
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples;
}

function toSegments(result, source) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (chunks.length === 0) {
    return [
      {
        speaker: "Speaker",
        start: 0,
        end: 0,
        text: normalize(result?.text || ""),
        source,
      },
    ].filter((segment) => segment.text);
  }

  return chunks
    .map((chunk) => {
      const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, 0];
      return {
        speaker: "Speaker",
        start: roundSeconds(start || 0),
        end: roundSeconds(end || start || 0),
        text: normalize(chunk.text || ""),
        source,
      };
    })
    .filter((segment) => segment.text);
}

function renderMarkdown(title, segments, cleaned) {
  const lines = [`# ${title}`, "", "## Speaker", ""];
  for (const segment of segments) {
    const text = cleaned ? normalize(segment.text) : segment.text;
    lines.push(`**[${formatTime(segment.start)}-${formatTime(segment.end)}]** ${text}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function normalize(text) {
  return String(text).trim().replace(/\s+/g, " ");
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
