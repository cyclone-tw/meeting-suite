#!/usr/bin/env node
// Pull new entries from the ZeroType replacement table into the user's ASR
// vocabulary (~/.config/recording-transcriber/asr-profile.json).
//
// ZeroType stays read-only. Safe new entries are written to the profile; the
// rest is only listed: short Chinese keys and corpus hits need a person,
// variants of private names belong in the private vocabulary note, and keys
// that already map elsewhere are conflicts. Review decisions live in
// ~/.config/recording-transcriber/vocabulary-import.json (format in
// config/vocabulary-import.example.json).
//
//   pnpm run vocab:import-zerotype --check                 # report only (pnpm 11: no "--")
//   pnpm run vocab:import-zerotype                         # write safe entries
//   pnpm run vocab:import-zerotype --check --corpus <dir> [--corpus <dir>]
import fs from "node:fs";
import path from "node:path";
import { userProfilePath } from "../lib/asr-profile.mjs";
import {
  classifyZeroTypeCandidates,
  countVocabularyHits,
  loadPrivateVocabulary,
  ownerHome,
  zeroTypeToPairs,
} from "../lib/vocabulary.mjs";

const CORPUS_EXTENSIONS = new Set([".md", ".txt", ".srt", ".vtt"]);

function usage() {
  return `Usage: vocab-import-zerotype [--check] [--json] [--corpus <file|dir>]...
                             [--zerotype <file>] [--profile <file>] [--policy <file>]

  --check     report differences only; never writes (exit 1 when anything is pending)
  --json      print the report as JSON
  --corpus    correctly written text (Wiki notes, docs) to count would-be replacements in;
              a candidate with hits goes to review. Only counts are printed.`;
}

function parseArgs(argv) {
  const opts = {
    check: false,
    json: false,
    corpus: [],
    zerotype: path.join(ownerHome(), "Library", "Application Support", "ZeroType", "global_replacements.json"),
    profile: userProfilePath(),
    policy: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--check") opts.check = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--corpus") opts.corpus.push(value());
    else if (arg === "--zerotype") opts.zerotype = value();
    else if (arg === "--profile") opts.profile = value();
    else if (arg === "--policy") opts.policy = value();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  // 審核紀錄預設放在設定檔旁邊（設定檔改放別處時跟著走）
  if (!opts.policy) opts.policy = path.join(opts.profile ? path.dirname(opts.profile) : path.join(ownerHome(), ".config", "recording-transcriber"), "vocabulary-import.json");
  return opts;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${label} ${file}: ${err.code || err.message}`);
  }
}

function corpusFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...corpusFiles(full));
    else if (entry.isFile() && CORPUS_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

// Hits per corpus for every rule that would be active: the profile plus the
// ZeroType candidates. Counted with the real matcher, so guards apply.
function auditCorpora(corpora, rules) {
  const audit = { corpora: [], hits: {} };
  for (const target of corpora) {
    const label = path.basename(path.resolve(target));
    const files = corpusFiles(target);
    const totals = {};
    for (const file of files) {
      const counts = countVocabularyHits(fs.readFileSync(file, "utf8"), rules);
      for (const [from, n] of Object.entries(counts)) totals[from] = (totals[from] || 0) + n;
    }
    audit.corpora.push({ label, files: files.length });
    for (const [from, n] of Object.entries(totals)) {
      audit.hits[from] = { ...(audit.hits[from] || {}), [label]: n };
    }
  }
  return audit;
}

function sortedMap(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function printReport(report, check) {
  const line = (items, fmt) => items.forEach((item) => console.log(`  ${fmt(item)}`));
  console.log(`ZeroType pairs: ${report.zerotype_pairs}; already known: ${report.known}`);
  console.log(`add (${report.add.length})${check ? "" : " -> written to the profile"}:`);
  line(report.add, (p) => `${p.from} -> ${p.to}`);
  console.log(`review (${report.review.length}): decide by hand, then add to the profile or to policy skip`);
  line(report.review, (p) => `${p.from} -> ${p.to}  [${p.reason}]`);
  console.log(`personal (${report.personal.length}): add to your private vocabulary note, never to git`);
  line(report.personal, (p) => `${p.from} -> ${p.to}`);
  console.log(`conflict (${report.conflict.length}): key already maps to something else`);
  line(report.conflict, (p) => `${p.from} -> ${p.to}  [profile: ${p.existing}]`);
  console.log(`skipped (${report.skipped.length})`);
  if (report.audit) {
    console.log(`corpus hits (${report.audit.corpora.map((c) => `${c.label}: ${c.files} files`).join(", ")}):`);
    for (const [from, hits] of Object.entries(report.audit.hits)) {
      console.log(`  ${from}  ${Object.entries(hits).map(([label, n]) => `${label}=${n}`).join(" ")}`);
    }
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`vocab-import-zerotype: ${err.message}\n${usage()}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!opts.profile) {
    console.error("vocab-import-zerotype: no user profile (CYCLONE_ASR_PROFILE_USER is empty); pass --profile <file>.");
    return 2;
  }

  const zerotype = readJson(opts.zerotype, "ZeroType table");
  const profile = fs.existsSync(opts.profile) ? readJson(opts.profile, "ASR profile") : {};
  const policy = fs.existsSync(opts.policy) ? readJson(opts.policy, "import policy") : {};
  const privatePaths = profile.private_vocabulary?.paths;
  const privateVocabulary = loadPrivateVocabulary({ paths: Array.isArray(privatePaths) ? privatePaths : [] });
  const pairs = zeroTypeToPairs(zerotype);
  const profileVocabulary = profile.vocabulary || {};

  let audit = null;
  let corpusHits = {};
  if (opts.corpus.length > 0) {
    const rules = { ...profileVocabulary };
    for (const { from, to } of pairs) if (!Object.hasOwn(rules, from)) rules[from] = to;
    audit = auditCorpora(opts.corpus, rules);
    corpusHits = Object.fromEntries(
      Object.entries(audit.hits).map(([from, hits]) => [from, Object.values(hits).reduce((a, b) => a + b, 0)]),
    );
  }

  const result = classifyZeroTypeCandidates({ pairs, profileVocabulary, policy, privateVocabulary, corpusHits });
  const report = { zerotype_pairs: pairs.length, ...result, ...(audit ? { audit } : {}) };

  if (!opts.check && result.add.length > 0) {
    const next = { ...profileVocabulary };
    for (const { from, to } of result.add) next[from] = to;
    profile.vocabulary = sortedMap(next);
    fs.mkdirSync(path.dirname(opts.profile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(opts.profile, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, opts.check);

  if (!opts.check) return 0;
  const pending = result.add.length + result.review.length + result.personal.length + result.conflict.length;
  return pending > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`vocab-import-zerotype: ${err.message}`);
  process.exitCode = 2;
}
