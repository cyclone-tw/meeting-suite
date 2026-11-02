// Tests for verified archive to Google Drive and to an iCloud Drive folder.
// Temp dirs stand in for the Google Drive mount (CYCLONE_DRIVE_MOUNT) and the
// iCloud Drive root (CYCLONE_ICLOUD_ROOT); the destinations come from a test
// user profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useTestProfile } from "./helpers/user-profile.mjs";

useTestProfile({ archive: { drive_prefix: "Archive/recording-transcripts/", icloud_prefix: "Transcripts/archive/" } });

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(TOOL_ROOT, "scripts", "archive-package.mjs");
const DEST = "Archive/recording-transcripts/2026/10/2026-10-06--synthetic-talk--rec001";
const ICLOUD_DEST = "Transcripts/archive/2026/10/2026-10-13--synthetic-talk--rec001";

function setup({ privacy = "public", mount = true, icloud = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-test-"));
  const drive = path.join(root, "drive");
  if (mount) fs.mkdirSync(path.join(drive, "Archive", "recording-transcripts"), { recursive: true });
  const icloudRoot = path.join(root, "icloud");
  if (icloud) fs.mkdirSync(icloudRoot);
  const pkg = path.join(root, "package");
  fs.mkdirSync(path.join(pkg, "transcripts", "mlx"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "source"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "manifest.json"), JSON.stringify({ privacy, package_id: "p1" }));
  fs.writeFileSync(path.join(pkg, "transcripts", "mlx", "transcript.md"), "# hello\n");
  fs.writeFileSync(path.join(pkg, "source", "captions.vtt"), "WEBVTT\n");
  fs.writeFileSync(path.join(pkg, "source", "audio.m4a"), Buffer.alloc(300000, 7));
  return {
    root,
    drive,
    icloud: icloudRoot,
    pkg,
    env: { ...process.env, CYCLONE_DRIVE_MOUNT: drive, CYCLONE_ICLOUD_ROOT: icloudRoot },
  };
}

function run(ctx, args, extraEnv = {}) {
  return spawnSync("node", [ARCHIVE, ...args], { env: { ...ctx.env, ...extraEnv }, encoding: "utf8" });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const a = path.join(d, n);
      if (fs.statSync(a).isDirectory()) walk(a);
      else out[path.relative(dir, a)] = fs.readFileSync(a).toString("base64");
    }
  };
  walk(dir);
  return out;
}

test("archives to Drive, verifies, then removes the local package", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(ctx.pkg), false, "local package must be gone");
  const target = path.join(ctx.drive, DEST);
  const after = snapshot(target);
  for (const rel of Object.keys(before)) {
    if (rel === "manifest.json") continue;
    assert.equal(after[rel], before[rel], `${rel} must be identical on Drive`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.drive_path, DEST);
  assert.equal(manifest.asset_package.drive_path, DEST);
  const receipt = JSON.parse(fs.readFileSync(path.join(target, "archive-receipt.json"), "utf8"));
  assert.equal(receipt.files, 4);
  assert.equal(receipt.local_removed, true);
  assert.equal(receipt.verified, "size+sha256");
  assert.equal(receipt.media_skipped, 0, "Drive keeps media by default (MacBook route unchanged)");
  assert.match(r.stderr, /\[archive\] copied 4 file\(s\).*local package removed/);
});

test("a verification mismatch keeps the local package and removes the partial Drive copy", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", DEST], { TRANSCRIPT_ARCHIVE_TEST_CORRUPT: "source/audio.m4a" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /verification failed for source\/audio\.m4a; local package kept/);
  assert.deepEqual(snapshot(ctx.pkg), before, "local package (manifest included) must be untouched");
  assert.equal(fs.existsSync(path.join(ctx.drive, DEST)), false);
});

test("a copy failure keeps the local package", { skip: process.getuid?.() === 0 }, () => {
  const ctx = setup();
  const unreadable = path.join(ctx.pkg, "transcripts", "mlx", "transcript.md");
  fs.chmodSync(unreadable, 0o000);
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  fs.chmodSync(unreadable, 0o644);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(ctx.pkg, "source", "audio.m4a")));
  assert.equal(fs.existsSync(path.join(ctx.drive, DEST)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.pkg, "manifest.json"), "utf8")).drive_path, undefined);
});

test("refusals touch nothing", () => {
  const cases = [
    ["outside the allowed root", setup(), ["--dest", "Archive/Private/recording-transcripts/2026/10/2026-10-06--x--rec001"], /must be under/],
    ["path traversal", setup(), ["--dest", "Archive/recording-transcripts/../../x/2026-10-06--x--rec001"], /plain relative path/],
    ["non-neutral folder name", setup(), ["--dest", "Archive/recording-transcripts/2026/10/Some Student Name"], /YYYY-MM-DD--neutral-slug--rec001/],
    ["missing Drive mount", setup({ mount: false }), ["--dest", DEST], /Google Drive mount not found/],
  ];
  for (const [name, ctx, args, message] of cases) {
    const before = snapshot(ctx.pkg);
    const r = run(ctx, [ctx.pkg, ...args]);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, message, name);
    assert.deepEqual(snapshot(ctx.pkg), before, `${name}: local package untouched`);
  }
});

test("an existing non-empty destination is never overwritten", () => {
  const ctx = setup();
  const target = path.join(ctx.drive, DEST);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "existing.md"), "keep");
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists and is not empty/);
  assert.deepEqual(fs.readdirSync(target), ["existing.md"]);
  assert.ok(fs.existsSync(ctx.pkg));
});

test("packages marked student-private or without a privacy value archive like any other", () => {
  for (const privacy of ["student-private", null]) {
    const ctx = setup({ privacy });
    const r = run(ctx, [ctx.pkg, "--dest", DEST]);
    assert.equal(r.status, 0, `${privacy}: ${r.stderr}`);
    assert.equal(fs.existsSync(ctx.pkg), false);
  }
});

test("a package in use (lock present) is refused", () => {
  const ctx = setup({ privacy: "sensitive" });
  fs.writeFileSync(path.join(ctx.pkg, ".cyclone-transcript.lock"), "{}");
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /in use/);
  assert.ok(fs.existsSync(ctx.pkg));
});

test("a symlink in the package is refused before the manifest is touched", () => {
  const ctx = setup();
  fs.symlinkSync("/etc/hosts", path.join(ctx.pkg, "source", "link.txt"));
  const manifestBefore = fs.readFileSync(path.join(ctx.pkg, "manifest.json"), "utf8");
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /symlink/);
  assert.equal(fs.readFileSync(path.join(ctx.pkg, "manifest.json"), "utf8"), manifestBefore);
  assert.equal(fs.existsSync(path.join(ctx.drive, DEST)), false);
});

test("a symlinked manifest is refused", () => {
  const ctx = setup();
  const real = path.join(ctx.root, "elsewhere.json");
  fs.renameSync(path.join(ctx.pkg, "manifest.json"), real);
  fs.symlinkSync(real, path.join(ctx.pkg, "manifest.json"));
  const before = fs.readFileSync(real, "utf8");
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(real, "utf8"), before);
});

test("a failure into a pre-existing empty destination leaves it empty again", () => {
  const ctx = setup();
  const target = path.join(ctx.drive, DEST);
  fs.mkdirSync(target, { recursive: true });
  const r = run(ctx, [ctx.pkg, "--dest", DEST], { TRANSCRIPT_ARCHIVE_TEST_CORRUPT: "source/audio.m4a" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(fs.readdirSync(target), [], "no leftover subdirectories, so a retry is not refused");
  assert.ok(fs.existsSync(path.join(ctx.pkg, "source", "audio.m4a")));
});

test("if the Drive receipt cannot be written, nothing local is deleted", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", DEST], { TRANSCRIPT_ARCHIVE_TEST_FAIL_RECEIPT: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /receipt write failed; local package kept/);
  assert.deepEqual(snapshot(ctx.pkg), before);
  assert.equal(fs.existsSync(path.join(ctx.drive, DEST)), false);
});

test("the package lock is held during the run and never copied to Drive", () => {
  const ctx = setup();
  const r = run(ctx, [ctx.pkg, "--dest", DEST]);
  assert.equal(r.status, 0, r.stderr);
  const target = path.join(ctx.drive, DEST);
  assert.equal(fs.existsSync(path.join(target, ".cyclone-transcript.lock")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "archive-receipt.json"), "utf8")).local_removed, true);
});

test("a failure updating the final receipt is reported, not thrown, once local is gone", () => {
  const ctx = setup();
  const r = run(ctx, [ctx.pkg, "--dest", DEST], { TRANSCRIPT_ARCHIVE_TEST_FAIL_RECEIPT: "final" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(ctx.pkg), false);
  assert.match(r.stderr, /WARNING: Drive receipt still says local_removed=false/);
  const receipt = JSON.parse(fs.readFileSync(path.join(ctx.drive, DEST, "archive-receipt.json"), "utf8"));
  assert.equal(receipt.local_removed, false);
  assert.equal(receipt.files, 4);
});

// --- iCloud transcript folder ---

test("archives to the iCloud folder with text results only by default", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", ICLOUD_DEST]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(ctx.pkg), false, "local package, audio included, must be gone");
  const target = path.join(ctx.icloud, ICLOUD_DEST);
  const after = snapshot(target);
  assert.deepEqual(Object.keys(after).sort(), [
    "archive-receipt.json",
    "manifest.json",
    "source/captions.vtt",
    "transcripts/mlx/transcript.md",
  ]);
  for (const rel of ["source/captions.vtt", "transcripts/mlx/transcript.md"]) {
    assert.equal(after[rel], before[rel], `${rel} must be identical in iCloud`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.icloud_path, ICLOUD_DEST);
  assert.equal(manifest.asset_package.storage, "icloud-drive");
  assert.equal(manifest.asset_package.media_included, false);
  assert.equal(manifest.drive_path, undefined, "an iCloud archive never claims a Drive path");
  const receipt = JSON.parse(fs.readFileSync(path.join(target, "archive-receipt.json"), "utf8"));
  assert.equal(receipt.storage, "icloud-drive");
  assert.equal(receipt.icloud_path, ICLOUD_DEST);
  assert.equal(receipt.files, 3);
  assert.equal(receipt.media_skipped, 1);
  assert.equal(receipt.local_removed, true);
  assert.equal(receipt.verified, "size+sha256");
  assert.match(
    r.stderr,
    /\[archive\] copied 3 file\(s\) \(.* MB\) to iCloud Drive\/Transcripts\/archive\/2026\/10\/2026-10-13--synthetic-talk--rec001; verified size\+sha256; skipped 1 media file\(s\).*; local package removed/,
  );
  assert.deepEqual(fs.readdirSync(path.join(ctx.drive, "Archive", "recording-transcripts")), [],
    "never falls back to Drive");
});

test("--include-media also archives the audio to the iCloud zone", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", ICLOUD_DEST, "--include-media"]);
  assert.equal(r.status, 0, r.stderr);
  const target = path.join(ctx.icloud, ICLOUD_DEST);
  assert.equal(snapshot(target)["source/audio.m4a"], before["source/audio.m4a"]);
  const receipt = JSON.parse(fs.readFileSync(path.join(target, "archive-receipt.json"), "utf8"));
  assert.equal(receipt.files, 4);
  assert.equal(receipt.media_skipped, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).asset_package.media_included, true);
  assert.doesNotMatch(r.stderr, /skipped/);
});

test("iCloud refusals touch nothing, local or in iCloud", () => {
  const cases = [
    ["missing iCloud Drive", setup({ icloud: false }), ICLOUD_DEST, /iCloud Drive folder not found/],
    ["outside the zone", setup(), "Transcripts/other/2026/10/2026-10-13--x--rec001", /must be under/],
    ["no YYYY/MM folders", setup(), "Transcripts/archive/2026-10-13--x--rec001", /Transcripts\/archive\/YYYY\/MM\//],
    ["YYYY/MM does not match the date", setup(), "Transcripts/archive/2026/09/2026-10-13--x--rec001", /Transcripts\/archive\/YYYY\/MM\//],
    ["non-neutral folder name", setup(), "Transcripts/archive/2026/10/Some Student Name", /YYYY-MM-DD--neutral-slug--rec001/],
    ["path traversal", setup(), "Transcripts/archive/../../x/2026/10/2026-10-13--x--rec001", /plain relative path/],
  ];
  for (const [name, ctx, dest, message] of cases) {
    const before = snapshot(ctx.pkg);
    const r = run(ctx, [ctx.pkg, "--dest", dest]);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, message, name);
    assert.deepEqual(snapshot(ctx.pkg), before, `${name}: local package untouched`);
    if (name === "missing iCloud Drive") assert.equal(fs.existsSync(ctx.icloud), false, "no local stand-in is created");
    else assert.deepEqual(fs.readdirSync(ctx.icloud), [], `${name}: nothing written to iCloud`);
  }
});

test("an existing non-empty iCloud destination is never overwritten", () => {
  const ctx = setup();
  const target = path.join(ctx.icloud, ICLOUD_DEST);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "existing.md"), "keep");
  const r = run(ctx, [ctx.pkg, "--dest", ICLOUD_DEST]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists and is not empty/);
  assert.deepEqual(fs.readdirSync(target), ["existing.md"]);
  assert.ok(fs.existsSync(path.join(ctx.pkg, "source", "audio.m4a")));
});

test("an iCloud verification mismatch keeps the local package and removes the partial copy", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", ICLOUD_DEST], { TRANSCRIPT_ARCHIVE_TEST_CORRUPT: "transcripts/mlx/transcript.md" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /verification failed for transcripts\/mlx\/transcript\.md; local package kept/);
  assert.deepEqual(snapshot(ctx.pkg), before, "local package, audio and manifest included, must be untouched");
  assert.equal(fs.existsSync(path.join(ctx.icloud, ICLOUD_DEST)), false);
});

test("without archive destinations in the user profile, archive refuses and touches nothing", () => {
  const ctx = setup();
  const before = snapshot(ctx.pkg);
  const r = run(ctx, [ctx.pkg, "--dest", DEST], { CYCLONE_ASR_PROFILE_USER: "" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no archive destination/);
  assert.deepEqual(snapshot(ctx.pkg), before);
});
