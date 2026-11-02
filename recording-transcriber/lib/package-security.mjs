import fs from "node:fs";
import path from "node:path";

// 一般檔案安全：套件根目錄必須是真實目錄、不經過 symlink，manifest 裡的相對路徑不能逃出套件。
// 與資料隱私無關（已移除隱私分級與 restricted package 機制）。

export function loadPackageForLocalTool(rawRoot) {
  const root = canonicalExistingDirectory(rawRoot);
  const manifestPath = path.join(root, "manifest.json");
  const manifestStat = lstatRegularFile(manifestPath, "transcript manifest");
  if (!manifestStat) throw new Error("Missing transcript manifest.");

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Invalid transcript manifest.");
  }
  return { root, manifest };
}

export function resolveConfinedPackagePath(root, value, fallback = "") {
  const selected = value || fallback;
  if (typeof selected !== "string" || !selected || selected.includes("\0")) {
    throw new Error("Transcript manifest contains an invalid package path.");
  }
  if (path.isAbsolute(selected)) {
    throw new Error("Transcript manifest paths must be package-relative.");
  }
  const canonicalRoot = path.resolve(root);
  const resolved = path.resolve(canonicalRoot, selected);
  if (resolved === canonicalRoot || !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Transcript manifest path escapes the package.");
  }
  assertExistingChainNoSymlinks(canonicalRoot, resolved);
  return resolved;
}

function canonicalExistingDirectory(rawRoot) {
  const resolved = path.resolve(rawRoot);
  assertRawPathHasNoUserSymlink(resolved);
  let canonical;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    throw new Error("Transcript package directory is missing.");
  }
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Transcript package root is not a regular directory.");
  }
  return canonical;
}

function assertRawPathHasNoUserSymlink(resolved) {
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (!stat.isSymbolicLink()) continue;
    if (cursor === "/var" || cursor === "/tmp") continue;
    throw new Error("Transcript package path contains a symlink.");
  }
}

function assertExistingChainNoSymlinks(root, target) {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Transcript package path contains a symlink.");
  }
}

function lstatRegularFile(file, label) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid ${label}.`);
  return stat;
}
