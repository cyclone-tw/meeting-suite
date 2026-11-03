// 共用元件（meeting-scribe#195）：介面中英切換。會議轉錄 App 先用，之後共用元件與字幕工作室也用同一份。
// 一般 script，載入後掛 window.MeetingI18n。做法照 gettext：程式裡照樣寫中文，包在 _("中文")；
// 英文字典（web/shared/lang-en.js 的 window.MeetingLangEN）用中文原文當鍵，查不到就顯示中文。
//
//   MeetingI18n.pick(saved, languages)  → "zh" 或 "en"
//     saved：使用者選過的（頁面自己記，例如 localStorage 的 ms.lang）；沒選過時看瀏覽器第一個語言，中文就中文，其他英文
//   MeetingI18n.create(lang, dicts)     → { lang, _, translate, missing }
//     _(zh, vars)：翻譯；vars 有給就把 {名稱} 換成 vars 裡的值。字典的值可以是 [單數, 複數]，依 vars.n 是不是 1 挑
//     translate(root)：把 root 底下的文字與 title／placeholder／aria-label／alt 照字典換掉（開頁時對靜態畫面做一次）。
//       鍵是去掉頭尾空白、中間空白縮成一格的文字，換的時候保留原本頭尾的空白；script、style、textarea 只換屬性、
//       裡面的字不動；translate="no" 的元素整個不動
//     msg(text)：主機送來、已經組好的訊息照字典換（#152）：整句是鍵就換；不是就比對帶 {名稱} 的鍵（字面要一樣、字面越長越先比），
//       變數的部分原樣帶過去，本身也是字典裡的訊息就一起翻。查不到照原樣，不記進 missing
//     missing：英文模式下查不到的中文（除錯用）
//   MeetingI18n.use(i18n)               → 登記頁面目前用的翻譯（create 的結果），共用元件經 t() 取用（#201）
//   MeetingI18n.t(zh, vars)             → 用登記的翻譯；頁面沒登記（還沒做中英切換的頁面）就照中文，只換 {名稱}
//   MeetingI18n.version
(function () {
  "use strict";
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA"]);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : s);

  function pick(saved, languages) {
    if (saved === "zh" || saved === "en") return saved;
    const first = (languages && languages[0]) || "";
    return !first || /^zh\b/i.test(first) ? "zh" : "en";
  }

  function create(lang, dicts) {
    const map = lang === "en" ? Object.assign({}, ...(dicts || [])) : null;
    const missing = new Set();
    const look = (zh) => {
      if (!map) return zh;
      if (Object.prototype.hasOwnProperty.call(map, zh)) return map[zh];
      missing.add(zh);
      return zh;
    };

    function _(zh, vars) {
      let s = look(zh);
      if (Array.isArray(s)) s = s[vars && vars.n === 1 ? 0 : 1];
      return fill(s, vars);
    }

    function swap(text) {
      const key = norm(text);
      if (!key || !map || !Object.prototype.hasOwnProperty.call(map, key)) {
        if (key && map && /[㐀-鿿]/.test(key)) missing.add(key);
        return null;
      }
      const v = Array.isArray(map[key]) ? map[key][1] : map[key];
      return text.match(/^\s*/)[0] + v + text.match(/\s*$/)[0];
    }

    // attrsOnly：script、style、textarea 只換屬性（例如 textarea 的 placeholder），裡面的字不動
    function translateEl(el, attrsOnly) {
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        const t = v && swap(v);
        if (t != null) el.setAttribute(a, t.trim());
      }
      if (attrsOnly) return;
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) {
          const t = swap(node.nodeValue);
          if (t != null) node.nodeValue = t;
        } else if (node.nodeType === 1 && node.getAttribute("translate") !== "no") {
          translateEl(node, SKIP.has(node.tagName));
          if (node.tagName === "TEMPLATE") for (const c of Array.from(node.content.children)) translateEl(c);
        }
      }
    }

    function translate(root) {
      if (!map || !root) return;
      if (root.nodeType === 1) translateEl(root);
      else for (const n of Array.from(root.children || [])) translateEl(n);
    }

    const RX = /[.*+?^${}()|[\]\\]/g;
    const pats = map ? Object.keys(map).filter((k) => /\{\w+\}/.test(k)).map((k) => {
      const parts = k.split(/\{(\w+)\}/), names = parts.filter((x, i) => i % 2 === 1);
      const lit = parts.filter((x, i) => i % 2 === 0).join("").length;
      const rx = new RegExp("^" + parts.map((p, i) => (i % 2 ? "([\\s\\S]*?)" : p.replace(RX, "\\$&"))).join("") + "$");
      return { k, rx, names, lit };
    }).filter((p) => p.lit).sort((a, b) => b.lit - a.lit) : [];

    function msg(text, depth = 0) {
      if (!map || typeof text !== "string" || !/[\u3400-\u9fff]/.test(text)) return text;   // 沒有中文字（例如錯誤類型名稱）就不用查
      if (Object.prototype.hasOwnProperty.call(map, text)) return Array.isArray(map[text]) ? map[text][1] : map[text];
      if (depth < 4) {
        for (const p of pats) {
          const m = p.rx.exec(text);
          if (!m) continue;
          const vars = {};
          p.names.forEach((n, i) => { if (!(n in vars)) vars[n] = msg(m[i + 1], depth + 1); });
          const v = map[p.k];
          return fill(Array.isArray(v) ? v[vars.n === "1" ? 0 : 1] : v, vars);
        }
      }
      return text;
    }

    return Object.freeze({ lang: lang === "en" ? "en" : "zh", _, translate, msg, missing });
  }

  let current = null;
  const use = (i18n) => { current = i18n || null; };
  function t(zh, vars) {
    if (current) return current._(zh, vars);
    return fill(zh, vars);
  }

  window.MeetingI18n = Object.freeze({ version: "1.1.0", pick, create, use, t });
})();
