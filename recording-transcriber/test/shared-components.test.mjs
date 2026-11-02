import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRecapFiles } from "../lib/shared-components.mjs";

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
