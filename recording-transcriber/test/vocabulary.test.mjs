// Tests for the shared ASR vocabulary: literal
// replacement guards, ZeroType import filtering, the optional private Wiki
// vocabulary and the MacBook-only import command. All names and paths are
// synthetic; nothing here reads the real ZeroType table or the real Wiki.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyVocabulary,
  classifyZeroTypeCandidates,
  countVocabularyHits,
  loadPrivateVocabulary,
  loadSharedVocabulary,
  parsePrivateVocabulary,
  parseSharedVocabulary,
  sharedToZeroType,
  classifyPending,
  appendToSharedNote,
  zeroTypeToPairs,
} from "../lib/vocabulary.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = path.join(TOOL_ROOT, "scripts", "vocab-import-zerotype.mjs");
const SHIPPED = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, "config", "asr-profile.json"), "utf8"));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, "config", "asr-profile.example.json"), "utf8"));
// 測試用的使用者設定：詞彙筆記放在暫存 home 底下的這兩個位置，固定替換只有一筆
const PROFILE = {
  vocabulary: { "夜圈": "頁籤", "開衣修": "開 issue" },
  shared_vocabulary: { paths: ["notes/transcription-vocabulary.md"] },
  private_vocabulary: { paths: ["notes/asr-private.md"] },
};
useTestProfile(PROFILE);

function makeTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vocab-test-"));
}

function privateNote(json) {
  return `---\ntype: Concept\nprivacy: sensitive\n---\n\n# ASR personal vocabulary\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

// ---- literal replacement guards ----------------------------------------------

test("vocabulary replaces literally and the longest key wins", () => {
  assert.equal(applyVocabulary("用 AI超元域 和 超元域", { "超元域": "X", "AI超元域": "Y" }), "用 Y 和 X");
  assert.equal(applyVocabulary("穿結 API", { "穿結": "串接" }), "串接 API");
});

test("a key that is part of its own target does not damage the correct spelling", () => {
  assert.equal(applyVocabulary("心智圖與心智", { "心智": "心智圖" }), "心智圖與心智圖");
  assert.equal(applyVocabulary("Cyclone and Cyclon", { "Cyclon": "Cyclone" }), "Cyclone and Cyclone");
});

test("any target spelling is protected from other rules", () => {
  // "教學章節" contains the key "學章"; the protected target "教學" keeps it whole.
  assert.equal(applyVocabulary("教學章節", { "學章": "學障", "教學": "教學" }), "教學章節");
  assert.equal(applyVocabulary("Claude Code", { "Code": "程式碼", "Cloud Code": "Claude Code" }), "Claude Code");
});

test("ASCII keys only match whole ASCII words", () => {
  const map = { "Remy": "README", "GBT": "GPT" };
  assert.equal(applyVocabulary("DeRemy 寫了 Remy", map), "DeRemy 寫了 README", "leading ASCII edge");
  assert.equal(applyVocabulary("Remyx 和 GBTs", map), "Remyx 和 GBTs", "trailing ASCII edge");
  assert.equal(applyVocabulary("XGBT 與 2GBT", map), "XGBT 與 2GBT", "letters and digits both count");
  assert.equal(applyVocabulary("看Remy檔，GBT-4", map), "看README檔，GPT-4", "CJK and punctuation are edges");
});

test("replacement is a single pass, not a cascade", () => {
  assert.equal(applyVocabulary("甲乙", { "甲": "乙", "乙": "丙" }), "乙丙");
});

test("hit counts use the same guards as replacement", () => {
  const hits = countVocabularyHits("Jeremy Remy Remy 心智圖 心智", { "Remy": "README", "心智": "心智圖" });
  assert.deepEqual(hits, { "Remy": 2, "心智": 1 });
});

// ---- ZeroType conversion and filtering ---------------------------------------

test("ZeroType {right: [wrong...]} becomes trimmed {from, to} pairs", () => {
  const table = {
    FinalOutput: { Literals: { "ignored": ["x"] }, Regex: [] },
    Transcription: {
      Literals: {
        "Cyclone": ["Syclon", "Syclon ", " Cyclone"],
        "串接": ["穿結"],
        "bad": "not-a-list",
      },
      Regex: [],
    },
  };
  // Identical pairs survive conversion; classification reports them as skipped.
  assert.deepEqual(zeroTypeToPairs(table), [
    { from: "Syclon", to: "Cyclone" },
    { from: "Cyclone", to: "Cyclone" },
    { from: "穿結", to: "串接" },
  ]);
});

test("classification: identical, skip, rewrite, short CJK, conflict, known and new", () => {
  const pairs = [
    { from: "Mac mini", to: "Mac mini" },
    { from: "Publicity", to: "Perplexity" },
    { from: "Cloud Code", to: "Claude" },
    { from: "轉入", to: "轉錄" },
    { from: "Herms", to: "Hermez" },
    { from: "Zeber", to: "Zeabur" },
    { from: "Syclon", to: "Cyclone" },
    { from: "開衣修", to: "開 issue" },
    { from: "夜圈", to: "頁籤" },
  ];
  const result = classifyZeroTypeCandidates({
    pairs,
    profileVocabulary: { "Herms": "Hermes", "Zeber": "Zeabur" },
    policy: {
      skip: { "Publicity": "real English word" },
      rewrite: { "Cloud Code": "Claude Code" },
      reviewed_short_keys: { "夜圈": "checked" },
    },
  });
  assert.deepEqual(result.add, [
    { from: "Cloud Code", to: "Claude Code" },
    { from: "Syclon", to: "Cyclone" },
    { from: "開衣修", to: "開 issue" },
    { from: "夜圈", to: "頁籤" },
  ]);
  assert.deepEqual(result.review.map((r) => r.from), ["轉入"]);
  assert.deepEqual(result.conflict, [{ from: "Herms", to: "Hermez", existing: "Hermes" }]);
  assert.deepEqual(result.skipped.map((r) => r.from), ["Mac mini", "Publicity"]);
  assert.equal(result.known, 1);
});

test("classification: variants of a private target go to the private list, never to add", () => {
  const result = classifyZeroTypeCandidates({
    pairs: [
      { from: "阿德哥哥", to: "阿德哥" },
      { from: "埃達", to: "Ada" },
      { from: "Adda", to: "Ada" },
    ],
    profileVocabulary: {},
    policy: {},
    privateVocabulary: { vocabulary: { "Adah": "Ada", "阿得哥": "阿德哥" }, skip: ["埃達"] },
  });
  assert.deepEqual(result.add, []);
  assert.deepEqual(result.personal, [
    { from: "阿德哥哥", to: "阿德哥" },
    { from: "Adda", to: "Ada" },
  ]);
  assert.deepEqual(result.skipped.map((r) => r.from), ["埃達"]);
});

test("classification: corpus hits send a candidate to review", () => {
  const result = classifyZeroTypeCandidates({
    pairs: [{ from: "Verso", to: "Vercel" }, { from: "Versel", to: "Vercel" }],
    profileVocabulary: {},
    policy: {},
    corpusHits: { "Verso": 3 },
  });
  assert.deepEqual(result.add, [{ from: "Versel", to: "Vercel" }]);
  assert.deepEqual(result.review, [{ from: "Verso", to: "Vercel", reason: "corpus hits 3" }]);
});

// ---- private Wiki vocabulary ---------------------------------------------------

test("private vocabulary: a missing file is silently empty", () => {
  const home = makeTemp();
  const loaded = loadPrivateVocabulary({ home, paths: ["notes/wiki/Private/x.md"] });
  assert.deepEqual(loaded.vocabulary, {});
  assert.equal(loaded.sha256, "absent");
});

test("private vocabulary: the first existing path wins and its JSON block is read", () => {
  const home = makeTemp();
  const replica = "notes/wiki-search/current/Private/v.md";
  const editor = "notes/wiki/Private/v.md";
  fs.mkdirSync(path.join(home, path.dirname(editor)), { recursive: true });
  fs.writeFileSync(path.join(home, editor), privateNote({ vocabulary: { "Adah": "Old" } }));
  let loaded = loadPrivateVocabulary({ home, paths: [replica, editor] });
  assert.deepEqual(loaded.vocabulary, { "Adah": "Old" });
  fs.mkdirSync(path.join(home, path.dirname(replica)), { recursive: true });
  fs.writeFileSync(path.join(home, replica), privateNote({ vocabulary: { "Adah": "Ada" }, skip: ["埃達"] }));
  loaded = loadPrivateVocabulary({ home, paths: [replica, editor] });
  assert.deepEqual(loaded.vocabulary, { "Adah": "Ada" });
  assert.deepEqual(loaded.skip, ["埃達"]);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
});

test("private vocabulary: malformed JSON or unsafe paths are ignored", () => {
  assert.equal(parsePrivateVocabulary("# no block").vocabulary, undefined);
  assert.equal(parsePrivateVocabulary("```json\n{oops\n```").vocabulary, undefined);
  const home = makeTemp();
  fs.writeFileSync(path.join(home, "outside.md"), privateNote({ vocabulary: { "a": "b" } }));
  const loaded = loadPrivateVocabulary({ home: path.join(home, "sub"), paths: ["../outside.md", path.join(home, "outside.md")] });
  assert.deepEqual(loaded.vocabulary, {});
});

test("private vocabulary: keys are trimmed and blank keys are dropped", () => {
  const parsed = parsePrivateVocabulary(privateNote({ vocabulary: { "  ": "_", "": "X", "\t": "Y", " Adah ": "Ada" } }));
  assert.deepEqual(parsed.vocabulary, { "Adah": "Ada" });
});

test("a vocabulary that cannot compile warns once and is treated as empty", (t) => {
  // V8 compiles lazily and rejects an oversized pattern ("too large") on
  // first use, so this must be caught at compile time, not mid-transcript.
  const huge = "x".repeat(100_000);
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(String(message)));
  assert.equal(applyVocabulary("Remy 開衣修", { [huge]: "y", "Remy": "README" }), "Remy 開衣修");
  assert.deepEqual(countVocabularyHits("Remy", { [huge]: "y", "Remy": "README" }), {});
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /\[vocabulary\]/);
  assert.ok(!warnings[0].includes("xxxx"), "the warning must not echo the keys");
});

test("postprocess survives blank, lone-surrogate and oversized private keys", () => {
  const rel = PROFILE.private_vocabulary.paths[0];
  const writeNote = (vocabulary) => {
    const home = makeTemp();
    fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), privateNote({ vocabulary }));
    return home;
  };
  const script = `
    const m = await import(process.argv[1]);
    console.log(await m.postprocessText(process.argv[2], {}, { language: "en" }));`;
  const run = (home) => spawnSync("node", ["--input-type=module", "-e", script,
    path.join(TOOL_ROOT, "scripts", "postprocess-text.mjs"), "Adah 夜圈 \u{1F600} a b"], {
    encoding: "utf8", env: { ...process.env, CYCLONE_ASR_OWNER_HOME: home },
  });
  // "\ud83d" is the first half of a pasted emoji; in a /u regex it never
  // splits a real surrogate pair.
  let r = run(writeNote({ "  ": "_", " Adah ": "Ada", "\ud83d": "X" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Ada 頁籤 \u{1F600} a b");
  r = run(writeNote({ ["z".repeat(100_000)]: "y", "Adah": "Ada" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Adah 夜圈 \u{1F600} a b", "an uncompilable vocabulary is skipped, not fatal");
  assert.match(r.stderr, /\[vocabulary\]/);
  assert.ok(!r.stderr.includes("zzzz"), "the warning must not echo private keys");
});

test("postprocess applies profile, then private, then manifest vocabulary", () => {
  const home = makeTemp();
  const rel = PROFILE.private_vocabulary.paths[0];
  fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), privateNote({ vocabulary: { "Adah": "Ada", "夜圈": "private-wins" } }));
  const script = `
    const m = await import(process.argv[1]);
    const out = await m.postprocessText(process.argv[2], { vocabulary: { "Zed": "Zee" } }, { language: "en" });
    console.log(out);`;
  const run = (env) => spawnSync("node", ["--input-type=module", "-e", script,
    path.join(TOOL_ROOT, "scripts", "postprocess-text.mjs"), "Adah 夜圈 Zed 開衣修"], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  let r = run({ CYCLONE_ASR_OWNER_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Ada private-wins Zee 開 issue");
  r = run({ CYCLONE_ASR_OWNER_HOME: makeTemp() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Adah 頁籤 Zee 開 issue", "without the private file only shared rules apply");
});

// ---- shared Wiki vocabulary (#84) ------------------------------------------------

const SHARED_NOTE = `---
type: Reference
---

# 轉錄用詞正本

說明文字裡的 - 這行 → 不算 不在任何一段

## 領域詞與專有名詞

學障、IEP、Cyclone
Hermes，OpenAB、學障
- 特推會（特殊、教育推行委員會）
### 這是分組小標題

## 固定替換（所有工具一律換）

- Adah → Ada

### 小標題分組

- 夜圈 → 頁籤
- 周 → 週
- 同一個 → 同一個
- Bad → Good（有備註）
- Typo -> Fixed

## 口述替換（ZeroType 一律換；其他交給 AI 判斷）

- Open App → OpenAB

## 誤聽對照（AI 依上下文判斷）

- 學長 → 學障（講到學生類別時）
- 書上 → 學障

## 其他段落

- Zed → Zee
`;

test("shared vocabulary: four sections by their first words, notes only on hints", () => {
  const v = parseSharedVocabulary(SHARED_NOTE);
  assert.deepEqual(v.terms, ["學障", "IEP", "Cyclone", "Hermes", "OpenAB", "特推會"], "清單符號與括號備註不算進詞");
  assert.deepEqual(v.fixed, { Adah: "Ada", "夜圈": "頁籤" });
  assert.deepEqual(v.dictation, { "Open App": "OpenAB" });
  // 一個中文字的 key、帶備註的固定替換：不字面取代，改當 AI 參考
  assert.deepEqual(v.hints, [["周", "週"], ["Bad", "Good", "有備註"], ["學長", "學障", "講到學生類別時"], ["書上", "學障"]]);
  // 對錯一樣、寫成 -> 的：算進略過的行數
  assert.equal(v.dropped, 2);
  assert.ok(parseSharedVocabulary("# 只有標題\n\n- a → b\n").error);
  // 固定替換的標題被改壞：整份當壞的（不能變成「沒有要換的」）
  assert.match(parseSharedVocabulary(SHARED_NOTE.replace("## 固定替換", "##固定替換")).error, /固定替換/);
  assert.match(parseSharedVocabulary(SHARED_NOTE.replace("## 固定替換", "### 固定替換")).error, /固定替換/);
});

test("shared vocabulary: the first existing path wins; a broken note warns and is ignored", () => {
  const home = makeTemp();
  const [replica, editor] = ["replica/v.md", "editor/v.md"];
  assert.equal(loadSharedVocabulary({ home, paths: [replica, editor] }).sha256, "absent");
  fs.mkdirSync(path.join(home, "editor"), { recursive: true });
  fs.writeFileSync(path.join(home, editor), SHARED_NOTE);
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual(loadSharedVocabulary({ home, paths: [replica, editor], warn }).fixed, { Adah: "Ada", "夜圈": "頁籤" });
  assert.equal(warnings.length, 1, "unusable lines are counted once");
  assert.ok(!warnings[0].includes("周"), "the warning must not echo entries");
  fs.mkdirSync(path.join(home, "replica"), { recursive: true });
  fs.writeFileSync(path.join(home, replica), "no sections here");
  const fellBack = loadSharedVocabulary({ home, paths: [replica, editor], warn });
  assert.equal(fellBack.path, path.join(home, editor), "壞的搜尋副本不擋住好的 checkout");
  assert.deepEqual(fellBack.fixed, { Adah: "Ada", "夜圈": "頁籤" });
  fs.writeFileSync(path.join(home, editor), "still no sections");
  const broken = loadSharedVocabulary({ home, paths: [replica, editor], warn });
  assert.equal(broken.sha256, "invalid");
  assert.equal(broken.path, "");
  assert.deepEqual(broken.fixed, {});
});

test("shared vocabulary is read again when the note changes, so a running Studio picks up edits", async () => {
  const home = makeTemp();
  const rel = PROFILE.shared_vocabulary.paths[0];
  fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), SHARED_NOTE);
  const saved = process.env.CYCLONE_ASR_OWNER_HOME;
  process.env.CYCLONE_ASR_OWNER_HOME = home;
  try {
    const { sharedVocabulary } = await import("../lib/asr-profile.mjs");
    assert.equal(sharedVocabulary().fixed.Adah, "Ada");
    assert.equal(sharedVocabulary(), sharedVocabulary(), "沒改就用同一份");
    fs.writeFileSync(path.join(home, rel), SHARED_NOTE.replace("- Adah → Ada", "- Adah → Ada Lovelace"));
    assert.equal(sharedVocabulary().fixed.Adah, "Ada Lovelace");
  } finally {
    if (saved === undefined) delete process.env.CYCLONE_ASR_OWNER_HOME; else process.env.CYCLONE_ASR_OWNER_HOME = saved;
  }
});

test("postprocess uses the shared note's 固定替換 instead of the profile list when the note exists", () => {
  const home = makeTemp();
  const rel = PROFILE.shared_vocabulary.paths[0];
  fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), SHARED_NOTE);
  const script = `
    const m = await import(process.argv[1]);
    console.log(await m.postprocessText(process.argv[2], {}, { language: "en" }));`;
  const run = (h) => spawnSync("node", ["--input-type=module", "-e", script,
    path.join(TOOL_ROOT, "scripts", "postprocess-text.mjs"), "Adah 夜圈 開衣修 Open App 書上"], {
    encoding: "utf8", env: { ...process.env, CYCLONE_ASR_OWNER_HOME: h },
  });
  let r = run(home);
  assert.equal(r.status, 0, r.stderr);
  // 正本沒有「開衣修」，profile 有：正本存在時不再套 profile；口述替換與誤聽對照不做字串取代
  assert.equal(r.stdout.trim(), "Ada 頁籤 開衣修 Open App 書上");
  r = run(makeTemp());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Adah 頁籤 開 issue Open App 書上", "without the note the profile list is the fallback");
});

// ---- shared vocabulary → ZeroType (#84) ----------------------------------------

test("ZeroType table: fixed and dictation become literals, prefixes get a trailing space, other layers stay", () => {
  const shared = { fixed: { Cyclon: "Cyclone", Syclon: "Cyclone", Syclone: "Cyclone", "Cloud Code": "Claude Code" }, dictation: { "Open App": "OpenAB" }, hints: [["學長", "學障"]] };
  const existing = {
    FinalOutput: { Literals: { "：": [":"] }, Regex: ["x+"] },
    Transcription: { Literals: { Claude: ["Cloud Code", "Cloud"], Cyclone: ["Cyclon "] }, Regex: ["y"] },
  };
  const { table, report } = sharedToZeroType(shared, existing);
  assert.deepEqual(table.FinalOutput, existing.FinalOutput, "FinalOutput 原樣保留");
  assert.deepEqual(table.Transcription.Regex, ["y"]);
  assert.deepEqual(table.Transcription.Literals, { "Claude Code": ["Cloud Code"], "Cyclone ": ["Cyclon ", "Syclon "], Cyclone: ["Syclone"], OpenAB: ["Open App"] });
  assert.deepEqual(report.guarded.sort(), ["Cyclon", "Syclon"]);
  assert.deepEqual(report.changed, [["Cloud Code", "Claude", "Claude Code"], ["Cyclon ", "Cyclone", "Cyclone "]], "加空格的 key 換到「正確寫法＋空格」");
  assert.deepEqual(report.removed, [["Cloud", "Claude"]]);
  assert.deepEqual(report.added.map(([w]) => w).sort(), ["Open App", "Syclon ", "Syclone"]);
  assert.ok(!JSON.stringify(table).includes("學長"), "誤聽對照不進 ZeroType");
  // 寫出去的表 ZeroType 自己套用時，不會把正確的字改壞
  const zt = Object.fromEntries(Object.entries(table.Transcription.Literals).flatMap(([r, ws]) => ws.map((w) => [w, r])));
  let text = "Cyclone 和 Syclone 和 Syclon 說 Syclon is here";
  for (const [w, r] of Object.entries(zt).sort((a, b) => a[0].length - b[0].length)) text = text.split(w).join(r);
  assert.equal(text, "Cyclone 和 Cyclone 和 Cyclone 說 Cyclone is here", "加了空格的 key 換回來也帶空格");
});

test("export-zerotype backs up and writes only when asked, and refuses without the shared note", () => {
  const home = makeTemp();
  const rel = PROFILE.shared_vocabulary.paths[0];
  const zt = path.join(home, "zt.json");
  fs.writeFileSync(zt, JSON.stringify({ FinalOutput: { Literals: {}, Regex: [] }, Transcription: { Literals: { Ada: ["Adah"] }, Regex: [] } }));
  const run = (...args) => spawnSync("node", [path.join(TOOL_ROOT, "scripts", "vocab-export-zerotype.mjs"), "--zerotype", zt, ...args], {
    encoding: "utf8", env: { ...process.env, CYCLONE_ASR_OWNER_HOME: home },
  });
  let r = run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /shared vocabulary note was not found/);
  fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), SHARED_NOTE);
  r = run("--check", "--list");
  assert.equal(r.status, 1, "有要改的：--check 回 1");
  assert.match(r.stdout, /add 2, remove 0, change 0/);
  assert.match(r.stdout, /\+ 夜圈 → 頁籤/);
  assert.deepEqual(JSON.parse(fs.readFileSync(zt, "utf8")).Transcription.Literals, { Ada: ["Adah"] }, "--check 不寫");
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(zt, "utf8")).Transcription.Literals, { Ada: ["Adah"], OpenAB: ["Open App"], "頁籤": ["夜圈"] });
  const backups = fs.readdirSync(home).filter((n) => n.startsWith("zt.json.bak-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, backups[0]), "utf8")).Transcription.Literals, { Ada: ["Adah"] });
  r = run("--check");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already up to date/);
  // 正本的固定替換與口述替換都空了（例如標題改壞成別的段）：不把 ZeroType 清空
  fs.writeFileSync(path.join(home, rel), "## 固定替換\n\n## 誤聽對照\n\n- 學長 → 學障\n");
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to empty/);
  // 會刪掉一半以上：要 --force
  fs.writeFileSync(path.join(home, rel), "## 固定替換\n\n- Zed → Zee\n");
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /would go; check the note, or pass --force/);
  assert.equal(fs.readdirSync(home).filter((n) => n.startsWith("zt.json.bak-")).length, 1, "拒絕時不寫也不備份");
  r = run("--force");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(zt, "utf8")).Transcription.Literals, { Zee: ["Zed"] });
  assert.equal(fs.readdirSync(home).filter((n) => n.startsWith("zt.json.bak-")).length, 2, "同一秒再寫也有自己的備份");
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith(".tmp")), []);
});

// ---- 收回會議 App 的更正（#84）-----------------------------------------------

test("harvest sorts host additions into 固定替換, 誤聽對照 and conflicts, and skips what the note has", () => {
  const shared = parseSharedVocabulary(SHARED_NOTE);
  const r = classifyPending([
    { fixed: [["Zeeb", "Zeabur"], ["孟", "盟"], ["Adah", "Ada"]], hints: [["思語", "詩妤"], ["Cloud Code", "Claude"]] },
    { fixed: [["Zeeb", "Zeabur"]], hints: [["思語", "詩玉"], ["學長", "學障"], ["", "x"], ["a→b", "c"]] },
  ], shared);
  assert.deepEqual(r.fixed, [["Zeeb", "Zeabur"]], "兩台都有的只收一次");
  assert.deepEqual(r.hints, [["孟", "盟"], ["Cloud Code", "Claude"]], "一個中文字的固定替換改當 AI 參考");
  assert.deepEqual(r.conflicts, [["思語", "詩妤", "詩玉", true], ["思語", "詩玉", "詩妤", true]], "兩台同一個錯字寫法不同：兩筆都不收");
  assert.equal(r.already, 2);
  const withConflict = classifyPending([{ hints: [["夜圈", "葉圈"]] }], shared);
  assert.deepEqual(withConflict.conflicts, [["夜圈", "葉圈", "頁籤"]], "正本已經有別的寫法：不收，列成衝突");
});

test("harvest appends to the end of each section and refuses a note without the section", () => {
  const out = appendToSharedNote(SHARED_NOTE, { fixed: [["Zeeb", "Zeabur"]], hints: [["思語", "詩妤"]] });
  const v = parseSharedVocabulary(out);
  assert.equal(v.fixed.Zeeb, "Zeabur");
  assert.deepEqual(v.hints.at(-1), ["思語", "詩妤"]);
  assert.match(out, /- 夜圈 → 頁籤\n- 周 → 週\n- 同一個 → 同一個\n- Bad → Good（有備註）\n- Typo -> Fixed\n- Zeeb → Zeabur\n\n## 口述替換/, "接在段落最後、空行之前");
  assert.equal(appendToSharedNote(SHARED_NOTE, {}), SHARED_NOTE, "沒有要加的就不動");
  assert.throws(() => appendToSharedNote("# 空的\n", { hints: [["a", "b"]] }), /找不到「誤聽對照」段/);
});

test("harvest writes through a temporary wiki worktree: lint, commit, push, and always cleans up", async () => {
  const root = makeTemp();
  const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const wiki = path.join(root, "wiki");
  git(root, "clone", "-q", origin, wiki);
  git(wiki, "config", "user.email", "t@example.com");
  git(wiki, "config", "user.name", "t");
  const rel = "Private/v.md";
  fs.mkdirSync(path.join(wiki, "Private"));
  fs.mkdirSync(path.join(wiki, "scripts"));
  fs.writeFileSync(path.join(wiki, rel), SHARED_NOTE);
  // 假的 lint：記下 CYCLONE_WIKI_ROOT；LINT_FAIL 存在就失敗
  fs.writeFileSync(path.join(wiki, "scripts", "wiki-lint.sh"), `echo "$CYCLONE_WIKI_ROOT" >> "${root}/lint-roots"; test ! -e "${root}/LINT_FAIL"\n`);
  fs.writeFileSync(path.join(wiki, "scripts", "privacy-scan.sh"), "exit 0\n");
  git(wiki, "add", ".");
  git(wiki, "commit", "-q", "-m", "init");
  git(wiki, "push", "-q", "origin", "HEAD:main");
  const { writeToWiki } = await import("../scripts/vocab-harvest.mjs");
  const worktrees = path.join(root, "wt");
  fs.mkdirSync(worktrees);
  const done = writeToWiki({ wiki, rel, add: { fixed: [["Zeeb", "Zeabur"]], hints: [] }, message: "harvest", worktrees });
  assert.match(done.sha, /^[0-9a-f]{7,}$/);
  // 本機正本還沒更新就再收一次：對 origin/main 再比，不重複寫、不多一個 commit
  const head = git(wiki, "rev-parse", "origin/main");
  const again = writeToWiki({ wiki, rel, add: { fixed: [["Zeeb", "Zeabur"]], hints: [["夜圈", "葉圈"]] }, message: "harvest", worktrees });
  assert.deepEqual(again, { sha: "", fixed: [], hints: [], skipped: 2 });
  git(wiki, "fetch", "-q", "origin");
  assert.equal(git(wiki, "rev-parse", "origin/main"), head);
  git(wiki, "fetch", "-q", "origin");
  assert.match(git(wiki, "show", `origin/main:${rel}`), /- Zeeb → Zeabur/);
  assert.deepEqual(fs.readdirSync(worktrees), [], "暫時 worktree 已移除");
  assert.match(fs.readFileSync(path.join(root, "lint-roots"), "utf8"), /-vocab-harvest-/, "lint 在暫時 worktree 裡跑");
  // lint 不過：不 commit、不 push，worktree 照樣清掉
  fs.writeFileSync(path.join(root, "LINT_FAIL"), "");
  assert.throws(() => writeToWiki({ wiki, rel, add: { fixed: [["Qux", "Quux"]], hints: [] }, message: "harvest", worktrees }), /wiki-lint\.sh/);
  fs.rmSync(path.join(root, "LINT_FAIL"));
  // 掃描不過：只說哪支沒過，不印它的輸出
  git(wiki, "pull", "-q", "--ff-only");
  fs.writeFileSync(path.join(wiki, "scripts", "privacy-scan.sh"), "echo 'hit: secret-ish-text'; exit 1\n");
  git(wiki, "commit", "-qam", "scan");
  git(wiki, "push", "-q", "origin", "HEAD:main");
  assert.throws(() => writeToWiki({ wiki, rel, add: { fixed: [["Qux", "Quux"]], hints: [] }, message: "harvest", worktrees }), (e) => /privacy-scan\.sh .*failed$/.test(e.message) && !e.message.includes("secret-ish"));
  git(wiki, "fetch", "-q", "origin");
  assert.doesNotMatch(git(wiki, "show", `origin/main:${rel}`), /Qux/);
  assert.deepEqual(fs.readdirSync(worktrees), []);
});

// ---- shipped profile ------------------------------------------------------------

test("the repo ships no personal vocabulary, servers or folders; they belong in the user profile", () => {
  assert.deepEqual(SHIPPED.vocabulary, {});
  for (const key of ["meeting_scribe_url", "meeting_scribe_standby_url", "shared_vocabulary", "private_vocabulary", "studio_drive", "icloud_inbox", "remote_host", "archive"]) {
    assert.ok(!(key in SHIPPED), `${key} must not be in config/asr-profile.json`);
  }
  assert.ok(!fs.existsSync(path.join(TOOL_ROOT, "config", "vocabulary-import.json")), "import decisions live in the user config folder");
});

test("example keys survive OpenCC cn->twp, which runs before vocabulary", async (t) => {
  let OpenCC;
  try {
    OpenCC = (await import("opencc-js")).default;
  } catch {
    t.skip("opencc-js not installed");
    return;
  }
  const convert = OpenCC.Converter({ from: "cn", to: "twp" });
  for (const from of Object.keys({ ...EXAMPLE.vocabulary, ...PROFILE.vocabulary })) {
    assert.equal(convert(from), from, `OpenCC rewrites key ${from}; it would never match`);
  }
});

// ---- ZeroType import command -----------------------------------------------------

function importFixture() {
  const root = makeTemp();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const zerotype = path.join(root, "global_replacements.json");
  fs.writeFileSync(zerotype, JSON.stringify({
    Transcription: { Literals: { "串接": ["穿結"], "Zeabur": ["Zeber", "Zebur"], "轉錄": ["轉入"] }, Regex: [] },
  }));
  const profile = path.join(root, "asr-profile.json");
  fs.writeFileSync(profile, JSON.stringify({ profile_version: 1, vocabulary: { "Zeber": "Zeabur" } }, null, 2) + "\n");
  const policy = path.join(root, "vocabulary-import.json");
  fs.writeFileSync(policy, JSON.stringify({ skip: {}, rewrite: {} }));
  const args = ["--zerotype", zerotype, "--profile", profile, "--policy", policy];
  const run = (extra = []) => spawnSync("node", [IMPORT, ...args, ...extra], {
    encoding: "utf8", env: { ...process.env, CYCLONE_ASR_OWNER_HOME: home },
  });
  return { root, home, profile, run };
}

test("import --check reports new entries and never writes", () => {
  const fx = importFixture();
  const before = fs.readFileSync(fx.profile, "utf8");
  const r = fx.run(["--check"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Zebur -> Zeabur/);
  assert.match(r.stdout, /review.*轉入/s);
  assert.equal(fs.readFileSync(fx.profile, "utf8"), before);
});

test("import writes only the safe new entries, sorted, and is then clean", () => {
  const fx = importFixture();
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  const vocab = JSON.parse(fs.readFileSync(fx.profile, "utf8")).vocabulary;
  assert.deepEqual(Object.keys(vocab), ["Zeber", "Zebur"]);
  assert.ok(!("轉入" in vocab) && !("穿結" in vocab), "short CJK keys need review, not auto-write");
  const again = fx.run(["--check", "--json"]);
  const report = JSON.parse(again.stdout);
  assert.deepEqual(report.add, []);
  assert.deepEqual(report.review.map((r) => r.from), ["穿結", "轉入"]);
  assert.equal(again.status, 1, "review items still pending keep --check non-zero");
});

test("import creates the user profile when it does not exist yet, private to the user", () => {
  const fx = importFixture();
  fs.rmSync(fx.profile);
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fx.profile, "utf8")).vocabulary), ["Zeber", "Zebur"]);
  assert.equal(fs.statSync(fx.profile).mode & 0o777, 0o600);
});

test("import reads its review decisions from beside the profile it writes", () => {
  const fx = importFixture();
  const dir = path.join(fx.root, "elsewhere");
  fs.mkdirSync(dir);
  const profile = path.join(dir, "asr-profile.json");
  fs.writeFileSync(path.join(dir, "vocabulary-import.json"), JSON.stringify({ skip: { Zebur: "tested: keep" }, rewrite: {} }));
  const r = spawnSync("node", [IMPORT, "--zerotype", path.join(fx.root, "global_replacements.json"), "--profile", profile, "--check", "--json"], { encoding: "utf8", env: { ...process.env, CYCLONE_ASR_OWNER_HOME: fx.home } });
  const report = JSON.parse(r.stdout);
  assert.ok(!report.add.some((x) => x.from === "Zebur"), "旁邊那份 skip 有生效");
});
