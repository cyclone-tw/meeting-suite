// MeetingI18n（web/shared/i18n.js，#195）的測試：語言判斷、_() 代入與單複數、靜態畫面換字（極小的假 DOM）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function load() {
  const window = {};
  vm.runInContext(fs.readFileSync(new URL("../../web/shared/i18n.js", import.meta.url), "utf8"), vm.createContext({ window }));
  return window.MeetingI18n;
}
const text = (t) => ({ nodeType: 3, nodeValue: t });
function el(tagName, attrs = {}, kids = []) {
  return { nodeType: 1, tagName, attrs: { ...attrs }, childNodes: kids,
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } };
}

test("pick: saved choice wins, otherwise the browser's first language", () => {
  const I = load();
  assert.equal(I.pick("en", ["zh-TW"]), "en");
  assert.equal(I.pick("zh", ["en-US"]), "zh");
  assert.equal(I.pick(null, ["zh-TW", "en"]), "zh");
  assert.equal(I.pick(null, ["zh-Hant-TW"]), "zh");
  assert.equal(I.pick(null, ["en-US", "zh-TW"]), "en");
  assert.equal(I.pick(null, ["ja"]), "en");
  assert.equal(I.pick("fr", []), "zh", "壞的值與沒有語言都當中文");
  assert.equal(I.pick(undefined, undefined), "zh");
});

test("_: translate, fill {vars}, plurals by n, fall back to Chinese", () => {
  const I = load();
  const dict = { "開始錄音": "Start recording", "已勾 {n} 項": ["{n} item checked", "{n} items checked"], "連不到{host}": "Can't reach {host}" };
  const en = I.create("en", [dict]);
  assert.equal(en._("開始錄音"), "Start recording");
  assert.equal(en._("已勾 {n} 項", { n: 1 }), "1 item checked");
  assert.equal(en._("已勾 {n} 項", { n: 3 }), "3 items checked");
  assert.equal(en._("連不到{host}", { host: "mini" }), "Can't reach mini");
  assert.equal(en._("連不到{host}", { other: 1 }), "Can't reach {host}", "沒給的變數原樣留著");
  assert.equal(en._("沒在字典"), "沒在字典");
  assert.deepEqual([...en.missing], ["沒在字典"]);
  assert.equal(en._("連不到{host}", { host: "$& {host}" }), "Can't reach $& {host}", "代入的值不再展開");
  const zh = I.create("zh", [dict]);
  assert.equal(zh._("開始錄音"), "開始錄音");
  assert.equal(zh._("已勾 {n} 項", { n: 2 }), "已勾 2 項", "中文也代入變數");
  assert.equal(zh.missing.size, 0);
  assert.equal(I.create("en", [{ a: "1" }, { a: "2" }])._("a"), "2", "後面的字典蓋前面的");
  assert.equal(I.create("en", [{ toString: "x" }])._("hasOwnProperty"), "hasOwnProperty", "不會拿到物件原型上的東西");
});

test("translate: text nodes and attributes, keeps surrounding spaces, textarea only gets its attributes, skips script and translate=no", () => {
  const I = load();
  const dict = { "設定": "Settings", "關閉設定": "Close settings", "會議 名稱": "Meeting name", "主機": "the host" };
  const label = text("\n    設定  ");
  const multi = text(" 會議\n   名稱 ");
  const scriptText = text("設定");
  const areaText = text("設定");
  const noText = text("設定");
  const unknown = text("沒有翻譯");
  const btn = el("BUTTON", { title: "關閉設定", "aria-label": "關閉設定", "data-x": "設定" }, [label]);
  const root = el("DIV", {}, [btn, el("P", {}, [multi, unknown]), el("SCRIPT", {}, [scriptText]), el("TEXTAREA", { placeholder: "設定" }, [areaText]),
    el("SPAN", { translate: "no" }, [noText])]);
  I.create("zh", [dict]).translate(root);
  assert.equal(label.nodeValue, "\n    設定  ", "中文模式不動");
  const en = I.create("en", [dict]);
  en.translate(root);
  assert.equal(label.nodeValue, "\n    Settings  ");
  assert.equal(btn.attrs.title, "Close settings");
  assert.equal(btn.attrs["aria-label"], "Close settings");
  assert.equal(btn.attrs["data-x"], "設定", "只換 title／placeholder／aria-label／alt");
  assert.equal(multi.nodeValue, " Meeting name ", "中間的換行與空白縮成一格再查");
  assert.equal(scriptText.nodeValue, "設定");
  assert.equal(areaText.nodeValue, "設定", "textarea 裡的字是使用者的內容，不動");
  assert.equal(root.childNodes[3].attrs.placeholder, "Settings", "textarea 的 placeholder 要換");
  assert.equal(noText.nodeValue, "設定");
  assert.equal(unknown.nodeValue, "沒有翻譯");
  assert.ok(en.missing.has("沒有翻譯"));
});

test("use/t: shared components follow the page's translator, Chinese when none is registered (#201)", () => {
  const I = load();
  assert.equal(I.t("共 {n} 段", { n: 3 }), "共 3 段", "沒登記：照中文、照樣代入");
  assert.equal(I.t("複製"), "複製");
  const en = I.create("en", [{ "複製": "Copy", "共 {n} 段": ["{n} paragraph", "{n} paragraphs"] }]);
  I.use(en);
  assert.equal(I.t("複製"), "Copy");
  assert.equal(I.t("共 {n} 段", { n: 1 }), "1 paragraph");
  I.t("沒在字典");
  assert.ok(en.missing.has("沒在字典"), "共用元件查不到的字也記在頁面的 missing");
  I.use(null);
  assert.equal(I.t("複製"), "複製");
});

test("msg: server messages already filled in are matched back to {name} keys (#152)", () => {
  const I = load();
  const en = I.create("en", [{ "連不到主機": "Can't reach the host", "匯入失敗（{err}）": "Import failed ({err})", "{name}：{error}": "{name}: {error}",
    "檔案路徑不合法：{path}": "Invalid file path: {path}", "共 {n} 段": ["{n} paragraph", "{n} paragraphs"], "a.b（{x}）": "dot {x}" }]);
  assert.equal(en.msg("連不到主機"), "Can't reach the host");
  assert.equal(en.msg("匯入失敗（TimeoutError）"), "Import failed (TimeoutError)");
  assert.equal(en.msg("pack.json：檔案路徑不合法：x：y"), "pack.json: Invalid file path: x：y", "比較具體的先比，裡面的訊息一起翻");
  assert.equal(en.msg("共 1 段"), "1 paragraph");
  assert.equal(en.msg("共 2 段"), "2 paragraphs");
  assert.equal(en.msg("aXb（1）"), "aXb（1）", "鍵裡的 . 是字面，不是正規式");
  assert.equal(en.msg("沒在字典"), "沒在字典");
  assert.equal(en.missing.size, 0, "msg 查不到不算缺字");
  assert.equal(I.create("zh", [{ "連不到主機": "x" }]).msg("連不到主機"), "連不到主機", "中文模式照原樣");
});
