// 介面中英切換（#152）的掃描工具：找出字幕工作室頁面裡給人看的中文。
// 移植自 meeting-scribe 的 tests/i18n_scan.py（會議 App 用同一套規則），兩邊改了要一起改：
// - HTML：<script>、<style>、<textarea>、註解以外的文字，以及 title／placeholder／aria-label／alt 屬性；
//   標了 translate="no" 的元素整個不算（web/shared/i18n.js 也不換）。文字的鍵是去掉頭尾空白、中間空白縮成一格。
// - JS：字串（'…'、"…"、`…`）；註解與正規表示式不算。樣板字串只看 ${…} 以外的字，${…} 裡面另外掃。
//   同一行的註解有「不翻」兩個字的，那一行的字串是資料或產出內容，不算介面文字。
export const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;
const ATTRS = ["title", "placeholder", "aria-label", "alt"];
const KEEP = /(\/\/|\/\*).*不翻/;
const REGEX_PREV = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw"]);
const SKIP_TAGS = new Set(["script", "style", "textarea"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => /\s/.test(c);

export const norm = (s) => s.replace(/\s+/g, " ").trim();
const lineAt = (src, i) => src.slice(0, i).split("\n").length;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/** HTML → { texts: [[行號, 文字]], attrs: [[行號, 屬性, 值]], scripts: [[開始行號, 內容]] } */
export function parseHtml(text) {
  const texts = [], attrs = [], scripts = [], keep = [];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let pos = 0, m;
  const addText = (from, to) => {
    if (keep.length) return;
    const raw = decode(text.slice(from, to));
    if (CJK.test(raw)) texts.push([lineAt(text, from + raw.search(/\S|$/)), norm(raw)]);
  };
  while ((m = re.exec(text))) {
    addText(pos, m.index);
    pos = re.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      if (keep.length && keep.at(-1)[0] === tag && !--keep.at(-1)[1]) keep.pop();
      continue;
    }
    const tag = m[2].toLowerCase(), a = {};
    for (const [, k, v] of (m[3] || "").matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) a[k.toLowerCase()] = v === undefined ? "" : decode(v.replace(/^["']|["']$/g, ""));
    if (keep.length && keep.at(-1)[0] === tag) keep.at(-1)[1] += 1;
    else if (a.translate === "no" && !VOID_TAGS.has(tag) && !m[0].endsWith("/>")) keep.push([tag, 1]);
    if (a.translate !== "no") for (const k of ATTRS) if (a[k] && CJK.test(a[k])) attrs.push([lineAt(text, m.index), k, norm(a[k])]);
    if (SKIP_TAGS.has(tag)) {
      const close = text.toLowerCase().indexOf(`</${tag}`, pos);
      const end = close < 0 ? text.length : close;
      if (tag === "script" && !("src" in a)) scripts.push([lineAt(text, pos), text.slice(pos, end)]);
      re.lastIndex = pos = end;
    }
  }
  addText(pos, text.length);
  return { texts, attrs, scripts };
}

function skipQuoted(src, k) {
  const q = src[k];
  k += 1;
  while (k < src.length && src[k] !== q) k += src[k] === "\\" ? 2 : 1;
  return k + 1;
}

/** src[i] 是 `：回傳 [結束位置, [["lit", 原文] | ["expr", 開始, 結束]]] */
export function templateParts(src, i) {
  let j = i + 1, buf = "";
  const n = src.length, parts = [];
  while (j < n && src[j] !== "`") {
    if (src[j] === "\\") { buf += src.slice(j, j + 2); j += 2; continue; }
    if (src.startsWith("${", j)) {
      if (buf) { parts.push(["lit", buf]); buf = ""; }
      let depth = 1, k = j + 2;
      while (k < n && depth) {
        const c = src[k];
        if (c === "{") depth += 1;
        else if (c === "}") { depth -= 1; if (!depth) break; }
        else if (c === "'" || c === '"') { k = skipQuoted(src, k); continue; }
        else if (c === "`") { k = templateParts(src, k)[0]; continue; }
        k += 1;
      }
      parts.push(["expr", j + 2, k]);
      j = k + 1;
      continue;
    }
    buf += src[j];
    j += 1;
  }
  if (buf) parts.push(["lit", buf]);
  return [j + 1, parts];
}

/** 一層的字串：[[開始, 結束, 引號, 是否直接包在 _( 裡]]；樣板字串的 ${…} 由呼叫端用 templateParts 往下掃 */
export function tokens(src, start = 0, end = src.length) {
  const out = [];
  let i = start, last = "", word = "";
  while (i < end) {
    const c = src[i];
    if (c === "/" && src.startsWith("//", i)) { const j = src.indexOf("\n", i); i = j < 0 || j > end ? end : j; continue; }
    if (c === "/" && src.startsWith("/*", i)) { const j = src.indexOf("*/", i + 2); i = j < 0 ? end : j + 2; continue; }
    if (c === "/" && (REGEX_PREV.has(last) || last === "" || REGEX_WORDS.has(word))) {
      let j = i + 1, cls = false;
      while (j < end && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j += 1;
      }
      i = j + 1;
      while (i < end && /[a-z]/i.test(src[i])) i += 1;
      last = ")"; word = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let k = i - 1;
      while (k >= start && " \t\n".includes(src[k])) k -= 1;
      const wrapped = k >= 1 && src[k] === "(" && src[k - 1] === "_" && !(k >= 2 && (isAlnum(src[k - 2]) || "_$.".includes(src[k - 2])));
      const j = c === "`" ? templateParts(src, i)[0] : skipQuoted(src, i);
      out.push([i, j, c, wrapped]);
      i = j; last = ")"; word = "";
      continue;
    }
    if (!isSpace(c)) {
      if (isAlnum(c) || c === "_" || c === "$") word = last && (isAlnum(last) || last === "_" || last === "$") ? word + c : c;
      else word = "";
      last = c;
    }
    i += 1;
  }
  return out;
}

/** [[行號, 字面文字, 是否包在 _( 裡, 引號]]；樣板字串的字面文字把 ${…} 寫成 {} */
export function jsStrings(src, baseLine = 1, start = 0, end = src.length) {
  const out = [];
  for (const [i, j, q, wrapped] of tokens(src, start, end)) {
    const line = baseLine + lineAt(src, i) - 1;
    if (q === "`") {
      const parts = templateParts(src, i)[1];
      out.push([line, parts.map((p) => (p[0] === "lit" ? p[1] : "{}")).join(""), wrapped, q]);
      for (const p of parts) if (p[0] === "expr") out.push(...jsStrings(src, baseLine, p[1], p[2]));
    } else out.push([line, src.slice(i + 1, j - 1), wrapped, q]);
  }
  return out;
}

const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
/** JS 字串原文（不含引號）→ 實際的字 */
export function cook(raw) {
  return raw.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (m, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if ((e[0] === "u" || e[0] === "x") && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ESC[e] ?? e;
  });
}

/** 一段 JS（或頁面裡的 script）：[[行號, 內容, 是否包在 _( 裡]]，含中文、該行沒有「不翻」 */
export function cjkStrings(src, baseLine = 1, lines = src.split("\n")) {
  return jsStrings(src, baseLine).filter(([ln, s]) => CJK.test(s) && !KEEP.test(lines[ln - 1] || "")).map(([ln, s, w]) => [ln, s, w]);
}

/** 頁面（HTML）給人看的中文：[[種類, 行號, 內容, 是否包在 _( 裡]] */
export function pageCjkStrings(text) {
  const p = parseHtml(text), lines = text.split("\n");
  const found = p.texts.map(([ln, s]) => ["html", ln, s, false]);
  found.push(...p.attrs.map(([ln, k, v]) => ["attr:" + k, ln, v, false]));
  for (const [ln, src] of p.scripts) for (const [sl, s, w] of cjkStrings(src, ln, lines)) found.push(["js", sl, s, w]);
  return found;
}

/** 一段 JS 用到的翻譯鍵：{ keys: Map(鍵 → 行號), bad: [[行號, 原文]] }（_( 的第一個參數不是單純字串的） */
export function jsKeys(src, baseLine = 1) {
  const keys = new Map(), bad = [];
  const walk = (start, end) => {
    for (const [i, j, q, wrapped] of tokens(src, start, end)) {
      if (q === "`") for (const p of templateParts(src, i)[1]) if (p[0] === "expr") walk(p[1], p[2]);
      if (!wrapped) continue;
      const line = baseLine + lineAt(src, i) - 1;
      if (q === "`" || !/^\s*[,)]/.test(src.slice(j, j + 20))) { bad.push([line, src.slice(i, j + 20)]); continue; }
      const k = cook(src.slice(i + 1, j - 1));
      if (!keys.has(k)) keys.set(k, line);
    }
  };
  walk(0, src.length);
  return { keys, bad };
}

/** 頁面用到的翻譯鍵：靜態文字、屬性、script 裡 _( ) 的字串 */
export function pageKeys(text) {
  const p = parseHtml(text), keys = new Map(), bad = [];
  for (const [ln, s] of p.texts) if (!keys.has(s)) keys.set(s, ln);
  for (const [ln, , v] of p.attrs) if (!keys.has(v)) keys.set(v, ln);
  for (const [ln, src] of p.scripts) {
    const r = jsKeys(src, ln);
    for (const [k, l] of r.keys) if (!keys.has(k)) keys.set(k, l);
    bad.push(...r.bad);
  }
  return { keys, bad };
}

/** 一段 JS 裡所有含中文的字串（含「不翻」的行），給「字典的鍵有沒有用到」的檢查 */
export function jsLiterals(src) {
  const out = new Set();
  const walk = (start, end) => {
    for (const [i, j, q] of tokens(src, start, end)) {
      if (q === "`") { for (const p of templateParts(src, i)[1]) if (p[0] === "expr") walk(p[1], p[2]); continue; }
      if (CJK.test(src.slice(i, j))) out.add(cook(src.slice(i + 1, j - 1)));
    }
  };
  walk(0, src.length);
  return out;
}
