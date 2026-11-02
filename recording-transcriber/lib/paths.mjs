import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Shared package-path resolution. The original scripts capture `packagePath` in
// a closure; this lib version takes it as a parameter so new modules can reuse
// the same portable-package logic (strips drive_path / package_id prefixes so a
// package recorded on one machine resolves on another).

export function resolveCandidatePath(value, packagePath) {
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.join(packagePath, value);
}

export function resolvePortablePackagePath(value, manifestData, packagePath) {
  if (!value) return "";
  const packageId = manifestData?.package_id;
  const drivePath = manifestData?.drive_path || manifestData?.asset_package?.drive_path;
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

// Try each candidate (direct path, then portable-stripped). Returns the first
// that exists on disk, or "" if none.
export function resolvePackagePath(values, packagePath, manifestData) {
  for (const value of (values || []).filter(Boolean)) {
    const direct = resolveCandidatePath(value, packagePath);
    if (direct && fs.existsSync(direct)) return direct;

    const portable = resolvePortablePackagePath(value, manifestData, packagePath);
    if (portable && fs.existsSync(portable)) return portable;
  }
  return "";
}

// iCloud Drive 的根目錄（archive 與 wiki 交接單共用）；測試用 CYCLONE_ICLOUD_ROOT 指到暫存區
export function icloudRoot(env = process.env) {
  return env.CYCLONE_ICLOUD_ROOT
    || path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
}
