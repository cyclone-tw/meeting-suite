#!/usr/bin/env node
// Bring corrections added in the meeting app (meeting_scribe_url and the standby)
// back into the shared vocabulary note. The note lives in the user's wiki
// (profile.shared_vocabulary.wiki_path) and is read and written through the wiki
// tool (profile.wiki_cli): get the note with its receipt, append, put it back (#197).
//
//   pnpm run vocab:harvest --check             # list what each host added (pnpm 11: no "--")
//   pnpm run vocab:harvest --agent <name>      # append them to the note and put it back
//
// Each host's GET /api/corrections has `pending`: pairs it added that the note
// does not have yet. Conflicts (the note already maps the same wrong form to
// something else) are only listed: fix them in the note or remove them from the
// host. Once the hosts read the new note, their pending list empties itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAsrProfile, vocabularySource } from "../lib/asr-profile.mjs";
import { NOTE_TTL_MS, appendToSharedNote, classifyPending, dropNoteCache, ownerHome, parseSharedVocabulary } from "../lib/vocabulary.mjs";
import { wikiRun } from "../lib/wiki-cli.mjs";

function usage() {
  return `Usage: vocab-harvest [--check] [--json] [--agent <name>]

  --check          list only; never writes (exit 1 when there is something to bring back)
  --json           print the result as JSON
  --agent <name>   who is writing, as the wiki tool records it (default: shared_vocabulary.agent in the user profile)`;
}

function hosts(env = process.env) {
  if (env.CYCLONE_MEETING_SCRIBE_HOSTS !== undefined) return env.CYCLONE_MEETING_SCRIBE_HOSTS.split(",").map((x) => x.trim()).filter(Boolean);
  const p = loadAsrProfile().profile;
  return [p.meeting_scribe_url, p.meeting_scribe_standby_url].filter((x) => typeof x === "string" && x);
}

async function pendingOf(url) {
  const r = await fetch(`${url.replace(/\/+$/, "")}/api/corrections`, { headers: { "X-Meeting-Scribe": "1" }, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!j || typeof j !== "object" || !("pending" in j)) throw new Error("這台的會議 App 還沒有 pending（版本太舊？）");
  return j.pending || {};
}

const WRITE_TIMEOUT_MS = 300_000;
const frontMatter = (text) => /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] || "";

// 稿件（要寫回的整篇）固定放這裡：寫不進去時留著，下次寫成功就收掉
export const draftPath = (home = ownerHome()) => path.join(home, ".config", "recording-transcriber", "vocab-harvest-draft.md");

// 讀正本與它的收據（get 的 JSON：之後 put 要原樣交回去，wiki 用裡面的 blob 判斷有沒有人改過）
export function readNoteReceipt({ bin, note, env }) {
  const r = wikiRun(bin, ["get", "--", note], { timeoutMs: 30_000, ...(env ? { env } : {}) });
  if (!r.ok) throw new Error(`詞彙未載入：正本讀不到（${r.reason}）`);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 下一行一起擋 */ }
  if (j?.ok !== true || j.path !== note || typeof j.content !== "string" || !/^[0-9a-f]{40}$/.test(String(j.blob))) throw new Error("詞彙未載入：wiki 工具回的不是這一篇的收據");
  return { raw: r.stdout, content: j.content };
}

// 把 add 接到正本對應段落的最後，整篇（frontmatter、id 原樣）put 回去。只寫 note 這一篇。
// 寫不進去（讀了之後有人改過＝blob 對不上、連不上、逾時）就把稿件留在 draft、丟錯：不重新取 blob 再送，
// 重跑一次會重新讀最新的正本。回傳 { commit }
export function writeToWiki({ bin, note, agent, base, add, draft = draftPath(), env }) {
  const body = appendToSharedNote(base.content, add);
  if (frontMatter(body) !== frontMatter(base.content)) throw new Error("寫回的稿件動到了 frontmatter，沒有寫入");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vocab-harvest-"));
  try {
    const baseFile = path.join(work, "base.json"), bodyFile = path.join(work, "body.md");
    fs.writeFileSync(baseFile, base.raw, { mode: 0o600 });
    fs.writeFileSync(bodyFile, body, { mode: 0o600 });
    const r = wikiRun(bin, ["put", "--agent", agent, "--base-json", baseFile, "--body-file", bodyFile, "--", note], { timeoutMs: WRITE_TIMEOUT_MS, ...(env ? { env } : {}) });
    let reply = null;
    if (r.ok) { try { reply = JSON.parse(r.stdout); } catch { /* 當成沒確認 */ } }
    if (reply?.ok === true) {
      fs.rmSync(draft, { force: true });
      return { commit: typeof reply.commit === "string" ? reply.commit : "" };
    }
    fs.mkdirSync(path.dirname(draft), { recursive: true, mode: 0o700 });
    fs.writeFileSync(draft, body, { mode: 0o600 });
    fs.chmodSync(draft, 0o600);
    const why = r.ok ? "wiki 工具沒有回確認" : r.reason;
    const unsure = r.ok || r.kind === "timeout" || ["A1-timeout", "A1-unavailable"].includes(r.code);
    const hint = r.code === "blob-conflict" ? "讀了之後有人改過正本；再跑一次會讀最新的正本再接上去"
      : unsure ? "結果沒確認，可能已經寫進去；再跑一次會先讀最新的正本，已經有的不會重複寫" : "再跑一次會重新讀正本";
    throw new Error(`正本沒有寫入（${why}${r.requestId ? `，request_id ${r.requestId}` : ""}）。${hint}。稿件留在 ${draft}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const at = args.indexOf("--agent");
  const [, flagAgent] = at >= 0 ? args.splice(at, 2) : [];
  const bad = args.find((a) => !["--check", "--json", "--help", "-h"].includes(a));
  if (bad) { console.error(`vocab-harvest: unknown argument: ${bad}\n${usage()}`); return 2; }
  if (args.includes("--help") || args.includes("-h")) { console.log(usage()); return 0; }
  const check = args.includes("--check"), json = args.includes("--json");
  const profile = loadAsrProfile().profile;
  const source = vocabularySource("shared_vocabulary", profile);
  if (!source || source.problem) { console.error(`vocab-harvest: ${source?.problem || "set shared_vocabulary.wiki_path and wiki_cli in the user profile"}`); return 1; }
  const agent = String(flagAgent ?? profile.shared_vocabulary?.agent ?? "").trim();
  if (!check && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(agent)) { console.error("vocab-harvest: writing needs --agent <name> (or shared_vocabulary.agent in the user profile); nothing written."); return 1; }
  // 每次都讀 wiki 上最新的正本（不用快取）：比對與寫回用同一份，收據也是它的
  const base = readNoteReceipt(source);
  const shared = parseSharedVocabulary(base.content);
  if (shared.error) { console.error(`vocab-harvest: 正本看不懂（${shared.error}）; nothing to compare with.`); return 1; }
  const list = [], unreachable = [];
  for (const url of hosts()) {
    try { list.push(await pendingOf(url)); } catch (e) { unreachable.push(`${new URL(url).hostname.split(".")[0]}: ${e.message}`); }
  }
  const result = classifyPending(list, shared);
  if (json) console.log(JSON.stringify({ ...result, unreachable }, null, 2));
  else {
    for (const u of unreachable) console.error(`[harvest] could not read ${u}`);
    console.log(`[harvest] new 固定替換 ${result.fixed.length}, new 誤聽對照 ${result.hints.length}, conflicts ${result.conflicts.length}, already in the note ${result.already}`);
    for (const [w, r] of result.fixed) console.log(`  固定替換 + ${w} → ${r}`);
    for (const [w, r] of result.hints) console.log(`  誤聽對照 + ${w} → ${r}`);
    for (const [w, r, other, both] of result.conflicts) console.log(`  衝突 ${w} → ${r}（${both ? `另一台是 ${other}` : `正本是 ${other}`}；改正本，或從那台的對照拿掉）`);
  }
  const todo = result.fixed.length + result.hints.length;
  if (!todo) {
    if (!json) console.log("[harvest] nothing to bring back");
    // 每台都問到了、也沒有要寫的：之前沒寫成的稿件已經不需要（例如那次其實寫進去了）
    if (!check && !unreachable.length) fs.rmSync(draftPath(), { force: true });
    return unreachable.length ? 1 : 0;
  }
  if (check) return 1;
  const done = writeToWiki({ ...source, agent, base, add: result });
  dropNoteCache(source);   // 這台下一次轉錄就讀新的正本
  console.log(`[harvest] wrote ${todo} pair(s) to the note${done.commit ? ` (${done.commit.slice(0, 7)})` : ""}; this tool reads it within ${NOTE_TTL_MS / 60_000} minutes`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`vocab-harvest: ${e.message}`); process.exitCode = 1; });
