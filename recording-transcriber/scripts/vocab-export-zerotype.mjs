#!/usr/bin/env node
// Write ZeroType's replacement table from the shared vocabulary note
// (profile.shared_vocabulary). The note is the one list; ZeroType gets its 固定替換 and 口述替換 sections as plain literals.
//
//   pnpm run vocab:export-zerotype --check      # show what would change (pnpm 11: no "--")
//   pnpm run vocab:export-zerotype              # back up the old table, then write
//   pnpm run vocab:export-zerotype --check --list   # also list the pairs that change
//
// The old table is copied next to it as global_replacements.json.bak-<time>
// first. ZeroType reads the file when it starts; quit and reopen it afterwards.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sharedVocabulary } from "../lib/asr-profile.mjs";
import { ownerHome, sharedToZeroType } from "../lib/vocabulary.mjs";

function usage() {
  return `Usage: vocab-export-zerotype [--check] [--list] [--json] [--force] [--zerotype <file>]

  --check     report only; never writes (exit 1 when the table would change)
  --list      also print each pair that is added, removed or changed
  --json      print the report as JSON
  --force     write even when more than half of the current entries would go`;
}

function parseArgs(argv) {
  const opts = { check: false, list: false, json: false, force: false, zerotype: path.join(ownerHome(), "Library", "Application Support", "ZeroType", "global_replacements.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--zerotype") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--zerotype needs a value");
      opts.zerotype = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
const zeroTypeRunning = () => spawnSync("/usr/bin/pgrep", ["-x", "ZeroType"], { stdio: "ignore" }).status === 0;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2).filter((a) => a !== "--"));
  } catch (err) {
    console.error(`vocab-export-zerotype: ${err.message}\n${usage()}`);
    return 2;
  }
  if (opts.help) { console.log(usage()); return 0; }
  const shared = sharedVocabulary();
  if (!shared.path) {
    console.error("vocab-export-zerotype: the shared vocabulary note was not found or is broken (see config/asr-profile.json shared_vocabulary.paths); nothing written.");
    return 1;
  }
  if (!Object.keys(shared.fixed).length && !Object.keys(shared.dictation).length) {
    console.error("vocab-export-zerotype: the shared note has no 固定替換 or 口述替換 entries; refusing to empty ZeroType's table.");
    return 1;
  }
  let existing, target;
  try {
    target = fs.realpathSync(opts.zerotype);   // 是捷徑（symlink）就寫到它指的檔，不把捷徑換掉
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (err) {
    console.error(`vocab-export-zerotype: cannot read the ZeroType table ${opts.zerotype}: ${err.code || err.message}`);
    return 1;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    console.error("vocab-export-zerotype: the ZeroType table is not a JSON object; nothing written.");
    return 1;
  }
  const { table, report } = sharedToZeroType(shared, existing);
  const changes = report.added.length + report.removed.length + report.changed.length;
  if (opts.json) console.log(JSON.stringify({ note_sha256: shared.sha256.slice(0, 16), ...report }, null, 2));
  else {
    console.log(`[zerotype] from ${shared.path}`);
    console.log(`[zerotype] add ${report.added.length}, remove ${report.removed.length}, change ${report.changed.length}; ${report.guarded.length} key(s) get a trailing space so the right form is not rewritten`);
    if (opts.list) {
      for (const [w, r] of report.added) console.log(`  + ${w} → ${r}`);
      for (const [w, r] of report.removed) console.log(`  - ${w} → ${r}`);
      for (const [w, a, b] of report.changed) console.log(`  ~ ${w} → ${a}  ⇒  ${b}`);
    }
  }
  if (!changes) { if (!opts.json) console.log("[zerotype] already up to date"); return 0; }
  if (opts.check) return 1;
  const before = Object.values(existing.Transcription?.Literals || {}).reduce((n, ws) => n + (Array.isArray(ws) ? ws.length : 0), 0);
  if (!opts.force && report.removed.length * 2 > before) {
    console.error(`vocab-export-zerotype: ${report.removed.length} of ${before} current entries would go; check the note, or pass --force.`);
    return 1;
  }
  let backup = `${target}.bak-${stamp()}`;
  for (let n = 1; fs.existsSync(backup); n += 1) backup = `${target}.bak-${stamp()}-${n}`;
  fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, { mode: fs.statSync(target).mode & 0o777 });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  console.log(`[zerotype] written; the old table is ${path.basename(backup)}`);
  if (zeroTypeRunning()) console.log("[zerotype] ZeroType is running: quit and reopen it to load the new table.");
  return 0;
}

process.exitCode = main();
