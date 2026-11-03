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
//     missing：英文模式下查不到的中文（除錯用）
//   MeetingI18n.version
(function () {
  "use strict";
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA"]);
  const norm = (s) => s.replace(/\s+/g, " ").trim();

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
      if (!vars) return s;
      return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
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

    return Object.freeze({ lang: lang === "en" ? "en" : "zh", _, translate, missing });
  }

  window.MeetingI18n = Object.freeze({ version: "1.0.0", pick, create });
})();
