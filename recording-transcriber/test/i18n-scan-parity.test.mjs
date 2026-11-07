// 兩份 i18n 掃描器（meeting-scribe 的 tests/i18n_scan.py 與這邊的 test/helpers/i18n-scan.mjs）是同一套規則的兩種語言版本，
// 註解要求「兩邊一起改」。這個測試把同一份樣本頁交給兩邊，結果不同就失敗（#165，公開版 #6 第 5 項）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scribeDir } from "../lib/meeting-recap.mjs";
import { pageCjkStrings, pageKeys } from "./helpers/i18n-scan.mjs";

const SAMPLE = `<!doctype html>
<html><head><title>標題文字</title><style>.x::after { content: "樣式裡的中文"; }</style></head>
<body>
<!-- 註解裡的中文不算 -->
<h1>  會議   轉錄  </h1>
<input placeholder="請輸入名稱" aria-label="名稱欄位" alt="替代文字">
<p translate="no" title="不要翻的屬性">不要翻的文字</p>
<textarea>文字區的中文</textarea>
<script>
const a = _("共 {n} 段", { n: 3 });
const b = "直接寫的中文字串";
const c = '單引號的字串';
const d = \`樣板字串 \${_("裡面的鍵")} 後面的字\`;
const e = "資料內容"; // 不翻：這一行是資料
// 註解裡的 "中文字串" 不算
const f = /正規表示式中文/.test(x);
const g = _("含跳脫\\n換行");
const h = _(variable);
const i = _(\`樣板鍵\`);
</script>
</body></html>`;

const scanner = path.join(scribeDir() || "", "tests", "i18n_scan.py");

test("the Python and JS i18n scanners agree on the same page", { skip: !fs.existsSync(scanner) && "no meeting-scribe checkout next to this one" }, () => {
  const py = spawnSync("python3", ["-I", "-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(scanner))})
import i18n_scan as s
text = sys.stdin.read()
keys, bad = s.page_keys(text)
print(json.dumps({"keys": keys, "bad": [[l, t] for l, t in bad],
                  "cjk": [[k.replace("js\`", "js"), l, v, bool(w)] for k, l, v, w in s.page_cjk_strings(text)]}, ensure_ascii=False))
`], { input: SAMPLE, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const want = JSON.parse(py.stdout);
  const k = pageKeys(SAMPLE);
  const got = {
    keys: Object.fromEntries(k.keys),
    bad: k.bad.map(([l, t]) => [l, t]),
    cjk: pageCjkStrings(SAMPLE).map(([kind, l, v, w]) => [kind.replace("js`", "js"), l, v, Boolean(w)]),
  };
  const norm = (o) => ({ keys: Object.entries(o.keys).sort(), bad: o.bad, cjk: [...o.cjk].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  assert.deepEqual(norm(got), norm(want));
  assert.ok(Object.keys(got.keys).length >= 6, "樣本要真的掃到東西");
});
