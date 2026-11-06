// 防呆（#163）：package.json 的 test 清單是手動維護的，新增測試檔忘了登記就會靜默失去覆蓋。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every test file is registered in package.json's test script", () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.test;
  const listed = new Set(script.split(/\s+/).filter((x) => x.startsWith("test/")));
  const onDisk = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [], "測試檔沒登記進 package.json 的 test 清單");
  assert.deepEqual([...listed].filter((f) => !fs.existsSync(path.join(ROOT, f))), [], "清單裡有不存在的測試檔");
});

// 清單裡同一個檔不能列兩次（跑兩遍只是浪費，也代表清單被誤編輯）
test("package.json's test script lists each file once", () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.test;
  const files = script.split(/\s+/).filter((x) => x.startsWith("test/"));
  assert.deepEqual(files.filter((f, i) => files.indexOf(f) !== i), []);
});
