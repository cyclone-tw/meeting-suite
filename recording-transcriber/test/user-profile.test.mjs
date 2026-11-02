// 使用者設定檔：repo 只放通用預設，個人值放 ~/.config/recording-transcriber/asr-profile.json
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { icloudInboxDir, icloudInboxName, mergeProfile, remoteHost, remoteToolDirShell, userProfilePath } from "../lib/asr-profile.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the user file overrides the repo defaults key by key; objects merge, lists and values replace", () => {
  const base = { language: "auto", opencc: { enabled: true, from: "cn", to: "twp" }, vocabulary: { a: "A" }, list: [1, 2] };
  const merged = mergeProfile(base, { opencc: { enabled: false }, vocabulary: { b: "B" }, list: [3], icloud_inbox: "Inbox" });
  assert.deepEqual(merged, { language: "auto", opencc: { enabled: false, from: "cn", to: "twp" }, vocabulary: { a: "A", b: "B" }, list: [3], icloud_inbox: "Inbox" });
  assert.deepEqual(base.opencc, { enabled: true, from: "cn", to: "twp" }, "預設值本身不被改到");
  assert.deepEqual(mergeProfile(base, null), base);
});

test("the user file lives in ~/.config; tests never read the real one", () => {
  assert.equal(userProfilePath({ CYCLONE_ASR_PROFILE_USER: "/x/p.json" }), "/x/p.json");
  assert.equal(userProfilePath({ CYCLONE_ASR_PROFILE_USER: "" }), "");
  assert.equal(userProfilePath({ NODE_TEST_CONTEXT: "child-v8" }), "", "跑測試時不讀這台的真設定");
  assert.equal(userProfilePath({ CYCLONE_ASR_OWNER_HOME: "/h" }).replace(/^.*?(\.config)/, "$1"), path.join(".config", "recording-transcriber", "asr-profile.json"));
});

test("a script reads the user file and the user's values win over the repo defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-user-profile-"));
  const file = path.join(dir, "asr-profile.json");
  fs.writeFileSync(file, JSON.stringify({ language: "en", icloud_inbox: "Inbox", vocabulary: { "Cloud Code": "Claude Code" } }));
  const script = `const m = await import(process.argv[1]); const { profile, user_file } = m.loadAsrProfile();
    console.log(JSON.stringify({ language: profile.language, model: profile.mlx_model, inbox: profile.icloud_inbox, vocab: profile.vocabulary, user_file }));`;
  const run = (env) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", script, path.join(TOOL_ROOT, "lib", "asr-profile.mjs")], { encoding: "utf8", env: { ...process.env, ...env } }).stdout);
  const mine = run({ CYCLONE_ASR_PROFILE_USER: file });
  assert.deepEqual(mine, { language: "en", model: "mlx-community/whisper-large-v3-mlx", inbox: "Inbox", vocab: { "Cloud Code": "Claude Code" }, user_file: file });
  const none = run({ CYCLONE_ASR_PROFILE_USER: "" });
  assert.deepEqual([none.language, none.inbox, none.vocab, none.user_file], ["auto", undefined, {}, ""], "沒有使用者設定就是通用預設");
  fs.writeFileSync(file, "{ broken");
  const bad = spawnSync(process.execPath, ["--input-type=module", "-e", script, path.join(TOOL_ROOT, "lib", "asr-profile.mjs")], { encoding: "utf8", env: { ...process.env, CYCLONE_ASR_PROFILE_USER: file } });
  assert.notEqual(bad.status, 0, "壞掉的設定檔要說出來，不默默用預設");
  assert.match(bad.stderr, /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("optional features are off until the user sets them", () => {
  assert.equal(icloudInboxName({}), "");
  assert.equal(icloudInboxName({ icloud_inbox: "../x" }), "", "不能跳出 iCloud Drive");
  assert.equal(icloudInboxName({ icloud_inbox: "/Inbox/" }), "Inbox");
  assert.equal(icloudInboxDir("studio", { profile: {}, home: "/h" }), "");
  assert.equal(icloudInboxDir("studio", { profile: { icloud_inbox: "Inbox" }, home: "/h" }), "/h/Library/Mobile Documents/com~apple~CloudDocs/Inbox/studio");
  assert.equal(remoteHost({}, {}), "");
  assert.equal(remoteHost({}, { remote_host: "studio-mac" }), "studio-mac");
  assert.equal(remoteHost({ CYCLONE_TRANSCRIBE_REMOTE_HOST: "other" }, { remote_host: "studio-mac" }), "other");
});

test("the remote Mac runs the tool from the same place relative to its home", () => {
  assert.equal(remoteToolDirShell({}, { home: "/Users/a", root: "/Users/a/src/meeting-suite/recording-transcriber" }), `"$HOME"/'src/meeting-suite/recording-transcriber'`);
  assert.equal(remoteToolDirShell({}, { home: "/Users/a", root: "/opt/rt" }), "'/opt/rt'", "不在家目錄底下就用完整路徑");
  assert.equal(remoteToolDirShell({ CYCLONE_TRANSCRIBE_REMOTE_TOOL_DIR: "/srv/it's" }, {}), `'/srv/it'\\''s'`);
});
