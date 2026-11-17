import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { wikiGetContent } from "./wiki-cli.mjs";

// Literal {wrong: right} vocabulary for transcripts.
//
// Replacement is a single regex pass, longest key first, so output is never
// re-scanned (no cascades) and the "AI超元域" over "超元域" rule still holds.
// Two guards keep correct text intact:
//   - every target spelling is itself a protected token, so a key that is part
//     of a target ("Cyclon" -> "Cyclone", "心智" -> "心智圖") leaves the correct
//     spelling alone;
//   - a key that starts or ends with an ASCII letter/digit only matches at an
//     ASCII word edge, so "Remy" never rewrites "Jeremy".
// Chinese has no word edges, so short Chinese keys that hit common words
// ("學章" inside "教學章節") are kept out by review, not by the matcher.

const ASCII_WORD_CHAR = /[A-Za-z0-9]/;
const SHORT_CJK_KEY = /^[\u3400-\u9fff]{1,2}$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(token) {
  let pattern = escapeRegExp(token);
  if (ASCII_WORD_CHAR.test(token[0])) pattern = `(?<![A-Za-z0-9])${pattern}`;
  if (ASCII_WORD_CHAR.test(token[token.length - 1])) pattern = `${pattern}(?![A-Za-z0-9])`;
  return pattern;
}

function cleanMap(map) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [from, to] of Object.entries(map)) {
    if (from && typeof to === "string") out[from] = to;
  }
  return out;
}

// postprocessSegments applies one map to every segment; compile it once.
const compiled = new WeakMap();
let warnedCompile = false;

// A map that cannot compile (V8 rejects an oversized pattern, and only on
// first use) means no vocabulary for this run, never a failed transcript.
// The warning names the error type only: the pattern holds private keys.
function compile(map) {
  if (map && typeof map === "object" && compiled.has(map)) return compiled.get(map);
  let matcher;
  try {
    matcher = buildMatcher(map);
    if (matcher) {
      matcher.regex.test("");
      matcher.regex.lastIndex = 0;
    }
  } catch (err) {
    matcher = null;
    if (!warnedCompile) {
      warnedCompile = true;
      console.error(`[vocabulary] cannot compile the vocabulary (${err?.name || "Error"}); skipping replacement`);
    }
  }
  if (map && typeof map === "object") compiled.set(map, matcher);
  return matcher;
}

function buildMatcher(map) {
  const vocab = cleanMap(map);
  const replacements = new Map(Object.entries(vocab).filter(([from, to]) => from !== to));
  if (replacements.size === 0) return null;
  const tokens = new Set([...Object.keys(vocab), ...Object.values(vocab)].filter(Boolean));
  const ordered = [...tokens].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return { replacements, regex: new RegExp(ordered.map(tokenPattern).join("|"), "gu") };
}

export function applyVocabulary(text, map) {
  const value = String(text ?? "");
  const matcher = compile(map);
  if (!matcher || !value) return value;
  return value.replace(matcher.regex, (match) => matcher.replacements.get(match) ?? match);
}

// Number of replacements each key would make in `text`, with the same guards.
export function countVocabularyHits(text, map) {
  const counts = {};
  const matcher = compile(map);
  if (!matcher) return counts;
  for (const match of String(text ?? "").matchAll(matcher.regex)) {
    if (matcher.replacements.has(match[0])) counts[match[0]] = (counts[match[0]] || 0) + 1;
  }
  return counts;
}

export function isShortCjkKey(key) {
  return SHORT_CJK_KEY.test(key);
}

// ZeroType keeps {right: [wrong, ...]} under Transcription.Literals. Keys and
// variants are trimmed: ZeroType users pad keys with spaces as a poor man's
// word edge, which the ASCII guard above already provides.
export function zeroTypeToPairs(table) {
  const literals = table?.Transcription?.Literals;
  const pairs = [];
  const seen = new Set();
  if (!literals || typeof literals !== "object") return pairs;
  for (const [rawTo, variants] of Object.entries(literals)) {
    if (!Array.isArray(variants)) continue;
    const to = String(rawTo).trim();
    if (!to) continue;
    for (const variant of variants) {
      const from = String(variant ?? "").trim();
      if (!from || seen.has(from)) continue;
      seen.add(from);
      pairs.push({ from, to });
    }
  }
  return pairs;
}

// Sorts ZeroType pairs into: add (safe to write to the shared profile),
// review (needs a person: a short Chinese key not yet in
// policy.reviewed_short_keys, or corpus hits), personal (a
// variant of a name kept in the private Wiki file; never written to git),
// conflict (key already maps elsewhere), skipped (identical, or rejected by a
// policy/private skip list) and a count of entries already known.
export function classifyZeroTypeCandidates({
  pairs,
  profileVocabulary = {},
  policy = {},
  privateVocabulary = {},
  corpusHits = {},
}) {
  const skip = policy.skip || {};
  const rewrite = policy.rewrite || {};
  const reviewedShort = policy.reviewed_short_keys || {};
  const privateMap = cleanMap(privateVocabulary.vocabulary);
  const privateSkip = new Set(Array.isArray(privateVocabulary.skip) ? privateVocabulary.skip : []);
  const personalTargets = new Set(Object.values(privateMap));
  const profile = cleanMap(profileVocabulary);
  const result = { add: [], review: [], personal: [], conflict: [], skipped: [], known: 0 };

  for (const pair of pairs) {
    const from = pair.from;
    const to = typeof rewrite[from] === "string" ? rewrite[from] : pair.to;
    if (from === to) {
      result.skipped.push({ from, to, reason: "identical" });
    } else if (Object.hasOwn(skip, from)) {
      result.skipped.push({ from, to, reason: String(skip[from] || "policy skip") });
    } else if (privateSkip.has(from)) {
      result.skipped.push({ from, to, reason: "private skip" });
    } else if (Object.hasOwn(privateMap, from)) {
      result.known += 1;
    } else if (Object.hasOwn(profile, from)) {
      if (profile[from] === to) result.known += 1;
      else result.conflict.push({ from, to, existing: profile[from] });
    } else if (personalTargets.has(to)) {
      result.personal.push({ from, to });
    } else if (isShortCjkKey(from) && !Object.hasOwn(reviewedShort, from)) {
      result.review.push({ from, to, reason: "short Chinese key" });
    } else if (corpusHits[from] > 0) {
      result.review.push({ from, to, reason: `corpus hits ${corpusHits[from]}` });
    } else {
      result.add.push({ from, to });
    }
  }
  return result;
}

// ---- vocabulary notes live in the user's wiki (#197) ---------------------------

// The passwd home, not $HOME: agents that run with their own HOME still find
// the wiki tool and the cache under the account's real home.
// CYCLONE_ASR_OWNER_HOME exists for tests.
export function ownerHome() {
  return process.env.CYCLONE_ASR_OWNER_HOME || os.userInfo().homedir;
}

// 兩篇詞彙筆記（共用詞彙表、人名詞彙）都放在使用者的 wiki，wiki 不在這台電腦上：每次透過 wiki 工具讀
// （lib/wiki-cli.mjs），讀到的存一份在本機。
//   - NOTE_TTL_MS 之內直接用存的那份，不再問 wiki（一次轉錄會起好幾個程序，每個都要讀）。
//   - 過了就再問；問不到時，存的那份還在 NOTE_STALE_MS 之內就先用，但一定說它不是最新的。
//   - 再舊、或從來沒讀到過：詞彙未載入，說出來。轉錄照跑，不因此失敗。
export const NOTE_TTL_MS = 10 * 60_000;
export const NOTE_STALE_MS = 7 * 24 * 3600_000;

export function noteCacheDir(home = ownerHome()) {
  return path.join(home, "Library", "Caches", "recording-transcriber", "vocabulary");
}

// 換了工具或換了筆記就是另一份：別支工具存的不能拿來用
const cacheFile = (dir, { bin, note }) => path.join(dir, `${createHash("sha256").update(`${bin}\0${note}`).digest("hex").slice(0, 24)}.json`);

function readCache(file, source) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const at = Date.parse(j?.fetched_at);
    return j?.note === source.note && typeof j.raw === "string" && Number.isFinite(at) ? { raw: j.raw, at } : null;
  } catch {
    return null;
  }
}

// 存不了（磁碟滿、資料夾不能寫）不影響這次：讀到的照用，下次再問 wiki
function writeCache(file, source, raw, now) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, note: source.note, fetched_at: new Date(now).toISOString(), raw }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 見上 */ }
}

export function dropNoteCache({ note, bin, cacheDir = noteCacheDir() }) {
  fs.rmSync(cacheFile(cacheDir, { bin, note }), { force: true });
}

// 回傳 { state: "fresh" | "cached", raw, ageMs }、{ state: "stale", raw, ageMs, reason }（問不到、用舊的）
// 或 { state: "unavailable", reason }
export function readWikiNote({ note, bin, cacheDir = noteCacheDir(), now = Date.now(), ttlMs = NOTE_TTL_MS, staleMs = NOTE_STALE_MS, timeoutMs, env, get = wikiGetContent }) {
  const file = cacheFile(cacheDir, { bin, note });
  const cached = readCache(file, { note });
  const age = cached ? now - cached.at : Infinity;
  if (cached && age >= 0 && age < ttlMs) return { state: "cached", raw: cached.raw, ageMs: age };
  const r = get(bin, note, { ...(timeoutMs ? { timeoutMs } : {}), ...(env ? { env } : {}) });
  // 成功卻沒有內容不算讀到（不存起來，免得接下來十分鐘都當成一篇空的筆記）
  if (r.ok && r.stdout.trim()) {
    writeCache(file, { note }, r.stdout, now);
    return { state: "fresh", raw: r.stdout, ageMs: 0 };
  }
  const reason = r.ok ? "wiki 工具沒有回內容" : r.reason;
  if (cached && age >= 0 && age <= staleMs) return { state: "stale", raw: cached.raw, ageMs: age, reason };
  return { state: "unavailable", reason };
}

function ageText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  return minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小時` : `${Math.round(minutes / 1440)} 天`;
}

// source 是個人設定算出來的（lib/asr-profile.mjs 的 vocabularySource）：null＝沒設定（不出聲）；
// { problem }＝設定了但不能用；{ note, bin }＝從 wiki 讀。
// 回傳 { state: "absent" | "unavailable" } 或 { state: "loaded" | "stale", raw, ageMs }。提示只說哪一篇、為什麼，不印筆記內容
function loadNote(label, source, { warn = defaultWarn, ...opts }) {
  if (!source) return { state: "absent" };
  if (source.problem) {
    warn(`[vocabulary] 詞彙未載入：${label}（${source.problem}）`);
    return { state: "unavailable" };
  }
  const r = readWikiNote({ ...opts, note: source.note, bin: source.bin });
  if (r.state === "unavailable") {
    warn(`[vocabulary] 詞彙未載入：${label}讀不到（${r.reason}）`);
    return { state: "unavailable" };
  }
  if (r.state === "stale") warn(`[vocabulary] ${label}不是最新的：這次讀不到（${r.reason}），先用 ${ageText(r.ageMs)}前存的那一份`);
  return { state: r.state === "stale" ? "stale" : "loaded", raw: r.raw, ageMs: r.ageMs };
}

const sha256Of = (raw) => createHash("sha256").update(raw).digest("hex");

// ---- private vocabulary (names of people) ---------------------------------------

// Hand-edited keys: a blank key would rewrite every space, so trim and drop.
function trimKeys(map) {
  const out = {};
  for (const [from, to] of Object.entries(map)) {
    const key = from.trim();
    if (key) out[key] = to;
  }
  return out;
}

// The Wiki note keeps its data in the first ```json block:
//   { "vocabulary": { "wrong": "right" }, "skip": ["rejected variant", ...] }
export function parsePrivateVocabulary(markdown) {
  const block = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(String(markdown ?? ""));
  if (!block) return { error: "no ```json block" };
  let data;
  try {
    data = JSON.parse(block[1]);
  } catch (err) {
    return { error: `invalid JSON: ${err.message}` };
  }
  return {
    vocabulary: trimKeys(cleanMap(data?.vocabulary)),
    skip: Array.isArray(data?.skip) ? data.skip.filter((item) => typeof item === "string") : [],
  };
}

// state：absent（沒設定）、loaded、stale（wiki 讀不到，用舊的）、unavailable（沒讀到）、invalid（讀到了但看不懂）。
// sha256 是筆記內容的雜湊；沒有內容時就是 state 那個字
export function loadPrivateVocabulary({ source = null, warn = defaultWarn, ...opts } = {}) {
  const empty = (state) => ({ vocabulary: {}, skip: [], path: "", sha256: state, state });
  const note = loadNote("人名詞彙", source, { warn, ...opts });
  if (note.raw === undefined) return empty(note.state);
  const parsed = parsePrivateVocabulary(note.raw);
  if (parsed.error) {
    warn(`[vocabulary] 詞彙未載入：人名詞彙的格式看不懂（${parsed.error.replace(/: .*$/s, "")}）`);
    return empty("invalid");
  }
  return { vocabulary: parsed.vocabulary, skip: parsed.skip, path: source.note, sha256: sha256Of(note.raw), state: note.state, ageMs: note.ageMs };
}

// ---- shared transcription vocabulary (meeting-scribe#137, #84) ------------------
//
// One Markdown note is the single list for every transcription tool. It is
// written for people, in four "## " sections (matched by their first words):
//   領域詞…   terms only, separated by 、 or new lines (ASR context / prompt)
//   固定替換… "- wrong → right": every tool always replaces
//   口述替換… "- wrong → right": ZeroType always replaces; elsewhere AI hints
//   誤聽對照… "- wrong → right（note）": AI hints only, never string replacement
const SHARED_SECTIONS = [["領域詞", "terms"], ["固定替換", "fixed"], ["口述替換", "dictation"], ["誤聽對照", "hints"]];
const PAIR_LINE = /^\s*[-*]\s*(.+?)\s*→\s*(.+?)\s*$/u;
const PAIR_NOTE = /^(.+?)\s*（(.+)）$/u;
const ONE_CJK = /^[\u3400-\u9fff]$/u;

const BULLET = /^\s*[-*]\s*/u;

export function parseSharedVocabulary(markdown) {
  const out = { terms: [], fixed: {}, dictation: {}, hints: [], dropped: 0 };
  const found = new Set();
  let section = null;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    // 只有 # 與 ## 換段；段裡的 ### 小標題（例如把固定替換分組）只是分組，條目照收
    if (/^#{1,2}\s/u.test(line)) {
      const head = line.replace(/^#+\s*/u, "").trim();
      const hit = line.startsWith("## ") && SHARED_SECTIONS.find(([h]) => head.startsWith(h));
      section = hit ? hit[1] : null;
      if (hit) found.add(hit[1]);
      continue;
    }
    if (!section || !line.trim() || /^#{3,6}\s/u.test(line)) continue;
    if (section === "terms") {
      for (const t of line.replace(BULLET, "").replace(/（[^）]*）/gu, "").split(/[、,，]/u)) {
        const term = t.trim();
        if (term && !out.terms.includes(term)) out.terms.push(term);
      }
      continue;
    }
    const m = PAIR_LINE.exec(line);
    if (!m) {
      if (BULLET.test(line)) out.dropped += 1;   // 像是一組對照但沒有「→」（例如寫成 ->）
      continue;
    }
    const wrong = m[1].trim();
    let right = m[2].trim(), note = "";
    const n = PAIR_NOTE.exec(right);
    if (n) [right, note] = [n[1].trim(), n[2].trim()];
    if (!wrong || !right || wrong === right) { out.dropped += 1; continue; }
    // 固定替換與口述替換：帶備註、或一個中文字的 key（會改到一般詞的一部分）不能字面取代，改當 AI 參考，不丟掉
    if (section === "hints" || note || ONE_CJK.test(wrong)) { out.hints.push(note ? [wrong, right, note] : [wrong, right]); continue; }
    out[section][wrong] = right;
  }
  // 固定替換那段不見了（標題被改壞）時不能當成「沒有要換的」：整份當壞的，退回舊的錯字表
  if (!found.has("fixed")) return { error: "no 固定替換 section" };
  return out;
}

export function loadSharedVocabulary({ source = null, warn = defaultWarn, ...opts } = {}) {
  const empty = (state) => ({ terms: [], fixed: {}, dictation: {}, hints: [], path: "", sha256: state, state });
  const note = loadNote("共用詞彙表", source, { warn, ...opts });
  if (note.raw === undefined) return empty(note.state);
  const parsed = parseSharedVocabulary(note.raw);
  if (parsed.error) {
    warn(`[vocabulary] 詞彙未載入：共用詞彙表的格式看不懂（${parsed.error}）`);
    return empty("invalid");
  }
  if (parsed.dropped) warn(`[vocabulary] shared vocabulary ${source.note}: skipped ${parsed.dropped} unusable line(s)`);
  const { dropped, ...rest } = parsed;
  return { ...rest, path: source.note, sha256: sha256Of(note.raw), state: note.state, ageMs: note.ageMs };
}

function defaultWarn(message) {
  console.error(message);
}

// ---- shared vocabulary → ZeroType (#84) ------------------------------------------
//
// ZeroType's global_replacements.json is {Transcription|FinalOutput: {Literals:
// {right: [wrong, ...]}, Regex: [...]}} and replaces plain substrings with no
// word boundary. Only 固定替換 and 口述替換 go in, as Transcription literals;
// Regex lists and the FinalOutput layer are kept as they are. A wrong form that
// sits inside its own right form (Cyclon → Cyclone), or starts another wrong
// form (Syclon, Syclone), gets a trailing space, or ZeroType would turn a
// correct "Cyclone" into "Cyclonee".
const pairsOfLiterals = (literals) => {
  const out = [];
  for (const [right, wrongs] of Object.entries(literals || {})) {
    for (const wrong of Array.isArray(wrongs) ? wrongs : []) if (typeof wrong === "string" && wrong) out.push([wrong, right]);
  }
  return out;
};

export function sharedToZeroType(shared, existing = {}) {
  const literals = {}, guarded = [];
  const entries = [...Object.entries(shared.fixed || {}), ...Object.entries(shared.dictation || {})];
  // 也包括「是另一個錯誤寫法的開頭」（Syclon 與 Syclone）：不然 Syclone 會先被換成 Cyclonee
  const insideAnother = (wrong, right) => right.includes(wrong) || entries.some(([w]) => w !== wrong && w.startsWith(wrong));
  for (const [wrong, right] of entries.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))) {
    // 加了空格的 key 換成「正確寫法＋空格」，把吃掉的空格補回去（Syclon is → Cyclone is）。
    // 後面接標點或在行尾時就不換：寧可漏換，也不把正確的字改壞
    const guard = insideAnother(wrong, right);
    const [key, target] = guard ? [`${wrong} `, `${right} `] : [wrong, right];
    if (guard) guarded.push(wrong);
    (literals[target] ||= []);
    if (!literals[target].includes(key)) literals[target].push(key);
  }
  const keep = (layer) => ({ Literals: existing?.[layer]?.Literals || {}, Regex: Array.isArray(existing?.[layer]?.Regex) ? existing[layer].Regex : [] });
  const table = { ...existing, FinalOutput: keep("FinalOutput"), Transcription: { ...keep("Transcription"), Literals: literals } };
  const before = new Map(pairsOfLiterals(existing?.Transcription?.Literals).map(([w, r]) => [w, r]));
  const after = new Map(pairsOfLiterals(literals).map(([w, r]) => [w, r]));
  const report = { added: [], removed: [], changed: [], guarded };
  for (const [w, r] of after) {
    if (!before.has(w)) report.added.push([w, r]);
    else if (before.get(w) !== r) report.changed.push([w, before.get(w), r]);
  }
  for (const [w, r] of before) if (!after.has(w)) report.removed.push([w, r]);
  return { table, report };
}

// ---- 把會議 App 裡新加的更正收回正本（#84，App 端 meeting-scribe#140）----
//
// 主機的 GET /api/corrections 有 pending：{hints, fixed}，是那台加的、正本裡還沒有的「錯→對」。
// 分三類：正本裡同一個錯字已經有別的寫法 → 衝突（不收，請人決定）；固定替換且不是一個中文字 → 固定替換；
// 其他（AI 參考、一個中文字）→ 誤聽對照。正本裡已經有一模一樣的就略過。
export function classifyPending(pendingList, shared) {
  const known = new Map();
  for (const [w, r] of [...Object.entries(shared.fixed || {}), ...Object.entries(shared.dictation || {}), ...(shared.hints || [])]) if (!known.has(w)) known.set(w, r);
  const out = { fixed: [], hints: [], conflicts: [], already: 0 };
  const seen = new Set();
  for (const { hints = [], fixed = [] } of pendingList) {
    for (const [kind, pairs] of [["fixed", fixed], ["hints", hints]]) {
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        const [w, r] = Array.isArray(pair) ? pair.map((x) => String(x ?? "").trim()) : ["", ""];
        if (!w || !r || w === r || /[\n→]/u.test(w + r)) continue;
        const id = `${w}\u0000${r}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (known.get(w) === r) { out.already += 1; continue; }
        if (known.has(w)) { out.conflicts.push([w, r, known.get(w)]); continue; }
        // 兩台加了同一個錯字、不同寫法：兩筆都不收，都列成衝突
        const twin = [...out.fixed, ...out.hints].find(([x]) => x === w) || out.conflicts.find(([x, , , both]) => x === w && both);
        if (twin) {
          for (const list of [out.fixed, out.hints]) {
            const i = list.findIndex(([x]) => x === w);
            if (i >= 0) { const [first] = list.splice(i, 1); out.conflicts.push([first[0], first[1], r, true]); }
          }
          out.conflicts.push([w, r, twin[1], true]);
          continue;
        }
        (kind === "fixed" && !ONE_CJK.test(w) ? out.fixed : out.hints).push([w, r]);
      }
    }
  }
  return out;
}

// 把新的對照接在正本對應段落的最後（下一個 # 或 ## 標題之前）；找不到段落就丟錯，不亂寫
export function appendToSharedNote(markdown, { fixed = [], hints = [] }) {
  const lines = String(markdown).split("\n");
  const insert = (head, pairs) => {
    if (!pairs.length) return;
    const start = lines.findIndex((l) => l.startsWith("## ") && l.slice(3).trim().startsWith(head));
    if (start < 0) throw new Error(`正本裡找不到「${head}」段`);
    let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/u.test(l));
    if (end < 0) end = lines.length;
    while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
    lines.splice(end, 0, ...pairs.map(([w, r]) => `- ${w} → ${r}`));
  };
  insert("固定替換", fixed);
  insert("誤聽對照", hints);
  return lines.join("\n");
}
