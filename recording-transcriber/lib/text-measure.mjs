// 量字寬（recording-transcriber#55）：圓角底框要照文字實際寬度畫，所以先用 macOS 的 CoreText 量 PingFang 每個字的寬度。
// 走 osascript 的 JavaScript（AppKit 的 NSFont），每台 Mac 都有，不用另外裝東西；一次量完一份字幕用到的所有字（約 0.1 秒）。
// 量不到（不是 Mac、osascript 失敗）就回傳空表，subtitle-box.mjs 會用估算的寬度，框可能寬一點或窄一點，但字一定在框裡置中。

import { spawnSync } from "node:child_process";

// libass 的粗體 PingFang TC 寬度最接近 Semibold（中文字都是 1 em，英數差約 2%）
const FONT = { bold: "PingFangTC-Semibold", regular: "PingFangTC-Regular" };

const JXA = `
ObjC.import('AppKit');
function run(argv) {
  const req = JSON.parse(argv[0]);
  const f = $.NSFont.fontWithNameSize(req.font, 1000);
  if (!f || (f.isNil && f.isNil())) return '{}';
  const attrs = $.NSDictionary.dictionaryWithObjectForKey(f, $.NSFontAttributeName);
  const out = {};
  for (const ch of req.chars) out[ch] = $(ch).sizeWithAttributes(attrs).width / 1000;
  return JSON.stringify(out);
}`;

// 回傳 { 字: 寬度 em }；run 可以換掉（測試用）
export function measureAdvances(texts, { bold = true, run = spawnSync } = {}) {
  const chars = [...new Set([...texts.join("")].filter((c) => c !== "\n" && c !== "\r"))];
  if (!chars.length || process.platform !== "darwin" && run === spawnSync) return {};
  try {
    const r = run("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA, JSON.stringify({ font: bold ? FONT.bold : FONT.regular, chars })], { encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0) return {};
    const out = JSON.parse(String(r.stdout || "{}").trim() || "{}");
    const clean = {};
    for (const [k, v] of Object.entries(out)) if (Number.isFinite(v) && v >= 0 && v < 4) clean[k] = v;
    return clean;
  } catch {
    return {};
  }
}
