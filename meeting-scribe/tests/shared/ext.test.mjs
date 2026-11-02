// ExtPanel（web/shared/ext.js）的測試：子頁籤、選項按鈕、選到的結果用 MdView 排版、各種按鈕（極小的假 DOM）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function setup({ icons = true } = {}) {
  const window = {};
  const doc = {
    defaultView: window,
    createElement: (tag) => node(tag),
    createElementNS: (ns, tag) => node(tag, ns),
    createTextNode: (t) => ({ text: t }),
  };
  function node(tag, ns) {
    const e = { tagName: tag, ns, children: [], attrs: {}, className: "", hidden: false, disabled: false, onclick: null,
      classList: { add(c) { e.className = e.className ? `${e.className} ${c}` : c; } },
      append(...k) { e.children.push(...k); }, replaceChildren(...k) { e.children = k; },
      setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; },
      set textContent(v) { e.children = [{ text: String(v) }]; },
      get textContent() { const t = (n) => (n.text !== undefined ? n.text : n.children.map(t).join("")); return t(e); },
      ownerDocument: doc };
    return e;
  }
  const ctx = vm.createContext({ window, setTimeout, clearTimeout });
  for (const f of [...(icons ? ["icons.js"] : []), "md.js", "ext.js"]) vm.runInContext(fs.readFileSync(new URL(`../../web/shared/${f}`, import.meta.url), "utf8"), ctx);
  const box = node("div");
  const all = (n, pred, out = []) => { if (n.children) { if (pred(n)) out.push(n); n.children.forEach((c) => all(c, pred, out)); } return out; };
  const find = (pred) => all(box, pred);
  const btn = (text) => find((n) => n.tagName === "button" && n.textContent.startsWith(text))[0];
  return { window, box, find, btn };
}

const MODS = [
  { id: "sprout", title: "讓這場會議發芽", description: "延伸探討與後續應用", output: "markdown", options: [] },
  { id: "mindmap", title: "心智圖", output: "mindmap", options: [] },
  { id: "perspective", title: "視角回饋", description: "換一個角色看這場會議", output: "markdown", options: [{ id: "who", label: "誰的視角", choices: [["boss", "老闆／主管"], ["parent", "家長"]] }] },
];

test("tabs come from the modules (not the mind map), sprout shows the sapling and 發芽, options are buttons", () => {
  const { window, box, find, btn } = setup();
  const runs = [];
  const h = window.ExtPanel.mount(box, { onRun: (m, o) => runs.push([m.id, o]) });
  assert.match(find((n) => n.className === "ext-note")[0].textContent, /正在向會議轉錄 App 要/);
  h.update({ modules: MODS, results: [], loading: false });
  const tabs = find((n) => n.className === "ext-tab");
  assert.deepEqual(tabs.map((t) => t.attrs["data-mod"]), ["sprout", "perspective"], "心智圖不在延伸");
  assert.equal(tabs[0].attrs["aria-selected"], "true");
  assert.equal(tabs[0].attrs["aria-label"], "讓這場會議發芽");
  assert.equal(tabs[0].children[0].tagName, "svg");
  assert.equal(tabs[0].children[0].ns, "http://www.w3.org/2000/svg");
  assert.equal(tabs[0].children[1].textContent, "發芽");
  assert.equal(tabs[1].textContent, "視角回饋");
  // 每個子頁籤都有圖示（#168）：發芽是樹苗、視角回饋是眼睛；裝飾用，讀屏不唸
  assert.deepEqual(tabs.map((t) => t.children[0].attrs["data-icon"]), ["sapling", "eye"]);
  assert.ok(tabs.every((t) => t.children[0].attrs["aria-hidden"] === "true"));
  assert.equal(tabs[1].attrs["aria-label"], undefined, "名稱沒縮短就不用另外給讀屏名稱");
  assert.match(find((n) => n.className === "ext-note")[0].textContent, /延伸探討與後續應用。還沒產生/);
  btn("產生").onclick();
  assert.equal(JSON.stringify(runs.at(-1)), JSON.stringify(["sprout", {}]));
  tabs[1].onclick();
  const choices = find((n) => n.className === "ext-choice");
  assert.deepEqual(choices.map((c) => [c.attrs["data-choice"], c.attrs["aria-pressed"]]), [["boss", "true"], ["parent", "false"]]);
  assert.deepEqual(choices.map((c) => c.children[0].attrs["data-icon"]), ["briefcase", "house"], "視角按鈕有圖示");
  choices[1].onclick();
  btn("產生").onclick();
  assert.equal(JSON.stringify(runs.at(-1)), JSON.stringify(["perspective", { who: "parent" }]));
  assert.equal(window.ExtPanel.keyOf(MODS[2], { who: "parent" }), "perspective:who=parent");
  assert.equal(window.ExtPanel.labelOf(MODS[2], { who: "parent" }), "視角回饋（家長）");
});

test("the picked choice's result is shown as formatted Markdown, with copy, reveal and a two-step remove", async () => {
  const { window, box, find, btn } = setup();
  const copied = [], revealed = [], removed = [];
  const h = window.ExtPanel.mount(box, { onCopy: (t) => copied.push(t), onReveal: (r) => revealed.push(r.key), onRemove: (r) => removed.push(r.key) });
  const parent = { key: "perspective:who=parent", module: "perspective", label: "視角回饋（家長）", markdown: "## 家長最在意\n\n- **進度**<b>", created: "x", meta: "10/26 在這台 MacBook 產生" };
  h.update({ modules: MODS, results: [parent], loading: false });
  h.pick("perspective", { who: "parent" });
  const bodyEl = find((n) => n.className.startsWith("ext-body"))[0];
  assert.equal(bodyEl.hidden, false);
  assert.ok(bodyEl.className.includes("md-view"), "用 MdView 排版");
  assert.equal(bodyEl.children[0].tagName, "h4");
  assert.equal(bodyEl.children[1].tagName, "ul");
  assert.equal(bodyEl.children[1].children[0].children[0].tagName, "strong");
  assert.equal(bodyEl.children[1].children[0].children[1].text, "<b>", "HTML 只是文字");
  assert.equal(find((n) => n.className === "ext-note")[0].textContent, "視角回饋（家長）：10/26 在這台 MacBook 產生");
  assert.match(find((n) => n.className === "ext-choice")[1].textContent, /家長・已產生/);
  assert.equal(btn("重新產生").disabled, false);
  btn("複製").onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied[0], parent.markdown, "複製的是原文");
  assert.ok(btn("已複製"), "複製後按鈕閃一下「已複製」");
  btn("在 Finder 顯示").onclick();
  assert.equal(JSON.stringify(revealed), JSON.stringify([parent.key]));
  btn("移除").onclick();
  assert.equal(removed.length, 0, "第一次只是問");
  btn("確定移除？").onclick();
  assert.equal(JSON.stringify(removed), JSON.stringify([parent.key]));
  // 換到老闆：還沒產生，不顯示結果
  find((n) => n.className === "ext-choice")[0].onclick();
  assert.equal(find((n) => n.className.startsWith("ext-body"))[0].hidden, true);
  assert.equal(btn("複製"), undefined);
});

test("busy, stale and error states; hosts without reveal or remove do not get those buttons", () => {
  const { window, box, find, btn } = setup();
  let stopped = 0;
  const h = window.ExtPanel.mount(box, { onRun() {}, onStop: () => { stopped += 1; } });
  const sprout = { key: "sprout", module: "sprout", label: "讓這場會議發芽", markdown: "內容", stale: true };
  h.update({ modules: MODS, results: [sprout], loading: false });
  assert.match(find((n) => n.className.includes("ext-note"))[0].textContent, /產生之後內容改過了/);
  assert.equal(btn("在 Finder 顯示"), undefined);
  assert.equal(btn("移除"), undefined);
  h.update({ busy: { key: "sprout", label: "讓這場會議發芽" } });
  assert.equal(btn("正在產生").disabled, true);
  btn("停止").onclick();
  assert.equal(stopped, 1);
  h.update({ busy: { key: "perspective:who=boss", label: "視角回饋（老闆／主管）" } });
  assert.equal(btn("重新產生").disabled, true, "別的在跑：不能按，但也不顯示停止");
  assert.equal(btn("停止"), undefined);
  h.update({ busy: null, error: "連不到會議轉錄 App" });
  assert.match(find((n) => n.className.includes("ext-warn"))[0].textContent, /沒有產生成功：連不到/);
  h.update({ error: "", modules: [MODS[1]] });
  assert.equal(find((n) => n.className === "ext-note")[0].textContent, "目前沒有延伸功能。");
  assert.ok(Object.isFrozen(window.ExtPanel));
});

test("other modules get the generic icon; without MeetingIcons the panel still works with text only; a failed copy says so", async () => {
  const mods = [...MODS, { id: "pack-x", title: "擴充包模組", output: "markdown", options: [] }];
  let s = setup();
  let h = s.window.ExtPanel.mount(s.box, { onCopy: () => false });
  h.update({ modules: mods, results: [{ key: "pack-x", module: "pack-x", label: "擴充包模組", markdown: "x" }], loading: false });
  assert.equal(s.find((n) => n.className === "ext-tab")[2].children[0].attrs["data-icon"], "spark");
  h.pick("pack-x");
  s.btn("複製").onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.btn("複製失敗"), "複製失敗要照實說");
  s = setup({ icons: false });
  h = s.window.ExtPanel.mount(s.box, {});
  h.update({ modules: mods, results: [], loading: false });
  const tabs = s.find((n) => n.className === "ext-tab");
  assert.equal(tabs[0].textContent, "發芽");
  assert.ok(tabs.every((t) => t.children.every((c) => c.tagName !== "svg")), "沒有圖示元件就只有文字");
});
