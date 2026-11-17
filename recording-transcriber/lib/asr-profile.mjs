import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NOTE_TTL_MS, loadPrivateVocabulary, loadSharedVocabulary, ownerHome } from "./vocabulary.mjs";
import { wikiBin, wikiNotePath } from "./wiki-cli.mjs";

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
  vocabularyMemo.clear();
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

// wiki 工具（CLI）的指令名稱，例如 "my-wiki"：Ask AI 查 wiki（#192、#194）與詞彙筆記（#197）都用它。工具要有
// `search -n <n> -- <關鍵字>`（輸出 JSON）與 `get --content -- <路徑>` 兩個唯讀指令；vocab-harvest 寫回還要
// `get`（JSON 收據）與 `put`（見 lib/wiki-cli.mjs）。沒填或格式不對就沒有這些功能。
// 只收字母、數字、點、底線、連字號：它會拼成固定資料夾底下的檔名，不能帶路徑
export function wikiCli(profile = loadAsrProfile().profile) {
  const name = typeof profile.wiki_cli === "string" ? profile.wiki_cli.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : "";
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

// 詞彙筆記（#197）：共用詞彙表與人名詞彙各是使用者 wiki 裡的一篇筆記，格式見 lib/vocabulary.mjs。
// 個人設定填 shared_vocabulary.wiki_path／private_vocabulary.wiki_path（筆記在 wiki 裡的路徑）和 wiki_cli。
// 回傳 null（沒設定這一篇）、{ problem }（設定了但不能用，要說出來）或 { note, bin }
export function vocabularySource(section, profile = loadAsrProfile().profile, env = process.env) {
  const cfg = isPlainObject(profile?.[section]) ? profile[section] : null;
  if (!cfg) return null;
  if (cfg.wiki_path === undefined) {
    // #197 之前填的是本機檔案路徑（paths）。本機已經沒有 wiki，不能安靜地當成「沒設定」
    return Array.isArray(cfg.paths) && cfg.paths.length ? { problem: `個人設定的 ${section} 還是本機路徑 paths，已經不讀了；請改填 wiki_path` } : null;
  }
  const note = wikiNotePath(cfg.wiki_path);
  if (!note) return { problem: `個人設定的 ${section}.wiki_path 格式不對` };
  const name = wikiCli(profile);
  if (!name) return { problem: "個人設定沒有填 wiki_cli" };
  return { note, bin: wikiBin(name, env, { home: ownerHome() }) };
}

// 同一個程序裡（工作室會開好幾天）不必每次都讀：讀到的用到快取到期，沒讀到的一分鐘後再試。
// 所以筆記改了，最慢 NOTE_TTL_MS 之後的下一次轉錄會讀到新版，不用重開
const RETRY_MS = 60_000;
const vocabularyMemo = new Map();

function memoVocabulary(section, load, fresh) {
  const source = vocabularySource(section);
  const key = JSON.stringify([ownerHome(), source]);
  const hit = vocabularyMemo.get(section);
  const now = Date.now();
  if (!fresh && hit && hit.key === key && now < hit.until) return hit.value;
  const value = load({ source, ...(fresh ? { ttlMs: 0 } : {}) });
  const keep = value.state === "absent" ? Infinity : value.state === "loaded" ? Math.max(0, NOTE_TTL_MS - value.ageMs) : RETRY_MS;
  vocabularyMemo.set(section, { key, until: now + keep, value });
  return value;
}

// 共用詞彙表：所有轉錄工具共用的那一篇。state 是 "loaded" 以外的值時，呼叫端要知道它沒有（或不是最新的）。
// fresh：不用存的那一份，現在就問 wiki（要照正本去改別的東西的指令用）
export function sharedVocabulary({ fresh = false } = {}) {
  return memoVocabulary("shared_vocabulary", loadSharedVocabulary, fresh);
}

// Replacements every tool always applies. The shared note wins; the profile's
// own list is only the fallback when the shared note was not loaded.
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

// 人名詞彙：不進 git 的個人資料（人名），同樣是 wiki 裡的一篇筆記
export function privateVocabulary() {
  return memoVocabulary("private_vocabulary", loadPrivateVocabulary);
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
