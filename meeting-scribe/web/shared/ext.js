// 共用元件（meeting-scribe#157）：「延伸」頁籤，會議轉錄 App 與字幕工作室用同一份。
// 一般 script，載入後掛 window.ExtPanel。只用 DOM 組畫面（不拼 HTML 字串）；結果用 window.MdView 排版。
//
//   const h = ExtPanel.mount(container, {
//     onRun(mod, options),        // 按「產生／重新產生」；宿主送出請求，好了再 h.update
//     onStop(),                   // 可選：產生中按「停止」
//     onCopy(text, result),       // 可選：複製（沒給就用 navigator.clipboard）
//     onReveal(result),           // 可選：工作室的「在 Finder 顯示」
//     onRemove(result),           // 可選：App 的「移除」（按兩次才算）
//   });
//   h.update({ modules, results, busy, error, loading })
//     modules：App 的模組清單 [{id, title, description, output, options:[{id, label, choices:[[id, label]]}]}]，只用 output 不是 mindmap 的
//     results：已產生的結果 [{key, module, label, markdown, stale, created, meta?}]；meta 是宿主想放在說明行的文字（例如在哪裡產生）
//     busy：正在產生的 { key, label } 或 null；error：上一次失敗的原因；loading：清單還沒來
//   h.destroy()
//   ExtPanel.keyOf(mod, options)、ExtPanel.labelOf(mod, options)：和伺服器同一套規則（模組＋選項決定一份結果）
(function () {
  "use strict";

  // 介面中英切換（#201）：用頁面登記的翻譯（web/shared/i18n.js 的 MeetingI18n.t）；沒載入就照中文
  const _ = (zh, vars) => (window.MeetingI18n?.t ? window.MeetingI18n.t(zh, vars)
    : vars ? zh.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : zh);
  // 圖示從共用的 MeetingIcons（web/shared/icons.js，#168）拿，不在這裡畫；沒載入就只顯示文字。
  // 認得的模組給圖示與短名稱，其他模組（含擴充包加的）用通用的星芒；視角按鈕各有圖示
  // 短名稱用函式：畫的時候才翻（頁面登記翻譯可能在這個檔載入之後）
  const LOOK = { sprout: { short: () => _("發芽"), icon: "sapling" }, perspective: { icon: "eye" } };
  const CHOICE_ICON = { "perspective.who.boss": "briefcase", "perspective.who.sped": "cap", "perspective.who.parent": "house" };
  const COPIED_MS = 1500;

  const keyOf = (mod, options = {}) => [mod.id, ...(mod.options || []).map((o) => `${o.id}=${options[o.id]}`)].join(":");
  // lang 給 "zh"／"en" 時用那個語言的固定格式（存檔的檔名與標題，跟介面語言無關，#204）；沒給就照介面語言（畫面上顯示）
  const labelOf = (mod, options = {}, lang) => {
    const picked = (mod.options || []).map((o) => o.choices.find(([c]) => c === options[o.id])?.[1]).filter(Boolean);
    if (!picked.length) return mod.title;
    if (lang === "zh") return `${mod.title}（${picked.join("、")}）`;   // 不翻：存檔的固定格式
    if (lang === "en") return `${mod.title} (${picked.join(", ")})`;
    return _("{title}（{choices}）", { title: mod.title, choices: picked.join(_("、")) });
  };

  function mount(container, hooks = {}) {
    const doc = container.ownerDocument;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (cls, text, onclick) => { const b = el("button", cls, text); b.setAttribute("type", "button"); b.onclick = onclick; return b; };
    // 裝飾用：旁邊一定有文字，讀屏不唸圖示
    const icon = (name) => doc.defaultView?.MeetingIcons?.icon(name, { doc, className: "ext-icon" }) || null;
    const withIcon = (b, name, text) => { const i = icon(name); if (i) b.append(i); b.append(el("span", "", text)); };

    let state = { modules: [], results: [], busy: null, error: "", loading: true };
    let pickId = "", armed = "", copied = "", copiedTimer = 0, gone = false;
    const choice = {};   // {模組: {選項: 選擇}}

    const root = el("div", "ext-panel");
    const tabs = el("div", "ext-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", _("延伸的哪一種"));
    const note = el("p", "ext-note");
    note.setAttribute("aria-live", "polite");
    const opts = el("div", "ext-opts");
    const actions = el("div", "ext-actions");
    const body = el("div", "ext-body");
    root.append(tabs, note, opts, actions, body);
    container.replaceChildren(root);

    const list = () => (state.modules || []).filter((m) => m.output !== "mindmap");
    const picked = () => list().find((m) => m.id === pickId) || list()[0] || null;
    const optionsOf = (mod) => {
      const out = {};
      for (const o of mod?.options || []) {
        const v = choice[mod.id]?.[o.id];
        out[o.id] = o.choices.some(([c]) => c === v) ? v : o.choices[0][0];
      }
      return out;
    };
    const resultOf = (key) => (state.results || []).find((r) => r.key === key) || null;

    function copy(text, result) {
      if (hooks.onCopy) return hooks.onCopy(text, result);
      const clip = doc.defaultView?.navigator?.clipboard;
      return clip ? clip.writeText(text) : false;   // 沒有剪貼簿可用就照實說複製失敗
    }

    function draw() {
      const mods = list(), mod = picked();
      if (mod) pickId = mod.id;
      const options = optionsOf(mod), key = mod ? keyOf(mod, options) : "", current = key ? resultOf(key) : null;
      const busy = state.busy || null, mine = busy && busy.key === key;

      // 子頁籤
      tabs.replaceChildren(...mods.map((m) => {
        const look = LOOK[m.id];
        const b = button("ext-tab", undefined, () => { pickId = m.id; armed = ""; draw(); });
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(m.id === pickId));
        b.setAttribute("data-mod", m.id);
        b.setAttribute("title", m.description ? _("{title}：{description}", { title: m.title, description: m.description }) : m.title);
        // 短名稱和模組名稱不一樣時（發芽），讀屏唸完整名稱
        if (look?.short) b.setAttribute("aria-label", m.title);
        withIcon(b, look?.icon || "spark", look?.short ? look.short() : m.title);
        return b;
      }));

      // 選項：每個選擇一顆按鈕，已產生的標出來
      opts.replaceChildren();
      for (const o of mod?.options || []) {
        const group = el("div", "ext-opt");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", o.label);
        group.append(el("span", "ext-opt-label", o.label));
        for (const [v, l] of o.choices) {
          const b = button("ext-choice", undefined, () => { choice[mod.id] = { ...(choice[mod.id] || {}), [o.id]: v }; armed = ""; draw(); });
          b.setAttribute("aria-pressed", String(options[o.id] === v));
          b.setAttribute("data-opt", o.id);
          b.setAttribute("data-choice", v);
          const ci = CHOICE_ICON[`${mod.id}.${o.id}.${v}`];
          if (ci) withIcon(b, ci, l); else b.append(el("span", "", l));
          if (resultOf(keyOf(mod, { ...options, [o.id]: v }))) b.append(el("span", "ext-done", _("・已產生")));
          group.append(b);
        }
        opts.append(group);
      }

      // 說明行
      note.className = "ext-note";
      if (mine) note.textContent = _("正在產生「{label}」，一兩分鐘就好。", { label: busy.label });
      else if (state.error) { note.textContent = _("沒有產生成功：{error}", { error: state.error }); note.className = "ext-note ext-warn"; }
      else if (state.loading) note.textContent = _("正在向會議轉錄 App 要延伸功能的清單…");
      else if (!mods.length) note.textContent = _("目前沒有延伸功能。");
      else if (current?.stale) { note.textContent = _("「{label}」產生之後內容改過了，要讓它跟上，按「重新產生」。", { label: current.label }); note.className = "ext-note ext-warn"; }
      else if (current) note.textContent = current.meta ? _("{label}：{meta}", { label: current.label, meta: current.meta }) : current.label;
      else note.textContent = mod?.description ? _("{title}：{description}。還沒產生。", { title: mod.title, description: mod.description }) : _("還沒產生。");

      // 動作
      actions.replaceChildren();
      const run = button("ext-run", mine ? _("正在產生…") : current ? _("重新產生") : _("產生"), () => { if (mod && !state.busy) hooks.onRun?.(mod, optionsOf(mod)); });
      run.disabled = !mod || Boolean(busy);
      actions.append(run);
      if (mine && hooks.onStop) actions.append(button("ext-stop", _("停止"), () => hooks.onStop()));
      if (current) {
        // 複製後按鈕閃一下「已複製」（失敗就說要手動選取），兩邊一樣
        const key = current.key, flash = (ok) => {
          if (gone) return;   // 剪貼簿回來前元件已經拿掉
          copied = ok ? `ok:${key}` : `fail:${key}`; draw();
          clearTimeout(copiedTimer); copiedTimer = setTimeout(() => { copied = ""; draw(); }, COPIED_MS);
        };
        const copyText = copied === `ok:${key}` ? _("已複製") : copied === `fail:${key}` ? _("複製失敗，請手動選取") : _("複製");
        actions.append(button("ext-copy", copyText, () => {
          Promise.resolve().then(() => copy(current.markdown, current)).then((r) => flash(r !== false), () => flash(false));
        }));
        if (hooks.onReveal) actions.append(button("ext-reveal", _("在 Finder 顯示"), () => hooks.onReveal(current)));
        if (hooks.onRemove) {
          const rm = button("ext-remove", armed === current.key ? _("確定移除？") : _("移除"), () => {
            if (armed !== current.key) { armed = current.key; draw(); return; }
            armed = "";
            hooks.onRemove(current);
          });
          actions.append(rm);
        }
      }

      // 結果：Markdown 排版
      if (current && doc.defaultView?.MdView) { body.hidden = false; doc.defaultView.MdView.render(body, current.markdown); }
      else if (current) { body.hidden = false; body.replaceChildren(el("pre", "ext-raw", current.markdown)); }
      else { body.hidden = true; body.replaceChildren(); }
    }

    draw();
    return Object.freeze({
      update(next) { state = { ...state, ...next }; draw(); },
      pick(id, options) { pickId = id; if (options) choice[id] = { ...options }; draw(); },
      current() { const mod = picked(); return mod ? { module: mod.id, options: optionsOf(mod), key: keyOf(mod, optionsOf(mod)) } : null; },
      destroy() { gone = true; clearTimeout(copiedTimer); container.replaceChildren(); },
    });
  }

  window.ExtPanel = Object.freeze({ mount, keyOf, labelOf, version: "1.2" });
})();
