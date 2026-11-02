// Unit tests for small shared helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLastJson } from "../lib/json-tail.mjs";
import { icloudSyncStatus } from "../scripts/transcript-job.mjs";

test("parseLastJson returns the final top-level object", () => {
  const text = 'progress\n{\n  "engine": "inner"\n}\nmore\n{\n  "engine": "summary",\n  "nested": { "a": 1 }\n}\n';
  assert.deepEqual(parseLastJson(text), { engine: "summary", nested: { a: 1 } });
  assert.deepEqual(parseLastJson('{"a":1}'), { a: 1 });
  assert.equal(parseLastJson(""), null);
  assert.equal(parseLastJson("no json here"), null);
});

test("icloudSyncStatus parses brctl output", () => {
  const recent = new Date(Date.now() - 2 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${recent.getFullYear()}-${pad(recent.getMonth() + 1)}-${pad(recent.getDate())} ${pad(recent.getHours())}:${pad(recent.getMinutes())}:${pad(recent.getSeconds())}`;
  const status = icloudSyncStatus(`<c> foreground {sync:has-synced-down last-sync:${stamp}.004, caught-up}`);
  assert.equal(status.icloud_state, "foreground");
  assert.equal(status.icloud_last_sync, stamp);
  assert.ok(status.icloud_last_sync_age_hours > 1.5 && status.icloud_last_sync_age_hours < 2.5);
  assert.deepEqual(icloudSyncStatus(""), { icloud_state: "unknown", icloud_last_sync: "", icloud_last_sync_age_hours: null });
});

test("tool fingerprint survives a symlink cycle in the tool tree", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cycle-"));
  for (const dir of ["lib", "scripts", "config"]) fs.cpSync(path.join(toolRoot, dir), path.join(copy, dir), { recursive: true });
  const fingerprint = () => {
    const r = spawnSync("node", ["--input-type=module", "-e",
      "const m = await import(process.argv[1]); console.log(m.toolFingerprint());", path.join(copy, "lib", "asr-profile.mjs")],
      { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const before = fingerprint();
  fs.symlinkSync("..", path.join(copy, "lib", "loop"));
  // A cycle must neither crash nor re-hash the same files under a longer path.
  assert.equal(fingerprint(), before);
});

test("a symlinked source file is hashed like a copy", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fingerprintOf = (root) => {
    const r = spawnSync("node", ["--input-type=module", "-e",
      "const m = await import(process.argv[1]); console.log(m.toolFingerprint());", path.join(root, "lib", "asr-profile.mjs")],
      { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "fp-copy-"));
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "fp-link-"));
  for (const dir of ["lib", "scripts", "config"]) {
    fs.cpSync(path.join(toolRoot, dir), path.join(copy, dir), { recursive: true });
    fs.cpSync(path.join(toolRoot, dir), path.join(linked, dir), { recursive: true });
  }
  const target = path.join(linked, "scripts", "vad.mjs");
  fs.renameSync(target, path.join(linked, "vad.real.mjs"));
  fs.symlinkSync(path.join(linked, "vad.real.mjs"), target);
  assert.equal(fingerprintOf(linked), fingerprintOf(copy));
});

test("icloudSyncStatus strips the ANSI colour codes real brctl prints", () => {
  const real = "1 containers matching 'com.apple.CloudDocs'\n<c{1}m.a{3}e.C{7}s[1] \u001b[0;1;32mforeground\u001b[0m {client:idle server:full-sync sync:has-synced-down last-sync:2026-10-05 22:58:30.306, caught-up}>";
  const status = icloudSyncStatus(real);
  assert.equal(status.icloud_state, "foreground");
  assert.equal(status.icloud_last_sync, "2026-10-05 22:58:30");
  assert.equal(icloudSyncStatus(real.replace("32mforeground", "30mbackground")).icloud_state, "background");
});
