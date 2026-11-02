// 心智圖元件（#155）：會議轉錄 App 與字幕工作室共用同一份，App 改了工作室就一樣。
// 一般 script（不是 ES module），載入後掛 window.MindMap；不依賴頁面的任何全域變數或 id，class 一律 mm- 開頭，樣式在同資料夾的 mindmap.css。
// 資料：{center, branches: [{label, children: [{label, children: [{label}]}]}]}（主題 → 議題 → 重點 → 細節）；編輯過會多一個 edited: true。
// 標籤來自 AI：進 DOM 一律 textContent／setAttribute，不拼 HTML。
(() => {
  "use strict";
  const VERSION = "1.0.0";
  const NS = "http://www.w3.org/2000/svg", FONT = 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif';
  // 配色（#127）：print＝存檔、下載用的固定淺色版（不動）；light／dark 是畫面上的，分支色取自心智圖產生器的「繽紛」配色，暗色版調亮、底色調深
  const THEMES = {
    print: { bg: "#fbfaf6", center: "#1d1d1b", onCenter: "#ffffff", fill: "#ffffff", text: "#1d1d1b", branches: ["#2f6f5e", "#3b6ea5", "#a4692f", "#7a4f9a", "#a43f5a", "#4f7d2f", "#56708a"] },
    light: { bg: "#faf8f4", center: "#243047", onCenter: "#ffffff", fill: "#ffffff", text: "#1f2328", tint: 0.86, branches: ["#e4572e", "#17a06b", "#2f6fdb", "#8a4fd6", "#c2255c", "#b8860b"] },
    dark: { bg: "#15171c", center: "#ecebe6", onCenter: "#15171c", fill: "#1f232b", text: "#ecebe6", tint: 0.78, branches: ["#ff8a65", "#3dd598", "#74a7ff", "#bb93ff", "#ff6f9f", "#e9bb4f"] },
  };
  const DEPTH = 3, LABEL_MAX = 40, UNDO_MAX = 50, MIN_S = 0.15, MAX_S = 4;

  // ---- 純函式 ----

  // 編輯中可能有空格：沒字也沒子項的丟掉，有子項的叫「（未命名）」；一格一行（Mermaid 與 Markdown 程式碼區塊才不會壞）
  function view(map) {
    // XML 不收的控制字元也拿掉，不然 .opml 存 Drive 會被擋
    const label = (t) => String(t ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/\s+/g, " ").replace(/`/g, "'").trim();
    const walk = (n) => {
      if (!n || typeof n !== "object") return null;
      const children = (Array.isArray(n.children) ? n.children : []).map(walk).filter(Boolean), l = label(n.label);
      return l || children.length ? { label: l || "（未命名）", children } : null;
    };
    map = map && typeof map === "object" ? map : {};
    return { center: label(map.center) || "（未命名）", branches: (Array.isArray(map.branches) ? map.branches : []).map(walk).filter(Boolean) };
  }

  // Mermaid 的括號有特殊意義：換成全形，貼到 Notion／Obsidian 才不會壞
  const mermaidLabel = (t) => String(t).replace(/[()]/g, (c) => (c === "(" ? "（" : "）")).replace(/[[\]{}]/g, (c) => ({ "[": "［", "]": "］", "{": "｛", "}": "｝" })[c]).replace(/\s+/g, " ").trim();
  function toMermaid(map) {
    const m = view(map), out = ["mindmap", `  root((${mermaidLabel(m.center)}))`];
    const walk = (n, d) => { out.push("  ".repeat(d + 1) + mermaidLabel(n.label)); n.children.forEach((c) => walk(c, d + 1)); };
    m.branches.forEach((b) => walk(b, 1));
    return out.join("\n");
  }
  function toMarkdown(map) {
    const m = view(map), outline = [];
    const walk = (n, d) => { outline.push("  ".repeat(d) + "- " + n.label); n.children.forEach((c) => walk(c, d + 1)); };
    m.branches.forEach((b) => walk(b, 0));
    return `# 心智圖：${m.center}\n\n\`\`\`mermaid\n${toMermaid(map)}\n\`\`\`\n\n## 大綱\n\n${outline.join("\n")}\n`;
  }
  // .opml：XMind、MindNode、SimpleMind、iThoughts、MindManager 都能匯入繼續改。中心主題是唯一的最上層 outline
  function toOpml(map) {
    const m = view(map), doc = document.implementation.createDocument(null, "opml", null), root = doc.documentElement;
    root.setAttribute("version", "2.0");
    const el = (tag, parent, text) => { const e = doc.createElement(tag); if (tag === "outline") e.setAttribute("text", text); else if (text != null) e.textContent = text; parent.append(e); return e; };
    el("title", el("head", root), m.center);
    const walk = (n, parent) => { const o = el("outline", parent, n.label); n.children.forEach((c) => walk(c, o)); };
    const top = el("outline", el("body", root), m.center);
    m.branches.forEach((b) => walk(b, top));
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc) + "\n";
  }
  // 存檔用的 SVG：樣式全寫在屬性裡，不靠外部 CSS；theme 沒給就是列印版（淺色），給 light／dark 就照那個配色
  function toSvg(map, opt = {}) {
    return new XMLSerializer().serializeToString(buildSvg(view(map), { theme: opt.theme }));
  }

  // 顏色小工具：a 往 b 混 t（0～1）；onColorHex 挑白或黑字，哪個跟底色對比高用哪個（WCAG 相對亮度）
  function mixHex(a, b, t) {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const A = rgb(a), B = rgb(b);
    return "#" + A.map((v, i) => Math.round(v * (1 - t) + B[i] * t).toString(16).padStart(2, "0")).join("");
  }
  function onColorHex(h) {
    const L = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
    return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? "#ffffff" : "#111111";
  }

  // 版面：中心在中間，議題依序分到右邊、左邊；每一層一欄，子節點垂直排開、用曲線接回父節點
  // opt.theme：沒給＝列印版；light／dark＝畫面配色。opt.live：畫面上的互動版，節點可以點、可以 Tab 到，有子項的旁邊有 −／數字圓鈕，
  // 底色由外框負責；opt.collapsed 裡的 key（"0"、"0.1"）收起來不畫子項
  function buildSvg(map, opt = {}) {
    const ctx = document.createElement("canvas").getContext("2d");
    const size = [20, 16, 14, 13], weight = [700, 700, 500, 400], rowH = 36, padX = 12, colGap = 44, margin = 28;
    const width = (label, d) => { ctx.font = `${weight[d]} ${size[d]}px ${FONT}`; return Math.ceil(ctx.measureText(label).width) + padX * 2; };
    const T = THEMES[opt.theme] || THEMES.print, colored = T !== THEMES.print, live = !!opt.live, closed = opt.collapsed || new Set();
    // 每個節點記下自己的 key（第幾個議題.第幾個重點…），收合用；收起來的節點畫面上當成沒有子項
    const tag = (n, key) => { n.key = key; (n.children || []).forEach((c, i) => tag(c, key + "." + i)); };
    map.branches.forEach((b, i) => tag(b, String(i)));
    const kids = (n) => (n.children && n.children.length && !(live && closed.has(n.key)) ? n.children : []);
    const rows = (n) => (kids(n).length ? kids(n).reduce((a, c) => a + rows(c), 0) : 1);
    const half = Math.ceil(map.branches.length / 2);
    const sides = [map.branches.slice(0, half), map.branches.slice(half)];
    // 每一側每一層的欄寬
    const colW = sides.map((list) => {
      const w = [0, 0, 0];
      const walk = (n, d) => { w[d - 1] = Math.max(w[d - 1], width(n.label, d)); kids(n).forEach((c) => walk(c, d + 1)); };
      list.forEach((b) => walk(b, 1));
      return w;
    });
    const centerW = width(map.center, 0), centerH = 48;
    const sideRows = sides.map((list) => list.reduce((a, b) => a + rows(b), 0));
    const h = Math.max(...sideRows, 2) * rowH + margin * 2;
    const leftSpan = colW[1].reduce((a, w) => a + (w ? w + colGap : 0), 0);
    const cx = margin + leftSpan + centerW / 2, cy = h / 2;
    const rightSpan = colW[0].reduce((a, w) => a + (w ? w + colGap : 0), 0);
    const W = Math.ceil(cx + centerW / 2 + rightSpan + margin);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("xmlns", NS);
    svg.setAttribute("width", W); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${W} ${h}`);
    svg.setAttribute("role", live ? "group" : "img"); svg.setAttribute("aria-label", "心智圖：" + map.center);
    const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.append(e); return e; };
    if (!live) el("rect", { x: 0, y: 0, width: W, height: h, rx: 14, fill: T.bg });
    const links = el("g", { fill: "none", "stroke-width": 2 }), nodes = el("g", {});
    const count = (n) => (n.children || []).reduce((a, c) => a + 1 + count(c), 0);
    const node = (n, d, x, y, w, color, dir = 1) => {
      const label = d === 0 ? n : n.label, nh = d === 0 ? centerH : d === 1 ? 32 : 28;
      const fill = d === 0 ? T.center : d === 1 ? color : colored && d === 2 ? mixHex(color, T.bg, T.tint) : T.fill;
      const ink = d === 0 ? T.onCenter : d >= 2 ? T.text : colored ? onColorHex(color) : "#ffffff";
      let g = nodes;
      const fold = live && d >= 1 && n.children?.length;
      if (fold) {
        const open = !closed.has(n.key);
        g = el("g", { class: "mm-node", "data-key": n.key, tabindex: 0, role: "button", "aria-expanded": String(open), "aria-label": `${label}（${open ? "按一下收合" : `已收合 ${count(n)} 項，按一下展開`}）` }, nodes);
      }
      const box = live ? { class: "mm-box" } : {};
      if (d <= 1) el("rect", { ...box, x: x - w / 2, y: y - nh / 2, width: w, height: nh, rx: nh / 2, fill }, g);
      else el("rect", { ...box, x: x - w / 2, y: y - nh / 2, width: w, height: nh, rx: 8, fill, stroke: color, "stroke-width": 1.5 }, g);
      const t = el("text", { x, y: y + size[d] * 0.36, "text-anchor": "middle", "font-family": FONT, "font-size": size[d], "font-weight": weight[d], fill: ink }, g);
      t.textContent = label;
      if (fold) {
        // 圓鈕放在節點朝外的那一端：展開時是 −，收起來時是實心圓加上底下有幾項
        const open = !closed.has(n.key), bx = x + dir * (w / 2), r = 10;
        const b = el("g", { class: "mm-tog" }, g);
        el("circle", { cx: bx, cy: y, r, fill: open ? T.bg : color, stroke: color, "stroke-width": 2 }, b);
        const bt = el("text", { x: bx, y: y + 4, "text-anchor": "middle", "font-family": FONT, "font-size": open ? 15 : 11, "font-weight": 700, fill: open ? color : onColorHex(color) }, b);
        bt.textContent = open ? "−" : String(count(n));
      }
    };
    const curve = (x1, y1, x2, y2, color) => { const mx = (x1 + x2) / 2; el("path", { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, stroke: color }, links); };
    let colorIdx = 0;
    sides.forEach((list, side) => {
      const dir = side === 0 ? 1 : -1, cols = colW[side];
      const colX = [cx + dir * (centerW / 2 + colGap + cols[0] / 2)];
      colX.push(colX[0] + dir * (cols[0] / 2 + colGap + cols[1] / 2));
      colX.push(colX[1] + dir * (cols[1] / 2 + colGap + cols[2] / 2));
      let top = cy - (sideRows[side] * rowH) / 2;
      const place = (n, d, parentX, parentY, parentW, color) => {
        const span = rows(n) * rowH, y = top + span / 2, x = colX[d - 1], w = width(n.label, d);
        curve(parentX + dir * parentW / 2, parentY, x - dir * w / 2, y, color);
        if (kids(n).length) {
          const save = top;
          kids(n).forEach((c) => { place(c, d + 1, x, y, w, color); });
          top = save + span;
        } else top += rowH;
        node(n, d, x, y, w, color, dir);
      };
      list.forEach((b) => place(b, 1, cx, cy, centerW, T.branches[colorIdx++ % T.branches.length]));
    });
    node(map.center, 0, cx, cy, centerW, T.center);
    return svg;
  }

  // ---- 元件 ----

  const clone = (m) => (m ? JSON.parse(JSON.stringify(m)) : null);
  const safeName = (s) => String(s || "mindmap").replace(/[\\/:*?"<>|]/g, "_");

  function copyToClipboard(text) {
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);   // iPhone Safari 要這行才選得到
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };
    return navigator.clipboard?.writeText(text).then(() => true, fallback) ?? Promise.resolve(fallback());
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // mount(container, {map, theme: "auto"|"dark"|"light", editable, fileName, onChange, onTheme}) → handle
  // theme "auto"：先看 <html data-theme>，沒有才看系統的淺色／深色，兩者改變都會跟著變。
  // onChange(map)：一次編輯完成才呼叫（改字是失焦或 Enter；加、刪、移動、復原是按下去就算），給的是一份複本。
  // onTheme(next)：按心智圖的「亮色／暗色」時呼叫，由頁面決定怎麼換（App 換整頁的主題）；沒給就只換心智圖自己。
  function mount(container, opts = {}) {
    let map = clone(opts.map), themeSetting = opts.theme || "auto", editable = opts.editable !== false, fileName = opts.fileName || "mindmap";
    let editing = false, undo = [], inputs = new WeakMap(), svgTimer = 0, moved = false, destroyed = false;
    const cam = { x: 0, y: 0, s: 1, auto: true }, collapsed = new Set();
    const mk = (tag, props = {}, data) => { const e = Object.assign(document.createElement(tag), props); if (data) e.dataset.mm = data; return e; };
    const btn = (data, text, title) => { const b = mk("button", { type: "button", textContent: text }, data); if (title) b.title = title; return b; };

    // ---- 畫面骨架 ----
    const root = mk("div", { className: "mm" });
    const tools = mk("div", { className: "mm-tools" });
    const P = {
      root, tools,
      "edit-btn": btn("edit-btn", "編輯", "直接改字、加減項目、調整順序"),
      copy: btn("copy", "複製 Mermaid", "貼到 Notion、Obsidian、GitHub 會自動畫成心智圖"),
      png: btn("png", "下載圖片"),
      opml: btn("opml", "匯出到心智圖 App", "下載 .opml，XMind、MindNode、SimpleMind 等心智圖 App 打開後可以繼續改"),
      note: mk("p", { className: "mm-note", hidden: true }),
      viewer: mk("div", { className: "mm-viewer" }),
      bar: mk("div", { className: "mm-bar" }),
      "zoom-out": btn("zoom-out", "−", "縮小（−）"),
      scale: mk("span", { className: "mm-scale", textContent: "100%" }),
      "zoom-in": btn("zoom-in", "＋", "放大（＋）"),
      fit: btn("fit", "符合畫面", "整張圖放進畫面（0）"),
      "expand-all": btn("expand-all", "全部展開"),
      "collapse-all": btn("collapse-all", "全部收合", "只留中心和議題"),
      theme: btn("theme", "亮色"),
      full: btn("full", "大畫面", "蓋滿整個視窗看"),
      body: mk("div", { className: "mm-body", tabIndex: 0 }),
      stage: mk("div", { className: "mm-stage" }),
      hint: mk("p", { className: "mm-hint" }),
      edit: mk("div", { className: "mm-edit", hidden: true }),
      undo: null,
    };
    P["edit-btn"].setAttribute("aria-pressed", "false");
    P.viewer.setAttribute("aria-label", "心智圖");
    P.bar.setAttribute("role", "toolbar"); P.bar.setAttribute("aria-label", "心智圖檢視");
    P.scale.setAttribute("aria-live", "polite");
    P.body.setAttribute("aria-label", "心智圖畫布：拖曳移動，＋／−縮放，0 符合畫面");
    for (const [k, label] of [["zoom-out", "縮小"], ["zoom-in", "放大"], ["fit", "符合畫面"], ["expand-all", "全部展開"], ["collapse-all", "全部收合"]]) P[k].setAttribute("aria-label", label);
    tools.append(P["edit-btn"], P.copy, P.png, P.opml);
    P.bar.append(P["zoom-out"], P.scale, P["zoom-in"], P.fit, P["expand-all"], P["collapse-all"], mk("span", { className: "mm-sep" }), P.theme, P.full);
    P.body.append(P.stage);
    P.viewer.append(P.bar, P.body, P.hint);
    root.append(tools, P.note, P.viewer, P.edit);
    container.append(root);

    // ---- 主題 ----
    const themeNow = () => {
      if (themeSetting === "light" || themeSetting === "dark") return themeSetting;
      const d = document.documentElement.dataset.theme;
      return d === "light" || d === "dark" ? d : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    };
    const followTheme = () => { if (themeSetting === "auto" && !destroyed) renderSvg(); };
    const themeObserver = new MutationObserver(followTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const schemeQuery = matchMedia("(prefers-color-scheme: light)");
    schemeQuery.addEventListener?.("change", followTheme);

    const emit = () => { if (opts.onChange && map) opts.onChange(clone(map)); };
    const say = (text, err = false) => { P.note.textContent = text; P.note.classList.toggle("mm-err", err); P.note.hidden = !text; };

    function render() {
      if (destroyed) return;
      if (!map || !editable) editing = false;
      P["edit-btn"].hidden = !map || !editable;
      P.copy.hidden = P.png.hidden = P.opml.hidden = !map;
      tools.hidden = !map;
      P["edit-btn"].setAttribute("aria-pressed", String(editing));
      P["edit-btn"].textContent = editing ? "完成編輯" : "編輯";
      if (!map) say("");
      renderSvg();
      renderEdit();
    }

    function renderSvg() {
      clearTimeout(svgTimer);
      P.stage.replaceChildren();
      P.viewer.hidden = !map;
      if (!map) { setFull(false); return; }
      const theme = themeNow();
      root.dataset.mmTheme = theme; P.viewer.dataset.mmTheme = theme;   // 大畫面時檢視搬到 body 底下，配色要跟著它走
      P.stage.append(buildSvg(view(map), { theme, live: true, collapsed }));
      renderBar();
      if (cam.auto) fitView(); else applyCam();
    }

    // ---- 編輯（改的是 map 本身，圖、Mermaid、PNG、.opml 都用改過的版本；復原最多 50 步）----
    function pushUndo(snapshot) {
      undo.push(snapshot);
      if (undo.length > UNDO_MAX) undo.shift();
    }
    // 改結構（加、刪、移）之前先存一份給「復原」；做完重畫，焦點放到 focus 那一格
    function change(fn) {
      pushUndo(JSON.stringify(map));
      const focus = fn();
      map.edited = true;
      render();
      emit();
      if (focus) inputs.get(focus)?.focus();
    }
    function renderEdit() {
      const box = P.edit;
      box.hidden = !editing;
      box.replaceChildren();
      P.undo = null;
      if (!editing) return;
      inputs = new WeakMap();
      const field = (node, key, depth, aria) => {
        const input = mk("input", { type: "text", value: node[key] ?? "", maxLength: LABEL_MAX, placeholder: depth ? "輸入文字" : "中心主題" });
        input.setAttribute("aria-label", aria);
        // 改字前的樣子在第一次輸入時記（不靠 focus 事件：頁面在背景時不一定會觸發）；change 時收成一步復原並通知頁面
        let before = null;
        input.oninput = () => {
          if (before === null) before = JSON.stringify(map);
          node[key] = input.value; map.edited = true;
          clearTimeout(svgTimer); svgTimer = setTimeout(renderSvg, 150);
        };
        // quiet：Enter 接著會加一格，那一步會通知，這裡就不另外通知
        input.onchange = (e, quiet = false) => {
          if (before !== null && before !== JSON.stringify(map)) { pushUndo(before); renderUndo(); if (!quiet) emit(); }
          before = null;
        };
        inputs.set(node, input);
        return input;
      };
      const tool = (text, title, fn, disabled = false) => {
        const b = mk("button", { type: "button", textContent: text, title, disabled });
        b.setAttribute("aria-label", title);
        b.onclick = fn;
        return b;
      };
      const row = (depth) => { const r = mk("div", { className: "mm-row" }); r.style.setProperty("--d", depth); return r; };
      const center = row(0);
      center.append(field(map, "center", 0, "中心主題"));
      box.append(center);
      const NAMES = ["議題", "重點", "細節"];
      const walk = (list, depth, parent) => list.forEach((node, i) => {
        const r = row(depth);
        const input = field(node, "label", depth, `第 ${depth} 層（${NAMES[depth - 1]}）`);
        // Enter：在下面加一格同一層的（中文輸入法選字時不算）
        input.onkeydown = (e) => {
          if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          input.onchange(null, true);   // 先把剛打的字記成一步復原，再記加一格這一步（兩步合成一次通知）
          change(() => { const n = { label: "", children: [] }; list.splice(i + 1, 0, n); return n; });
        };
        r.append(input,
          tool("＋", `在「${node.label || "這一格"}」下面加${NAMES[depth] || ""}`, () => change(() => { const n = { label: "", children: [] }; (node.children ||= []).push(n); return n; }), depth >= DEPTH),
          tool("↑", "往上移", () => change(() => { list.splice(i - 1, 0, ...list.splice(i, 1)); return node; }), i === 0),
          tool("↓", "往下移", () => change(() => { list.splice(i + 1, 0, ...list.splice(i, 1)); return node; }), i === list.length - 1),
          tool("✕", `刪掉「${node.label || "這一格"}」${node.children?.length ? "和底下的項目" : ""}`, () => change(() => { list.splice(i, 1); return list[i] || list[i - 1] || parent; })));
        box.append(r);
        if (node.children?.length && depth < DEPTH) walk(node.children, depth + 1, node);
      });
      walk(map.branches ||= [], 1, map);
      const foot = mk("div", { className: "mm-foot" });
      P.undo = mk("button", { type: "button", textContent: "復原", onclick: undoLast }, "undo");
      const done = mk("button", { type: "button", textContent: "完成編輯", onclick: () => { editing = false; render(); P["edit-btn"].focus(); } }, "done");
      foot.append(tool("＋ 新增議題", "在最後加一個議題", () => change(() => { const n = { label: "", children: [] }; map.branches.push(n); return n; })), P.undo, done);
      box.append(foot);
      renderUndo();
    }
    function renderUndo() { if (P.undo) P.undo.disabled = !undo.length; }
    function undoLast() {
      if (!undo.length) return;
      map = JSON.parse(undo.pop());
      render();
      emit();
      // 編輯器整個重畫過：焦點放回「復原」（退到底按不了就放「完成編輯」），鍵盤不用從頭 Tab
      (P.undo && !P.undo.disabled ? P.undo : P.edit.querySelector('[data-mm="done"]'))?.focus();
    }

    // ---- 畫布（#127）：平移、縮放、收合、大畫面。cam：畫面上 (x, y) 位移與縮放 s；auto＝還沒動過，版面或大小改變時自動「符合畫面」----
    let home = null;
    const svgSize = () => { const svg = P.stage.querySelector("svg"); return svg ? { w: +svg.getAttribute("width"), h: +svg.getAttribute("height") } : null; };
    function applyCam() {
      P.stage.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
      P.scale.textContent = Math.round(cam.s * 100) + "%";
    }
    function fitView() {
      const body = P.body, size = svgSize(), W = body.clientWidth, pad = 16;
      cam.auto = true;
      if (!size || !W) return;   // 還看不到（在別的頁籤、側欄關著）：等 ResizeObserver 通知再算
      let H = body.clientHeight;
      if (!isFull()) {
        // 一般版面：寬的圖縮小後上下會空一大塊，畫布高度跟著圖縮（最多 58vh／560px，最少 240px）
        const maxH = Math.min(560, Math.max(280, innerHeight * 0.58));
        const fitS = Math.min((W - pad * 2) / size.w, (maxH - pad * 2) / size.h, 1.6);
        H = Math.round(Math.max(240, Math.min(maxH, size.h * fitS + pad * 2)));
        body.style.height = H + "px";
      } else body.style.height = "";
      if (!H) return;
      const s = Math.max(MIN_S, Math.min((W - pad * 2) / size.w, (H - pad * 2) / size.h, 1.6));
      cam.s = s; cam.x = (W - size.w * s) / 2; cam.y = (H - size.h * s) / 2;
      applyCam();
    }
    // 以畫布上的 (px, py) 為中心縮放 f 倍；沒給位置就用畫布中心
    function zoom(f, px, py) {
      if (px === undefined) { px = P.body.clientWidth / 2; py = P.body.clientHeight / 2; }
      const ns = Math.min(MAX_S, Math.max(MIN_S, cam.s * f)), k = ns / cam.s;
      cam.x = px - (px - cam.x) * k; cam.y = py - (py - cam.y) * k; cam.s = ns; cam.auto = false;
      applyCam();
    }
    function pan(dx, dy) { cam.x += dx; cam.y += dy; cam.auto = false; applyCam(); }
    // 收合／展開一個節點：重畫後把它留在畫面上原來的位置，不會一點就跳走
    function toggle(key) {
      const at = (k) => P.stage.querySelector(`.mm-node[data-key="${k}"] .mm-box`)?.getBoundingClientRect();
      const before = at(key);
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      cam.auto = false;
      renderSvg();
      const after = at(key);
      if (before && after) pan(before.left - after.left, before.top - after.top);
      P.stage.querySelector(`.mm-node[data-key="${key}"]`)?.focus({ preventScroll: true });
    }
    function setAll(open) {
      collapsed.clear();
      if (!open && map) view(map).branches.forEach((b, i) => { if (b.children.length) collapsed.add(String(i)); });
      cam.auto = true;
      renderSvg();
    }

    // 大畫面：把整個檢視搬到 body 底下蓋滿視窗（放在 fixed＋z-index 的側欄裡會被標題列蓋住），關掉再搬回原位
    const isFull = () => P.viewer.classList.contains("mm-full");
    function setFull(on) {
      if (on === isFull()) return;
      const view = P.viewer;
      if (on) {
        home = view.parentNode;
        document.body.append(view);
        view.setAttribute("role", "dialog"); view.setAttribute("aria-modal", "true");
      } else {
        if (home) home.insertBefore(view, P.edit);
        view.removeAttribute("role"); view.removeAttribute("aria-modal");
      }
      view.classList.toggle("mm-full", on);
      document.body.classList.toggle("mm-full-open", on);
      if (destroyed) { view.remove(); return; }
      renderBar();
      fitView();
      (on ? P.body : P.full).focus({ preventScroll: true });
    }
    function renderBar() {
      const full = isFull(), light = themeNow() === "light";
      P.full.textContent = full ? "關閉" : "大畫面";
      P.full.setAttribute("aria-label", full ? "關閉大畫面" : "大畫面檢視");
      P.full.title = full ? "回到原位（Esc）" : "蓋滿整個視窗看";
      P.theme.textContent = light ? "暗色" : "亮色";
      P.theme.setAttribute("aria-label", light ? "改成暗色" : "改成亮色");
      // 手機、平板（只有觸控）不提滾輪和 Esc
      P.hint.textContent = matchMedia("(pointer: coarse)").matches ? "單指拖曳移動・雙指縮放・點議題收合／展開"
        : full ? "拖曳移動・滾輪或雙指縮放・點議題收合／展開・Esc 關閉" : "拖曳移動・Ctrl＋滾輪或觸控板捏合縮放・點議題收合／展開";
    }

    // ---- 按鈕 ----
    P["zoom-in"].onclick = () => zoom(1.25);
    P["zoom-out"].onclick = () => zoom(0.8);
    P.fit.onclick = () => fitView();
    P["expand-all"].onclick = () => setAll(true);
    P["collapse-all"].onclick = () => setAll(false);
    P.full.onclick = () => setFull(!isFull());
    P.theme.onclick = () => {
      const next = themeNow() === "light" ? "dark" : "light";
      if (opts.onTheme) opts.onTheme(next); else { themeSetting = next; renderSvg(); }
    };
    P["edit-btn"].onclick = () => { editing = !editing; render(); if (editing) inputs.get(map)?.focus(); };
    const flash = (b, text) => {
      const label = b.dataset.label || (b.dataset.label = b.textContent);
      b.textContent = text;
      setTimeout(() => { b.textContent = label; }, 1500);
    };
    P.copy.onclick = async () => { if (map) flash(P.copy, (await copyToClipboard(toMermaid(map))) ? "已複製" : "複製失敗，請手動選取"); };
    P.opml.onclick = () => { if (map) download(new Blob([toOpml(map)], { type: "text/x-opml" }), `${safeName(fileName)}.opml`); };
    P.png.onclick = async () => {
      if (!map) return;
      try {
        const svg = buildSvg(view(map)), scale = 2;
        const w = +svg.getAttribute("width"), h = +svg.getAttribute("height");
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = w * scale; canvas.height = h * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => download(blob, `${safeName(fileName)}.png`), "image/png");
      } catch (e) {
        say("這個瀏覽器沒辦法轉成圖片，可以改用「複製 Mermaid」或「匯出到心智圖 App」。", true);
      }
    };

    // ---- 畫布操作 ----
    const body = P.body;
    // 點節點收合／展開；剛拖曳過的那一下不算點
    body.addEventListener("click", (e) => {
      if (moved) { moved = false; return; }
      const g = e.target.closest?.(".mm-node");
      if (g) toggle(g.dataset.key);
    });
    // 鍵盤：＋／− 縮放、0 符合畫面、方向鍵平移；節點上 Enter／空白鍵收合（工具列按鈕上也能用 ＋／−／0）
    P.viewer.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const g = e.target.closest?.(".mm-node");
      if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(g.dataset.key); return; }
      const k = e.key, step = 60;
      if (k === "+" || k === "=") zoom(1.25);
      else if (k === "-" || k === "_") zoom(0.8);
      else if (k === "0") fitView();
      else if (e.target.tagName === "BUTTON" && k.startsWith("Arrow")) return;
      else if (k === "ArrowLeft") pan(step, 0);
      else if (k === "ArrowRight") pan(-step, 0);
      else if (k === "ArrowUp") pan(0, step);
      else if (k === "ArrowDown") pan(0, -step);
      else return;
      e.preventDefault();
    });
    // 大畫面時 Tab 只在檢視裡面繞
    P.viewer.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || !isFull()) return;
      const items = [...P.viewer.querySelectorAll("button, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // Esc 關大畫面：在 window 的捕捉階段先處理，不讓頁面自己的 Esc（例如收起側欄）也跟著觸發
    const onEsc = (e) => { if (e.key === "Escape" && isFull()) { e.preventDefault(); e.stopPropagation(); setFull(false); } };
    window.addEventListener("keydown", onEsc, true);
    // 滾輪：Ctrl／⌘＋滾輪（觸控板捏合也是這個）縮放；大畫面時一般滾輪也縮放。一般版面的一般滾輪照常捲頁面
    body.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey || isFull())) return;
      e.preventDefault();
      const r = body.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoom(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // Pointer Events：一指（或滑鼠）拖曳平移、兩指捏合縮放；畫布 touch-action:none，不會跟頁面捲動搶
    const pts = new Map();
    let drag = null, pinch = null;
    const local = (p) => { const r = body.getBoundingClientRect(); return { x: p.x - r.left, y: p.y - r.top }; };
    body.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { moved = false; drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], c = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: cam.s, cx: cam.x, cy: cam.y, mx: c.x, my: c.y };
        drag = null; moved = true;
      }
    });
    const onMove = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 5) { moved = true; body.classList.add("mm-dragging"); }
        if (moved) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; cam.auto = false; applyCam(); }
      } else if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()], c = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const ns = Math.min(MAX_S, Math.max(MIN_S, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)), k = ns / pinch.s;
        cam.s = ns; cam.x = c.x - (pinch.mx - pinch.cx) * k; cam.y = c.y - (pinch.my - pinch.cy) * k; cam.auto = false;
        applyCam();
      }
    };
    const onUp = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) pinch = null;
      if (!pts.size) { drag = null; body.classList.remove("mm-dragging"); }
      // 捏合後剩一指：從這裡接著拖，不會跳
      else if (pts.size === 1 && !drag) { const [p] = [...pts.values()]; drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y }; }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // 畫布大小改變（打開側欄、切頁籤、拉寬視窗、轉手機方向）：還沒動過就重新符合畫面
    const resize = window.ResizeObserver ? new ResizeObserver(() => { if (cam.auto && map) fitView(); }) : null;
    resize?.observe(body);

    render();

    return {
      // 換一張圖。預設當成新的一張：視角、收合、復原都重來。
      // {undo: true}：目前這張先存進「復原」（例如重新產生，按復原拿得回來）；{keep: true}：視角、收合、復原、編輯狀態都留著（例如整場換名字）
      set(next, o = {}) {
        if (o.undo && map) pushUndo(JSON.stringify(map));
        map = clone(next);
        if (!o.keep) {
          collapsed.clear(); cam.auto = true;
          if (!o.undo) { undo = []; editing = false; }
        }
        render();
      },
      get: () => clone(map),
      setTheme(t) { themeSetting = t === "light" || t === "dark" ? t : "auto"; if (map) renderSvg(); },
      setEditable(on) { editable = !!on; render(); },
      setFileName(name) { fileName = name || "mindmap"; },
      // 目前的檢視狀態（畫面上顯示什麼、測試用）：位移、縮放、收合了幾個、是否在編輯、是否大畫面
      state: () => ({ x: cam.x, y: cam.y, s: cam.s, auto: cam.auto, collapsed: collapsed.size, editing, full: isFull(), theme: themeNow() }),
      // 元件裡的元素（root、tools、edit-btn、copy、png、opml、note、viewer、bar、zoom-out、scale、zoom-in、fit、expand-all、collapse-all、theme、full、body、stage、hint、edit、undo）
      part: (name) => P[name] || null,
      fit: () => fitView(),
      destroy() {
        if (destroyed) return;
        destroyed = true;   // 先標記：setFull 收回大畫面時就不會重畫、不會搶焦點
        setFull(false);
        clearTimeout(svgTimer);
        themeObserver.disconnect();
        schemeQuery.removeEventListener?.("change", followTheme);
        window.removeEventListener("keydown", onEsc, true);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        resize?.disconnect();
        root.remove();
      },
    };
  }

  window.MindMap = Object.freeze({ version: VERSION, view, toMermaid, toMarkdown, toOpml, toSvg, mount });
})();
