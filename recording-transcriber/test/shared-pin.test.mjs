// 共用元件的完整性（#165，公開版 #5 第 3 項）：Studio 直接執行隔壁 meeting-scribe checkout 的 web/shared/*.js。
// 公開版發佈時，匯出工具把出貨那一份的 SHA-256 釘進 web/shared-pin.json；Studio 供應前對照，不符就拒絕。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPin, loadPin, PIN_FILE, scriptsOf, sha256, verifyShared, writePin } from "../lib/shared-pin.mjs";
import { scribeDir } from "../lib/meeting-recap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rt-pin-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("buildPin hashes the .js and .css files of a shared dir, skipping other files and links", (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "md.js"), "a");
  fs.writeFileSync(path.join(d, "ext.css"), "b");
  fs.writeFileSync(path.join(d, "notes.txt"), "c");
  fs.symlinkSync(path.join(d, "md.js"), path.join(d, "link.js"));
  const pin = buildPin(d);
  assert.deepEqual(Object.keys(pin.files).sort(), ["ext.css", "md.js"]);
  assert.equal(pin.files["md.js"], sha256("a"));
  assert.equal(pin.schema, 1);
});

test("verifyShared accepts the pinned bytes and refuses changed, unpinned and traversal names", () => {
  const pin = { schema: 1, files: { "md.js": sha256("good") } };
  assert.equal(verifyShared(pin, "md.js", Buffer.from("good")), null);
  assert.match(verifyShared(pin, "md.js", Buffer.from("evil")), /不一樣|differs/);
  assert.match(verifyShared(pin, "ext.js", Buffer.from("good")), /清單|not pinned/);
  assert.match(verifyShared(pin, "__proto__", Buffer.from("good")), /清單|not pinned/);
  assert.match(verifyShared(pin, "constructor", Buffer.from("good")), /清單|not pinned/);
});

test("loadPin returns null when there is no pin (private checkouts) and throws on a malformed one", (t) => {
  const d = tmp(t);
  assert.equal(loadPin(d), null);
  fs.mkdirSync(path.join(d, "web"));
  fs.writeFileSync(path.join(d, PIN_FILE), "{broken");
  assert.throws(() => loadPin(d), /shared-pin/);
  fs.writeFileSync(path.join(d, PIN_FILE), JSON.stringify({ schema: 2, files: {} }));
  assert.throws(() => loadPin(d), /shared-pin/);
  fs.writeFileSync(path.join(d, PIN_FILE), JSON.stringify({ schema: 1, files: { "md.js": "not-a-hash" } }));
  assert.throws(() => loadPin(d), /shared-pin/);
  writePin(path.join(d, "web"), path.join(d, PIN_FILE));
  assert.deepEqual(loadPin(d).files, {});
  assert.deepEqual(loadPin(d).scripts, {});
});

// 公開版（有 pin、隔壁就是 meeting-scribe）：釘的清單必須等於那裡真的檔案，不然 Studio 一啟動就拒絕供應共用元件
test("when a pin ships, it matches the meeting-scribe checkout next to it", (t) => {
  const pin = loadPin(ROOT);
  const shared = path.join(scribeDir() || "", "web", "shared");
  if (!pin) return t.skip("no web/shared-pin.json here (private checkout; the export tool creates it)");
  if (!fs.existsSync(shared)) return t.skip("no meeting-scribe checkout next to this one");
  assert.deepEqual(buildPin(shared, scriptsOf(path.dirname(path.dirname(shared)))), pin);
});

test("scripts are pinned by their path relative to the meeting-scribe root, and a malformed scripts map is refused", (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, "shared"));
  fs.mkdirSync(path.join(d, "deploy"));
  fs.writeFileSync(path.join(d, "deploy", "build-pages.py"), "print(1)");
  const pin = buildPin(path.join(d, "shared"), scriptsOf(d));
  assert.deepEqual(pin.scripts, { "deploy/build-pages.py": sha256("print(1)") });
  assert.equal(verifyShared(pin, "deploy/build-pages.py", Buffer.from("print(1)"), "scripts"), null);
  assert.match(verifyShared(pin, "deploy/build-pages.py", Buffer.from("print(2)"), "scripts"), /不一樣|differs/);
  assert.match(verifyShared(pin, "deploy/other.py", Buffer.from("x"), "scripts"), /清單|not pinned/);
  fs.mkdirSync(path.join(d, "web"));
  fs.writeFileSync(path.join(d, PIN_FILE), JSON.stringify({ schema: 1, files: {}, scripts: { "deploy/build-pages.py": "nope" } }));
  assert.throws(() => loadPin(d), /shared-pin/);
});
