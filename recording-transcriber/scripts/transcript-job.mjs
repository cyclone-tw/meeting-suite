#!/usr/bin/env node
// Remote transcript job runner. Runs on the host
// that does the ASR (Mac mini) and is driven over short ssh calls by
// scripts/transcribe-remote.mjs on the MacBook:
//
//   ping                                   host readiness + tool fingerprint
//   start <job> --url <youtube> | --icloud <relpath> [--language L] [--keep-media]
//                                          create the job dir, run it detached
//   prepare <job>                          create an empty subtitle job; the MacBook
//                                          then rsyncs the video into <job>/input/
//   subtitle <job> --input <name> [--privacy P] [--engine soniox|whisper] [--proofreader claude|codex|…] [--burn] [--terms a,b]
//                                          run scripts/subtitle-run.mjs detached (#825)
//   status <job>                           print status.json
//   pack <job>                             tar of harvestable files on stdout
//   finish <job>                           delete the whole job dir, verified
//   gc [--hours N]                         delete abandoned job dirs
//
// Long ssh sessions to the mini drop, so `start` returns at once and the work
// continues in a detached child; the caller polls `status`.
//
// Transcript jobs take YouTube URLs or files the user dropped in the iCloud
// inbox; for iCloud files the engine is mlx (local, no cloud fallback).
//
// Subtitle jobs: the video arrives over tailnet
// (rsync into the job dir) and the input is deleted when the run ends to free
// disk; `finish` then removes the whole job dir. --privacy only marks content
// as containing personal data, which keeps it away from proofreaders that may
// route to a mainland-China cloud model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isYouTubeUrl } from "./download-yt.mjs";
import { icloudInboxDir, normalizeLanguage, runtimeIdentity } from "../lib/asr-profile.mjs";
import { parseLastJson } from "../lib/json-tail.mjs";
import { checkProofreader } from "../lib/proofreaders.mjs";

const SELF = fileURLToPath(import.meta.url);
const TOOL_ROOT = path.resolve(path.dirname(SELF), "..");
const CLI = path.join(TOOL_ROOT, "scripts", "transcript-cli.mjs");
const JOB_MARKER = ".cyclone-transcript-job.json";
const JOB_FORMAT = "cyclone-transcript-job-v1";
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,80}$/;
const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg",
]);
const HARVEST = ["manifest.json", "cleanup-receipt.json", "transcripts", "outputs"];
const SUBTITLE_RUN = process.env.CYCLONE_SUBTITLE_RUN_SCRIPT || path.join(TOOL_ROOT, "scripts", "subtitle-run.mjs");
const SAFE_INPUT = /^source\.[a-z0-9]{2,5}$/;

// sshd hands non-interactive sessions a minimal PATH; mlx_whisper lives in
// ~/.local/bin and ffmpeg / yt-dlp / node in the Homebrew prefix.
process.env.PATH = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin",
].join(":");

export function jobsRoot() {
  return process.env.CYCLONE_TRANSCRIPT_JOBS_ROOT
    || path.join(os.homedir(), ".local", "state", "cyclone-transcript-jobs");
}

export function icloudInbox() {
  return process.env.CYCLONE_TRANSCRIBE_ICLOUD_INBOX || icloudInboxDir("transcribe");
}

function out(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(message, code = 2) {
  out({ ok: false, error: message });
  process.exit(code);
}

function jobDir(id) {
  if (!JOB_ID.test(id || "")) fail("invalid job id");
  return path.join(jobsRoot(), id);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeStatus(dir, patch) {
  const file = path.join(dir, "status.json");
  const current = fs.existsSync(file) ? readJson(file) : {};
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return next;
}

function assertOwnedJob(dir) {
  const marker = path.join(dir, JOB_MARKER);
  if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink()) {
    fail("not a tool-owned transcript job");
  }
  if (readJson(marker).format !== JOB_FORMAT) fail("job marker mismatch");
}

// Resolve a path the caller gave relative to the iCloud inbox, refusing
// anything that escapes it (../, absolute paths, symlinks pointing out).
export function resolveInboxFile(rel) {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error("iCloud path must be relative to the inbox");
  }
  if (!icloudInbox()) throw new Error("no iCloud inbox on this host (set icloud_inbox in the user profile)");
  const inbox = fs.realpathSync(icloudInbox());
  const candidate = path.join(inbox, rel);
  if (!fs.existsSync(candidate)) throw new Error("file not found in the iCloud inbox (not synced yet?)");
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(inbox + path.sep)) throw new Error("iCloud path escapes the inbox");
  if (!fs.statSync(real).isFile()) throw new Error("iCloud path is not a regular file");
  if (!MEDIA_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw new Error(`unsupported media type: ${path.extname(real) || "(none)"}`);
  }
  return real;
}

function isDataless(file) {
  const r = spawnSync("/usr/bin/stat", ["-f", "%Sf", file], { encoding: "utf8" });
  return r.status === 0 && /dataless/.test(r.stdout);
}

// iCloud files on the mini are often placeholders; pull the bytes down first.
function materialize(file) {
  if (!isDataless(file)) return;
  spawnSync("/usr/bin/brctl", ["download", file], { stdio: "ignore" });
  const deadline = Date.now() + Number(process.env.CYCLONE_ICLOUD_DOWNLOAD_TIMEOUT_SECONDS || 1800) * 1000;
  while (isDataless(file)) {
    if (Date.now() > deadline) throw new Error("iCloud download timed out (file still a placeholder)");
    spawnSync("/bin/sleep", ["2"]);
  }
}

function lastJson(text) {
  return parseLastJson(text);
}

// The mini's iCloud daemon can stall in "background" for hours (2026-10-05);
// report its state so the MacBook can warn before relying on the inbox.
export function icloudSyncStatus(rawOutput) {
  // Real brctl output wraps the state in ANSI colour codes ("\x1b[0;1;32mforeground").
  const raw = String(rawOutput || "").replace(/\x1b\[[0-9;]*m/g, "");
  const state = (raw.match(/\b(foreground|background)\b/) || [])[1] || "unknown";
  const stamp = (raw.match(/last-sync:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || "";
  const ageHours = stamp ? (Date.now() - new Date(stamp.replace(" ", "T")).getTime()) / 3600000 : null;
  return {
    icloud_state: state,
    icloud_last_sync: stamp,
    icloud_last_sync_age_hours: ageHours === null || Number.isNaN(ageHours) ? null : Math.round(ageHours * 10) / 10,
  };
}

function firstError(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|failed/i.test(l)) || lines[lines.length - 1] || "unknown failure";
}

// --- commands ---

async function cmdPing() {
  const which = (bin) => spawnSync("/usr/bin/which", [bin], { encoding: "utf8" }).stdout.trim();
  const ytdlp = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  const { ffmpegFull } = await import("./subtitle-run.mjs");
  const { hasSonioxKey } = await import("../lib/soniox-async.mjs");
  const { claudeBin } = await import("../lib/claude-stream.mjs");
  out({
    ok: true,
    ffmpeg_full: Boolean(ffmpegFull()),
    soniox_key: hasSonioxKey(),
    claude: fs.existsSync(claudeBin()),
    ...runtimeIdentity(),
    node: process.version,
    mlx_whisper: which("mlx_whisper") ? true : false,
    ffmpeg: which("ffmpeg") ? true : false,
    yt_dlp: ytdlp.status === 0 ? ytdlp.stdout.trim() : "",
    icloud_inbox: fs.existsSync(icloudInbox()),
    ...icloudSyncStatus(
      process.env.CYCLONE_TEST_BRCTL_STATUS
        ?? spawnSync("/usr/bin/brctl", ["status", "com.apple.CloudDocs"], { encoding: "utf8" }).stdout ?? "",
    ),
  });
}

function cmdStart(id, args) {
  const dir = jobDir(id);
  const request = { url: "", icloud: "", language: "", keep_media: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") request.url = args[++i] || "";
    else if (a === "--icloud") request.icloud = args[++i] || "";
    else if (a === "--language") request.language = args[++i] || "";
    else if (a === "--keep-media") request.keep_media = true;
    else fail(`unknown option: ${a}`);
  }
  if (Boolean(request.url) === Boolean(request.icloud)) fail("give exactly one of --url or --icloud");
  if (request.url && !isYouTubeUrl(request.url)) fail("only YouTube URLs are accepted");
  try {
    normalizeLanguage(request.language || "auto");
    if (request.icloud) resolveInboxFile(request.icloud);
  } catch (error) {
    fail(String(error.message || error));
  }
  fs.mkdirSync(jobsRoot(), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    fail("job already exists");
  }
  fs.writeFileSync(path.join(dir, JOB_MARKER),
    JSON.stringify({ format: JOB_FORMAT, job_id: id, created_at: new Date().toISOString() }) + "\n");
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(request, null, 2) + "\n");
  writeStatus(dir, { job_id: id, state: "queued", host: runtimeIdentity().host });
  const log = fs.openSync(path.join(dir, "run.log"), "a");
  const child = spawn(process.execPath, [SELF, "run", id], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  out({ ok: true, job_id: id, state: "queued" });
}

function newJobDir(id) {
  const dir = jobDir(id);
  fs.mkdirSync(jobsRoot(), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    fail("job already exists");
  }
  fs.writeFileSync(path.join(dir, JOB_MARKER),
    JSON.stringify({ format: JOB_FORMAT, job_id: id, created_at: new Date().toISOString() }) + "\n");
  return dir;
}

function cmdPrepare(id) {
  const dir = newJobDir(id);
  fs.mkdirSync(path.join(dir, "input"), { mode: 0o700 });
  writeStatus(dir, { job_id: id, state: "prepared", kind: "subtitle", host: runtimeIdentity().host });
  out({ ok: true, job_id: id, state: "prepared", input_dir: path.join(dir, "input") });
}

function subtitleRequest(args) {
  const request = { kind: "subtitle", input: "", privacy: "public", engine: "soniox", proofreader: "claude", burn: false, terms: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--input") request.input = args[++i] || "";
    else if (a === "--privacy") request.privacy = args[++i] || "";
    else if (a === "--engine") request.engine = args[++i] || "";
    else if (a === "--burn") request.burn = true;
    else if (a === "--size") request.size = args[++i] || "";
    else if (a === "--style") request.style = args[++i] || "";
    else if (a === "--terms") request.terms = args[++i] || "";
    else if (a === "--proofreader") request.proofreader = args[++i] || "";
    else throw new Error(`unknown option: ${a}`);
  }
  if (!SAFE_INPUT.test(request.input)) throw new Error("input must be source.<ext> inside the job's input dir");
  if (!MEDIA_EXTENSIONS.has(path.extname(request.input))) throw new Error("unsupported media type");
  if (!["public", "sensitive", "student-private"].includes(request.privacy)) throw new Error("invalid privacy class");
  if (!["soniox", "whisper"].includes(request.engine)) throw new Error("invalid engine");
  if (request.size !== undefined && !["small", "medium", "large"].includes(request.size)) throw new Error("invalid subtitle size");
  if (request.style !== undefined && !["box", "outline"].includes(request.style)) throw new Error("invalid subtitle style");
  checkProofreader(request.proofreader, request.privacy);
  return request;
}

function cmdSubtitle(id, args) {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) fail("job not prepared");
  assertOwnedJob(dir);
  const status = readJson(path.join(dir, "status.json"));
  if (status.state !== "prepared") fail(`job is ${status.state}, not prepared`);
  let request;
  try {
    request = subtitleRequest(args);
  } catch (error) {
    fail(String(error.message || error));
  }
  const input = path.join(dir, "input", request.input);
  if (!fs.existsSync(input) || !fs.lstatSync(input).isFile()) fail("input file has not been uploaded");
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(request, null, 2) + "\n");
  writeStatus(dir, { state: "queued" });
  const log = fs.openSync(path.join(dir, "run.log"), "a");
  const child = spawn(process.execPath, [SELF, "run", id], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  out({ ok: true, job_id: id, state: "queued" });
}

function runSubtitleJob(dir, request) {
  const input = path.join(dir, "input", request.input);
  try {
    writeStatus(dir, { state: "running", step: "subtitle", started_at: new Date().toISOString() });
    const req = subtitleRequest(["--input", request.input, "--privacy", request.privacy, "--engine", request.engine, "--proofreader", request.proofreader || "claude",
      ...(request.burn ? ["--burn"] : []), ...(request.size ? ["--size", request.size] : []), ...(request.style ? ["--style", request.style] : []), ...(request.terms ? ["--terms", request.terms] : [])]);
    const args = [SUBTITLE_RUN, input, "--out", path.join(dir, "outputs"), "--privacy", req.privacy, "--engine", req.engine, "--proofreader", req.proofreader];
    if (req.burn) args.push("--burn");
    if (req.size) args.push("--size", req.size);
    if (req.style) args.push("--style", req.style);
    if (req.terms) args.push("--terms", req.terms);
    const r = spawnSync(process.execPath, args, { cwd: TOOL_ROOT, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
    // 只留步驟與錯誤，不留字幕內容
    fs.writeFileSync(path.join(dir, "cli.log"), String(r.stderr || "").split("\n").filter((l) => l.startsWith("[")).join("\n"));
    const summary = lastJson(r.stdout || "");
    const media = removeInput(input);
    if (r.status !== 0 || !summary?.ok) {
      writeStatus(dir, { state: "failed", step: "subtitle", error: summary?.error || firstError(r.stderr), cleanup: media, finished_at: new Date().toISOString() });
      return;
    }
    const { ok, ...report } = summary;
    writeStatus(dir, { state: "succeeded", step: "done", report, cleanup: media, finished_at: new Date().toISOString() });
  } catch (error) {
    writeStatus(dir, { state: "failed", error: String(error?.message || error), cleanup: removeInput(input), finished_at: new Date().toISOString() });
  }
}

// 跑完就刪上傳的影片（釋放磁碟），回報刪了多少
function removeInput(file) {
  if (!fs.existsSync(file)) return { deleted: 0, bytes_deleted: 0, leftovers: 0 };
  const bytes = fs.statSync(file).size;
  fs.rmSync(file, { force: true });
  return { deleted: 1, bytes_deleted: bytes, leftovers: fs.existsSync(file) ? 1 : 0 };
}

function cmdRun(id) {
  const dir = jobDir(id);
  assertOwnedJob(dir);
  const request = readJson(path.join(dir, "request.json"));
  if (request.kind === "subtitle") return runSubtitleJob(dir, request);
  try {
    writeStatus(dir, { state: "running", step: "prepare", started_at: new Date().toISOString() });
  } catch (error) {
    if (!fs.existsSync(dir)) return; // job dir removed underneath us (gc / finish)
    throw error;
  }
  try {
    // Re-validate: request.json is data on disk, not something `start` vouches
    // for forever.
    if (Boolean(request.url) === Boolean(request.icloud)) throw new Error("request needs exactly one source");
    if (request.url && !isYouTubeUrl(request.url)) throw new Error("only YouTube URLs are accepted");
    normalizeLanguage(request.language || "auto");
    let source = request.url;
    let engine = "auto";
    if (request.icloud) {
      writeStatus(dir, { step: "icloud-download" });
      source = resolveInboxFile(request.icloud);
      materialize(source);
      engine = "mlx";
    }
    writeStatus(dir, { step: "transcribe" });
    // 交接單由 MacBook 收割後寫（#49），mini 不寫，免得同一份交兩次
    const args = [CLI, source, "--engine", engine, "--out", path.join(dir, "package"), "--no-handoff"];
    if (request.language) args.push("--language", request.language);
    if (request.keep_media) args.push("--keep-media");
    const r = spawnSync(process.execPath, args, { cwd: TOOL_ROOT, encoding: "utf8", env: process.env });
    fs.writeFileSync(path.join(dir, "cli.log"), `${r.stderr || ""}\n--- stdout ---\n${r.stdout || ""}`);
    const summary = lastJson(r.stdout || "");
    const cleanup = summary?.cleanup
      || (fs.existsSync(path.join(dir, "package", "cleanup-receipt.json"))
        ? receiptCounts(readJson(path.join(dir, "package", "cleanup-receipt.json")))
        : null);
    if (r.status !== 0 || !summary) {
      writeStatus(dir, {
        state: "failed",
        step: "transcribe",
        error: firstError(r.stderr),
        cleanup,
        finished_at: new Date().toISOString(),
      });
      return;
    }
    writeStatus(dir, {
      state: "succeeded",
      step: "done",
      engine: summary.engine,
      fallbacks: summary.fallbacks || [],
      cleanup,
      runtime: summary.runtime,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    writeStatus(dir, { state: "failed", error: String(error?.message || error), finished_at: new Date().toISOString() });
  }
}

function receiptCounts(receipt) {
  return {
    keep_media: receipt.keep_media,
    deleted: receipt.deleted.length,
    trashed: receipt.trashed.length,
    leftovers: receipt.leftovers.length,
    bytes_deleted: receipt.bytes_deleted,
    bytes_trashed: receipt.bytes_trashed,
  };
}

function cmdStatus(id) {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) return out({ ok: true, job_id: id, state: "missing" });
  assertOwnedJob(dir);
  const file = path.join(dir, "status.json");
  // `start` writes the marker before the first status; report that gap as queued.
  out(fs.existsSync(file) ? { ok: true, ...readJson(file) } : { ok: true, job_id: id, state: "queued" });
}

function cmdPack(id) {
  const dir = jobDir(id);
  assertOwnedJob(dir);
  const pkg = path.join(dir, "package");
  const entries = HARVEST.filter((name) => fs.existsSync(path.join(pkg, name)));
  if (!entries.includes("manifest.json")) {
    process.stderr.write("job has no package manifest\n");
    process.exit(3);
  }
  const r = spawnSync("/usr/bin/tar", ["-C", pkg, "-cf", "-", ...entries], { stdio: ["ignore", "inherit", "inherit"] });
  process.exit(r.status ?? 1);
}

function dirBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.lstatSync(abs);
    total += stat.isDirectory() ? dirBytes(abs) : stat.size;
  }
  return total;
}

function removeJob(dir) {
  const bytes = dirBytes(dir);
  fs.rmSync(dir, { recursive: true, force: false });
  return { removed: !fs.existsSync(dir), bytes };
}

function cmdFinish(id) {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) return out({ ok: true, job_id: id, removed: true, bytes: 0, already_gone: true });
  assertOwnedJob(dir);
  const status = fs.existsSync(path.join(dir, "status.json")) ? readJson(path.join(dir, "status.json")) : {};
  if (status.state === "running" || status.state === "queued") fail("job is still running");
  // prepared（傳到一半就中斷）也可以收
  const result = removeJob(dir);
  out({ ok: result.removed, job_id: id, ...result });
}

function cmdGc(args) {
  const hoursIndex = args.indexOf("--hours");
  const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : 48;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const removed = [];
  const root = jobsRoot();
  if (fs.existsSync(root)) {
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      if (!JOB_ID.test(id) || !fs.existsSync(path.join(dir, JOB_MARKER))) continue;
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      removed.push({ job_id: id, ...removeJob(dir) });
    }
  }
  out({ ok: true, removed });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "ping") return cmdPing();
  if (command === "start") return cmdStart(rest[0], rest.slice(1));
  if (command === "prepare") return cmdPrepare(rest[0]);
  if (command === "subtitle") return cmdSubtitle(rest[0], rest.slice(1));
  if (command === "run") return cmdRun(rest[0]);
  if (command === "status") return cmdStatus(rest[0]);
  if (command === "pack") return cmdPack(rest[0]);
  if (command === "finish") return cmdFinish(rest[0]);
  if (command === "gc") return cmdGc(rest);
  fail("usage: transcript-job.mjs ping|start|prepare|subtitle|status|pack|finish|gc");
}

if (path.resolve(process.argv[1] ?? "") === SELF) main();
