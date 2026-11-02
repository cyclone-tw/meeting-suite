// MdView（web/shared/md.js）的測試：解析規則與 DOM 輸出（用一個極小的假 DOM，不靠瀏覽器）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function fakeDoc() {
  const mk = (tag) => {
    const e = { tagName: tag, children: [], attrs: {}, style: {}, className: "", _text: null,
      classList: { add(c) { e.className = e.className ? `${e.className} ${c}` : c; } },
      append(...kids) { e.children.push(...kids); },
      replaceChildren() { e.children = []; },
      setAttribute(k, v) { e.attrs[k] = String(v); },
      set textContent(v) { e.children = [{ text: String(v) }]; },
      ownerDocument: null };
    e.ownerDocument = doc;
    return e;
  };
  const doc = { createElement: mk, createTextNode: (t) => ({ text: t }) };
  return doc;
}
// 把假 DOM 轉成好比對的字串（文字照原樣，所以 <script> 也只是文字）
const show = (n) => (n.text !== undefined ? n.text : `<${n.tagName}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join("")}${n.style.textAlign ? ` align=${n.style.textAlign}` : ""}>${n.children.map(show).join("")}</${n.tagName}>`);

const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL("../../web/shared/md.js", import.meta.url), "utf8"), ctx);
const MdView = ctx.window.MdView;
const html = (md, opts) => { const doc = fakeDoc(); const box = doc.createElement("div"); MdView.render(box, md, opts); return box.children.map(show).join(""); };

test("headings map # to the chosen level; paragraphs keep single line breaks", () => {
  assert.equal(html("# 標題\n\n第一行\n第二行"), "<h3>標題</h3><p>第一行<br></br>第二行</p>");
  assert.equal(html("## 次標", { top: 4 }), "<h5>次標</h5>");
  assert.equal(html("#### 小"), "<h6>小</h6>", "最深到 h6");
  assert.ok(Object.isFrozen(MdView));
});

test("inline: bold, italic, strike, code, safe links only, bare URLs without trailing punctuation", () => {
  assert.equal(html("**粗** 和 *斜* 和 ~~刪~~ 和 `x<y>`"), "<p><strong>粗</strong> 和 <em>斜</em> 和 <del>刪</del> 和 <code>x<y></code></p>");
  assert.equal(html("[官網](https://example.com/a?b=1)"), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">官網</a></p>');
  assert.equal(html("[壞](javascript:alert(1))"), "<p>[壞](javascript:alert(1))</p>", "不是 http(s) 就當文字");
  assert.equal(html("看 https://a.example/x。"), '<p>看 <a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a>。</p>');
  assert.equal(html("snake_case_name 不是斜體"), "<p>snake_case_name 不是斜體</p>");
  assert.equal(html("見https://a.com/x，請參考"), '<p>見<a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>，請參考</p>', "網址後面緊接的中文不算網址");
  assert.equal(html("（https://a.com/y）"), '<p>（<a href="https://a.com/y" target="_blank" rel="noopener noreferrer">https://a.com/y</a>）</p>');
  assert.equal(html("[https://x.com](https://x.com)"), '<p><a href="https://x.com" target="_blank" rel="noopener noreferrer">https://x.com</a></p>', "連結裡不會再有連結");
  assert.equal(html("<script>alert(1)</script>"), "<p><script>alert(1)</script></p>", "HTML 只是文字（假 DOM 的 text 節點）");
  const doc = fakeDoc(), box = doc.createElement("div");
  MdView.render(box, "<b>x</b>");
  assert.equal(box.children[0].children[0].text, "<b>x</b>", "放在文字節點裡，不會變成元素");
});

test("lists: unordered, ordered with start, nested, continuation lines, blank lines between items", () => {
  assert.equal(html("- 一\n- 二\n  - 二之一\n  - 二之二\n- 三"), "<ul><li>一</li><li>二<ul><li>二之一</li><li>二之二</li></ul></li><li>三</li></ul>");
  assert.equal(html("3. 三\n4. 四"), '<ol start="3"><li>三</li><li>四</li></ol>');
  assert.equal(html("- 項目\n  接續的說明\n\n- 下一項"), "<ul><li>項目<br></br>接續的說明</li><li>下一項</li></ul>");
  assert.equal(html("1. 甲\n   - 甲的子項"), "<ol><li>甲<ul><li>甲的子項</li></ul></li></ol>");
  assert.equal(html("1. **標題**\n\n   - 要點一\n   - 要點二\n\n2. 第二"), "<ol><li><strong>標題</strong><ul><li>要點一</li><li>要點二</li></ul></li><li>第二</li></ol>", "空一行再接縮排的子清單");
  assert.equal(html("- **重點**：說明"), "<ul><li><strong>重點</strong>：說明</li></ul>");
});

test("code blocks, quotes, rules and tables", () => {
  assert.equal(html("```js\nconst a = '<b>';\n```"), '<pre data-lang="js"><code>const a = \'<b>\';</code></pre>');
  assert.equal(html("> 引用\n> 第二行"), "<blockquote><p>引用<br></br>第二行</p></blockquote>");
  assert.equal(html("前\n\n---\n\n後"), "<p>前</p><hr></hr><p>後</p>");
  assert.equal(html("| 事項 | 負責 |\n|:--|--:|\n| 發教材 | **老師** |\n| 回饋 |"),
    "<div><table><thead><tr><th align=left>事項</th><th align=right>負責</th></tr></thead><tbody><tr><td align=left>發教材</td><td align=right><strong>老師</strong></td></tr><tr><td align=left>回饋</td><td align=right></td></tr></tbody></table></div>");
});

test("the meeting outputs the apps already show still look right", () => {
  const full = "## 核心結論\n\n本場討論資源班閱讀教材。\n\n### 待辦\n\n- 下週三前發試用版給家長\n- 特推會月底確認課表";
  assert.equal(html(full), "<h4>核心結論</h4><p>本場討論資源班閱讀教材。</p><h5>待辦</h5><ul><li>下週三前發試用版給家長</li><li>特推會月底確認課表</li></ul>");
  assert.equal(MdView.parse("").length, 0);
  assert.equal(MdView.parse(null).length, 0);
});
