"""介面中英切換（#195）的掃描工具：找出頁面裡給人看的中文。

- HTML：<script>、<style>、註解以外的文字，以及 title／placeholder／aria-label／alt 屬性（元素標了 translate="no" 的屬性不算）。
  文字的鍵是去掉頭尾空白、中間空白縮成一格（web/shared/i18n.js 用同一個規則）。
- JS：字串（'…'、"…"、`…`）；註解與正規表示式不算。樣板字串只看 ${…} 以外的字，${…} 裡面另外掃。
  同一行的註解有「不翻」兩個字的，那一行的字串是資料或產出內容，不算介面文字。
"""
import re
from html.parser import HTMLParser

CJK = re.compile(r"[　-〿㐀-鿿豈-﫿＀-￯]")
ATTRS = ("title", "placeholder", "aria-label", "alt")
KEEP = re.compile(r"(//|/\*).*不翻")
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")
REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw"}
SKIP_TAGS = ("script", "style", "textarea")


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


class _Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.texts, self.attrs, self.scripts = [], [], [], []
        self._script = None

    def _attrs(self, attrs):
        if dict(attrs).get("translate") == "no":
            return   # 標了 translate="no"（例如資料夾名稱的 placeholder），web/shared/i18n.js 也不換
        for k, v in attrs:
            if k in ATTRS and v and CJK.search(v):
                self.attrs.append((self.getpos()[0], k, norm(v)))

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.stack.append(tag)
            if tag == "script" and not dict(attrs).get("src"):
                line, col = self.getpos()
                self._script = [line, []]
        self._attrs(attrs)

    def handle_startendtag(self, tag, attrs):
        self._attrs(attrs)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
            if tag == "script" and self._script:
                self.scripts.append((self._script[0], "".join(self._script[1])))
                self._script = None

    def handle_data(self, data):
        if self.stack:
            if self.stack[-1] == "script" and self._script:
                self._script[1].append(data)
            return
        if CJK.search(data):
            self.texts.append((self.getpos()[0], norm(data)))


def parse_html(text):
    p = _Page()
    p.feed(text)
    p.close()
    return p


def _skip_quoted(src, k):
    q, k = src[k], k + 1
    while k < len(src) and src[k] != q:
        k += 2 if src[k] == "\\" else 1
    return k + 1


def template_parts(src, i):
    """src[i] 是 `：回傳 (結束位置, [("lit", 原文) | ("expr", 開始, 結束)])。"""
    j, n, parts, buf = i + 1, len(src), [], []
    while j < n and src[j] != "`":
        if src[j] == "\\":
            buf.append(src[j:j + 2])
            j += 2
            continue
        if src.startswith("${", j):
            if buf:
                parts.append(("lit", "".join(buf)))
                buf = []
            depth, k = 1, j + 2
            while k < n and depth:
                c = src[k]
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if not depth:
                        break
                elif c in "'\"":
                    k = _skip_quoted(src, k)
                    continue
                elif c == "`":
                    k = template_parts(src, k)[0]
                    continue
                k += 1
            parts.append(("expr", j + 2, k))
            j = k + 1
            continue
        buf.append(src[j])
        j += 1
    if buf:
        parts.append(("lit", "".join(buf)))
    return j + 1, parts


def tokens(src, start=0, end=None):
    """一層的字串：[(開始, 結束, 引號, 是否直接包在 _( 裡)]；樣板字串的 ${…} 由呼叫端用 template_parts 往下掃。"""
    end = len(src) if end is None else end
    out, i, last, word = [], start, "", ""
    while i < end:
        c = src[i]
        if c == "/" and src.startswith("//", i):
            j = src.find("\n", i)
            i = end if j < 0 or j > end else j
            continue
        if c == "/" and src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = end if j < 0 else j + 2
            continue
        if c == "/" and (last in REGEX_PREV or last == "" or word in REGEX_WORDS):
            j, cls = i + 1, False
            while j < end and src[j] != "\n":
                d = src[j]
                if d == "\\":
                    j += 2
                    continue
                if d == "[":
                    cls = True
                elif d == "]":
                    cls = False
                elif d == "/" and not cls:
                    break
                j += 1
            i = j + 1
            while i < end and src[i].isalpha():
                i += 1
            last, word = ")", ""
            continue
        if c in "'\"`":
            k = i - 1
            while k >= start and src[k] in " \t\n":
                k -= 1
            wrapped = k >= 1 and src[k] == "(" and src[k - 1] == "_" and not (k >= 2 and (src[k - 2].isalnum() or src[k - 2] in "_$."))
            j = template_parts(src, i)[0] if c == "`" else _skip_quoted(src, i)
            out.append((i, j, c, wrapped))
            i = j
            last, word = ")", ""
            continue
        if not c.isspace():
            if c.isalnum() or c in "_$":
                word = word + c if last and (last.isalnum() or last in "_$") else c
            else:
                word = ""
            last = c
        i += 1
    return out


def js_strings(src, base_line=1, start=0, end=None, keep_lines=None):
    """[(行號, 字面文字, 是否包在 _( 裡, 引號)]；樣板字串的字面文字不含 ${…}，${…} 裡的字串另外列出。"""
    out = []
    for i, j, q, wrapped in tokens(src, start, end):
        line = base_line + src.count("\n", 0, i)
        if q == "`":
            _, parts = template_parts(src, i)
            out.append((line, "".join(p[1] if p[0] == "lit" else "{}" for p in parts), wrapped, q))
            for p in parts:
                if p[0] == "expr":
                    out.extend(js_strings(src, base_line, p[1], p[2]))
        else:
            out.append((line, src[i + 1:j - 1], wrapped, q))
    return out


def page_cjk_strings(text):
    """index.html 裡給人看的中文：(種類, 行號, 內容, 是否包在 _( 裡)；有「不翻」註解的行不算。"""
    p = parse_html(text)
    lines = text.split("\n")
    found = [("html", ln, s, False) for ln, s in p.texts]
    found += [("attr:" + k, ln, v, False) for ln, k, v in p.attrs]
    for ln, src in p.scripts:
        for sl, s, wrapped, q in js_strings(src, ln):
            if CJK.search(s) and not KEEP.search(lines[sl - 1]):
                found.append(("js" + ("`" if q == "`" else ""), sl, s, wrapped))
    return found


ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def cook(raw):
    """JS 字串原文（不含引號）→ 實際的字。"""
    out, k = [], 0
    while k < len(raw):
        c = raw[k]
        if c != "\\":
            out.append(c)
            k += 1
            continue
        d = raw[k + 1]
        if d == "u" and raw[k + 2] == "{":
            e = raw.index("}", k)
            out.append(chr(int(raw[k + 3:e], 16)))
            k = e + 1
        elif d == "u":
            out.append(chr(int(raw[k + 2:k + 6], 16)))
            k += 6
        elif d == "x":
            out.append(chr(int(raw[k + 2:k + 4], 16)))
            k += 4
        else:
            out.append(ESC.get(d, d))
            k += 2
    return "".join(out)


def page_keys(text):
    """頁面用到的翻譯鍵：{鍵: 第一次出現的行號}，以及 _( 裡不是單純字串的地方 [(行號, 原文)]。"""
    p = parse_html(text)
    keys, bad = {}, []
    for ln, s in p.texts:
        keys.setdefault(s, ln)
    for ln, _k, v in p.attrs:
        keys.setdefault(v, ln)
    for base, src in p.scripts:
        for i, j, q, wrapped in _all_tokens(src):
            if not wrapped:
                continue
            line = base + src.count("\n", 0, i)
            if q == "`" or not re.match(r"\s*[,)]", src[j:j + 20]):
                bad.append((line, src[i:j + 20]))
                continue
            keys.setdefault(cook(src[i + 1:j - 1]), line)
    return keys, bad


def page_literals(text):
    """頁面 script 裡所有含中文的字串（含「不翻」的行），給「字典的鍵有沒有用到」的檢查。"""
    p = parse_html(text)
    out = set()
    for _base, src in p.scripts:
        for i, j, q, _w in _all_tokens(src):
            if q != "`" and CJK.search(src[i:j]):
                out.add(cook(src[i + 1:j - 1]))
    return out


def _all_tokens(src, start=0, end=None):
    for t in tokens(src, start, end):
        yield t
        if t[2] == "`":
            for p in template_parts(src, t[0])[1]:
                if p[0] == "expr":
                    yield from _all_tokens(src, p[1], p[2])
