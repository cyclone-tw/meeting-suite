// Synthetic tests: language detection, OpenCC
// gating, engine fallback and media cleanup. Fake mlx_whisper / yt-dlp / trash
// binaries keep the suite offline and away from the real Trash.
//
// Run: node --test tools/recording-transcriber/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { shouldApplyOpencc } from "../lib/asr-profile.mjs";
import { useTestProfile } from "./helpers/user-profile.mjs";

useTestProfile({ icloud_inbox: "Inbox", archive: { icloud_prefix: "Transcripts/archive/" } });

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(TOOL_ROOT, "scripts", "transcript-cli.mjs");
const ARCHIVE = path.join(TOOL_ROOT, "scripts", "archive-package.mjs");
const OPENCC_INSTALLED = fs.existsSync(path.join(TOOL_ROOT, "node_modules", "opencc-js"));
const FFMPEG = spawnSync("/usr/bin/which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();

function makeTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "transcriber-test-"));
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// Fake mlx_whisper: records its argv, reports FAKE_MLX_LANGUAGE (or the forced
// --language) and emits FAKE_MLX_TEXT. FAKE_MLX_FAIL=1 exits non-zero;
// FAKE_MLX_HANG_MARKER=<file> writes that file and then hangs until killed.
function fakeMlx(dir) {
  return writeExecutable(path.join(dir, "fake-mlx"), `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_MLX_ARGS, JSON.stringify(args));
if (process.env.FAKE_MLX_FAIL === "1") process.exit(3);
if (process.env.FAKE_MLX_HANG_MARKER) {
  fs.writeFileSync(process.env.FAKE_MLX_HANG_MARKER, "started");
  setInterval(() => {}, 1000);
  return;
}
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ""; };
const language = get("--language") || process.env.FAKE_MLX_LANGUAGE || "";
const text = process.env.FAKE_MLX_TEXT || "hello world";
fs.writeFileSync(
  path.join(get("--output-dir"), get("--output-name") + ".json"),
  JSON.stringify({ text, language, segments: [{ start: 0, end: 1.5, text }] }),
);
`);
}

// Fake yt-dlp: metadata, --list-subs, audio download (FAKE_YT_AUDIO=fail|ok)
// and caption download writing en-orig + zh-Hant VTT files.
function fakeYtDlp(binDir) {
  return writeExecutable(path.join(binDir, "yt-dlp"), `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const out = () => args[args.indexOf("-o") + 1];
if (args.includes("--print")) {
  console.log("vid123|Synthetic Video|Synthetic Channel|2026-10-05|1:00|https://www.youtube.com/watch?v=vid123");
} else if (args.includes("--list-subs")) {
  console.log("Available automatic captions for vid123:\\nLanguage Name Formats\\nen-orig English (Original) vtt\\nzh-Hant Chinese (Traditional) vtt");
} else if (args.includes("-x")) {
  if (process.env.FAKE_YT_MP3) {
    const file = out().replace("%(upload_date>%Y-%m-%d)s-%(title)s.%(ext)s", "2026-10-05-Synthetic.mp3");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(process.env.FAKE_YT_MP3, file);
    process.exit(0);
  }
  if (process.env.FAKE_YT_AUDIO === "fail") { console.error("ERROR: unable to download video data: HTTP Error 403: Forbidden"); process.exit(1); }
  const file = out().replace("%(upload_date>%Y-%m-%d)s-%(title)s.%(ext)s", "2026-10-05-Synthetic.mp3");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "synthetic-mp3");
  fs.writeFileSync(file.replace(/\\.mp3$/, ".webm.part"), "synthetic-partial");
} else if (args.includes("--write-subs")) {
  if (process.env.FAKE_YT_CAPTIONS === "fail") { console.error("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests"); process.exit(1); }
  const dir = path.dirname(out());
  const cue = (text) => "WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\n" + text + "\\n";
  fs.writeFileSync(path.join(dir, "vid123.en-orig.vtt"), cue("software is great"));
  fs.writeFileSync(path.join(dir, "vid123.zh-Hant.vtt"), cue("软件很棒"));
}
`);
}

function setup() {
  const root = makeTemp();
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const argsFile = path.join(root, "mlx-args.json");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRANSCRIBE_MLX_COMMAND: fakeMlx(root),
    FAKE_MLX_ARGS: argsFile,
    // Keep the host's private Wiki vocabulary out of these runs (#755).
    CYCLONE_ASR_OWNER_HOME: root,
    // The wiki handoff goes to a temp "iCloud Drive", never this Mac's real one (#49).
    CYCLONE_ICLOUD_ROOT: path.join(root, "icloud-drive"),
  };
  fs.mkdirSync(env.CYCLONE_ICLOUD_ROOT);
  delete env.TRANSCRIBE_LANGUAGE;
  fakeYtDlp(bin);
  const source = path.join(root, "talk.m4a");
  fs.writeFileSync(source, "synthetic-audio");
  return { root, env, argsFile, source, out: path.join(root, "package"), toWiki: path.join(env.CYCLONE_ICLOUD_ROOT, "Inbox", "to-wiki") };
}

function runCli(ctx, args, extraEnv = {}) {
  return spawnSync("node", [CLI, ...args, "--out", ctx.out], {
    cwd: ctx.root,
    env: { ...ctx.env, ...extraEnv },
    encoding: "utf8",
  });
}

function mlxTranscript(ctx) {
  const dir = path.join(ctx.out, "transcripts", "mlx-whisper-large-v3-mlx");
  return JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8"));
}

function manifest(ctx) {
  return JSON.parse(fs.readFileSync(path.join(ctx.out, "manifest.json"), "utf8"));
}

// Public runs inherit the engine's stdout, so the CLI summary is the last JSON
// object printed, not the whole stream.
function summaryOf(r) {
  const start = r.stdout.lastIndexOf("\n{\n");
  return JSON.parse(start >= 0 ? r.stdout.slice(start + 1) : r.stdout);
}

function receipt(ctx) {
  return JSON.parse(fs.readFileSync(path.join(ctx.out, "cleanup-receipt.json"), "utf8"));
}

test("auto language does not force Chinese and keeps English text", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], {
    FAKE_MLX_LANGUAGE: "en",
    FAKE_MLX_TEXT: "software 软件",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!JSON.parse(fs.readFileSync(ctx.argsFile, "utf8")).includes("--language"));
  const transcript = mlxTranscript(ctx);
  assert.equal(transcript.language, "en");
  assert.equal(transcript.segments[0].text, "software 软件", "OpenCC must not run on English");
});

test("detected Chinese still gets OpenCC cn->twp", { skip: !OPENCC_INSTALLED }, () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], {
    FAKE_MLX_LANGUAGE: "zh",
    FAKE_MLX_TEXT: "软件",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mlxTranscript(ctx).segments[0].text, "軟體");
});

test("explicit --language is passed to mlx_whisper", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx", "--language", "en"]);
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(fs.readFileSync(ctx.argsFile, "utf8"));
  assert.equal(args[args.indexOf("--language") + 1], "en");
});

test("invalid --language is rejected before any output", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx", "--language", "en;rm"]);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(ctx.out), false);
});

test("candidates record host, tool fingerprint and ASR profile hash", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"]);
  assert.equal(r.status, 0, r.stderr);
  const runtime = manifest(ctx).transcription_candidates[0].runtime;
  assert.match(runtime.tool_fingerprint, /^[0-9a-f]{16}$/);
  assert.match(runtime.asr_profile_sha256, /^[0-9a-f]{16}$/);
  assert.ok(runtime.host);
  assert.equal(manifest(ctx).transcription_candidates[0].condition_on_previous_text, false);
});

test("media copied for the run is deleted at the end; transcripts and pre-existing files stay", () => {
  const ctx = setup();
  fs.mkdirSync(path.join(ctx.out, "source"), { recursive: true });
  fs.writeFileSync(path.join(ctx.out, "source", "someone-elses.mp3"), "keep me");
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(ctx.out, "source", "original.m4a")), false);
  assert.equal(fs.existsSync(path.join(ctx.out, "source", "someone-elses.mp3")), true);
  assert.equal(fs.existsSync(ctx.source), true, "the caller's original is never touched");
  assert.ok(fs.existsSync(path.join(ctx.out, "transcripts", "mlx-whisper-large-v3-mlx", "transcript.md")));
  const rec = receipt(ctx);
  assert.deepEqual(rec.deleted, ["source/original.m4a"]);
  assert.equal(rec.leftovers.length, 0);
  assert.equal(manifest(ctx).media_retention.keep_media, false);
  assert.match(r.stderr, /\[cleanup\] deleted 1 file/);
  assert.equal(summaryOf(r).cleanup.deleted, 1);
});

test("--keep-media keeps the media and says so", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx", "--keep-media"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(ctx.out, "source", "original.m4a")), true);
  assert.deepEqual(receipt(ctx).kept, ["source/original.m4a"]);
  assert.match(r.stderr, /--keep-media/);
});

test("a failed run still removes its media", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], { FAKE_MLX_FAIL: "1" });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(ctx.out, "source", "original.m4a")), false);
  assert.deepEqual(receipt(ctx).deleted, ["source/original.m4a"]);
});

test("when hard delete fails the file goes to trash and the receipt says trashed", () => {
  const ctx = setup();
  const fakeTrashDir = path.join(ctx.root, "fake-trash");
  fs.mkdirSync(fakeTrashDir);
  const fakeTrash = writeExecutable(path.join(ctx.root, "fake-trash-cmd"),
    `#!/bin/sh\nmv "$1" "${fakeTrashDir}/"\n`);
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], {
    TRANSCRIPT_CLEANUP_TEST_FAIL_DELETE: "1",
    TRANSCRIPT_CLEANUP_TRASH_COMMAND: fakeTrash,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(receipt(ctx).trashed, ["source/original.m4a"]);
  assert.ok(fs.existsSync(path.join(fakeTrashDir, "original.m4a")));
  assert.match(r.stderr, /trashed 1 file.*still on disk/);
});

test("YouTube auto prefers MLX and falls back to original-language captions when the audio download fails", () => {
  const ctx = setup();
  const r = runCli(ctx, ["https://www.youtube.com/watch?v=vid123"], { FAKE_YT_AUDIO: "fail" });
  assert.equal(r.status, 0, r.stderr);
  const summary = summaryOf(r);
  assert.equal(summary.engine, "captions");
  assert.equal(summary.fallbacks[0].from, "mlx");
  assert.match(summary.fallbacks[0].reason, /403/);
  assert.equal(manifest(ctx).engine_fallbacks.length, 1);
  const segments = JSON.parse(fs.readFileSync(
    path.join(ctx.out, "transcripts", "captions", "segments.json"), "utf8")).segments;
  assert.equal(segments[0].text, "software is great", "must pick en-orig, not the zh translation");
});

test("YouTube via MLX removes the downloaded audio and partial files", () => {
  const ctx = setup();
  const r = runCli(ctx, ["https://www.youtube.com/watch?v=vid123"], { FAKE_MLX_LANGUAGE: "en" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summaryOf(r).engine, "mlx");
  assert.deepEqual(fs.readdirSync(path.join(ctx.out, "source")), []);
  assert.equal(receipt(ctx).deleted.length, 2);
});

test("unknown-language heuristic: Chinese (both scripts) yes, English/Japanese/Korean no", () => {
  assert.equal(shouldApplyOpencc("", "我們的時間是寶貴的"), true);
  assert.equal(shouldApplyOpencc("", "软件开发"), true);
  assert.equal(shouldApplyOpencc("", "\u4e00\u9fff"), true, "U+4E00..U+9FFF is in range");
  assert.equal(shouldApplyOpencc("", "hello world"), false);
  assert.equal(shouldApplyOpencc("", "ひらがなと漢字"), false);
  assert.equal(shouldApplyOpencc("", "한국어 漢字"), false);
  assert.equal(shouldApplyOpencc("en", "软件"), false, "a known language wins over the heuristic");
  assert.equal(shouldApplyOpencc("zh", "hello"), true);
});

test("--language without a value is an error, not a silent auto", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx", "--language"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--language needs a value/);
  assert.equal(fs.existsSync(ctx.out), false);
});

test("without MLX, a caption 429 falls back to groq and the audio is materialized first", { skip: !FFMPEG }, () => {
  const ctx = setup();
  const mp3 = path.join(ctx.root, "tiny.mp3");
  spawnSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", mp3]);
  const r = runCli(ctx, ["https://www.youtube.com/watch?v=vid123", "--groq-dry-run"], {
    TRANSCRIBE_MLX_COMMAND: path.join(ctx.root, "no-such-mlx"),
    FAKE_YT_CAPTIONS: "fail",
    FAKE_YT_MP3: mp3,
    HOME: ctx.root,
  });
  assert.equal(r.status, 0, r.stderr);
  const summary = summaryOf(r);
  assert.equal(summary.engine, "groq");
  assert.deepEqual(summary.fallbacks.map((f) => [f.from, f.to]), [["captions", "groq"]]);
  assert.match(summary.fallbacks[0].reason, /429/);
  const kinds = manifest(ctx).source_files.map((f) => f.kind);
  assert.ok(kinds.includes("youtube-audio"), "audio was prepared before groq ran");
  assert.deepEqual(receipt(ctx).deleted, ["source/2026-10-05-Synthetic.mp3"]);
});

// --- engine scratch files (#747): nothing may stay behind in the temp dir ---

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("Groq --vad leaves no scratch audio in the temp dir", { skip: !FFMPEG }, () => {
  const ctx = setup();
  const tmp = path.join(ctx.root, "tmp");
  fs.mkdirSync(tmp);
  const mp3 = path.join(ctx.root, "tone.mp3");
  spawnSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", mp3]);
  const r = runCli(ctx, [mp3, "--engine", "groq", "--vad", "--groq-dry-run"], { TMPDIR: tmp, HOME: ctx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summaryOf(r).engine, "groq");
  assert.deepEqual(fs.readdirSync(tmp), [], "the VAD output must not outlive the run");
  assert.deepEqual(receipt(ctx).deleted, ["source/original.mp3"]);
});

test("an interrupted run removes the engine scratch dir as well as the copied media", async () => {
  const ctx = setup();
  const tmp = path.join(ctx.root, "tmp");
  fs.mkdirSync(tmp);
  const started = path.join(ctx.root, "mlx-started");
  const child = spawn("node", [CLI, ctx.source, "--engine", "mlx", "--out", ctx.out], {
    cwd: ctx.root,
    env: { ...ctx.env, TMPDIR: tmp, FAKE_MLX_HANG_MARKER: started },
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await waitFor(() => fs.existsSync(started));
  assert.equal(fs.readdirSync(tmp).length, 1, "the MLX engine holds one scratch dir while it runs");
  process.kill(-child.pid, "SIGINT"); // Ctrl-C reaches the whole process group
  await exited;
  assert.deepEqual(fs.readdirSync(tmp), [], "the engine scratch dir must not outlive an interrupt");
  assert.equal(fs.existsSync(path.join(ctx.out, "source", "original.m4a")), false);
});

test("transcript then iCloud archive leaves no package, media or scratch files behind", () => {
  const ctx = setup();
  const tmp = path.join(ctx.root, "tmp");
  const icloud = path.join(ctx.root, "icloud");
  fs.mkdirSync(tmp);
  fs.mkdirSync(icloud);
  const env = { TMPDIR: tmp, CYCLONE_ICLOUD_ROOT: icloud };
  const t = runCli(ctx, [ctx.source, "--engine", "mlx", "--keep-media"], env);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stderr, /\[cleanup\] --keep-media/);
  const dest = "Transcripts/archive/2026/10/2026-10-13--synthetic-talk--rec001";
  const a = spawnSync("node", [ARCHIVE, ctx.out, "--dest", dest], { env: { ...ctx.env, ...env }, encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /\[archive\] .*skipped 1 media file\(s\).*local package removed/);
  assert.equal(fs.existsSync(ctx.out), false, "the local package is gone");
  assert.deepEqual(fs.readdirSync(tmp), [], "no engine scratch files are left");
  assert.ok(fs.existsSync(ctx.source), "the caller's original is never touched");
  const archived = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else archived.push(path.relative(path.join(icloud, dest), abs));
    }
  };
  walk(path.join(icloud, dest));
  assert.ok(archived.includes("transcripts/mlx-whisper-large-v3-mlx/transcript.md"), archived.join(", "));
  assert.deepEqual(archived.filter((rel) => !/\.(md|json|srt|vtt|txt)$/.test(rel)), [], "text results only");
});

// ---- wiki 交接單（#49）----
test("a finished run writes one wiki handoff to iCloud to-wiki; --no-handoff skips it", () => {
  const ctx = setup();
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], { FAKE_MLX_TEXT: "今天談 Claude Code" });
  assert.equal(r.status, 0, r.stderr);
  const summary = summaryOf(r);
  assert.equal(summary.handoff.ok, true, r.stderr);
  assert.deepEqual(fs.readdirSync(ctx.toWiki), [summary.handoff.name]);
  assert.match(summary.handoff.name, /^\d{4}-\d{2}-\d{2}--talk$/);
  assert.match(r.stderr, /\[handoff\] wrote iCloud Drive\/Inbox\/to-wiki\//);
  const dir = path.join(ctx.toWiki, summary.handoff.name);
  const handoff = fs.readFileSync(path.join(dir, "handoff.md"), "utf8");
  assert.ok(handoff.includes(`- 來源：${ctx.source}`), handoff);
  assert.match(handoff, /轉錄方式：mlx/);
  assert.ok(handoff.includes(`轉錄包：${ctx.out}`), "points at the local package");
  assert.match(fs.readFileSync(path.join(dir, "transcript.md"), "utf8"), /\*\*\[00:00:00\]\*\* 今天談 Claude Code/);

  const again = setup();
  const skipped = runCli(again, [again.source, "--engine", "mlx", "--no-handoff"]);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(summaryOf(skipped).handoff, { skipped: true });
  assert.equal(fs.existsSync(again.toWiki), false);
});

test("without iCloud Drive the transcript still succeeds and the missing handoff is reported", () => {
  const ctx = setup();
  const missing = path.join(ctx.root, "no-icloud");
  const r = runCli(ctx, [ctx.source, "--engine", "mlx"], { CYCLONE_ICLOUD_ROOT: missing });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summaryOf(r).handoff.ok, false);
  assert.match(r.stderr, /\[handoff\] FAILED, no wiki handoff written: 找不到 iCloud Drive/);
  assert.equal(fs.existsSync(missing), false, "never creates a stand-in iCloud folder");
  assert.ok(fs.existsSync(path.join(ctx.out, "manifest.json")));
});
