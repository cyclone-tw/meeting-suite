import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadRecapFiles, localBuild } from "../lib/shared-components.mjs";
import { sha256 } from "../lib/shared-pin.mjs";

test("RecapFiles is loaded from the checkout, refused on a different major version, and reloaded when the file changes (#116)", () => {
  const scribe = fs.mkdtempSync(path.join(os.tmpdir(), "rt-rf-"));
  assert.throws(() => loadRecapFiles(scribe), /找不到會議轉錄 App 的共用存檔格式/);
  assert.throws(() => loadRecapFiles(""), /找不到/);
  fs.mkdirSync(path.join(scribe, "web", "shared"), { recursive: true });
  const file = path.join(scribe, "web", "shared", "recap-files.js");
  fs.writeFileSync(file, 'module.exports = { version: "1.0.0", tag: "a" };\n');
  assert.equal(loadRecapFiles(scribe).tag, "a");
  fs.writeFileSync(file, 'module.exports = { version: "1.2.0", tag: "bb" };\n');
  assert.equal(loadRecapFiles(scribe).tag, "bb", "檔案改了就重新載入");
  fs.writeFileSync(file, 'module.exports = { version: "2.0.0", tag: "c" };\n');
  assert.throws(() => loadRecapFiles(scribe), /版本（2\.0\.0）和工作室不相容/);
  fs.writeFileSync(file, "throw new Error('壞了');\n");
  assert.throws(() => loadRecapFiles(scribe), /載入失敗：壞了/);
});

// ---- 釘選（#165）：Studio 的 Node 行程自己會執行這兩樣東西，沒有瀏覽器沙箱，所以也要對照釘選 ----
const RF_SRC = (tag) => `(function () { const api = Object.freeze({ version: "1.0.0", tag: ${JSON.stringify(tag)} }); if (typeof module === "object" && module && module.exports) module.exports = api; })();`;
function scribeWith(t, recapSrc, buildSrc) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rt-scribe-pinned-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, "web", "shared"), { recursive: true });
  fs.mkdirSync(path.join(d, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(d, "web", "shared", "recap-files.js"), recapSrc);
  fs.writeFileSync(path.join(d, "deploy", "build-pages.py"), buildSrc);
  return d;
}

test("pinned recap-files.js: the pinned bytes load, a changed or unpinned file is refused before it runs", (t) => {
  const marker = path.join(os.tmpdir(), `rt-pin-ran-${process.pid}`);
  const good = RF_SRC("good");
  const scribe = scribeWith(t, good, "print('x')");
  const pin = { schema: 1, files: { "recap-files.js": sha256(good) }, scripts: {} };
  assert.equal(loadRecapFiles(scribe, { pin }).tag, "good");
  // 被改過：不能執行（改過的程式一跑就會留下記號）
  fs.writeFileSync(path.join(scribe, "web", "shared", "recap-files.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");` + RF_SRC("evil"));
  assert.throws(() => loadRecapFiles(scribe, { pin }), /不一致/);
  assert.ok(!fs.existsSync(marker), "被改過的檔案不能被執行");
  assert.throws(() => loadRecapFiles(scribe, { pin: { schema: 1, files: {}, scripts: {} } }), /不一致/, "不在清單上也拒絕");
});

test("pinned recap-files.js runs the bytes that were verified, not whatever is on disk a moment later", (t) => {
  const good = RF_SRC("verified");
  const scribe = scribeWith(t, good, "print('x')");
  const pin = { schema: 1, files: { "recap-files.js": sha256(good) }, scripts: {} };
  const file = path.join(scribe, "web", "shared", "recap-files.js");
  const realRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (p, ...rest) => {
    const out = realRead(p, ...rest);
    if (String(p) === file && (reads += 1) === 1) fs.writeFileSync(file, RF_SRC("swapped-after-check"));   // 驗證完、執行前被換掉
    return out;
  });
  assert.equal(loadRecapFiles(scribe, { pin }).tag, "verified", "執行的是驗證過的那份內容");
});

test("pinned localBuild checks the build script before spawning it", async (t) => {
  const py = "print('abc123')";
  const scribe = scribeWith(t, RF_SRC("x"), py);
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit("data", "abc123\n"); c.emit("close", 0); }); return c; };
  const pin = { schema: 1, files: {}, scripts: { "deploy/build-pages.py": sha256(py) } };
  assert.equal(await localBuild(scribe, { pin, spawnImpl }), "abc123");
  fs.writeFileSync(path.join(scribe, "deploy", "build-pages.py"), "import os; os.system('evil')");
  await assert.rejects(localBuild(scribe, { pin, spawnImpl }), /不一致/);
  assert.equal(spawned, 1, "被改過的腳本不能被叫起來");
});

test("pinned recap-files.js is evaluated with this === module.exports, like require (#165)", (t) => {
  const src = '(function (root) { root.version = "1.0.0"; root.tag = "this-ok"; })(this);';
  const scribe = scribeWith(t, src, "print('x')");
  const pin = { schema: 1, files: { "recap-files.js": sha256(src) }, scripts: {} };
  assert.equal(loadRecapFiles(scribe, { pin }).tag, "this-ok");
});
