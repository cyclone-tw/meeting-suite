// 字幕的文字處理：每個字的時間、改字後對回時間、
// 依台灣字幕慣例切行、驗證 AI 回傳的修正清單（只准換字，不准純刪中文字）。

const CJK = /[㐀-鿿]/;
const PUNCT_END = "。！？!?";
const PUNCT_SOFT = "，,、；;：:";

export const SUBTITLE_DEFAULTS = { maxLine: 16, gapMs: 600, minCueMs: 400 };

// 把一段文字的時間平均分給它的每個字（code point）。
function spread(text, start, end, speaker, out) {
  const chars = [...text];
  const n = Math.max(chars.length, 1);
  chars.forEach((c, i) => {
    out.push({ c, s: start + Math.floor(((end - start) * i) / n), e: start + Math.floor(((end - start) * (i + 1)) / n), spk: speaker ?? null });
  });
}

// Soniox 的 tokens：{text, start_ms, end_ms, speaker, is_audio_event}
export function charsFromSoniox(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (t.is_audio_event || typeof t.text !== "string") continue;
    spread(t.text, t.start_ms, t.end_ms, t.speaker, out);
  }
  return out;
}

// mlx_whisper --word-timestamps 的 JSON：segments[].words[]{word, start, end}（秒）
export function charsFromWhisper(result) {
  const out = [];
  for (const seg of result?.segments || []) {
    for (const w of seg.words || []) {
      spread(String(w.word ?? ""), Math.round(w.start * 1000), Math.round(w.end * 1000), null, out);
    }
  }
  return out;
}

export const textOf = (chars) => chars.map((x) => x.c).join("");

// Whisper 常在中文後面用半形標點，換成全形（長度不變，時間不受影響）。
export function fullWidthPunct(text) {
  return text.replace(/([㐀-鿿]),/gu, "$1，").replace(/([㐀-鿿])\?/gu, "$1？").replace(/([㐀-鿿])!/gu, "$1！");
}

// Myers diff（以 code point 為單位），回傳 [op, aStart, aEnd, bStart, bEnd] 區段。
// 每一步的 V 都留著好倒推：存成 Int32Array，記憶體約 4·D² bytes（D 是編輯距離）。
// D 超過 maxD 就放棄、回傳 null，交給 diffOps 分段做（recording-transcriber#28、#30）。
function myersOps(a, b, maxD = Infinity) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));   // 這一步之前的 V，k 從 -d-1 到 d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  // 倒推出每一步，再合併成區段
  const steps = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d], at = (k) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { steps.push("="); x--; y--; }
    if (d > 0) steps.push(x === prevX ? "+" : "-");
    x = prevX; y = prevY;
  }
  steps.reverse();
  const ops = [];
  let ai = 0, bi = 0;
  for (const op of steps) {
    const kind = op === "=" ? "equal" : "change";
    const last = ops[ops.length - 1];
    const na = op === "+" ? 0 : 1, nb = op === "-" ? 0 : 1;
    if (last && last[0] === kind) { last[2] += na; last[4] += nb; }
    else ops.push([kind, ai, ai + na, bi, bi + nb]);
    ai += na; bi += nb;
  }
  return ops;
}

export const DIFF_WINDOW = 1000;
export const DIFF_MAX_EDITS = 6000;   // 4·6000² bytes ≈ 144 MB

// 先整份做精確的 Myers；只有編輯距離大到超過 maxD 才分段：每次拿兩邊各 win 個字，
// 提交到視窗前 3/4 裡最後一段相同的地方，從那裡接著做。找不到相同的字就把視窗放大四倍再找，
// 還是沒有才小步（50 字）當成整塊改掉。stats 記下有沒有走到分段、補了幾個字，寫進處理報告。
export function diffOps(a, b, { win = DIFF_WINDOW, maxD = DIFF_MAX_EDITS, stats } = {}) {
  const whole = myersOps(a, b, maxD);
  if (whole) return whole;
  if (stats) stats.windowed = (stats.windowed || 0) + 1;
  const ops = [];
  const push = (kind, a1, a2, b1, b2) => {
    if (a1 === a2 && b1 === b2) return;
    const last = ops[ops.length - 1];
    if (last && last[0] === kind && last[2] === a1 && last[4] === b1) { last[2] = a2; last[4] = b2; } else ops.push([kind, a1, a2, b1, b2]);
  };
  // 提交到視窗前 3/4 裡最後一段相同的字；那段相同的字一路延伸到後面時，只提交到 3/4 為止
  // （相同的字切開沒關係，剩下的下一個視窗會再對上）
  const commit = (w, i, j, size) => {
    const limit = Math.floor(size * 0.75);
    for (let k = w.length - 1; k >= 0; k--) {
      const [kind, a1, a2, b1] = w[k];
      const len = Math.min(a2 - a1, limit - a1, limit - b1);
      if (kind !== "equal" || len <= 0) continue;
      for (let q = 0; q < k; q++) push(w[q][0], i + w[q][1], i + w[q][2], j + w[q][3], j + w[q][4]);
      push("equal", i + a1, i + a1 + len, j + b1, j + b1 + len);
      return [a1 + len, b1 + len];
    }
    return null;
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const ra = a.length - i, rb = b.length - j;
    if (!ra || !rb) { push("change", i, a.length, j, b.length); break; }
    if (ra <= win && rb <= win) {
      for (const [k, a1, a2, b1, b2] of myersOps(a.slice(i), b.slice(j))) push(k, i + a1, i + a2, j + b1, j + b2);
      break;
    }
    let step = commit(myersOps(a.slice(i, i + win), b.slice(j, j + win)), i, j, win);
    if (!step) step = commit(myersOps(a.slice(i, i + 4 * win), b.slice(j, j + 4 * win), maxD) || [], i, j, 4 * win);
    if (!step) {
      const na = Math.min(ra, 50), nb = Math.min(rb, 50);
      push("change", i, i + na, j, j + nb);
      if (stats) stats.fallback_chars = (stats.fallback_chars || 0) + na;
      step = [na, nb];
    }
    i += step[0]; j += step[1];
  }
  return ops;
}

// 改過的文字逐字對回原本的字取得時間。一字換一字的直接沿用原本那個字的時間；
// 長度不同的換掉或新增，才把被換掉那一段的時間平均分給新的字。stats 見 diffOps。
export function realign(chars, newText, stats) {
  const a = chars.map((x) => x.c), b = [...newText];
  const out = [];
  for (const [kind, a1, a2, b1, b2] of diffOps(a, b, { stats })) {
    if (kind === "equal" || a2 - a1 === b2 - b1) {
      for (let k = 0; k < b2 - b1; k++) out.push({ ...chars[a1 + k], c: b[b1 + k] });
      continue;
    }
    const n = b2 - b1;
    if (!n) continue;
    const src = a2 > a1 ? chars.slice(a1, a2) : [chars[Math.max(0, a1 - 1)] ?? { s: 0, e: 0, spk: null }];
    const s = src[0].s, e = src[src.length - 1].e;
    for (let k = 0; k < n; k++) out.push({ c: b[b1 + k], s: s + Math.floor(((e - s) * k) / n), e: s + Math.floor(((e - s) * (k + 1)) / n), spk: src[0].spk ?? null });
  }
  return out;
}

const SEGMENT_END = /[。！？!?，,；;、：:\n]/u;

// 只改附近幾個字的轉換（簡轉繁、全形標點）：一句一句轉、一句一句對時間。每段很短，
// 一定對得準，也不用整份 diff（#30）。段落在標點後切，沒有標點就每 max 個字切一次。
// 轉完長度一樣就一個位置對一個位置（diff 遇到重複的字可能把一字換一字拆成一增一刪）。
export function realignBySegment(chars, transform, max = 200) {
  const out = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (i + 1 < chars.length && !SEGMENT_END.test(chars[i].c) && i + 1 - start < max) continue;
    const seg = chars.slice(start, i + 1);
    const next = transform(textOf(seg)), cs = [...next];
    if (cs.length === seg.length) seg.forEach((x, k) => out.push({ ...x, c: cs[k] }));
    else out.push(...realign(seg, next));
    start = i + 1;
  }
  return out;
}

const isAsciiWordChar = (c) => /^[A-Za-z0-9]$/.test(c);
const isDigit = (c) => c !== undefined && /^[0-9]$/.test(c);
// 10:30、1,000 這種數字中間的半形標點不算斷句的地方
const isNumberPunct = (prev, c, next) => /^[,:.]$/.test(c) && isDigit(prev) && isDigit(next);
const width = (cur) => cur.reduce((w, x) => (x.c.trim() && !PUNCT_SOFT.includes(x.c) && !PUNCT_END.includes(x.c) ? w + (x.c.charCodeAt(0) < 128 ? 0.5 : 1) : w), 0);

function cueText(cur, keepPunct = false) {
  let text = cur.map((x) => x.c).join("").trim();
  if (keepPunct) return text.replace(/\s+/gu, " ").trim();   // 外語字幕照原文的標點（#56）
  text = text.replace(/[—–…]+/gu, " ");
  text = text.replace(/[，、；：]|(?<!\d)[,;:]|[,;:](?!\d)/gu, " ");   // 句中逗號換空格（數字裡的不換）
  text = text.replace(/[。！？!?]+$/u, "");                       // 句尾不加標點
  text = text.replace(/[。]/gu, " ");
  return text.replace(/\s+/gu, " ").trim();
}

// 一行中文字幕照台灣慣例整理（句中逗號換空格、句尾不加標點）：給不經過切句的字幕用，例如 YouTube 作者上傳的中文字幕（#56）
export const tidyZhText = (text) => cueText([...String(text)].map((c) => ({ c })));

// ---- 太長的一段要切成幾行時，挑最自然的地方切（recording-transcriber#33）----
const SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("zh-Hant", { granularity: "word" }) : null;
const CONNECTORS = new Set(["然後", "還有", "就是", "所以", "因為", "但是", "可是", "如果", "而且", "或是", "或者", "不過", "其實", "只是",
  "那", "像是", "比如", "包括", "接著", "另外", "因此", "再來", "最後", "首先", "然而", "雖然", "例如"]);
const PHRASE_END = new Set([..."呢啊吧嘛喔哦啦嗎耶呀欸"]);
const NO_LINE_START = new Set([..."的了呢啊吧嘛喔哦啦嗎耶呀欸們著過得地"]);
const TITLES = new Set(["老師", "主任", "校長", "組長", "同學", "先生", "小姐", "教授", "醫師", "醫生", "處長", "科長", "局長", "園長", "教練", "老闆"]);
const FUNCTION_CHARS = new Set([..."的了呢啊吧嘛喔哦啦嗎在是有和跟與或把被讓給對從到要會能就也都還很再又才講說聽看做用"]);
const isCjk = (c) => /\p{Script=Han}/u.test(c);
const charWidth = (c) => (!c.trim() || PUNCT_SOFT.includes(c) || PUNCT_END.includes(c) ? 0 : c.charCodeAt(0) < 128 ? 0.5 : 1);

// 一段字切成每行不超過 maxLine 的幾行：只切在詞與詞之間（系統的中文分詞），
// 連續的單字詞（多半是人名）、稱謂前、「的了呢」前不切；停頓、逗號後、連接詞前、語助詞後比較好；
// 每行越接近滿行越好（平方罰，所以會兩行平均）。用 DP 找總成本最低的切法。
function splitRun(cur, maxLine) {
  const n = cur.length;
  const text = cur.map((x) => x.c).join("");
  const words = [];   // [start, end, 字串]，以字（code point）為單位
  if (SEGMENTER) {
    let at = 0;
    for (const { segment } of SEGMENTER.segment(text)) { const len = [...segment].length; words.push([at, at + len, segment]); at += len; }
  } else for (let k = 0; k < n; k++) words.push([k, k + 1, cur[k].c]);
  const wordAt = new Map(words.map((w) => [w[0], w]));
  const prevWord = new Map(words.map((w) => [w[1], w]));
  const blocked = (b) => (isAsciiWordChar(cur[b - 1].c) && isAsciiWordChar(cur[b].c))
    || isNumberPunct(cur[b - 2]?.c, cur[b - 1].c, cur[b].c) || isNumberPunct(cur[b - 1].c, cur[b].c, cur[b + 1]?.c);
  const cost = (b) => {
    if (blocked(b)) return Infinity;
    const L = prevWord.get(b), R = wordAt.get(b);
    let c = R && L ? 0 : 20;   // 不在詞的邊界上：盡量不要
    const gap = cur[b].s - cur[b - 1].e;
    if (gap > 0) c -= Math.min(gap / 50, 8);   // 句中停頓 0.3 秒就是很明顯的斷點
    if (PUNCT_SOFT.includes(cur[b - 1].c)) c -= 8;
    if (R && CONNECTORS.has(R[2])) c -= 4;
    if (L && PHRASE_END.has(L[2])) c -= 3;
    if (NO_LINE_START.has(cur[b].c)) c += 6;
    if (L && R) {
      const single = (w) => w[1] - w[0] === 1 && isCjk(w[2]) && !FUNCTION_CHARS.has(w[2]);
      if (TITLES.has(R[2]) && single(L)) c += 8;
      if (single(L) && single(R)) c += 6;
    }
    return c;
  };
  const prefix = [0];
  for (const x of cur) prefix.push(prefix[prefix.length - 1] + charWidth(x.c));
  const pieceCost = (i, j) => {
    const w = prefix[j] - prefix[i];
    return w > maxLine ? Infinity : ((maxLine - w) / maxLine) ** 2 * 8 + 30;   // 每多一行的成本高過所有加分：能少切就少切
  };
  const best = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(-1), bc = [0];
  for (let b = 1; b < n; b++) bc.push(cost(b));
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (prefix[j] - prefix[i] > maxLine) break;
      if (best[i] === Infinity || (i > 0 && bc[i] === Infinity)) continue;
      const v = best[i] + (i > 0 ? bc[i] : 0) + pieceCost(i, j);
      if (v < best[j]) { best[j] = v; from[j] = i; }
    }
  }
  if (best[n] === Infinity) {
    // 切不出來（例如很長的英文或數字）：退回原本的做法，滿一行就切
    const pieces = [];
    let piece = [];
    for (const x of cur) { piece.push(x); if (width(piece) >= maxLine) { pieces.push(piece); piece = []; } }
    if (piece.length) pieces.push(piece);
    return pieces;
  }
  const pieces = [];
  for (let j = n; j > 0; j = from[j]) pieces.unshift(cur.slice(from[j], j));
  return pieces;
}

// 外語影片（#56）：保留標點、英文句點也算句尾；拉丁字母的語言每行寬一點（英數算半格，21 約 42 個字母）
export function cueOptsFor(lang) {
  if (!lang || lang === "zh") return {};
  return ["ja", "ko"].includes(lang) ? { keepPunct: true } : { maxLine: 21, keepPunct: true };
}
const isPunctOnly = (ch) => PUNCT_END.includes(ch) || PUNCT_SOFT.includes(ch) || ch === "." || ch === "…";
const ABBREV = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "jr", "sr", "prof", "inc", "no"]);
// 英文的句點：後面是空白或結尾，而且不是 Mr. Dr. 這種縮寫、也不是 U.S. 這種縮寫的一部分
function latinPeriod(chars, i) {
  if (chars[i].c !== "." || (chars[i + 1] && chars[i + 1].c.trim())) return false;
  let k = i - 1, w = "";
  while (k >= 0 && /[A-Za-z.]/.test(chars[k].c)) { w = chars[k].c + w; k--; }
  return !(ABBREV.has(w.toLowerCase()) || /^[A-Za-z](\.[A-Za-z])+$/.test(w));
}

// 依停頓、換講者、句尾標點切成一段一段（逗號在夠長時才切）；一段太長再用 splitRun 挑自然的地方切成幾行。
// 英數算半格，英文單字或數字中間不切。
export function buildCues(chars, opts = {}) {
  const { maxLine, gapMs, minCueMs, keepPunct } = { ...SUBTITLE_DEFAULTS, ...opts };
  const cues = [];
  let cur = [];
  const flush = () => {
    for (const piece of width(cur) > maxLine ? splitRun(cur, maxLine) : [cur]) {
      const text = cueText(piece, keepPunct);
      const body = piece.filter((x) => x.c.trim());
      if (text && body.length) cues.push({ start: body[0].s, end: Math.max(body[body.length - 1].e, body[0].s + minCueMs), text });
    }
    cur = [];
  };
  chars.forEach((c, i) => {
    const prev = cur[cur.length - 1];
    // 外語（#56）：辨識的標點常在停頓之後才出現、一個字也可能被停頓切開（1,6｜67）。
    // 標點接在前面那句；單字或數字中間不因為停頓切開
    const glued = keepPunct && prev && (isPunctOnly(c.c) || (isAsciiWordChar(prev.c) && (isAsciiWordChar(c.c) || isNumberPunct(prev.c, c.c, chars[i + 1]?.c)))
      || (isNumberPunct(chars[i - 2]?.c, prev.c, c.c)));
    if (prev && !glued && (c.s - prev.e > gapMs || (c.spk ?? null) !== (prev.spk ?? null))) flush();
    if (!cur.length && !c.c.trim()) return;
    // 剛斷完句、下一個字是標點（例如 "?" 晚到）：補在上一句後面，不自成一句
    if (keepPunct && !cur.length && isPunctOnly(c.c)) {
      const last = cues[cues.length - 1];
      if (last) { last.text = `${last.text}${c.c}`; last.end = Math.max(last.end, c.e); }
      return;
    }
    cur.push(c);
    const numPunct = isNumberPunct(chars[i - 1]?.c, c.c, chars[i + 1]?.c);
    const w = width(cur);
    const softBreak = PUNCT_SOFT.includes(c.c) && !numPunct && w >= maxLine / 2;
    const endBreak = (PUNCT_END.includes(c.c) || (keepPunct && latinPeriod(chars, i))) && !numPunct;
    if (endBreak || softBreak) flush();
  });
  if (cur.length) flush();
  // 前後兩條不重疊
  for (let i = 1; i < cues.length; i++) if (cues[i - 1].end > cues[i].start) cues[i - 1].end = cues[i].start;
  return cues;
}

const srtTime = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
};

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

// find→replace 只是把 find 刪掉幾個中文字、沒有換字 → 這是潤飾，不准。
export function isPureDeletion(find, rep) {
  const f = [...find], r = [...rep];
  if (r.length >= f.length) return false;
  let j = 0;
  for (const ch of f) if (j < r.length && ch === r[j]) j++;
  if (j < r.length) return false;
  const removed = [...f];
  for (const ch of r) removed.splice(removed.indexOf(ch), 1);
  return removed.some((ch) => CJK.test(ch));
}

// 套用 AI 的修正清單：find 在這段只能出現一次、不能是純刪字、長度差不超過 4。
export function applyEdits(text, edits) {
  const applied = [], rejected = [];
  let out = text;
  for (const e of Array.isArray(edits) ? edits : []) {
    const find = typeof e?.find === "string" ? e.find : "", rep = typeof e?.replace === "string" ? e.replace : "";
    const count = find ? out.split(find).length - 1 : 0;
    const why = !find || find === rep ? "no-op" : count !== 1 ? `matches ${count} times`
      : isPureDeletion(find, rep) ? "deletes words" : Math.abs([...find].length - [...rep].length) > 4 ? "too large" : "";
    if (why) { rejected.push({ find, replace: rep, why }); continue; }
    out = out.replace(find, () => rep);
    applied.push({ find, replace: rep });
  }
  return { text: out, applied, rejected };
}

// 逐字校對的分段：在句尾標點切，太長（沒有標點的 Whisper 輸出）就在逗號或硬切。
export function chunkText(text, size = 400, hardMax = 1200) {
  const parts = [];
  let buf = "";
  for (const seg of text.split(/(?<=[。！？!?])/u)) {
    buf += seg;
    while ([...buf].length > hardMax) {
      const chars = [...buf];
      let cut = chars.slice(0, hardMax).join("").search(/[，,][^，,]*$/u) + 1;
      if (cut <= 0) cut = hardMax;
      parts.push(chars.slice(0, cut).join(""));
      buf = chars.slice(cut).join("");
    }
    if ([...buf].length >= size) { parts.push(buf); buf = ""; }
  }
  if (buf) parts.push(buf);
  return parts;
}
