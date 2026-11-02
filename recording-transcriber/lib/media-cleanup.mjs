import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Default media retention: downloaded video/audio,
// copied originals and extracted audio are removed when a run ends — success,
// failure or interrupt — unless the caller passes --keep-media. Transcripts,
// subtitles, captions text and the manifest always stay.
//
// Safety rules:
// - Only <package>/source and <package>/audio are scanned, never anything else
//   (model caches live outside the package and can never match).
// - Only entries that did not exist when the run started are touched, so a
//   re-run on an existing package never removes files someone put there.
// - Symlinks are unlinked, never followed.
// - Hard delete first, verified; `trash` only when the delete fails, and the
//   receipt says so, because trashed files still use disk. Callers may pass
//   allowTrash=false to report a leftover instead of moving it to the Trash.

export const CLEANUP_RECEIPT = "cleanup-receipt.json";
const MEDIA_DIRS = ["source", "audio"];
const KEEP_EXTENSIONS = new Set([".vtt", ".srt", ".json", ".txt", ".md"]);
// Test-only hooks (never set them in real runs): TRANSCRIPT_CLEANUP_TRASH_COMMAND
// points the trash fallback at a fake so synthetic files never land in the
// real Trash; TRANSCRIPT_CLEANUP_TEST_FAIL_DELETE=1 simulates a failed delete.
const TRASH_COMMAND = process.env.TRANSCRIPT_CLEANUP_TRASH_COMMAND || "/usr/bin/trash";

export function snapshotMedia(packageRoot) {
  return new Set(listMediaEntries(packageRoot));
}

export function cleanupRunMedia(packageRoot, preExisting, { keepMedia = false, allowTrash = true } = {}) {
  const receipt = {
    keep_media: Boolean(keepMedia),
    deleted: [],
    trashed: [],
    kept: [],
    leftovers: [],
    bytes_deleted: 0,
    bytes_trashed: 0,
    finished_at: "",
  };
  for (const rel of listMediaEntries(packageRoot)) {
    if (preExisting.has(rel)) continue;
    if (KEEP_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(packageRoot, rel);
    const bytes = sizeOf(abs);
    if (keepMedia) {
      receipt.kept.push(rel);
      continue;
    }
    if (hardDelete(abs)) {
      receipt.deleted.push(rel);
      receipt.bytes_deleted += bytes;
    } else if (allowTrash && moveToTrash(abs)) {
      receipt.trashed.push(rel);
      receipt.bytes_trashed += bytes;
    } else {
      receipt.leftovers.push(rel);
    }
  }
  if (!keepMedia) removeEmptyDir(path.join(packageRoot, "audio"));
  receipt.finished_at = new Date().toISOString();
  return receipt;
}

export function writeCleanupReceipt(packageRoot, receipt) {
  const file = path.join(packageRoot, CLEANUP_RECEIPT);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return file;
}

export function summarizeCleanup(receipt) {
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  if (receipt.keep_media) {
    return `[cleanup] --keep-media: kept ${receipt.kept.length} media file(s), nothing removed`;
  }
  const parts = [`deleted ${receipt.deleted.length} file(s) (${mb(receipt.bytes_deleted)} MB)`];
  if (receipt.trashed.length) {
    parts.push(`trashed ${receipt.trashed.length} file(s) (${mb(receipt.bytes_trashed)} MB, still on disk until Trash is emptied)`);
  }
  parts.push(receipt.leftovers.length ? `LEFTOVERS ${receipt.leftovers.length}` : "no leftovers");
  return `[cleanup] ${parts.join("; ")}`;
}

function listMediaEntries(packageRoot) {
  const entries = [];
  for (const dir of MEDIA_DIRS) {
    const abs = path.join(packageRoot, dir);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walk(abs, dir, entries);
  }
  return entries.sort();
}

// Tolerates entries vanishing mid-walk: cleanup runs in a finally block and
// must never replace the run's own error with a race on a temp file.
function walk(absDir, relDir, out) {
  let names = [];
  try {
    names = fs.readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(absDir, name);
    const rel = path.join(relDir, name);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
}

function sizeOf(abs) {
  try {
    const stat = fs.lstatSync(abs);
    return stat.isSymbolicLink() ? 0 : stat.size;
  } catch {
    return 0;
  }
}

function exists(abs) {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function hardDelete(abs) {
  if (process.env.TRANSCRIPT_CLEANUP_TEST_FAIL_DELETE === "1") return false;
  try {
    fs.rmSync(abs, { force: false });
  } catch {
    return false;
  }
  return !exists(abs);
}

function moveToTrash(abs) {
  if (!fs.existsSync(TRASH_COMMAND)) return false;
  const result = spawnSync(TRASH_COMMAND, [abs], { stdio: "ignore" });
  return result.status === 0 && !exists(abs);
}

function removeEmptyDir(abs) {
  try {
    if (fs.lstatSync(abs).isDirectory() && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  } catch {
    // missing or not empty: nothing to do
  }
}
