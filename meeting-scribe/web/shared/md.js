// 共用元件（meeting-scribe#157）：把 AI 寫的 Markdown 排版顯示，會議轉錄 App 與字幕工作室用同一份。
// 一般 script（不是 ES module），載入後掛 window.MdView。只用 DOM 組畫面（createElement＋textContent），
// 不拼 HTML 字串：內容來自 AI，任何 HTML 都當成文字；連結只收 http／https。
//
//   MdView.parse(markdown)                 → 區塊陣列（純資料，方便測試）
//   MdView.render(container, markdown, { top })  → 清空 container 後畫進去；top＝「#」對應的標題層級（預設 3）
//
// 支援：標題 #～######、段落（單一換行保留）、無序／有序清單（可巢狀）、粗體、斜體、刪除線、行內程式碼、
// 程式碼區塊（```）、表格、引用、分隔線、連結與裸網址。
(function () {
  "use strict";

  // ---- 行內 ----
  const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;
  // 依序比對：行內程式碼、連結、裸網址、粗體、刪除線、斜體（只認 *，免得 snake_case 被當斜體）
  // 網址只認 ASCII：中文沒有空白分隔，網址後面緊接的中文、全形標點不能被吃進去
  const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\*([^*\s][^*\n]*?)\*/;

  // noLink：連結文字裡不再找網址（不然 <a> 裡又有 <a>）
  function inline(text, noLink = false) {
    const out = [];
    let rest = String(text);
    while (rest) {
      const m = INLINE.exec(rest);
      if (!m) { out.push({ t: "text", v: rest }); break; }
      if (m.index) out.push({ t: "text", v: rest.slice(0, m.index) });
      if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
      else if (m[2] !== undefined) {
        out.push(SAFE_URL.test(m[3]) && !noLink ? { t: "a", href: m[3], c: inline(m[2], true) } : { t: "text", v: m[0] });
      } else if (m[4] !== undefined && noLink) {
        out.push({ t: "text", v: m[4] });
      } else if (m[4] !== undefined) {
        // 句尾的標點不算在網址裡
        const url = m[4].replace(/[.,;:!?，。；：！？、]+$/u, "");
        out.push({ t: "a", href: url, c: [{ t: "text", v: url }] });
        if (url.length < m[4].length) out.push({ t: "text", v: m[4].slice(url.length) });
      } else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: "strong", c: inline(m[5] ?? m[6], noLink) });
      else if (m[7] !== undefined) out.push({ t: "del", c: inline(m[7], noLink) });
      else out.push({ t: "em", c: inline(m[8], noLink) });
      rest = rest.slice(m.index + m[0].length);
    }
    // 相鄰的文字併在一起
    return out.reduce((acc, n) => {
      const last = acc[acc.length - 1];
      if (n.t === "text" && last?.t === "text") last.v += n.v; else acc.push(n);
      return acc;
    }, []).filter((n) => n.t !== "text" || n.v);
  }

  // ---- 區塊 ----
  const indentOf = (line) => { let n = 0; for (const ch of line) { if (ch === " ") n += 1; else if (ch === "\t") n += 4; else break; } return n; };
  const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  function parse(md) {
    const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
    return blocks(lines, 0, lines.length);
  }

  function blocks(lines, from, to) {
    const out = [];
    let i = from;
    while (i < to) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const body = [];
        i += 1;
        while (i < to && !new RegExp(`^\\s{0,3}${m[1]}\\s*$`).test(lines[i])) { body.push(lines[i]); i += 1; }
        out.push({ t: "code", lang: m[2] || "", text: body.join("\n") });
        i += 1;
        continue;
      }
      if ((m = HEAD.exec(line))) { out.push({ t: "h", level: m[1].length, c: inline(m[2]) }); i += 1; continue; }
      if (HR.test(line)) { out.push({ t: "hr" }); i += 1; continue; }   // 「- - -」也是分隔線，不是清單
      if (/^\s{0,3}>/.test(line)) {
        const inner = [];
        while (i < to && /^\s{0,3}>/.test(lines[i])) { inner.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i += 1; }
        out.push({ t: "quote", c: blocks(inner, 0, inner.length) });
        continue;
      }
      if (line.includes("|") && i + 1 < to && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const head = cells(line), align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
        const rows = [];
        i += 2;
        while (i < to && lines[i].includes("|") && lines[i].trim()) { rows.push(cells(lines[i])); i += 1; }
        out.push({ t: "table", align: head.map((_, k) => align[k] || ""), head: head.map(inline), rows: rows.map((r) => head.map((_, k) => inline(r[k] ?? ""))) });
        continue;
      }
      if (ITEM.test(line)) { i = list(lines, i, to, out); continue; }
      // 段落：連續的一般文字行，單一換行保留
      const para = [];
      while (i < to && lines[i].trim() && !HEAD.test(lines[i]) && !FENCE.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !ITEM.test(lines[i]) && !HR.test(lines[i])) {
        para.push(inline(lines[i].trim()));
        i += 1;
      }
      out.push({ t: "p", lines: para });
    }
    return out;
  }

  // 清單：同一層的項目縮排一樣；縮排更深的項目是子清單；接在項目後面、縮排比記號深的一般文字是同一項的續行
  function list(lines, i, to, out) {
    const first = ITEM.exec(lines[i]);
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const node = { t: ordered ? "ol" : "ul", start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    out.push(node);
    while (i < to) {
      const line = lines[i];
      if (!line.trim()) {
        // 空行之後還是同一層的項目，清單就繼續
        let k = i + 1;
        while (k < to && !lines[k].trim()) k += 1;
        const next = k < to ? ITEM.exec(lines[k]) : null;
        // 縮排更深的（不論有序無序）是上一項的子清單；同一層要同一種才算同一個清單
        if (next && (indentOf(next[1]) > base || (indentOf(next[1]) === base && /\d/.test(next[2]) === ordered))) { i = k; continue; }
        break;
      }
      const m = ITEM.exec(line);
      const ind = indentOf(line);
      if (m && ind === base) {
        if (/\d/.test(m[2]) !== ordered) break;
        node.items.push({ c: [inline(m[3])], sub: [] });
        i += 1;
        continue;
      }
      if (m && ind > base && node.items.length) { i = list(lines, i, to, node.items[node.items.length - 1].sub); continue; }
      if (!m && ind > base && node.items.length) { node.items[node.items.length - 1].c.push(inline(line.trim())); i += 1; continue; }
      break;
    }
    return i;
  }

  // ---- 畫到 DOM ----
  function el(doc, tag, cls) { const e = doc.createElement(tag); if (cls) e.className = cls; return e; }
  function drawInline(doc, parent, nodes) {
    for (const n of nodes) {
      if (n.t === "text") parent.append(doc.createTextNode(n.v));
      else if (n.t === "code") { const e = el(doc, "code", "md-code"); e.textContent = n.v; parent.append(e); }
      else if (n.t === "a") {
        const a = el(doc, "a", "md-link");
        a.setAttribute("href", n.href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        drawInline(doc, a, n.c);
        parent.append(a);
      } else { const e = el(doc, n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del"); drawInline(doc, e, n.c); parent.append(e); }
    }
  }
  function drawLines(doc, parent, lines) {
    lines.forEach((l, k) => { if (k) parent.append(el(doc, "br")); drawInline(doc, parent, l); });
  }
  function drawBlocks(doc, parent, list, top) {
    for (const b of list) {
      if (b.t === "h") { const e = el(doc, `h${Math.min(6, top + b.level - 1)}`, `md-h md-h${b.level}`); drawInline(doc, e, b.c); parent.append(e); }
      else if (b.t === "p") { const e = el(doc, "p", "md-p"); drawLines(doc, e, b.lines); parent.append(e); }
      else if (b.t === "hr") parent.append(el(doc, "hr", "md-hr"));
      else if (b.t === "code") {
        const pre = el(doc, "pre", "md-pre"), code = el(doc, "code");
        code.textContent = b.text;
        if (b.lang) pre.setAttribute("data-lang", b.lang);
        pre.append(code);
        parent.append(pre);
      } else if (b.t === "quote") { const e = el(doc, "blockquote", "md-quote"); drawBlocks(doc, e, b.c, top); parent.append(e); }
      else if (b.t === "ul" || b.t === "ol") {
        const e = el(doc, b.t, `md-list md-${b.t}`);
        if (b.t === "ol" && b.start !== 1) e.setAttribute("start", String(b.start));
        for (const it of b.items) {
          const li = el(doc, "li");
          drawLines(doc, li, it.c);
          drawBlocks(doc, li, it.sub, top);
          e.append(li);
        }
        parent.append(e);
      } else if (b.t === "table") {
        const wrap = el(doc, "div", "md-table-wrap"), table = el(doc, "table", "md-table");
        const thead = el(doc, "thead"), tr = el(doc, "tr");
        b.head.forEach((c, k) => { const th = el(doc, "th"); if (b.align[k]) th.style.textAlign = b.align[k]; drawInline(doc, th, c); tr.append(th); });
        thead.append(tr);
        const tbody = el(doc, "tbody");
        for (const r of b.rows) {
          const row = el(doc, "tr");
          r.forEach((c, k) => { const td = el(doc, "td"); if (b.align[k]) td.style.textAlign = b.align[k]; drawInline(doc, td, c); row.append(td); });
          tbody.append(row);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
      }
    }
  }

  function render(container, markdown, { top = 3 } = {}) {
    const doc = container.ownerDocument;
    container.replaceChildren();
    container.classList.add("md-view");
    drawBlocks(doc, container, parse(markdown), Math.max(1, Math.min(6, top)));
    return container;
  }

  window.MdView = Object.freeze({ parse, inline, render, version: "1" });
})();
