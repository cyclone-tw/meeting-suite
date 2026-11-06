// Synthetic tests for the MacBook -> mini lane.
// A fake `ssh` runs the remote command locally with HOME pointed at a fake
// mini home, so the whole flow (ping, detached job, polling, harvest, remote
// cleanup, local fallback) runs offline.
//
// Run: node --test tools/recording-transcriber/test/remote.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLastJson } from "../lib/json-tail.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";

useTestProfile({ icloud_inbox: "Inbox" });

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = path.join(TOOL_ROOT, "scripts", "transcribe-remote.mjs");
const JOB = path.join(TOOL_ROOT, "scripts", "transcript-job.mjs");

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const FAKE_MLX = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (process.env.FAKE_MLX_FAIL === "1") process.exit(3);
if (process.env.FAKE_MLX_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_MLX_SLEEP) * 1000);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ""; };
fs.writeFileSync(path.join(get("--output-dir"), get("--output-name") + ".json"),
  JSON.stringify({ text: "hello", language: "en", segments: [{ start: 0, end: 1, text: "hello from " + (process.env.FAKE_WHERE || "?") }] }));
`;

const FAKE_YTDLP = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2099.01.01"); process.exit(0); }
if (args.includes("--print")) { console.log("vid123|Synthetic|Chan|2026-10-05|1:00|https://www.youtube.com/watch?v=vid123"); process.exit(0); }
if (args.includes("-x")) {
  const file = args[args.indexOf("-o") + 1].replace("%(upload_date>%Y-%m-%d)s-%(title)s.%(ext)s", "2026-10-05-Synthetic.mp3");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "synthetic-mp3");
}
`;

// Fake ssh: drops -o options, logs the remote command, then runs it locally as
// the "mini" (fake HOME, fake binaries first on PATH, FAKE_WHERE=mini).
const FAKE_SSH = `#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i] !== "--") i += args[i] === "-o" ? 2 : 1;
const host = args[i + 1];
const command = args[i + 2];
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ host, command }) + "\\n");
if (process.env.FAKE_SSH_DOWN === "1") { process.stderr.write("ssh: connect to host " + host + ": Connection refused\\n"); process.exit(255); }
const env = { ...process.env, HOME: process.env.FAKE_MINI_HOME, FAKE_WHERE: "mini" };
delete env.TRANSCRIBE_MLX_COMMAND;
if (process.env.FAKE_REMOTE_MLX_FAIL === "1") env.FAKE_MLX_FAIL = "1";
if (process.env.FAKE_REMOTE_MLX_SLEEP) env.FAKE_MLX_SLEEP = process.env.FAKE_REMOTE_MLX_SLEEP;
delete env.FAKE_REMOTE_MLX_SLEEP;
if (process.env.FAKE_SSH_FAIL_ON && command.includes("transcript-job.mjs '" + process.env.FAKE_SSH_FAIL_ON + "'")) {
  process.stderr.write("ssh: Connection reset by peer\\n");
  process.exit(255);
}
const r = spawnSync("/bin/sh", ["-c", command], { env, stdio: "inherit" });
process.exit(r.status ?? 1);
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-lane-test-"));
  const miniHome = path.join(root, "mini-home");
  const macHome = path.join(root, "mac-home");
  const inbox = path.join(root, "icloud", "Inbox", "transcribe");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(macHome, { recursive: true });
  // Remote binaries live in the fake mini's ~/.local/bin, which the job runner
  // puts first on PATH, so the real Homebrew yt-dlp is never reached.
  writeExecutable(path.join(miniHome, ".local", "bin", "mlx_whisper"), FAKE_MLX);
  writeExecutable(path.join(miniHome, ".local", "bin", "yt-dlp"), FAKE_YTDLP);
  const macBin = path.join(root, "mac-bin");
  writeExecutable(path.join(macBin, "mlx_whisper"), FAKE_MLX);
  writeExecutable(path.join(macBin, "yt-dlp"), FAKE_YTDLP);
  const sshLog = path.join(root, "ssh.log");
  fs.writeFileSync(sshLog, "");
  const env = {
    ...process.env,
    HOME: macHome,
    PATH: `${macBin}:${process.env.PATH}`,
    FAKE_WHERE: "macbook",
    FAKE_MINI_HOME: miniHome,
    FAKE_SSH_LOG: sshLog,
    CYCLONE_TRANSCRIBE_SSH: writeExecutable(path.join(root, "fake-ssh"), FAKE_SSH),
    CYCLONE_TRANSCRIBE_REMOTE_TOOL_DIR: TOOL_ROOT,
    CYCLONE_TRANSCRIBE_ICLOUD_INBOX: inbox,
    CYCLONE_TRANSCRIBE_POLL_SECONDS: "0.2",
    TRANSCRIBE_MLX_COMMAND: path.join(macBin, "mlx_whisper"),
    // Shared by the fake mini through the fake ssh, so a mini-side handoff would show up here too (#49).
    CYCLONE_ICLOUD_ROOT: path.join(root, "icloud-drive"),
  };
  fs.mkdirSync(env.CYCLONE_ICLOUD_ROOT);
  delete env.TRANSCRIBE_LANGUAGE;
  return { root, miniHome, inbox, sshLog, env, out: path.join(root, "harvest"), toWiki: path.join(env.CYCLONE_ICLOUD_ROOT, "Inbox", "to-wiki") };
}

function runClient(ctx, args, extraEnv = {}, { host = "mini-test" } = {}) {
  const r = spawnSync("node", [CLIENT, ...args, ...(host ? ["--host", host] : []), "--out", ctx.out], {
    env: { ...ctx.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60000,
  });
  const report = parseLastJson(r.stdout);
  // Usage errors (exit 2) end before any report; everything else must report.
  if (r.status !== 2) assert.ok(report, `no JSON report on stdout; stderr:\n${r.stderr}`);
  return { ...r, report };
}

function sshCommands(ctx) {
  return fs.readFileSync(ctx.sshLog, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).command.match(/transcript-job\.mjs '(\w+)'/)?.[1]);
}

function jobsLeft(ctx) {
  const root = path.join(ctx.miniHome, ".local", "state", "cyclone-transcript-jobs");
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

function harvestedText(ctx) {
  const file = path.join(ctx.out, "transcripts", "mlx-whisper-large-v3-mlx", "transcript.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).segments[0].text;
}

test("iCloud file runs on the mini, is harvested, and the mini job dir is removed", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "meeting.mp4");
  fs.writeFileSync(file, "synthetic-video");
  const r = runClient(ctx, [file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "mini-test");
  assert.equal(harvestedText(ctx), "hello from mini");
  assert.deepEqual(jobsLeft(ctx), [], "mini job dir must be gone");
  assert.equal(r.report.remote.job_dir_removed, true);
  assert.equal(r.report.remote.cleanup.deleted, 1);
  assert.equal(r.report.consistency.match, true);
  assert.ok(fs.existsSync(file), "the user's original in iCloud is never deleted");
  assert.deepEqual([...new Set(sshCommands(ctx))], ["ping", "start", "status", "pack", "finish", "gc"]);
  assert.ok(fs.existsSync(path.join(ctx.out, "remote-run.json")));
  assert.match(r.stderr, /\[cleanup\] remote media: deleted 1/);
  assert.match(r.stderr, /remote job dir removed/);
});

test("YouTube runs on the mini and the downloaded audio is cleaned there", () => {
  const ctx = setup();
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "mini-test");
  assert.equal(r.report.engine, "mlx");
  assert.equal(harvestedText(ctx), "hello from mini");
  assert.equal(r.report.remote.cleanup.deleted, 1);
  assert.deepEqual(jobsLeft(ctx), []);
});

test("unreachable mini falls back to the MacBook and says why", () => {
  const ctx = setup();
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"], { FAKE_SSH_DOWN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.match(r.report.fallback_reason, /ping failed: .*Connection refused/);
  assert.equal(harvestedText(ctx), "hello from macbook");
  assert.equal(r.report.local_cleanup.deleted, 1);
  assert.deepEqual(sshCommands(ctx), ["ping"], "no job is started when ping fails");
});

test("a failing remote ASR falls back locally and still removes the mini job dir", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "talk.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = runClient(ctx, [file], { FAKE_REMOTE_MLX_FAIL: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.match(r.report.fallback_reason, /remote transcription failed/);
  assert.equal(harvestedText(ctx), "hello from macbook");
  assert.deepEqual(jobsLeft(ctx), [], "failed remote job must still be cleaned up");
  assert.equal(r.report.remote.job_dir_removed, true);
});

test("without a remote host (none set in the profile, no --host) the job runs locally without ssh", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "talk.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = runClient(ctx, [file], {}, { host: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.match(r.report.fallback_reason, /no remote host/);
  assert.deepEqual(sshCommands(ctx), []);
});

test("a file outside the iCloud inbox runs locally without ssh", () => {
  const ctx = setup();
  const file = path.join(ctx.root, "elsewhere.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = runClient(ctx, [file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.deepEqual(sshCommands(ctx), []);
  assert.ok(fs.existsSync(file));
});

test("job runner refuses paths that escape the inbox and non-YouTube URLs", () => {
  const ctx = setup();
  // Real files right outside the inbox, so a missing check would find them.
  const outside = path.join(path.dirname(ctx.inbox), "outside.mp4");
  fs.writeFileSync(outside, "x");
  fs.symlinkSync(outside, path.join(ctx.inbox, "link.mp4"));
  const env = { ...ctx.env, HOME: ctx.miniHome };
  for (const args of [
    ["--icloud", "../outside.mp4"],
    ["--icloud", outside],
    ["--icloud", "link.mp4"],
    ["--url", "https://example.com/video.mp4"],
  ]) {
    const r = spawnSync("node", [JOB, "start", "job-test-001", ...args], { env, encoding: "utf8" });
    assert.notEqual(r.status, 0, args.join(" "));
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /not found/, `${args.join(" ")} must be refused, not merely missing`);
  }
  assert.deepEqual(jobsLeft(ctx), []);
});

test("a failed harvest falls back locally and still finishes the mini job", () => {
  const ctx = setup();
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"], { FAKE_SSH_FAIL_ON: "pack" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.match(r.report.fallback_reason, /harvest failed/);
  assert.equal(harvestedText(ctx), "hello from macbook");
  assert.deepEqual(jobsLeft(ctx), []);
});

test("a remote timeout falls back locally and honestly reports a job dir it could not remove", () => {
  const ctx = setup();
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123", "--timeout-minutes", "0.02"], {
    FAKE_REMOTE_MLX_SLEEP: "4",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "local");
  assert.match(r.report.fallback_reason, /timed out/);
  assert.equal(harvestedText(ctx), "hello from macbook");
  assert.equal(r.report.remote.job_dir_removed, false, "a still-running job cannot be finished");
  assert.match(r.stderr, /REMOTE JOB DIR LEFT/);
});

test("--out must be new or empty, so the fallback can never delete someone's files", () => {
  const ctx = setup();
  fs.mkdirSync(ctx.out);
  fs.writeFileSync(path.join(ctx.out, "keep.txt"), "mine");
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"], { FAKE_SSH_FAIL_ON: "pack" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /new or empty directory/);
  assert.equal(fs.readFileSync(path.join(ctx.out, "keep.txt"), "utf8"), "mine");
  assert.deepEqual(sshCommands(ctx), []);
});

test("job runner re-validates request.json at run time", () => {
  const ctx = setup();
  const env = { ...ctx.env, HOME: ctx.miniHome };
  const dir = path.join(ctx.miniHome, ".local", "state", "cyclone-transcript-jobs", "crafted-job-01");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".cyclone-transcript-job.json"), JSON.stringify({ format: "cyclone-transcript-job-v1" }));
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ url: path.join(ctx.root, "secret.m4a"), icloud: "" }));
  spawnSync("node", [JOB, "run", "crafted-job-01"], { env, encoding: "utf8" });
  const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.match(status.error, /only YouTube URLs/);
  assert.equal(fs.existsSync(path.join(dir, "package")), false);
});

test("abandoned mini job dirs older than 48 h are reaped after a run", () => {
  const ctx = setup();
  const jobs = path.join(ctx.miniHome, ".local", "state", "cyclone-transcript-jobs");
  const orphan = path.join(jobs, "orphan-job-0001");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, ".cyclone-transcript-job.json"), JSON.stringify({ format: "cyclone-transcript-job-v1" }));
  const old = new Date(Date.now() - 72 * 3600 * 1000);
  fs.utimesSync(orphan, old, old);
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.remote.gc_removed, 1);
  assert.deepEqual(jobsLeft(ctx), []);
});

test("a stale remote iCloud sync is reported before relying on the inbox", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "talk.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = runClient(ctx, [file], {
    CYCLONE_TEST_BRCTL_STATUS: "<c> background {sync:has-synced-down last-sync:2020-01-01 03:14:27.390, caught-up}",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.report.remote.icloud_warning, /last synced .* h ago \(background\)/);
  assert.match(r.stderr, /WARNING: remote iCloud last synced/);
});

test("--out must be a new or empty directory, and an existing one is left alone", () => {
  const ctx = setup();
  fs.mkdirSync(ctx.out);
  fs.writeFileSync(path.join(ctx.out, "keep.txt"), "mine");
  const file = path.join(ctx.root, "elsewhere.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = spawnSync("node", [CLIENT, file, "--out", ctx.out], { env: ctx.env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /new or empty directory/);
  assert.equal(fs.readFileSync(path.join(ctx.out, "keep.txt"), "utf8"), "mine");
  assert.deepEqual(sshCommands(ctx), [], "refused before any ssh call");
});

test("an unknown mini iCloud sync state also warns", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "talk.m4a");
  fs.writeFileSync(file, "synthetic-audio");
  const r = runClient(ctx, [file], { CYCLONE_TEST_BRCTL_STATUS: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.report.remote.icloud_warning, /sync state unknown/);
});

test("a non-numeric GC hours setting never reaches the remote command", () => {
  const ctx = setup();
  const r = runClient(ctx, ["https://www.youtube.com/watch?v=vid123"], { CYCLONE_TRANSCRIBE_GC_HOURS: "48; touch /tmp/pwned" });
  assert.equal(r.status, 0, r.stderr);
  const gcCall = fs.readFileSync(ctx.sshLog, "utf8").split("\n").find((l) => l.includes("'gc'"));
  assert.match(gcCall, /'--hours' '48'/);
});

// ---- wiki 交接單（#49）----
test("a remote run writes exactly one wiki handoff on the MacBook, and so does the local fallback", () => {
  const ctx = setup();
  const file = path.join(ctx.inbox, "meeting.mp4");
  fs.writeFileSync(file, "synthetic-video");
  const r = runClient(ctx, [file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.executed_on, "mini-test");
  assert.equal(r.report.handoff.ok, true, r.stderr);
  assert.deepEqual(fs.readdirSync(ctx.toWiki), [r.report.handoff.name], "the mini must not write its own");
  const handoff = fs.readFileSync(path.join(ctx.toWiki, r.report.handoff.name, "handoff.md"), "utf8");
  assert.ok(handoff.includes(`- 來源：${fs.realpathSync(file)}`), handoff);
  assert.match(handoff, /^title: "meeting"$/m);
  assert.match(fs.readFileSync(path.join(ctx.out, "remote-run.json"), "utf8"), /"handoff"/);

  const local = setup();
  const f2 = path.join(local.inbox, "meeting.mp4");
  fs.writeFileSync(f2, "synthetic-video");
  const l = runClient(local, [f2], { FAKE_SSH_DOWN: "1" });
  assert.equal(l.status, 0, l.stderr);
  assert.equal(l.report.executed_on, "local");
  assert.equal(fs.readdirSync(local.toWiki).length, 1, "the local CLI is told not to write a second one");

  const off = setup();
  const f3 = path.join(off.inbox, "meeting.mp4");
  fs.writeFileSync(f3, "synthetic-video");
  const o = runClient(off, [f3, "--no-handoff"]);
  assert.equal(o.status, 0, o.stderr);
  assert.equal(fs.existsSync(off.toWiki), false);
});

test("harvest unpacks the remote tar without trusting its owner (#163)", () => {
  // 解包走 /usr/bin/tar；來源是使用者自己設定的主機，仍不採用 tar 裡記的擁有者
  const src = fs.readFileSync(CLIENT, "utf8");
  assert.match(src, /"\/usr\/bin\/tar", \["-xf", "-", "--no-same-owner", "-C"/);
});
