// 字幕工作室介面中英切換（#152）：頁面的中文都要能翻，英文字典 web/studio/lang-en.js 要跟頁面對得上。
// 之後每改一次介面都要兩種語言一起改：
// - studio.html 的文字與 title／placeholder／aria-label／alt、web/studio/*.js 的字串，都要在字典裡；JS 的字串包在 _("中文")。
//   資料或產出內容（檔名、字幕、送給 AI 的格式、存進專案的值）在那一行註解寫「不翻」。
// - 主機回頁面的錯誤（scripts/subtitle-studio.mjs 的 fail(res, 狀態, "…")、throw new Error("…")）也要在字典裡，
//   頁面的 api() 用 I18N.msg 照字典換（帶 {名稱} 的樣板，變數原樣帶過去）。
// - 字典不能有用不到的鍵；英文不能是空的或還有中文；{名稱} 要跟中文一樣。
// 共用元件（心智圖、延伸頁籤）的字在會議轉錄 App 的 web/shared/lang-en.js，那邊測。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CJK, pageCjkStrings, pageKeys, cjkStrings, jsKeys, jsLiterals, tokens, templateParts, cook } from "./helpers/i18n-scan.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PAGE = read("web/studio.html");
const JS = fs.readdirSync(new URL("../web/studio/", import.meta.url)).filter((f) => f.endsWith(".js") && f !== "lang-en.js").sort()
  .map((f) => ({ name: f, src: read(`web/studio/${f}`) }));
const SERVER = read("scripts/subtitle-studio.mjs");
// 工作狀態裡存給頁面顯示的訊息（剪輯建議的 warning／dropped），頁面顯示時經 I18N.msg（#154）
const JOB_SOURCES = [SERVER, read("lib/cut-suggest.mjs")];
const VARS = /\{(\w+)\}/g;
const canon = (s) => s.replace(/\{(\w*)\}/g, "{}");

export function loadDict() {
  const m = read("web/studio/lang-en.js").match(/^window\.StudioLangEN = Object\.freeze\((\{[\s\S]*\})\);\s*$/m);
  assert.ok(m, "lang-en.js 要是 window.StudioLangEN = Object.freeze({…});，中間是 JSON");
  return JSON.parse(m[1]);
}

// 主機送到頁面的錯誤訊息：fail(res, 狀態, 字串) 與 throw new Error(字串)；f-string 的 ${…} 寫成 {}
export function serverMessages(src = SERVER) {
  const out = [];
  for (const [i, j, q] of tokens(src)) {
    const before = src.slice(Math.max(0, i - 40), i);
    if (!/(fail\(res, *\d+, *|new Error\(|aiWarning = |dropped: )$/.test(before)) continue;
    const text = q === "`" ? templateParts(src, i)[1].map((p) => (p[0] === "lit" ? cook(p[1]) : "{}")).join("") : cook(src.slice(i + 1, j - 1));
    if (CJK.test(text)) out.push([src.slice(0, i).split("\n").length, text]);
  }
  return out;
}

const en = loadDict();
const enShapes = new Set(Object.keys(en).map(canon));

test("page text and attributes are in the dictionary", () => {
  const { keys } = pageKeys(PAGE);
  const missing = [...keys].filter(([k]) => !(k in en)).map(([k, ln]) => `studio.html:${ln}: ${k.slice(0, 60)}`);
  assert.deepEqual(missing, [], "英文字典 web/studio/lang-en.js 少了這些");
  assert.deepEqual(pageCjkStrings(PAGE).filter(([k]) => k === "js"), [], "studio.html 不放 script；程式在 web/studio/*.js");
});

test("script strings are wrapped in _() or marked 不翻", () => {
  const raw = JS.flatMap(({ name, src }) => cjkStrings(src).filter(([, , w]) => !w).map(([ln, s]) => `${name}:${ln}: ${s.slice(0, 60)}`));
  assert.deepEqual(raw, [], "web/studio/*.js 的中文要包在 _(\"…\") 裡；資料或產出內容在那一行註解寫「不翻」");
});

test("_() takes plain strings and every key has English", () => {
  const missing = [], bad = [];
  for (const { name, src } of JS) {
    const r = jsKeys(src);
    for (const [k, ln] of r.keys) if (!(k in en)) missing.push(`${name}:${ln}: ${k.slice(0, 60)}`);
    bad.push(...r.bad.map(([ln, s]) => `${name}:${ln}: ${s}`));
  }
  assert.deepEqual(bad, [], "_( ) 的第一個參數要是單純的字串（變數用 {名稱} 加第二個參數），字典才查得到");
  assert.deepEqual(missing, [], "英文字典 web/studio/lang-en.js 少了這些");
});

test("server messages shown on the page have English", () => {
  const missing = JOB_SOURCES.flatMap((src) => serverMessages(src)).filter(([, t]) => !enShapes.has(canon(t))).map(([ln, t]) => `subtitle-studio.mjs:${ln}: ${t.slice(0, 60)}`);
  assert.deepEqual(missing, [], "主機回頁面的訊息要在字典裡（${…} 的位置用 {名稱}）");
});

test("dictionary values are English, keep placeholders, and every key is used", () => {
  for (const [k, v] of Object.entries(en)) {
    const forms = Array.isArray(v) ? v : [v];
    assert.ok(typeof v === "string" || (forms.length === 2 && k.includes("{n}")), `單複數要剛好兩個，而且中文要有 {n}：${k}`);
    for (const f of forms) {
      assert.equal(typeof f, "string", k);
      assert.ok(f.trim(), `英文是空的：${k}`);
      assert.ok(!CJK.test(f), `英文裡還有中文或全形標點：${k} → ${f}`);
      assert.deepEqual(new Set(f.match(VARS) || []), new Set(k.match(VARS) || []), `{名稱} 要跟中文一樣：${k} → ${f}`);
    }
  }
  const used = new Set(pageKeys(PAGE).keys.keys());
  for (const { src } of JS) { for (const k of jsKeys(src).keys.keys()) used.add(k); for (const k of jsLiterals(src)) used.add(k); }
  const shapes = new Set(JOB_SOURCES.flatMap((src) => serverMessages(src)).map(([, t]) => canon(t)));
  assert.deepEqual(Object.keys(en).filter((k) => !used.has(k) && !shapes.has(canon(k))), [], "字典裡有用不到的鍵");
});

test("the server message scanner sees fail() and throw, with template slots", () => {
  const src = 'x = 1;\nreturn fail(res, 409, "已經在處理");\nthrow new Error(`找不到 ${f}`);\nconsole.log("記錄用");\nfail(res, 500, e.message);';
  assert.deepEqual(serverMessages(src), [[2, "已經在處理"], [3, "找不到 {}"]]);
  assert.deepEqual(serverMessages('aiWarning = `${a} 這段壞了`;\nreturn { dropped: "剪太多" };').map(([, t]) => t), ["{} 這段壞了", "剪太多"], "工作狀態的 warning／dropped 也算");
});

test("nothing shadows the global translator _", () => {
  // _ 是全域的翻譯函式：參數或變數也叫 _ 的話，那裡面的 _("…") 會壞掉（例如 .map((_, i) => …)）
  const shadow = /\(\s*_\s*[,)=]|,\s*_\s*[,)\]=]|(?<![\w$.])_\s*=>|\b(?:const|let|var)\s+_\b|\[\s*_\s*[,\]]|\{\s*_\s*[,}:]/g;
  const bad = [];
  for (const { name, src } of JS) {
    const code = src.replace(/\/\/[^\n]*/g, "");
    for (const m of code.matchAll(shadow)) {
      const line = code.slice(0, m.index).split("\n").length, text = src.split("\n")[line - 1];
      if (!(name === "i18n.js" && /^const _ = I18N\._;/.test(text))) bad.push(`${name}:${line}: ${text.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], "不要把參數或變數取名 _，會蓋掉翻譯函式");
});

test("web/studio/i18n.js falls back safely when the engine is missing or old", async () => {
  const vm = await import("node:vm");
  const code = read("web/studio/i18n.js");
  const run = (MeetingI18n) => {
    const html = { lang: "", classList: { add() {}, remove() {} } };
    const ctx = vm.createContext({ document: { documentElement: html }, navigator: { languages: ["en-US"] }, localStorage: { getItem: () => null }, setTimeout: () => 0 });
    ctx.window = ctx;
    if (MeetingI18n) ctx.MeetingI18n = MeetingI18n;
    new vm.Script(code + "\n;globalThis.__out = { UI_LANG, msg: I18N.msg('主機訊息'), t: _('共 {n} 段', { n: 2 }), lang: document.documentElement.lang };").runInContext(ctx);
    return ctx.__out;
  };
  assert.deepEqual({ ...run(null) }, { UI_LANG: "zh", msg: "主機訊息", t: "共 2 段", lang: "zh-Hant" }, "沒有引擎：中文");
  assert.equal(run({ pick: () => "en" }).UI_LANG, "zh", "引擎缺 create：中文");
  // 舊引擎：有 create、pick，沒有 use 與 msg（meeting-scribe#203 之前）——不能拋錯，msg 照原樣
  const old = { pick: () => "en", create: () => Object.freeze({ lang: "en", _: (s) => "EN:" + s, translate() {}, missing: new Set() }) };
  assert.deepEqual({ ...run(old) }, { UI_LANG: "en", msg: "主機訊息", t: "EN:共 {n} 段", lang: "en" });
});

test("real engine: stored job messages translate through msg (#154)", async (t) => {
  // 公開版與一般安裝 meeting-scribe 在旁邊；worktree 或單獨 clone 時找不到就跳過
  const { scribeDir } = await import("../lib/meeting-recap.mjs");
  const dir = scribeDir();
  const engine = dir && fs.existsSync(`${dir}/web/shared/i18n.js`) ? fs.readFileSync(`${dir}/web/shared/i18n.js`, "utf8") : "";
  if (!engine.includes("msg")) return t.skip("找不到有 msg 的 meeting-scribe checkout");
  const vm = await import("node:vm");
  const ctx = vm.createContext({});
  ctx.window = ctx;
  new vm.Script(engine).runInContext(ctx);
  const I = ctx.MeetingI18n.create("en", [en]);
  assert.equal(I.msg("0:12–0:30、1:00–1:10 這段 AI 回覆的格式不對，沒有 AI 建議；其他段落照常。按「重新找」可以再試一次。"),
    en["{ranges} 這段 AI 回覆的格式不對，沒有 AI 建議；其他段落照常。按「重新找」可以再試一次。"].replace("{ranges}", "0:12–0:30、1:00–1:10"));
  assert.ok(!CJK.test(I.msg("AI 建議剪掉超過一半，看起來不對，只保留靜音與黑畫面的建議")));
});
