#!/usr/bin/env node
// Archive a finished transcript package to Google Drive or iCloud Drive, then
// remove the local copy. The destinations come from the user profile:
//   "archive": { "drive_mount": "<Google Drive folder, relative to home>",
//                "drive_prefix": "<folder under it>/", "icloud_prefix": "<folder under iCloud Drive>/" }
//
//   pnpm run archive <package-dir> --dest <drive_prefix>YYYY/MM/YYYY-MM-DD--slug--rec001
//   pnpm run archive <package-dir> --dest <icloud_prefix>YYYY/MM/YYYY-MM-DD--slug--rec001 [--include-media]
//
// Drive keeps every file, media included. The
// iCloud zone keeps text results only (transcripts, subtitles, summaries,
// manifest, receipts) unless --include-media: YouTube audio can be downloaded
// again and a local recording's original stays where it was. Skipped media is
// deleted with the local package and counted in the receipt.
//
// Order of operations, so nothing is lost:
//   1. validate package, storage root and destination (new or empty)
//   2. record the archive path / asset_package in the manifest
//   3. copy every archived file
//   4. verify every copy: same size and same sha256 as the local file
//   5. only then delete the local package and confirm it is gone
// Any failure before step 5 keeps the local package intact and removes the
// partial folder this run created.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadAsrProfile, runtimeIdentity } from "../lib/asr-profile.mjs";
import { icloudRoot } from "../lib/paths.mjs";

// Held for the whole run so nothing can add files between listing and deleting.
const PACKAGE_LOCK = ".cyclone-transcript.lock";

function acquirePackageLock(root) {
  const lockPath = path.join(root, PACKAGE_LOCK);
  fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  return lockPath;
}

function releasePackageLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone together with the deleted package.
  }
}

const PACKAGE_NAME = /^\d{4}-\d{2}-\d{2}--[a-z0-9][a-z0-9-]*--rec\d{3}$/;
export const ARCHIVE_RECEIPT = "archive-receipt.json";
// Audio／video and partial downloads. A denylist on purpose: the local package
// is deleted after the archive, so an unknown output (say a PDF in outputs/)
// must be archived rather than silently dropped.
const MEDIA_EXTENSIONS = new Set([
  ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".caf", ".aif", ".aiff",
  ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".part", ".ytdl",
]);

export function driveMount(profile = loadAsrProfile().profile) {
  if (process.env.CYCLONE_DRIVE_MOUNT) return process.env.CYCLONE_DRIVE_MOUNT;
  const mount = typeof profile.archive?.drive_mount === "string" ? profile.archive.drive_mount.trim() : "";
  if (!mount) return "";
  return path.isAbsolute(mount) ? mount : path.join(os.homedir(), mount);
}

export { icloudRoot };

const ROOT_KINDS = [
  {
    key: "drive_prefix",
    name: "Drive",
    storage: "google-drive",
    pathKey: "drive_path",
    display: (dest) => dest,
    mediaByDefault: true,
    base: () => driveMount(),
    missing: "Google Drive mount not found; is Google Drive for Desktop running?",
  },
  {
    key: "icloud_prefix",
    name: "iCloud",
    storage: "icloud-drive",
    pathKey: "icloud_path",
    display: (dest) => `iCloud Drive/${dest}`,
    mediaByDefault: false,
    datedFolders: true,
    base: icloudRoot,
    missing: "iCloud Drive folder not found; is iCloud Drive turned on?",
  },
];

const cleanPrefix = (value) => {
  const v = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
  return v && !v.split("/").some((part) => part === ".." || part === ".") ? `${v}/` : "";
};

export function archiveRoots(profile = loadAsrProfile().profile) {
  const archive = profile.archive || {};
  return ROOT_KINDS.map(({ key, ...kind }) => ({ ...kind, prefix: cleanPrefix(archive[key]) })).filter((root) => root.prefix);
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((a) => a !== "--");
  const opts = { pkg: "", dest: "", includeMedia: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dest") opts.dest = args[++i] || "";
    else if (args[i] === "--include-media") opts.includeMedia = true;
    else if (args[i].startsWith("--")) throw usageError(`unknown option: ${args[i]}`);
    else if (!opts.pkg) opts.pkg = args[i];
    else throw usageError("only one package is allowed");
  }
  if (!opts.pkg || !opts.dest) {
    throw usageError("usage: archive-package.mjs <package-dir> --dest <drive_prefix or icloud_prefix path> [--include-media]");
  }
  return opts;
}

export function validateDest(dest) {
  const clean = dest.replace(/\/+$/, "");
  const roots = archiveRoots();
  if (!roots.length) throw usageError("no archive destination: set archive.drive_prefix or archive.icloud_prefix in the user profile");
  const root = roots.find((candidate) => clean.startsWith(candidate.prefix));
  if (!root) {
    throw usageError(`destination must be under ${roots.map((candidate) => candidate.prefix).join(" or ")}`);
  }
  if (clean.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw usageError("destination must be a plain relative path");
  }
  const name = path.basename(clean);
  if (!PACKAGE_NAME.test(name)) {
    throw usageError("destination folder must look like YYYY-MM-DD--neutral-slug--rec001");
  }
  if (root.datedFolders && clean !== `${root.prefix}${name.slice(0, 4)}/${name.slice(5, 7)}/${name}`) {
    throw usageError(`destination must be ${root.prefix}YYYY/MM/YYYY-MM-DD--neutral-slug--rec001, with YYYY/MM matching the date`);
  }
  return { dest: clean, root };
}

function isMedia(rel) {
  return MEDIA_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error("package contains a symlink; refusing to archive");
      if (dir === root && name === PACKAGE_LOCK) continue;
      if (stat.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs));
    }
  };
  walk(root);
  return files;
}

function sha256(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function isInsideSyncedFolder(real) {
  return /\/Library\/(CloudStorage|Mobile Documents)\//.test(real);
}

export function archivePackage(pkgInput, destInput, { includeMedia: includeMediaFlag = false } = {}) {
  const { dest, root } = validateDest(destInput);
  const includeMedia = root.mediaByDefault || includeMediaFlag;
  const pkg = fs.realpathSync(path.resolve(pkgInput));
  if (!fs.statSync(pkg).isDirectory()) throw usageError("package is not a directory");
  if (isInsideSyncedFolder(pkg)) throw usageError("package is already inside a synced folder");
  const manifestFile = path.join(pkg, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw usageError("package has no manifest.json");
  if (fs.lstatSync(manifestFile).isSymbolicLink()) throw usageError("manifest.json is a symlink; refusing to archive");
  const originalManifest = fs.readFileSync(manifestFile, "utf8");
  const manifest = JSON.parse(originalManifest);
  const base = root.base();
  if (!base || !fs.existsSync(base)) {
    // Never create a local stand-in for a missing Drive／iCloud root: it would
    // look archived and then the local package would be deleted.
    throw usageError(root.missing);
  }
  const target = path.join(base, dest);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw usageError("destination already exists and is not empty; pick a new recNNN");
  }
  const createdTarget = !fs.existsSync(target);
  // Hold the package lock for the whole run, so nothing can add files between
  // listing and deleting (the lock goes away with the deleted package).
  let lock;
  try {
    lock = acquirePackageLock(pkg);
  } catch {
    throw usageError("package is in use (lock present)");
  }
  // Validate the whole tree (symlinks, readability) before mutating anything.
  let files;
  try {
    files = listFiles(pkg);
  } catch (error) {
    releasePackageLock(lock);
    throw usageError(error.message);
  }
  const skipped = includeMedia ? [] : files.filter(isMedia);
  files = files.filter((rel) => !skipped.includes(rel));
  const skippedBytes = skipped.reduce((sum, rel) => sum + fs.statSync(path.join(pkg, rel)).size, 0);

  manifest[root.pathKey] = dest;
  manifest.asset_package = {
    ...(manifest.asset_package || {}),
    storage: root.storage,
    [root.pathKey]: dest,
    package_manifest: "manifest.json",
    media_included: includeMedia,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

  let bytes = 0;
  let firstReceipt;
  try {
    for (const rel of files) {
      const from = path.join(pkg, rel);
      const to = path.join(target, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      if (process.env.TRANSCRIPT_ARCHIVE_TEST_CORRUPT === rel) fs.appendFileSync(to, "x");
    }
    for (const rel of files) {
      const from = path.join(pkg, rel);
      const to = path.join(target, rel);
      const size = fs.statSync(from).size;
      if (!fs.existsSync(to) || fs.statSync(to).size !== size || sha256(to) !== sha256(from)) {
        throw new Error(`verification failed for ${rel}`);
      }
      bytes += size;
    }
    // Receipt first: if the target cannot take it, nothing local has been deleted yet.
    firstReceipt = {
      archived_at: new Date().toISOString(),
      host: runtimeIdentity().host,
      storage: root.storage,
      [root.pathKey]: dest,
      files: files.length,
      bytes,
      media_included: includeMedia,
      media_skipped: skipped.length,
      media_skipped_bytes: skippedBytes,
      verified: "size+sha256",
      local_removed: false,
    };
    writeReceipt(target, firstReceipt);
  } catch (error) {
    releasePackageLock(lock);
    fs.writeFileSync(manifestFile, originalManifest);
    // The target was new or empty, so everything inside it came from this run.
    if (createdTarget) fs.rmSync(target, { recursive: true, force: true });
    else for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
    error.message = `${error.message}; local package kept`;
    throw error;
  }

  try {
    fs.rmSync(pkg, { recursive: true, force: false });
  } finally {
    releasePackageLock(lock); // no-op once the package (and its lock) is gone
  }
  // Past the point of no return: the archived copy is complete and verified, so
  // a receipt hiccup is reported, never thrown.
  const receipt = { ...firstReceipt, local_removed: !fs.existsSync(pkg) };
  try {
    writeReceipt(target, receipt);
  } catch {
    receipt.receipt_update_failed = true;
  }
  return { receipt, root, dest };
}

function writeReceipt(target, receipt) {
  const failOn = process.env.TRANSCRIPT_ARCHIVE_TEST_FAIL_RECEIPT;
  if (failOn === "1" || (failOn === "final" && receipt.local_removed !== false)) {
    throw new Error("receipt write failed");
  }
  fs.writeFileSync(path.join(target, ARCHIVE_RECEIPT), JSON.stringify(receipt, null, 2) + "\n");
}

function main() {
  try {
    const opts = parseArgs(process.argv);
    const { receipt, root, dest } = archivePackage(opts.pkg, opts.dest, { includeMedia: opts.includeMedia });
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    console.error(
      `[archive] copied ${receipt.files} file(s) (${mb(receipt.bytes)} MB) to ${root.display(dest)}; verified size+sha256; `
      + (receipt.media_skipped
        ? `skipped ${receipt.media_skipped} media file(s) (${mb(receipt.media_skipped_bytes)} MB, not archived; --include-media keeps them); `
        : "")
      + (receipt.local_removed ? "local package removed" : "LOCAL PACKAGE LEFT")
      + (receipt.receipt_update_failed ? `; WARNING: ${root.name} receipt still says local_removed=false` : ""),
    );
    console.log(JSON.stringify(receipt, null, 2));
    process.exit(receipt.local_removed ? 0 : 1);
  } catch (error) {
    console.error(`[archive] ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}

if (path.resolve(process.argv[1] ?? "") === new URL(import.meta.url).pathname) main();
