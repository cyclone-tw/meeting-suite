// 掃描器（test/helpers/i18n-scan.mjs）本身：和 meeting-scribe 的 tests/i18n_scan.py 同一組案例，兩邊要一致
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCjkStrings, pageKeys, cjkStrings } from "./helpers/i18n-scan.mjs";

const scan = (js) => pageCjkStrings(`<p>x</p><script>\n${js}\n</script>`).filter(([k]) => k === "js").map(([, , s, w]) => [s, w]);

test("comments and regex are not strings", () => {
  assert.deepEqual(scan('// 註解 "中文"\n/* 區塊 "中文" */\nconst r = /[，。]$/.test(x); const d = a / b / "中";'), [["中", false]]);
});

test("wrapped and unwrapped", () => {
  assert.deepEqual(scan('f(_("開始"), "結束", x._("不是"), a_("也不是"))'), [["開始", true], ["結束", false], ["不是", false], ["也不是", false]]);
});

test("template literals", () => {
  assert.deepEqual(scan('t = `<b>${ok ? _("好") : "壞"}</b>`; u = `共 ${n} 段`;'), [["好", true], ["壞", false], ["共 {} 段", false]]);
});

test("keep marker", () => {
  assert.deepEqual(scan('a = "檔名";   // 不翻：檔名\nb = "提示";'), [["提示", false]]);
  assert.deepEqual(cjkStrings('a = "檔名";   // 不翻\nb = "提示";').map(([, s]) => s), ["提示"]);
});

test("html text and attributes, translate=no skipped", () => {
  const found = pageCjkStrings('<p title="說明">  開始\n  錄音 </p><style>/* 樣式 */</style><textarea>預設</textarea><input placeholder="例如"><b translate="no">名<b>字</b></b><input translate="no" title="不算"><i>要翻</i> &amp; 好');
  assert.deepEqual(found.map(([k, , s]) => [k, s]), [["html", "開始 錄音"], ["html", "要翻"], ["html", "& 好"], ["attr:title", "說明"], ["attr:placeholder", "例如"]]);
});

test("keys cook escapes and refuse non-literals", () => {
  const { keys, bad } = pageKeys('<script>\n_("第一行\\n第二行「\\u4e2d」", { n }); _(`樣板`); _("中" + x);\n</script>');
  assert.ok(keys.has("第一行\n第二行「中」"));
  assert.equal(bad.length, 2, "樣板字串與拼接都不能當鍵");
});
