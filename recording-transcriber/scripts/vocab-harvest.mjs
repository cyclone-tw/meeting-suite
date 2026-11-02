#!/usr/bin/env node
// Bring corrections added in the meeting app (meeting_scribe_url and the standby)
// back into the shared vocabulary note. The note must live in a git checkout:
// profile.shared_vocabulary.repo (relative to home) and .wiki_path (the note
// inside it). Optional: lint and secret-scan scripts in that repo run first.
//
//   pnpm run vocab:harvest --check     # list what each host added (pnpm 11: no "--")
//   pnpm run vocab:harvest             # append them to the note, lint, commit, push
//
// Each host's GET /api/corrections has `pending`: pairs it added that the note
// does not have yet. Conflicts (the note already maps the same wrong form to
// something else) are only listed: fix them in the note or remove them from the
// host. Once the hosts pull the new note, their pending list empties itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadAsrProfile, sharedVocabulary } from "../lib/asr-profile.mjs";
import { appendToSharedNote, classifyPending, ownerHome, parseSharedVocabulary } from "../lib/vocabulary.mjs";

function usage() {
  return `Usage: vocab-harvest [--check] [--json]

  --check   list only; never writes (exit 1 when there is something to bring back)
  --json    print the result as JSON`;
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

// quiet：失敗時只說哪支沒過，不印它的輸出（掃描器可能回顯命中的內容）
const run = (cmd, args, opts = {}) => {
  const { quiet, ...rest } = opts;
  const r = spawnSync(cmd, args, { encoding: "utf8", ...rest });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 2).join(" ")} failed${quiet ? "" : `: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ").slice(0, 300)}`}`);
  return r.stdout;
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

// 在 wiki 的暫時 worktree 改正本、跑 lint 與 secret scan、commit、push 到 main，最後一定移除 worktree。
// 要加的先對 origin/main 上最新的正本再比一次：本機的正本可能還沒更新（剛收過一次、別人剛改過），
// 已經有的不重複寫，變成衝突的也不寫。回傳 { sha, fixed, hints, skipped }；沒有要寫的就不 commit（sha 是空的）
export function writeToWiki({ wiki, rel, add, message, worktrees }) {
  run("git", ["-C", wiki, "fetch", "-q", "origin"]);
  const wt = path.join(worktrees, `${path.basename(wiki)}-vocab-harvest-${stamp()}-${process.pid}`);
  run("git", ["-C", wiki, "worktree", "add", "-q", "--detach", wt, "origin/main"]);
  try {
    const file = path.join(wt, rel);
    const current = fs.readFileSync(file, "utf8");
    const latest = parseSharedVocabulary(current);
    if (latest.error) throw new Error(`origin/main 上的正本看不懂（${latest.error}），沒有寫入`);
    const fresh = classifyPending([{ fixed: add.fixed || [], hints: add.hints || [] }], latest);
    const skipped = (add.fixed || []).length + (add.hints || []).length - fresh.fixed.length - fresh.hints.length;
    if (!fresh.fixed.length && !fresh.hints.length) return { sha: "", fixed: [], hints: [], skipped };
    fs.writeFileSync(file, appendToSharedNote(current, fresh));
    const env = { ...process.env, CYCLONE_WIKI_ROOT: wt };
    // 筆記 repo 有 lint／掃描腳本就先跑（沒有就略過）
    if (fs.existsSync(path.join(wt, "scripts", "wiki-lint.sh"))) run("bash", ["scripts/wiki-lint.sh", rel], { cwd: wt, env });
    if (fs.existsSync(path.join(wt, "scripts", "privacy-scan.sh"))) run("bash", ["scripts/privacy-scan.sh", rel], { cwd: wt, env, quiet: true });
    run("git", ["-C", wt, "add", "--", rel]);
    run("git", ["-C", wt, "commit", "-q", "-m", message]);
    run("git", ["-C", wt, "push", "-q", "origin", "HEAD:main"]);
    return { sha: run("git", ["-C", wt, "rev-parse", "--short", "HEAD"]).trim(), fixed: fresh.fixed, hints: fresh.hints, skipped };
  } finally {
    spawnSync("git", ["-C", wiki, "worktree", "remove", "--force", wt], { stdio: "ignore" });
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const bad = args.find((a) => !["--check", "--json", "--help", "-h"].includes(a));
  if (bad) { console.error(`vocab-harvest: unknown argument: ${bad}\n${usage()}`); return 2; }
  if (args.includes("--help") || args.includes("-h")) { console.log(usage()); return 0; }
  const check = args.includes("--check"), json = args.includes("--json");
  const shared = sharedVocabulary();
  if (!shared.path) { console.error("vocab-harvest: the shared vocabulary note was not found or is broken; nothing to compare with."); return 1; }
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
  if (!todo) { if (!json) console.log("[harvest] nothing to bring back"); return unreachable.length ? 1 : 0; }
  if (check) return 1;
  const p = loadAsrProfile().profile.shared_vocabulary || {};
  const repo = typeof p.repo === "string" && p.repo.trim() ? p.repo.trim() : "";
  const wiki = process.env.CYCLONE_WIKI_CHECKOUT || (repo ? path.resolve(ownerHome(), repo) : "");
  if (!wiki || !p.wiki_path) throw new Error("set shared_vocabulary.repo and shared_vocabulary.wiki_path in the user profile");
  const done = writeToWiki({
    wiki, rel: p.wiki_path, add: result, worktrees: process.env.CYCLONE_WORKTREES || path.join(path.dirname(wiki), "worktrees"),
    message: `docs(private): bring meeting-app corrections into the transcription vocabulary\n\n${todo} pair(s) from ${hosts().length} host(s).`,
  });
  if (!done.sha) { console.log(`[harvest] the latest note on main already has these (${done.skipped}); nothing written`); return 0; }
  console.log(`[harvest] pushed ${done.sha} to ${path.basename(wiki)} main (${done.fixed.length + done.hints.length} pair(s)${done.skipped ? `, ${done.skipped} already there` : ""}); hosts pick it up on their next Wiki pull (about 15 minutes)`);
  const qmd = path.join(wiki, "scripts", "qmd-refresh.sh");
  if (fs.existsSync(qmd)) spawnSync("bash", [qmd], { cwd: wiki, stdio: "ignore" });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => { process.exitCode = c; }, (e) => { console.error(`vocab-harvest: ${e.message}`); process.exitCode = 1; });
