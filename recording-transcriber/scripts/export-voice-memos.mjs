#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAsrProfile } from "../lib/asr-profile.mjs";

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".caf", ".aiff", ".aif"]);
const DEFAULT_MAX_DEPTH = 8;

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  const opts = {
    sourceDirs: [],
    out: "",
    date: "",
    since: "",
    until: "",
    today: false,
    all: false,
    last: 0,
    slug: "voice-memo",
    list: false,
    dryRun: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    open: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source-dir") opts.sourceDirs.push(readFlagValue(args, ++index, arg));
    else if (arg.startsWith("--source-dir=")) opts.sourceDirs.push(arg.slice(13));
    else if (arg === "--out") opts.out = readFlagValue(args, ++index, arg);
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--date") opts.date = readFlagValue(args, ++index, arg);
    else if (arg.startsWith("--date=")) opts.date = arg.slice(7);
    else if (arg === "--since") opts.since = readFlagValue(args, ++index, arg);
    else if (arg.startsWith("--since=")) opts.since = arg.slice(8);
    else if (arg === "--until") opts.until = readFlagValue(args, ++index, arg);
    else if (arg.startsWith("--until=")) opts.until = arg.slice(8);
    else if (arg === "--today") opts.today = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--last") opts.last = Number(readFlagValue(args, ++index, arg));
    else if (arg.startsWith("--last=")) opts.last = Number(arg.slice(7));
    else if (arg === "--slug") opts.slug = readFlagValue(args, ++index, arg) || opts.slug;
    else if (arg.startsWith("--slug=")) opts.slug = arg.slice(7);
    else if (arg === "--list") opts.list = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--max-depth") opts.maxDepth = Number(readFlagValue(args, ++index, arg));
    else if (arg.startsWith("--max-depth=")) opts.maxDepth = Number(arg.slice(12));
    else if (arg === "--open") opts.open = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.all && !opts.date && !opts.since && !opts.until && !opts.last) {
    opts.today = true;
  }
  if (opts.date) {
    opts.since = opts.date;
    opts.until = opts.date;
  }
  opts.slug = slugify(opts.slug) || "voice-memo";
  validateOptions(opts);
  return opts;
}

function readFlagValue(args, index, flag) {
  if (index >= args.length || String(args[index]).startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return args[index];
}

function validateOptions(opts) {
  for (const [name, value] of [["--date", opts.date], ["--since", opts.since], ["--until", opts.until]]) {
    if (value) validateDateText(value, name);
  }

  if (opts.all && (opts.today || opts.date || opts.since || opts.until)) {
    throw new Error("--all cannot be combined with --today, --date, --since, or --until.");
  }
  if (opts.today && (opts.date || opts.since || opts.until)) {
    throw new Error("--today cannot be combined with --date, --since, or --until.");
  }
  if (opts.date && (opts.since || opts.until)) {
    throw new Error("--date cannot be combined with --since or --until.");
  }
  if (opts.since && opts.until && dayStart(opts.since) > dayStart(opts.until)) {
    throw new Error("--since must be earlier than or equal to --until.");
  }

  if (!Number.isInteger(opts.last) || opts.last < 0) {
    throw new Error("--last must be a non-negative integer.");
  }
  if (!Number.isInteger(opts.maxDepth) || opts.maxDepth < 0) {
    throw new Error("--max-depth must be a non-negative integer.");
  }
}

function validateDateText(value, flag) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid ${flag}: ${value}. Expected YYYY-MM-DD.`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid ${flag}: ${value}. Date does not exist.`);
  }
}

function usage() {
  console.error(`Usage: pnpm run export:voice-memos -- [options]

Copies macOS Voice Memos audio into an agent-ready folder and writes manifest.json.
The original Voice Memos files are never deleted or modified.

Options:
  --today                         export files modified today (default)
  --date YYYY-MM-DD               export one local date
  --since YYYY-MM-DD              export files modified on/after date
  --until YYYY-MM-DD              export files modified on/before date
  --last N                        export the most recent N files after date filters
  --all                           ignore date filters
  --source-dir <path>             add a source directory; may be repeated
  --out <dir>                     output folder (default: ~/<voice_memo_dir or voice-memo-exports>/<timestamp>--<slug>)
  --slug <text>                   neutral filename slug (default: voice-memo)
  --list                          list matching files only; do not copy
  --dry-run                       show what would be copied; do not copy
  --max-depth N                   recursive search depth for source dirs (default: ${DEFAULT_MAX_DEPTH})
  --open                          open output folder after export

Examples:
  pnpm run export:voice-memos -- --today --slug sld-workshop
  pnpm run export:voice-memos -- --date 2026-07-09
  pnpm run export:voice-memos -- --source-dir ~/Desktop/memos --all --out /tmp/memo-export`);
}

function defaultSourceDirs() {
  const home = os.homedir();
  return [
    "~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings",
    "~/Library/Group Containers/group.com.apple.VoiceMemos.shared",
    "~/Library/Containers/com.apple.VoiceMemos/Data/Library/Application Support/com.apple.voicememos/Recordings",
    "~/Library/Containers/com.apple.VoiceMemos/Data/Library/Application Support/com.apple.VoiceMemos/Recordings",
    "~/Library/Containers/com.apple.VoiceMemos/Data/Documents/Recordings",
    "~/Library/Application Support/com.apple.voicememos/Recordings",
    "~/Library/Application Support/com.apple.VoiceMemos/Recordings",
    "~/Library/Mobile Documents/com~apple~VoiceMemos/Documents",
  ].map((item) => expandPath(item, home));
}

function expandPath(value, home = os.homedir()) {
  if (!value) return "";
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.resolve(value);
}

function dateStamp(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function compactTimestamp(date = new Date()) {
  return `${dateStamp(date)}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}

function dayStart(dateText) {
  validateDateText(dateText, "date");
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function dayEnd(dateText) {
  const date = dayStart(dateText);
  date.setDate(date.getDate() + 1);
  return date;
}

function filterWindow(opts) {
  if (opts.all) return { since: null, until: null };
  if (opts.today) {
    const today = dateStamp();
    return { since: dayStart(today), until: dayEnd(today) };
  }
  return {
    since: opts.since ? dayStart(opts.since) : null,
    until: opts.until ? dayEnd(opts.until) : null,
  };
}

function discoverAudioFiles(sourceDirs, maxDepth) {
  const files = [];
  const seen = new Set();
  const checkedDirs = [];

  for (const dir of sourceDirs) {
    checkedDirs.push(dir);
    if (!dir || !fs.existsSync(dir)) continue;
    const stat = safeStat(dir);
    if (!stat?.isDirectory()) continue;
    walk(dir, 0, maxDepth, (filePath, fileStat) => {
      const ext = path.extname(filePath).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) return;
      const real = fs.realpathSync.native(filePath);
      if (seen.has(real)) return;
      seen.add(real);
      files.push({ sourcePath: filePath, stat: fileStat });
    });
  }

  return { files, checkedDirs };
}

function walk(dir, depth, maxDepth, onFile) {
  if (depth > maxDepth) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1, maxDepth, onFile);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = safeStat(fullPath);
    if (stat) onFile(fullPath, stat);
  }
}

function safeStat(value) {
  try {
    return fs.statSync(value);
  } catch {
    return null;
  }
}

function applyFilters(files, opts) {
  const { since, until } = filterWindow(opts);
  let result = files.filter((item) => {
    const mtime = item.stat.mtime;
    if (since && mtime < since) return false;
    if (until && mtime >= until) return false;
    return true;
  });

  result = result.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.sourcePath.localeCompare(b.sourcePath));
  if (opts.last > 0) {
    result = result.slice(-opts.last);
  }
  return result;
}

function defaultOutDir(opts) {
  const rel = loadAsrProfile().profile.voice_memo_dir;
  const base = typeof rel === "string" && rel.trim() ? path.resolve(os.homedir(), rel.trim()) : path.join(os.homedir(), "voice-memo-exports");
  return path.join(base, `${compactTimestamp()}--${opts.slug}`);
}

function exportFiles(matches, opts, outDir) {
  const sourceDir = path.join(outDir, "source");
  if (!opts.list && !opts.dryRun) {
    fs.mkdirSync(sourceDir, { recursive: true });
  }

  return matches.map((item, index) => {
    const recId = `rec${String(index + 1).padStart(3, "0")}`;
    const mtime = item.stat.mtime;
    const ext = path.extname(item.sourcePath).toLowerCase() || ".m4a";
    const targetName = `${dateStamp(mtime)}-${String(mtime.getHours()).padStart(2, "0")}${String(mtime.getMinutes()).padStart(2, "0")}${String(mtime.getSeconds()).padStart(2, "0")}--${opts.slug}--${recId}${ext}`;
    const targetPath = path.join(sourceDir, targetName);
    const durationSeconds = getDurationSeconds(item.sourcePath);

    if (!opts.list && !opts.dryRun) {
      fs.copyFileSync(item.sourcePath, targetPath, fs.constants.COPYFILE_FICLONE);
      fs.utimesSync(targetPath, item.stat.atime, item.stat.mtime);
    }

    return {
      id: recId,
      original_name: path.basename(item.sourcePath),
      source_path: item.sourcePath,
      exported_path: path.relative(outDir, targetPath),
      exported_absolute_path: targetPath,
      mtime: item.stat.mtime.toISOString(),
      size_bytes: item.stat.size,
      duration_seconds: durationSeconds,
      sha256: opts.list || opts.dryRun ? null : sha256(targetPath),
    };
  });
}

function getDurationSeconds(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeManifest(outDir, opts, checkedDirs, recordings) {
  const manifest = {
    package_id: path.basename(outDir),
    kind: "voice-memos-export",
    generated_at: new Date().toISOString(),
    source: "macOS Voice Memos local files",
    filters: {
      today: opts.today,
      all: opts.all,
      date: opts.date || null,
      since: opts.since || null,
      until: opts.until || null,
      last: opts.last || null,
      slug: opts.slug,
    },
    checked_source_dirs: checkedDirs,
    exported_count: recordings.length,
    recordings: recordings.map((item) => ({
      id: item.id,
      original_name: item.original_name,
      source_path: item.source_path,
      exported_path: item.exported_path,
      mtime: item.mtime,
      size_bytes: item.size_bytes,
      duration_seconds: item.duration_seconds,
      sha256: item.sha256,
    })),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function writeReadme(outDir, opts, recordings) {
  const lines = [
    "# Voice Memos Export",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Exported recordings: ${recordings.length}`,
    "",
    "## Files",
    "",
  ];

  for (const item of recordings) {
    lines.push(`- \`${item.exported_path}\` (${item.duration_seconds ?? "unknown"}s, ${item.size_bytes} bytes)`);
  }

  lines.push(
    "",
    "## Next Step",
    "",
    `Run transcription from \`${TOOL_DIR}\`:`,
    "",
    "```bash",
    `cd ${TOOL_DIR}`,
  );
  for (const item of recordings) {
    lines.push(`pnpm run transcript -- "${path.join(outDir, item.exported_path)}" --engine mlx`);
  }
  lines.push("```", "");

  fs.writeFileSync(path.join(outDir, "README.md"), lines.join("\n"), "utf8");
}

function printList(recordings, outDir, opts) {
  const mode = opts.list ? "list" : opts.dryRun ? "dry-run" : "export";
  console.log(JSON.stringify({
    mode,
    outDir: opts.list ? null : outDir,
    count: recordings.length,
    recordings: recordings.map((item) => ({
      id: item.id,
      original_name: item.original_name,
      source_path: item.source_path,
      exported_path: opts.list ? null : item.exported_path,
      mtime: item.mtime,
      size_bytes: item.size_bytes,
      duration_seconds: item.duration_seconds,
    })),
  }, null, 2));
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function main() {
  const opts = parseArgs(process.argv);
  const sourceDirs = opts.sourceDirs.length
    ? opts.sourceDirs.map((item) => expandPath(item))
    : defaultSourceDirs();
  const { files, checkedDirs } = discoverAudioFiles(sourceDirs, opts.maxDepth);
  const matches = applyFilters(files, opts);
  const outDir = expandPath(opts.out || defaultOutDir(opts));
  const recordings = exportFiles(matches, opts, outDir);

  if (!opts.list && !opts.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    writeManifest(outDir, opts, checkedDirs, recordings);
    writeReadme(outDir, opts, recordings);
  }

  printList(recordings, outDir, opts);

  if (matches.length === 0) {
    console.error("No matching Voice Memos audio found.");
    console.error("Checked source dirs:");
    for (const dir of checkedDirs) console.error(`- ${dir}`);
    console.error("Use --source-dir <path> if Voice Memos exports are in another folder.");
    process.exitCode = 1;
  } else if (opts.open && !opts.list && !opts.dryRun) {
    spawnSync("open", [outDir], { stdio: "ignore" });
  }
}

try {
  main();
} catch (error) {
  if (process.env.DEBUG && error?.stack) {
    console.error(error.stack);
  } else {
    console.error(`Error: ${error?.message || error}`);
  }
  process.exit(1);
}
