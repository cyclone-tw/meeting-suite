import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { driveFolderName, driveRoot, recordingStamp, saveToDrive } from "../lib/studio-drive.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rt-drive-"));

test("recording time comes from the name first, then the video's creation time", () => {
  assert.equal(recordingStamp("2026-10-25 21-01-30", "/x"), "2026-10-25 2101");
  assert.equal(recordingStamp("研習 2026-10-23_1402", "/x"), "2026-10-23 1402");
  assert.equal(recordingStamp("20261007-140038 校內會議", "/x"), "2026-10-07 1400");
  const birth = new Date(2026, 9, 26, 8, 5);
  assert.equal(recordingStamp("家長日", "/v.mp4", { statImpl: () => ({ birthtimeMs: birth.getTime(), birthtime: birth, mtime: new Date() }) }), "2026-10-26 0805");
  assert.equal(recordingStamp("2026-13-40 99-99", "/v", { statImpl: () => { throw new Error("no"); }, now: birth }), "2026-10-26 0805", "不合理的日期不算");
});

test("folder name is date, time and name like the meeting app; a name that is only a time becomes 錄影", () => {
  assert.equal(driveFolderName("2026-10-25 21-01-30", "2026-10-25 2101"), "2026-10-25 2101 錄影");
  assert.equal(driveFolderName("研習 2026-10-23_1402", "2026-10-23 1402"), "2026-10-23 1402 研習");
  assert.equal(driveFolderName("a/b:c", "2026-10-26 0805"), "2026-10-26 0805 a_b_c");
  assert.equal(driveFolderName("", "2026-10-26 0805"), "2026-10-26 0805 錄影");
});

test("the school Drive folder is found by account suffix; an env value overrides, empty turns it off", () => {
  const profile = { studio_drive: { account_suffix: "@school.example", folder: "我的雲端硬碟/會議紀錄" } };
  const readdir = () => ["GoogleDrive-me@gmail.com", "GoogleDrive-me@school.example"];
  assert.equal(driveRoot({}, profile, { home: "/h", readdir }), path.join("/h", "Library", "CloudStorage", "GoogleDrive-me@school.example", "我的雲端硬碟", "會議紀錄"));
  assert.equal(driveRoot({}, profile, { home: "/h", readdir: () => ["GoogleDrive-me@gmail.com"] }), "", "沒掛學校帳號");
  assert.equal(driveRoot({ CYCLONE_STUDIO_DRIVE_DIR: "/d" }, profile), "/d");
  assert.equal(driveRoot({ CYCLONE_STUDIO_DRIVE_DIR: "" }, profile), "");
});

test("saving makes one folder per video, adds (2) for a different video with the same name, and reuses its own folder", () => {
  const root = tmp(), src = tmp();
  fs.writeFileSync(path.join(src, "summary.md"), "總結");
  const a = saveToDrive({ root, name: "2026-10-25 21-01-30", stamp: "2026-10-25 2101", files: [path.join(src, "summary.md"), path.join(src, "nope.md")] });
  assert.deepEqual(a, { folder: "2026-10-25 2101 錄影", files: ["summary.md"] });
  const b = saveToDrive({ root, name: "2026-10-25 21-01-30", stamp: "2026-10-25 2101", files: [path.join(src, "summary.md")] });
  assert.equal(b.folder, "2026-10-25 2101 錄影 (2)", "另一支同名的影片");
  fs.writeFileSync(path.join(src, "summary.md"), "新的總結");
  const again = saveToDrive({ root, existing: a.folder, name: "x", stamp: "x", files: [path.join(src, "summary.md")] });
  assert.equal(again.folder, a.folder);
  assert.equal(fs.readFileSync(path.join(root, a.folder, "summary.md"), "utf8"), "新的總結", "重新產生是覆蓋");
  assert.throws(() => saveToDrive({ root: path.join(root, "missing"), name: "x", stamp: "s", files: [] }), /找不到要存的 Drive 資料夾/);
});

// ---- 在另一個程序裡存（#105）----
import { copyToDriveIsolated, driveDisabled, driveWhere } from "../lib/studio-drive.mjs";

test("the isolated copy finds the folder, copies the files and reports back; a failure keeps the folder it made", async () => {
  const root = tmp(), src = tmp();
  fs.writeFileSync(path.join(src, "summary.md"), "總結");
  const ok = await copyToDriveIsolated({ override: root, profile: {}, home: "/nowhere", name: "家長日", stamp: "2026-10-26 0805", files: [path.join(src, "summary.md")] });
  assert.deepEqual(ok, { root, folder: "2026-10-26 0805 家長日", files: ["summary.md"] });
  await assert.rejects(copyToDriveIsolated({ override: path.join(root, "gone"), profile: {}, name: "x", stamp: "s", files: [] }), /找不到要存的 Drive 資料夾/);
  // 資料夾建好了但檔案複製失敗（目標是個資料夾）：錯誤帶著資料夾名，下次沿用
  fs.mkdirSync(path.join(root, "2026-10-26 0900 x", "summary.md"), { recursive: true });
  await assert.rejects(copyToDriveIsolated({ override: root, profile: {}, existing: "2026-10-26 0900 x", name: "x", stamp: "2026-10-26 0900", files: [path.join(src, "summary.md")] }), (e) => e.folder === "2026-10-26 0900 x");
});

test("a copy that hangs is ended after the timeout; turning Drive off is an empty value or no profile", async () => {
  const hang = path.join(tmp(), "hang.mjs");
  fs.writeFileSync(hang, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const t0 = Date.now();
  await assert.rejects(copyToDriveIsolated({}, { timeoutMs: 200, script: hang }), /Google Drive 超過 0 秒沒有回應/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(driveDisabled({ CYCLONE_STUDIO_DRIVE_DIR: "" }, { studio_drive: { account_suffix: "@x", folder: "f" } }), true);
  assert.equal(driveDisabled({}, {}), true);
  assert.equal(driveDisabled({}, { studio_drive: { account_suffix: "@x", folder: "f" } }), false);
  assert.equal(driveDisabled({ CYCLONE_STUDIO_DRIVE_DIR: "/d" }, {}), false);
});

test("the place shown on the page is the configured label plus the folder name", () => {
  assert.equal(driveWhere({}, { studio_drive: { label: "學校 Drive", folder: "我的雲端硬碟/會議紀錄" } }), "學校 Drive／會議紀錄");
  assert.equal(driveWhere({}, { studio_drive: { folder: "My Drive/Meeting notes" } }), "Google Drive／Meeting notes");
  assert.equal(driveWhere({ CYCLONE_STUDIO_DRIVE_DIR: "/x/存檔" }, {}), "Google Drive／存檔");
});
