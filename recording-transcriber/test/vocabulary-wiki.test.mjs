// 詞彙筆記從 wiki 讀、寫回 wiki（#197）：本機已經沒有 wiki，兩篇筆記都透過個人設定的 wiki_cli 讀。
// 這裡的 wiki 是 test/helpers/fake-wiki.mjs（筆記是暫存資料夾裡的檔案），不連任何主機；人名都是假的。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as V from "../lib/vocabulary.mjs";
import * as P from "../lib/asr-profile.mjs";
import * as W from "../lib/wiki-cli.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";
import { calls, mark, readNote, useFakeWiki, writeNote } from "./helpers/fake-wiki.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, "config", "asr-profile.example.json"), "utf8"));
const SHARED = "Private/notes/transcription-vocabulary.md";
const PRIVATE = "Private/notes/asr-private.md";
const PROFILE = {
  vocabulary: { "夜圈": "頁籤", "開衣修": "開 issue" },
  wiki_cli: "fake-wiki",
  shared_vocabulary: { wiki_path: SHARED },
  private_vocabulary: { wiki_path: PRIVATE },
};
useTestProfile(PROFILE);
const BIN = useFakeWiki();

const FRONT = "---\nid: fake-vocab-0001\ntype: Reference\nprivacy: sensitive\n---\n";
const SHARED_NOTE = `${FRONT}
# 轉錄用詞正本

## 領域詞與專有名詞

學障、IEP

## 固定替換（所有工具一律換）

- Adah → Ada
- 夜圈 → 頁籤

## 口述替換（ZeroType 一律換；其他交給 AI 判斷）

- Open App → OpenAB

## 誤聽對照（AI 依上下文判斷）

- 書上 → 學障
`;
const PRIVATE_NOTE = `---\nid: fake-private-0001\ntype: Concept\n---\n\n# 人名\n\n\`\`\`json\n${JSON.stringify({ vocabulary: { Bobb: "Bob" }, skip: [] }, null, 2)}\n\`\`\`\n`;

const makeTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vocab-wiki-"));
// 一個暫存 home：同時是假 wiki 的根目錄，快取也落在它底下
function wikiHome({ shared = SHARED_NOTE, personal = PRIVATE_NOTE } = {}) {
  const home = makeTemp();
  if (shared !== null) writeNote(home, SHARED, shared);
  if (personal !== null) writeNote(home, PRIVATE, personal);
  return home;
}
const envOf = (home, extra = {}) => ({ ...process.env, CYCLONE_ASR_OWNER_HOME: home, FAKE_WIKI_ROOT: home, ...extra });
const node = (args, env) => spawnSync(process.execPath, args, { encoding: "utf8", env });
const POST = `const m = await import(process.argv[1]); console.log(await m.postprocessText(process.argv[2], {}, { language: "en" }));`;
const post = (home, text, extra) => node(["--input-type=module", "-e", POST, path.join(TOOL_ROOT, "scripts", "postprocess-text.mjs"), text], envOf(home, extra));
const IDENTITY = `const m = await import(process.argv[1]); console.log(JSON.stringify(m.runtimeIdentity()));`;
const identity = (home, extra) => JSON.parse(node(["--input-type=module", "-e", IDENTITY, path.join(TOOL_ROOT, "lib", "asr-profile.mjs")], envOf(home, extra)).stdout);
// 把快取改成 ms 毫秒以前存的
function ageCache(home, ms) {
  const dir = V.noteCacheDir(home);
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...j, fetched_at: new Date(Date.now() - ms).toISOString() }));
  }
}

// ---- 讀：成功 ---------------------------------------------------------------------

test("#197 the wiki answers: both notes load and their replacements apply", () => {
  const home = wikiHome();
  const r = post(home, "Adah 夜圈 開衣修 Bobb");
  assert.equal(r.status, 0, r.stderr);
  // 正本有的換掉；正本讀到了，個人設定裡的舊表（開衣修）就不用
  assert.equal(r.stdout.trim(), "Ada 頁籤 開衣修 Bob");
  assert.doesNotMatch(r.stderr, /詞彙未載入|不是最新/);
  assert.deepEqual(calls(home).sort(), [`get --content ${PRIVATE}`, `get --content ${SHARED}`]);
  const id = identity(home);
  assert.match(id.shared_vocabulary_sha256, /^[0-9a-f]{16}$/);
  assert.match(id.private_vocabulary_sha256, /^[0-9a-f]{16}$/);
});

// ---- 讀：失敗要說出來 -------------------------------------------------------------

test("#197 the wiki tool fails: the run goes on but says 詞彙未載入 for each note", () => {
  const home = wikiHome();
  mark(home, ".down");
  const r = post(home, "Adah 夜圈 開衣修 Bobb");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Adah 頁籤 開 issue Bobb", "只剩個人設定裡的舊表");
  assert.match(r.stderr, /\[vocabulary\] 詞彙未載入：共用詞彙表.*A1-unavailable/);
  assert.match(r.stderr, /\[vocabulary\] 詞彙未載入：人名詞彙.*A1-unavailable/);
  assert.ok(!r.stderr.includes("SSH"), "只印錯誤代碼，不印工具輸出的其他文字");
  const id = identity(home);
  assert.equal(id.shared_vocabulary_sha256, "unavailable");
  assert.equal(id.private_vocabulary_sha256, "unavailable");
});

test("#197 the wiki tool does not answer in time: 詞彙未載入, not a hang", () => {
  const home = wikiHome();
  mark(home, ".hang");
  const warnings = [];
  const started = Date.now();
  const v = V.loadSharedVocabulary({ source: { note: SHARED, bin: BIN }, cacheDir: path.join(home, "cache"), env: envOf(home), timeoutMs: 400, warn: (m) => warnings.push(m) });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(v.state, "unavailable");
  assert.equal(v.path, "");
  assert.deepEqual(v.fixed, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /詞彙未載入：共用詞彙表.*逾時/);
});

test("#197 the wiki tool is not on this Mac: 詞彙未載入", () => {
  const home = wikiHome();
  const r = post(home, "Adah Bobb", { CYCLONE_WIKI_BIN: path.join(home, "no-such-wiki-tool") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Adah Bobb");
  assert.match(r.stderr, /詞彙未載入：共用詞彙表.*找不到 wiki 工具/);
  assert.match(r.stderr, /詞彙未載入：人名詞彙.*找不到 wiki 工具/);
});

test("#197 a note the tool cannot parse is 詞彙未載入 too, and never echoes the note", () => {
  const home = wikiHome({ shared: "# 沒有段落\n\n- Adah → Ada\n", personal: "# 沒有 json 區塊 Bobb\n" });
  const r = post(home, "Adah 夜圈 Bobb");
  assert.equal(r.stdout.trim(), "Adah 頁籤 Bobb");
  assert.match(r.stderr, /詞彙未載入：共用詞彙表.*固定替換/);
  assert.match(r.stderr, /詞彙未載入：人名詞彙.*json/);
  assert.ok(!r.stderr.includes("Adah") && !r.stderr.includes("Bobb"));
  assert.equal(identity(home).shared_vocabulary_sha256, "invalid");
});

test("#197 a tool that exits 0 with nothing is not a loaded note", () => {
  const home = wikiHome({ shared: "\n" });
  const warnings = [];
  const opts = { source: { note: SHARED, bin: BIN }, cacheDir: path.join(home, "cache"), env: envOf(home), warn: (m) => warnings.push(m) };
  assert.equal(V.loadSharedVocabulary(opts).state, "unavailable");
  assert.match(warnings[0], /詞彙未載入：共用詞彙表.*沒有回內容/);
  // 沒有存成快取：筆記好了，下一次就讀到
  writeNote(home, SHARED, SHARED_NOTE);
  assert.equal(V.loadSharedVocabulary(opts).state, "loaded");
});

// ---- 設定 -------------------------------------------------------------------------

test("#197 profile: no section is silent; a leftover local path or a missing wiki_cli is 詞彙未載入", () => {
  const env = { CYCLONE_WIKI_BIN: "/x/wiki" };
  assert.equal(P.vocabularySource("shared_vocabulary", {}, env), null);
  assert.equal(P.vocabularySource("private_vocabulary", { private_vocabulary: {} }, env), null);
  assert.deepEqual(P.vocabularySource("shared_vocabulary", PROFILE, env), { note: SHARED, bin: "/x/wiki" });
  // #197 之前的設定：只有本機檔案路徑。本機 wiki 已經沒有了，不能當成「沒設定」
  assert.match(P.vocabularySource("shared_vocabulary", { wiki_cli: "w", shared_vocabulary: { paths: ["notes/v.md"] } }, env).problem, /paths.*wiki_path/);
  assert.match(P.vocabularySource("shared_vocabulary", { wiki_cli: "w", shared_vocabulary: { wiki_path: "../v.md" } }, env).problem, /wiki_path/);
  assert.match(P.vocabularySource("private_vocabulary", { private_vocabulary: { wiki_path: PRIVATE } }, env).problem, /wiki_cli/);
  for (const [load, label] of [[V.loadSharedVocabulary, "共用詞彙表"], [V.loadPrivateVocabulary, "人名詞彙"]]) {
    const warnings = [];
    const v = load({ source: { problem: "個人設定沒有填 wiki_cli" }, warn: (m) => warnings.push(m) });
    assert.equal(v.state, "unavailable");
    assert.equal(v.sha256, "unavailable");
    assert.deepEqual(warnings, [`[vocabulary] 詞彙未載入：${label}（個人設定沒有填 wiki_cli）`]);
    assert.equal(load({ source: null, warn: (m) => warnings.push(m) }).sha256, "absent");
    assert.equal(warnings.length, 1, "沒設定就不出聲");
  }
});

test("#197 a note path must stay inside the wiki", () => {
  assert.equal(W.wikiNotePath(` ${SHARED} `), SHARED);
  for (const bad of ["", "/abs/v.md", "../v.md", "a/../v.md", "a//v.md", "-v.md", "a/v.txt", "a\\v.md", "a/v\n.md", 3, null, `${"a/".repeat(200)}v.md`]) {
    assert.equal(W.wikiNotePath(bad), "", String(bad));
  }
});

test("#197 the example profile points at wiki notes, with no local path or checkout", () => {
  for (const key of ["shared_vocabulary", "private_vocabulary"]) {
    assert.ok(W.wikiNotePath(EXAMPLE[key].wiki_path), key);
    assert.ok(!("paths" in EXAMPLE[key]) && !("repo" in EXAMPLE[key]), key);
  }
  assert.ok(P.wikiCli(EXAMPLE));
});

// ---- 快取：有期限，過期的不能當成最新的 ------------------------------------------

test("#197 cache: fresh for a while, asked again after that, and an expired copy is never passed off as current", () => {
  const home = wikiHome();
  const cacheDir = path.join(home, "cache");
  const base = { note: SHARED, bin: BIN, cacheDir, env: envOf(home) };
  const t0 = 1_800_000_000_000;
  let r = V.readWikiNote({ ...base, now: t0 });
  assert.equal(r.state, "fresh");
  assert.equal(r.raw, SHARED_NOTE);
  r = V.readWikiNote({ ...base, now: t0 + V.NOTE_TTL_MS - 1 });
  assert.equal(r.state, "cached");
  assert.equal(calls(home).length, 1, "期限內不再問 wiki");
  for (const name of fs.readdirSync(cacheDir)) assert.equal(fs.statSync(path.join(cacheDir, name)).mode & 0o777, 0o600);
  // 過了期限：再問一次，讀到改過的
  const changed = SHARED_NOTE.replace("- Adah → Ada", "- Adah → Ada Lovelace");
  writeNote(home, SHARED, changed);
  const t1 = t0 + V.NOTE_TTL_MS + 1;
  r = V.readWikiNote({ ...base, now: t1 });
  assert.equal(r.state, "fresh");
  assert.equal(r.raw, changed);
  assert.equal(calls(home).length, 2);
  // 過期又連不上：可以先用舊的，但要說它是舊的
  mark(home, ".down");
  const t2 = t1 + 3 * 3600_000;
  r = V.readWikiNote({ ...base, now: t2 });
  assert.equal(r.state, "stale");
  assert.equal(r.ageMs, t2 - t1);
  assert.match(r.reason, /A1-unavailable/);
  let warnings = [];
  let v = V.loadSharedVocabulary({ source: { note: SHARED, bin: BIN }, cacheDir, env: envOf(home), now: t2, warn: (m) => warnings.push(m) });
  assert.equal(v.state, "stale");
  assert.equal(v.fixed.Adah, "Ada Lovelace");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[vocabulary\] 共用詞彙表不是最新的.*A1-unavailable.*3 小時前/);
  assert.ok(!warnings[0].includes("Lovelace"), "提示不印筆記內容");
  // 舊到超過上限：不用了
  warnings = [];
  v = V.loadSharedVocabulary({ source: { note: SHARED, bin: BIN }, cacheDir, env: envOf(home), now: t1 + V.NOTE_STALE_MS + 1, warn: (m) => warnings.push(m) });
  assert.equal(v.state, "unavailable");
  assert.deepEqual(v.fixed, {});
  assert.match(warnings[0], /詞彙未載入：共用詞彙表/);
  // 期限內的那一份算最新的：不提示
  mark(home, ".down", false);
  warnings = [];
  V.readWikiNote({ ...base, now: t2 });
  v = V.loadSharedVocabulary({ source: { note: SHARED, bin: BIN }, cacheDir, env: envOf(home), now: t2 + 1000, warn: (m) => warnings.push(m) });
  assert.equal(v.state, "loaded");
  assert.equal(v.path, SHARED);
  assert.deepEqual(warnings, []);
});

test("#197 an expired copy shows up in the run as 不是最新的, and a different wiki tool has no copy at all", () => {
  const home = wikiHome();
  assert.equal(post(home, "Adah Bobb").stdout.trim(), "Ada Bob");
  ageCache(home, 2 * 3600_000);
  mark(home, ".down");
  let r = post(home, "Adah Bobb");
  assert.equal(r.stdout.trim(), "Ada Bob", "先用 2 小時前存的那一份");
  assert.match(r.stderr, /共用詞彙表不是最新的.*2 小時前/);
  assert.match(r.stderr, /人名詞彙不是最新的.*2 小時前/);
  assert.doesNotMatch(r.stderr, /詞彙未載入/);
  ageCache(home, V.NOTE_STALE_MS + 60_000);
  r = post(home, "Adah Bobb");
  assert.equal(r.stdout.trim(), "Adah Bobb");
  assert.match(r.stderr, /詞彙未載入：共用詞彙表/);
  // 換了一支工具（或打錯名字）：別支工具存的不算
  ageCache(home, 1000);
  r = post(home, "Adah Bobb", { CYCLONE_WIKI_BIN: path.join(home, "other-wiki-tool") });
  assert.equal(r.stdout.trim(), "Adah Bobb");
  assert.match(r.stderr, /詞彙未載入：共用詞彙表.*找不到 wiki 工具/);
});

test("#197 one process asks the wiki once: a running Studio reuses the note until it expires", () => {
  const home = wikiHome();
  const saved = { home: process.env.CYCLONE_ASR_OWNER_HOME, root: process.env.FAKE_WIKI_ROOT };
  Object.assign(process.env, { CYCLONE_ASR_OWNER_HOME: home, FAKE_WIKI_ROOT: home });
  try {
    P.resetAsrProfileCache();
    const first = P.sharedVocabulary();
    assert.equal(first.fixed.Adah, "Ada");
    assert.equal(P.sharedVocabulary(), first);
    assert.deepEqual(P.profileVocabulary(), { Adah: "Ada", "夜圈": "頁籤" });
    assert.equal(P.privateVocabulary().vocabulary.Bobb, "Bob");
    assert.equal(P.privateVocabulary(), P.privateVocabulary());
    assert.equal(calls(home).length, 2, "兩篇各問一次");
  } finally {
    for (const [k, v] of [["CYCLONE_ASR_OWNER_HOME", saved.home], ["FAKE_WIKI_ROOT", saved.root]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    P.resetAsrProfileCache();
  }
});

// ---- vocab-harvest：寫回走 get → 編輯 → put --------------------------------------

const ADD = { fixed: [["Zeeb", "Zeabur"]], hints: [["思語", "詩妤"]] };
const draftOf = (home) => path.join(home, ".config", "recording-transcriber", "vocab-harvest-draft.md");

test("#197 harvest writes the shared note back through get and put, keeping the front matter and nothing else", async () => {
  const H = await import("../scripts/vocab-harvest.mjs");
  const home = wikiHome();
  const env = envOf(home);
  const base = H.readNoteReceipt({ bin: BIN, note: SHARED, env });
  assert.equal(base.content, SHARED_NOTE);
  const done = H.writeToWiki({ bin: BIN, note: SHARED, agent: "Claude", base, add: ADD, draft: draftOf(home), env });
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  const after = readNote(home, SHARED);
  assert.ok(after.startsWith(FRONT), "frontmatter 與 id 原樣");
  assert.match(after, /- 夜圈 → 頁籤\n- Zeeb → Zeabur\n\n## 口述替換/);
  assert.match(after, /- 書上 → 學障\n- 思語 → 詩妤\n$/);
  assert.equal(readNote(home, PRIVATE), PRIVATE_NOTE, "只動共用詞彙那一篇");
  assert.deepEqual(calls(home), [`get ${SHARED}`, `put agent=Claude ${SHARED}`]);
  assert.ok(!fs.existsSync(draftOf(home)), "成功就不留稿件");
});

test("#197 harvest: someone edited the note in between, so the put is refused, the draft is kept and nothing is forced", async () => {
  const H = await import("../scripts/vocab-harvest.mjs");
  const home = wikiHome();
  const env = envOf(home);
  const base = H.readNoteReceipt({ bin: BIN, note: SHARED, env });
  mark(home, ".edit-before-put");
  assert.throws(() => H.writeToWiki({ bin: BIN, note: SHARED, agent: "Claude", base, add: ADD, draft: draftOf(home), env }), /blob-conflict/);
  const now = readNote(home, SHARED);
  assert.match(now, /別人剛加的一行/, "別人改的還在");
  assert.doesNotMatch(now, /Zeeb/, "沒有蓋過去");
  assert.equal(calls(home).filter((c) => c.startsWith("put")).length, 1, "不換 blob 重送");
  const draft = fs.readFileSync(draftOf(home), "utf8");
  assert.ok(draft.startsWith(FRONT));
  assert.match(draft, /- Zeeb → Zeabur/);
  assert.equal(fs.statSync(draftOf(home)).mode & 0o777, 0o600);
  // 重跑＝重新讀最新的正本再寫：兩邊的都在，稿件收掉
  const again = H.readNoteReceipt({ bin: BIN, note: SHARED, env });
  H.writeToWiki({ bin: BIN, note: SHARED, agent: "Claude", base: again, add: ADD, draft: draftOf(home), env });
  assert.match(readNote(home, SHARED), /別人剛加的一行/);
  assert.match(readNote(home, SHARED), /- Zeeb → Zeabur/);
  assert.ok(!fs.existsSync(draftOf(home)));
});

test("#197 harvest never puts a note whose section is gone", async () => {
  const H = await import("../scripts/vocab-harvest.mjs");
  const home = wikiHome({ shared: `${FRONT}\n## 固定替換\n\n- Adah → Ada\n` });
  const env = envOf(home);
  const base = H.readNoteReceipt({ bin: BIN, note: SHARED, env });
  assert.throws(() => H.writeToWiki({ bin: BIN, note: SHARED, agent: "Claude", base, add: ADD, draft: draftOf(home), env }), /找不到「誤聽對照」段/);
  assert.equal(calls(home).filter((c) => c.startsWith("put")).length, 0);
});

// 子程序不能用 spawnSync：假的會議 App 主機跑在這個程序裡
const HARVEST = path.join(TOOL_ROOT, "scripts", "vocab-harvest.mjs");
const runAsync = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { env });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => { stdout += d; });
  c.stderr.on("data", (d) => { stderr += d; });
  c.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("#197 vocab-harvest command: --check only lists, a write needs --agent, and a refused write leaves the draft", async (t) => {
  let pending = { fixed: [["Zeeb", "Zeabur"]], hints: [] };
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ pending })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const home = wikiHome();
  const env = envOf(home, { CYCLONE_MEETING_SCRIBE_HOSTS: `http://127.0.0.1:${server.address().port}` });
  const run = (...args) => runAsync([HARVEST, ...args], env);

  let r = await run("--check");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /固定替換 \+ Zeeb → Zeabur/);
  assert.equal(readNote(home, SHARED), SHARED_NOTE, "--check 不寫");

  r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--agent/);
  assert.equal(readNote(home, SHARED), SHARED_NOTE);
  assert.equal(calls(home).filter((c) => c.startsWith("put")).length, 0);

  r = await run("--agent", "Claude");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[harvest\] wrote 1 pair/);
  assert.match(readNote(home, SHARED), /- Zeeb → Zeabur/);
  assert.ok(readNote(home, SHARED).startsWith(FRONT));

  r = await run("--agent", "Claude");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to bring back/, "讀的是 wiki 上最新的正本，不重複寫");

  pending = { fixed: [["Qux", "Quux"]], hints: [] };
  mark(home, ".edit-before-put");
  r = await run("--agent", "Claude");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blob-conflict/);
  assert.ok(r.stderr.includes(draftOf(home)), "說出稿件留在哪");
  assert.doesNotMatch(readNote(home, SHARED), /Qux/);
  assert.match(fs.readFileSync(draftOf(home), "utf8"), /- Qux → Quux/);

  // 之後沒有要寫的了（例如那次其實寫進去了、或那組從主機拿掉了）：稿件收掉；--check 不動它
  pending = { fixed: [["Zeeb", "Zeabur"]], hints: [] };
  r = await run("--check");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(draftOf(home)));
  r = await run("--agent", "Claude");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(draftOf(home)));

  mark(home, ".down");
  r = await run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /詞彙未載入.*A1-unavailable/);
});

// ---- 其他會寫東西的指令：詞彙沒讀到就不寫 ------------------------------------------

test("#197 export-zerotype refuses to write from a note it could not read fresh", () => {
  const home = wikiHome();
  const zt = path.join(home, "zt.json");
  const table = JSON.stringify({ FinalOutput: { Literals: {}, Regex: [] }, Transcription: { Literals: { Ada: ["Adah"] }, Regex: [] } });
  fs.writeFileSync(zt, table);
  const run = (...args) => node([path.join(TOOL_ROOT, "scripts", "vocab-export-zerotype.mjs"), "--zerotype", zt, ...args], envOf(home));
  assert.equal(run("--check").status, 1, "有要改的");
  ageCache(home, 2 * 3600_000);
  mark(home, ".down");
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不是最新的/);
  assert.match(r.stderr, /nothing written/);
  assert.equal(fs.readFileSync(zt, "utf8"), table);
  ageCache(home, V.NOTE_STALE_MS + 60_000);
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /詞彙未載入/);
  assert.equal(fs.readFileSync(zt, "utf8"), table);
});

test("#197 import-zerotype refuses to sort names without the private note", () => {
  const home = wikiHome();
  const zerotype = path.join(home, "global_replacements.json");
  fs.writeFileSync(zerotype, JSON.stringify({ Transcription: { Literals: { Bob: ["Bobby"] }, Regex: [] } }));
  const profile = path.join(home, "asr-profile.json");
  const before = `${JSON.stringify({ wiki_cli: "fake-wiki", private_vocabulary: { wiki_path: PRIVATE }, vocabulary: {} }, null, 2)}\n`;
  fs.writeFileSync(profile, before);
  const run = () => node([path.join(TOOL_ROOT, "scripts", "vocab-import-zerotype.mjs"), "--zerotype", zerotype, "--profile", profile, "--json"], envOf(home));
  mark(home, ".down");
  let r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /詞彙未載入：人名詞彙/);
  assert.equal(fs.readFileSync(profile, "utf8"), before, "人名詞彙沒讀到：不把人名的變體寫進共用錯字表");
  mark(home, ".down", false);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).personal, [{ from: "Bobby", to: "Bob" }]);
  assert.equal(fs.readFileSync(profile, "utf8"), before);
});
