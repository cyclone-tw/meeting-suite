import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SYSTEM_ROOTS = ["/opt/homebrew", "/usr/local", "/usr", "/bin"];
export const DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-mlx";

function resolveTrustedCandidate(candidate, extraRoots = []) {
  if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) return "";
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
    if (!stat.isFile()) return "";
  } catch {
    return "";
  }
  const roots = [...SYSTEM_ROOTS, ...extraRoots].map((root) => {
    const resolved = path.resolve(root);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  });
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
    ? resolved
    : "";
}

export function resolveFfmpegCommand() {
  for (const candidate of [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]) {
    const resolved = resolveTrustedCandidate(candidate);
    if (resolved) return resolved;
  }
  return "";
}

export function resolveMlxWhisperCommand() {
  const localPipxRoot = path.join(os.homedir(), ".local", "pipx", "venvs", "mlx-whisper");
  for (const candidate of [
    "/opt/homebrew/bin/mlx_whisper",
    "/usr/local/bin/mlx_whisper",
    path.join(os.homedir(), ".local", "bin", "mlx_whisper"),
  ]) {
    const resolved = resolveTrustedCandidate(candidate, [localPipxRoot]);
    if (resolved) return resolved;
  }
  return "";
}

export function resolveCachedMlxModel(model = DEFAULT_MLX_MODEL) {
  if (typeof model !== "string" || !model || model.includes("\0")) return "";
  if (path.isAbsolute(model)) {
    return isCompleteLocalMlxSnapshot(model, path.dirname(model)) ? fs.realpathSync(model) : "";
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) return "";

  // Ignores HF_HOME and other caller env on purpose.
  // A model must already exist in the normal per-user Hugging Face cache.
  const cacheRoot = path.join(os.homedir(), ".cache", "huggingface", "hub");
  const modelRoot = path.join(cacheRoot, `models--${model.replace("/", "--")}`);
  const refPath = path.join(modelRoot, "refs", "main");
  let revision = "";
  try {
    revision = fs.readFileSync(refPath, "utf8").trim();
  } catch {
    return "";
  }
  if (!/^[a-f0-9]{7,64}$/i.test(revision)) return "";
  const snapshot = path.join(modelRoot, "snapshots", revision);
  return isCompleteLocalMlxSnapshot(snapshot, cacheRoot) ? fs.realpathSync(snapshot) : "";
}

function isCompleteLocalMlxSnapshot(snapshot, allowedRoot) {
  let canonicalSnapshot;
  let canonicalRoot;
  try {
    canonicalSnapshot = fs.realpathSync(snapshot);
    canonicalRoot = fs.realpathSync(allowedRoot);
    if (!fs.statSync(canonicalSnapshot).isDirectory()) return false;
  } catch {
    return false;
  }
  if (
    canonicalSnapshot !== canonicalRoot
    && !canonicalSnapshot.startsWith(`${canonicalRoot}${path.sep}`)
  ) return false;

  const config = resolveContainedFile(path.join(canonicalSnapshot, "config.json"), canonicalRoot);
  const weightNames = ["weights.npz", "model.safetensors", "weights.safetensors"];
  const weights = weightNames.some((name) =>
    Boolean(resolveContainedFile(path.join(canonicalSnapshot, name), canonicalRoot))
  );
  return Boolean(config && weights);
}

function resolveContainedFile(candidate, root) {
  try {
    const resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return "";
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : "";
  } catch {
    return "";
  }
}

export function resolveCurrentNodeCommand() {
  const candidate = fs.realpathSync(process.execPath);
  const stat = fs.statSync(candidate);
  fs.accessSync(candidate, fs.constants.X_OK);
  if (!stat.isFile() || !path.isAbsolute(candidate)) {
    throw new Error("current Node runtime is not a trusted executable file");
  }
  return candidate;
}
