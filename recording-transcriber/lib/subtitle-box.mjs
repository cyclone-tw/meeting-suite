// 字幕的「圓角底框」樣式（recording-transcriber#55）：半透明黑色圓角框，中文淡黃、粗體。
// 瀏覽器端（/subtitle-box.mjs，短片模組會 import）、伺服器與測試共用，不能用 node 專屬的模組。
//
// libass 的 BorderStyle=3 只有方角，所以框用 ASS 向量繪圖（\p1）依文字寬度畫出來：
// 每句一個框（Layer 0），每一行字各自用 \an5\pos 放在框裡（Layer 1），所以行距與上下置中都由這裡決定，不靠 libass 排版。
// 字寬由呼叫端給（adv：字元 → 寬度，單位 em；伺服器用 CoreText 量，見 text-measure.mjs），沒量到的字用估算。
//
// 單位：fs 是 libass 字級（PlayRes 像素）。PingFang 的 ascender＋descender 是 1.4 em，libass 的字級等於這個高度，
// 所以字身（em）＝ fs / 1.4。\an5 以 ascender／descender 的中點對位置，PingFang 的中文字剛好落在框的正中間：
// 實際燒出 1080p 量過，字級 56／75／90、各種句子，上下留白差 0–1px（test/subtitle-box.test.mjs 每次都重量）。

export const SUBTITLE_STYLES = ["box", "outline"];
export const DEFAULT_STYLE = "box";
export const styleOf = (p) => (SUBTITLE_STYLES.includes(p?.subtitle_style) ? p.subtitle_style : DEFAULT_STYLE);

export const EM = 1 / 1.4;
export const BOX = {
  alpha: 0.68,          // 框的不透明度
  zh: "F7E98E",         // 中文（淡黃）
  en: "DADADA",         // 雙語的第二行（淺灰白，#56 用）
  radius: 0.16,         // 以下都乘上該行（多行時取最大）的字級 fs
  padX: 0.4,
  padY: 0.18,
  gap: 0.16,            // 行與行之間
  maxWidth: 0.92,       // 框最寬占畫面寬
  bottom: 22 / 288,     // 框的下緣離畫面下緣（一般影片，占畫面高）
};

// 估算字寬（em）：全形與中日韓字 1 em，其他依常見比例
export function guessAdvance(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000)) return 1;
  if (ch === " ") return 0.33;
  if (/[il.,:;'!|]/.test(ch)) return 0.3;
  if (/[mwMW@]/.test(ch)) return 0.85;
  return 0.58;
}

export const widthEm = (text, adv = {}) => [...String(text)].reduce((n, ch) => n + (Number.isFinite(adv[ch]) ? adv[ch] : guessAdvance(ch)), 0);

// 一行太寬就斷開：優先斷在空白，英文字不從中間切開（單一個字本身就太長才硬切）
export function wrapLine(text, maxEm, adv = {}) {
  const chars = [...String(text).trim()];
  if (!chars.length) return [];
  if (widthEm(chars.join(""), adv) <= maxEm) return [chars.join("")];
  const out = [];
  let line = [], w = 0, lastSpace = -1;
  for (const ch of chars) {
    const a = Number.isFinite(adv[ch]) ? adv[ch] : guessAdvance(ch);
    if (line.length && w + a > maxEm) {
      const latin = /[A-Za-z0-9]/;
      // 在英文字中間：退回上一個空白
      if (lastSpace > 0 && latin.test(ch) && latin.test(line[line.length - 1])) {
        const rest = line.slice(lastSpace + 1);
        out.push(line.slice(0, lastSpace).join("").trim());
        line = rest; w = widthEm(rest.join(""), adv);
      } else {
        out.push(line.join("").trim());
        line = []; w = 0;
      }
      lastSpace = -1;
      if (ch === " " && !line.length) continue;
    }
    if (ch === " ") lastSpace = line.length;
    line.push(ch); w += a;
  }
  if (line.length) out.push(line.join("").trim());
  return out.filter(Boolean);
}

// 框的版面：lines = [{ text, fs, colour, bold }]（雙語時兩行可以不同字級與顏色）。
// 回傳框的寬高、圓角，以及每一行文字中心離框上緣的距離 cy
export function boxLayout(lines, adv = {}) {
  const fsMax = Math.max(...lines.map((l) => l.fs));
  const padX = Math.round(fsMax * BOX.padX), padY = Math.round(fsMax * BOX.padY), gap = Math.round(fsMax * BOX.gap);
  let y = padY;
  const placed = lines.map((l, i) => {
    const em = l.fs * EM;
    const cy = y + em / 2;
    y += em + (i < lines.length - 1 ? gap : 0);
    return { ...l, cy, width: widthEm(l.text, l.adv || adv) * em };   // 雙語的原文那行不加粗，用細體量的字寬（#56）
  });
  const w = Math.round(Math.max(...placed.map((l) => l.width)) + padX * 2);
  const h = Math.round(y + padY);
  return { w, h, radius: Math.min(Math.round(fsMax * BOX.radius), Math.floor(h / 2)), padX, padY, lines: placed };
}

// 圓角矩形的 ASS 繪圖指令（左上角是 0,0）；c 是用三次貝茲曲線畫四分之一圓的控制點距離
export function roundedRect(w, h, r) {
  const k = Math.round(r * 0.4477);   // r × (1 − 0.5523)
  const n = (x) => Math.round(x);
  return [
    `m ${n(r)} 0`, `l ${n(w - r)} 0`, `b ${n(w - k)} 0 ${n(w)} ${n(k)} ${n(w)} ${n(r)}`,
    `l ${n(w)} ${n(h - r)}`, `b ${n(w)} ${n(h - k)} ${n(w - k)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `l ${n(r)} ${n(h)}`, `b ${n(k)} ${n(h)} 0 ${n(h - k)} 0 ${n(h - r)}`,
    `l 0 ${n(r)}`, `b 0 ${n(k)} ${n(k)} 0 ${n(r)} 0`,
  ].join(" ");
}

export const assTime = (ms) => {
  const cs = Math.max(0, Math.round(ms / 10)), p = (n) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
};
// 字幕文字裡的大括號與反斜線是 ASS 的控制字元，換成全形
export const assText = (t) => String(t).replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r?\n/g, "\\N");
// RRGGBB → ASS 的 &HAABBGGRR
export const assColour = (hex, alpha = 1) => {
  const a = Math.round((1 - alpha) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
};

// 框與字用到的兩個 ASS 樣式（樣式名 BoxBg、BoxText）
export function boxStyles(fs) {
  const s = (name, colour, align, bold) =>
    `Style: ${name},PingFang TC,${fs},${colour},&H00000000,&H00000000,&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,${align},0,0,0,1`;
  return [s("BoxBg", assColour("000000", BOX.alpha), 7, false), s("BoxText", assColour(BOX.zh), 5, true)];
}

// 一句字幕的 Dialogue：lines 是 [{ text, fs, colour?, bold? }]；anchor 是框的 { x 中心, bottom } 或 { x 中心, top }
export function boxDialogues({ start, end, lines, anchor, adv = {} }) {
  const kept = lines.filter((l) => String(l.text).trim());
  if (!kept.length) return [];
  const b = boxLayout(kept, adv);
  const left = Math.round(anchor.x - b.w / 2);
  const top = Math.round(anchor.top !== undefined ? anchor.top : anchor.bottom - b.h);
  const t0 = assTime(start), t1 = assTime(end);
  return [
    `Dialogue: 0,${t0},${t1},BoxBg,,0,0,0,,{\\pos(${left},${top})\\p1}${roundedRect(b.w, b.h, b.radius)}{\\p0}`,
    ...b.lines.map((l) => {
      const tags = [`\\pos(${Math.round(anchor.x)},${Math.round(top + l.cy)})`];
      if (l.fs !== kept[0].fs) tags.push(`\\fs${l.fs}`);
      if (l.colour && l.colour !== BOX.zh) tags.push(`\\1c${assColour(l.colour).replace(/^&H00/, "&H")}&`);
      if (l.bold === false) tags.push("\\b0");
      return `Dialogue: 1,${t0},${t1},BoxText,,0,0,0,,{${tags.join("")}}${assText(l.text)}`;
    }),
  ];
}

// 一句字幕的文字拆成框裡的行：先照原本的換行，再把太寬的行斷開
export function cueLines(text, { fs, maxWidthPx, adv = {} }) {
  const maxEm = Math.max(1, (maxWidthPx - 2 * Math.round(fs * BOX.padX)) / (fs * EM));
  return String(text).split(/\r?\n/).flatMap((line) => wrapLine(line, maxEm, adv)).map((t) => ({ text: t, fs }));
}

// ---- 雙語字幕（#56）----
// 外語影片的一句：text 是原文、tr 是中文譯文。顯示方式三選一：只放中文、只放原文、雙語（中文在上、原文在下且較小）。
// 沒有譯文的句子一律只顯示原文；一般（中文）影片沒有 tr，所以永遠只有一行 text。
export const LANG_MODES = ["zh", "orig", "both"];
export const DEFAULT_LANG_MODE = "both";
export const SUB_SCALE = 0.72;   // 雙語時原文那行的字級（乘上中文的字級）
export const langModeOf = (p) => (LANG_MODES.includes(p?.lang_mode) ? p.lang_mode : DEFAULT_LANG_MODE);

// 回傳要顯示的幾段：[{ text, role: "main" | "sub" }]
export function displayParts(cue, mode = DEFAULT_LANG_MODE) {
  const text = String(cue?.text ?? "").trim(), tr = String(cue?.tr ?? "").trim();
  if (!tr || mode === "orig") return text ? [{ text, role: "main" }] : [];
  if (mode === "zh" || !text) return [{ text: tr, role: "main" }];
  return [{ text: tr, role: "main" }, { text, role: "sub" }];
}

// 白字黑邊（SRT）用：幾段直接換行
export const displayText = (cue, mode) => displayParts(cue, mode).map((x) => x.text).join("\n");

// 圓角底框用：每段各自斷行，原文那行較小、淺灰、不加粗。advSub 是細體的字寬（沒給就用粗體的，框會寬一點）
export function cueBoxLines(cue, { fs, maxWidthPx, adv = {}, advSub, mode = DEFAULT_LANG_MODE }) {
  return displayParts(cue, mode).flatMap((part) => {
    if (part.role === "main") return cueLines(part.text, { fs, maxWidthPx, adv });
    const small = Math.round(fs * SUB_SCALE), sub = advSub || adv;
    return cueLines(part.text, { fs: small, maxWidthPx, adv: sub }).map((l) => ({ ...l, colour: BOX.en, bold: false, ...(advSub ? { adv: advSub } : {}) }));
  });
}

// 一般影片（橫式或直式原片）的整份 ASS：PlayRes 就是影片解析度，字級 fs 以像素計
export function boxAss({ cues, width, height, fs, adv = {}, advSub, mode = DEFAULT_LANG_MODE }) {
  const anchor = { x: width / 2, bottom: height - Math.round(height * BOX.bottom) };
  const maxWidthPx = width * BOX.maxWidth;
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...boxStyles(fs),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.flatMap((c) => boxDialogues({ start: c.start, end: c.end, lines: cueBoxLines(c, { fs, maxWidthPx, adv, advSub, mode }), anchor, adv })),
    "",
  ].join("\n");
}
