import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPrivateVocabulary, loadSharedVocabulary, ownerHome } from "./vocabulary.mjs";

// ASR habits. config/asr-profile.json in the repo holds the generic defaults;
// the user's own values (vocabulary, servers, folders) live outside git in
// ~/.config/recording-transcriber/asr-profile.json and override the defaults
// key by key (objects merge, everything else replaces). CYCLONE_ASR_PROFILE_USER
// points at another file; an empty value means "no user file". CLI flags and
// env vars still override per run. Every candidate records the profile hash, a
// fingerprint of the tool sources, and the host, so results from two machines
// can be compared.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = path.resolve(__dirname, "..");
export const ASR_PROFILE_PATH = path.join(TOOL_ROOT, "config", "asr-profile.json");

const FALLBACK_PROFILE = Object.freeze({
  profile_version: 0,
  mlx_model: "mlx-community/whisper-large-v3-mlx",
  language: "auto",
  condition_on_previous_text: false,
  opencc: { enabled: true, from: "cn", to: "twp" },
  vocabulary: {},
});

export function userProfilePath(env = process.env) {
  if (env.CYCLONE_ASR_PROFILE_USER !== undefined) return env.CYCLONE_ASR_PROFILE_USER;
  // Under `node --test` (and the processes tests start) the user's own file is
  // ignored, so test results never depend on whose Mac runs them.
  if (env.NODE_TEST_CONTEXT) return "";
  return path.join(ownerHome(), ".config", "recording-transcriber", "asr-profile.json");
}

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function mergeProfile(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(isPlainObject(over) ? over : {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeProfile(out[key], value) : value;
  }
  return out;
}

function readJsonFile(file) {
  if (!file) return { raw: "", data: null };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { raw: "", data: null };
  }
  try {
    return { raw, data: JSON.parse(raw) };
  } catch {
    throw new Error(`asr profile is not valid JSON: ${file}`);
  }
}

let cachedProfile = null;

export function loadAsrProfile() {
  if (cachedProfile) return cachedProfile;
  let repo = { raw: "", data: null };
  try {
    repo = readJsonFile(ASR_PROFILE_PATH);
  } catch {
    repo = { raw: "", data: null };
  }
  const user = readJsonFile(userProfilePath());
  const profile = mergeProfile(mergeProfile(FALLBACK_PROFILE, repo.data), user.data);
  const raw = repo.raw + (user.raw ? `\0${user.raw}` : "");
  cachedProfile = {
    profile,
    sha256: raw ? sha256(raw) : "missing",
    version: profile.profile_version,
    user_file: user.data ? userProfilePath() : "",
  };
  return cachedProfile;
}

export function resetAsrProfileCache() {
  cachedProfile = null;
}

// Optional integrations. Each returns "" when the user has not configured it,
// and callers treat "" as "feature off".

// A folder under iCloud Drive shared by the user's Macs (for example "Inbox").
// Subfolders: studio/ (videos for the Studio), transcribe/ (remote jobs),
// to-wiki/ (hand-offs for coding agents).
export function icloudInboxName(profile = loadAsrProfile().profile) {
  const name = typeof profile.icloud_inbox === "string" ? profile.icloud_inbox.trim() : "";
  if (!name || name.split("/").some((part) => part === ".." || part === ".")) return "";
  return name.replace(/^\/+|\/+$/g, "");
}

export function icloudInboxDir(sub, { profile, home = os.homedir() } = {}) {
  const name = icloudInboxName(profile);
  if (!name) return "";
  return path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", ...name.split("/"), ...(sub ? [sub] : []));
}

// Where the tool lives on the remote Mac, as a shell expression: the same path
// relative to the home folder as here (CYCLONE_TRANSCRIBE_REMOTE_TOOL_DIR overrides).
export function remoteToolDirShell(env = process.env, { home = os.homedir(), root = TOOL_ROOT } = {}) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  if (env.CYCLONE_TRANSCRIBE_REMOTE_TOOL_DIR) return q(env.CYCLONE_TRANSCRIBE_REMOTE_TOOL_DIR);
  const rel = path.relative(home, root);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `"$HOME"/${q(rel)}` : q(root);
}

// The other Mac that runs remote jobs, as an SSH host or alias.
export function remoteHost(env = process.env, profile = loadAsrProfile().profile) {
  return String(env.CYCLONE_TRANSCRIBE_REMOTE_HOST || profile.remote_host || "").trim();
}

const LANGUAGE_ALIASES = new Map([
  ["chinese", "zh"],
  ["mandarin", "zh"],
  ["english", "en"],
  ["japanese", "ja"],
  ["korean", "ko"],
  ["cantonese", "yue"],
]);

// Returns an ISO-ish language code, or "" for auto-detect.
export function normalizeLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "";
  if (LANGUAGE_ALIASES.has(raw)) return LANGUAGE_ALIASES.get(raw);
  if (!/^[a-z]{2,3}([_-][a-z0-9]+)*$/i.test(raw)) {
    throw new Error(`invalid transcript language: ${value}`);
  }
  return raw.split(/[_-]/)[0];
}

// Precedence: explicit value (CLI) > TRANSCRIBE_LANGUAGE env > profile.
export function resolveLanguage(explicit) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return normalizeLanguage(explicit);
  }
  if (process.env.TRANSCRIBE_LANGUAGE) return normalizeLanguage(process.env.TRANSCRIBE_LANGUAGE);
  return normalizeLanguage(loadAsrProfile().profile.language);
}

export function isChineseLanguage(language) {
  return /^(zh|yue|cmn)$/i.test(normalizeLanguageSafe(language));
}

function normalizeLanguageSafe(language) {
  try {
    return normalizeLanguage(language);
  } catch {
    return "";
  }
}

// CJK Unified Ideographs Ext-A + basic block: U+3400..U+4DBF and U+4E00..U+9FFF.
const CJK = /[\u3400-\u9fff]/;
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;

// OpenCC cn->twp is only correct for Chinese. Applying it to Japanese kanji
// rewrites them, and it is pointless for English. With a known language trust
// it; with an unknown language fall back to a script heuristic.
export function shouldApplyOpencc(language, sampleText = "") {
  const opencc = loadAsrProfile().profile.opencc || {};
  if (opencc.enabled === false) return false;
  const code = normalizeLanguageSafe(language);
  if (code) return isChineseLanguage(code);
  const text = String(sampleText);
  return CJK.test(text) && !KANA.test(text) && !HANGUL.test(text);
}

let cachedSharedVocabulary = null;

// Optional shared vocabulary: one Markdown note (format in lib/vocabulary.mjs)
// used by every transcription tool. profile.shared_vocabulary.paths lists where
// to look, relative to the home folder; the first existing one wins. The Studio
// runs for days, so the note is read again whenever one of those files changes.
function noteStamp(paths) {
  const home = path.resolve(ownerHome());
  return home + "|" + paths.map((rel) => {
    try {
      const st = fs.statSync(path.resolve(home, String(rel)));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("|");
}

export function sharedVocabulary() {
  const raw = loadAsrProfile().profile.shared_vocabulary?.paths;
  const paths = Array.isArray(raw) ? raw : [];
  const stamp = noteStamp(paths);
  if (cachedSharedVocabulary?.stamp === stamp) return cachedSharedVocabulary.value;
  cachedSharedVocabulary = { stamp, value: loadSharedVocabulary({ paths }) };
  return cachedSharedVocabulary.value;
}

// Replacements every tool always applies. The shared note wins; the profile's
// own list is only the fallback when no shared note exists.
export function profileVocabulary() {
  const shared = sharedVocabulary();
  if (shared.path) return { ...shared.fixed };
  const vocabulary = loadAsrProfile().profile.vocabulary;
  if (!vocabulary || typeof vocabulary !== "object" || Array.isArray(vocabulary)) return {};
  const map = {};
  for (const [from, to] of Object.entries(vocabulary)) {
    if (from && typeof to === "string") map[from] = to;
  }
  return map;
}

let cachedPrivateVocabulary = null;

// Optional personal entries (names of people) kept outside git.
// profile.private_vocabulary.paths lists where to look, relative to the home
// folder; the first existing one wins. Missing file -> no entries.
export function privateVocabulary() {
  if (cachedPrivateVocabulary) return cachedPrivateVocabulary;
  const paths = loadAsrProfile().profile.private_vocabulary?.paths;
  cachedPrivateVocabulary = loadPrivateVocabulary({ paths: Array.isArray(paths) ? paths : [] });
  return cachedPrivateVocabulary;
}

let cachedToolFingerprint = "";

// Hash of the tool's own code + profile, stable across hosts when both run the
// same canonical copy. Deployed copies are not git checkouts, so this is the
// cheapest drift signal available on both machines.
export function toolFingerprint() {
  if (cachedToolFingerprint) return cachedToolFingerprint;
  const hash = createHash("sha256");
  for (const dir of ["lib", "scripts", "config"]) {
    for (const rel of listSourceFiles(path.join(TOOL_ROOT, dir), dir)) {
      hash.update(`${rel}\0`);
      hash.update(fs.readFileSync(path.join(TOOL_ROOT, rel)));
      hash.update("\0");
    }
  }
  cachedToolFingerprint = hash.digest("hex").slice(0, 16);
  return cachedToolFingerprint;
}

function listSourceFiles(absDir, relDir) {
  if (!fs.existsSync(absDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = path.join(relDir, entry.name);
    // Symlinked files are hashed by content (symlink-based deployments match
    // copies); symlinked directories are never followed, so cycles such as
    // `latest -> ..` cannot crash or re-hash the tree.
    let kind = entry;
    if (entry.isSymbolicLink()) {
      try {
        kind = fs.statSync(path.join(absDir, entry.name));
      } catch {
        continue;
      }
      if (kind.isDirectory()) continue;
    }
    if (kind.isDirectory()) files.push(...listSourceFiles(path.join(absDir, entry.name), rel));
    else if (/\.(mjs|json)$/.test(entry.name)) files.push(rel);
  }
  return files;
}

export function runtimeIdentity() {
  const { sha256: profileSha, version } = loadAsrProfile();
  return {
    host: os.hostname().replace(/\.local$/, ""),
    tool_fingerprint: toolFingerprint(),
    asr_profile_version: version,
    asr_profile_sha256: profileSha.slice(0, 16),
    private_vocabulary_sha256: privateVocabulary().sha256.slice(0, 16),
    shared_vocabulary_sha256: sharedVocabulary().sha256.slice(0, 16),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
