// 影片庫（#184）：資料夾掃成樹、清單存讀
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addEntry, backupBroken, isListedVideo, loadLibrary, removeEntry, saveLibrary, scanFolder } from "../lib/library.mjs";

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-lib-"));
  const put = (rel, mtime) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); if (mtime) fs.utimesSync(f, mtime, mtime); };
  put("舊的.mp4", 1000);
  put("新的.MOV", 2000);
  put("筆記.txt");
  put(".隱藏.mp4");
  put("新的-字幕.mp4");
  put("新的-剪輯.mp4");
  put("新的-短片-01.mp4");
  put("新的-字幕/project.json");
  put("YouTube 下載/A [abc].mp4");
  put("YouTube 下載/A [abc]-字幕/subtitles.srt");
  put("空的/只有文件.txt");
  put("照片.photoslibrary/影片.mp4");
  put("一/二/三/第三層.mp4");
  put("一/二/三/四/第四層.mp4");
  return root;
}

test("isListedVideo keeps source videos and skips hidden files and studio outputs", () => {
  assert.equal(isListedVideo("錄影.mp4"), true);
  assert.equal(isListedVideo("A.MOV"), true);
  for (const n of ["筆記.txt", ".x.mp4", "v-字幕.mp4", "v-剪輯.mp4", "v-短片-12.mp4"]) assert.equal(isListedVideo(n), false, n);
});

test("scanFolder builds a tree of folders that contain videos, newest videos first, limited depth", () => {
  const root = makeTree();
  const t = scanFolder(root);
  assert.deepEqual(t.videos.map((v) => v.name), ["新的.MOV", "舊的.mp4"]);
  assert.deepEqual(t.dirs.map((d) => d.name).sort(), ["YouTube 下載", "一"].sort(), "沒有影片的、專案資料夾、照片圖庫不列");
  const dir = (n, name) => n.dirs.find((d) => d.name === name);
  assert.deepEqual(dir(t, "YouTube 下載").videos.map((v) => v.name), ["A [abc].mp4"]);
  assert.deepEqual(dir(t, "YouTube 下載").dirs, [], "-字幕 專案資料夾不進去");
  const three = dir(dir(dir(t, "一"), "二"), "三");
  assert.equal(three.name, "三");
  assert.deepEqual(three.videos.map((v) => v.name), ["第三層.mp4"]);
  assert.deepEqual(three.dirs, [], "第四層超過深度");
  assert.equal(t.truncated, false);
  assert.equal(typeof t.videos[0].size, "number");
  fs.rmSync(root, { recursive: true, force: true });
});

test("scanFolder stops at the video limit and says so; a missing folder is just empty", () => {
  const root = makeTree();
  const t = scanFolder(root, { maxVideos: 2 });
  const all = [];
  const walk = (n) => { all.push(...n.videos); n.dirs.forEach(walk); };
  walk(t);
  assert.equal(all.length, 2);
  assert.equal(t.truncated, true);
  assert.deepEqual(scanFolder(path.join(root, "沒有這個")), { path: path.join(root, "沒有這個"), name: "沒有這個", videos: [], dirs: [], truncated: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test("the library list saves privately, ignores junk, and adds or removes entries once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-libfile-"));
  const file = path.join(dir, "state", "library.json");
  assert.deepEqual(loadLibrary(file), { exists: false, broken: false, folders: [], files: [] });
  let lib = { folders: [], files: [] };
  lib = addEntry(lib, "folder", "/Users/x/Movies");
  lib = addEntry(lib, "folder", "/Users/x/Movies");
  lib = addEntry(lib, "file", "/Users/x/Desktop/a.mp4");
  assert.deepEqual(lib, { folders: ["/Users/x/Movies"], files: ["/Users/x/Desktop/a.mp4"] });
  saveLibrary(file, lib);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadLibrary(file), { exists: true, broken: false, ...lib });
  fs.writeFileSync(file, JSON.stringify({ folders: ["relative/path", 3, "/ok"], files: "x" }));
  assert.deepEqual(loadLibrary(file), { exists: true, broken: false, folders: ["/ok"], files: [] });
  assert.deepEqual(removeEntry(lib, "/Users/x/Movies"), { folders: [], files: ["/Users/x/Desktop/a.mp4"] });
  fs.rmSync(dir, { recursive: true, force: true });
});

// #186：清單檔壞掉（或讀不到）不能當成「還沒有清單」而重建覆寫；備份成 .broken 再改
test("a damaged library file is reported as broken (not missing) and can be backed up privately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-libbroken-"));
  const file = path.join(dir, "library.json");
  fs.writeFileSync(file, "{ 這不是 JSON");
  assert.deepEqual(loadLibrary(file), { exists: true, broken: true, folders: [], files: [] });
  fs.writeFileSync(file, "[1, 2]");
  assert.equal(loadLibrary(file).broken, true, "不是物件也算壞掉");
  fs.mkdirSync(path.join(dir, "dir.json"));
  assert.deepEqual(loadLibrary(path.join(dir, "dir.json")), { exists: true, broken: true, folders: [], files: [] }, "讀不到（不是 ENOENT）也不算沒有");
  fs.writeFileSync(file, "{ 壞掉的原文");
  assert.equal(backupBroken(file), true);
  assert.equal(fs.readFileSync(`${file}.broken`, "utf8"), "{ 壞掉的原文");
  assert.equal(backupBroken(path.join(dir, "dir.json")), false, "讀不到原檔：備份失敗，呼叫端不能覆寫");
  assert.equal(fs.statSync(`${file}.broken`).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
