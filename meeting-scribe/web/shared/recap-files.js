// 共用元件（meeting-scribe#166）：會後存檔的檔名與內容格式，會議轉錄 App 與字幕工作室用同一份，改一處兩邊一起變。
// 一般 script，不碰 DOM、全是純函式：瀏覽器載入後掛 window.RecapFiles；Node 用 require（module.exports），載入時不碰 window／document。
//
//   RecapFiles.version                              主版號不同代表格式不相容
//   RecapFiles.headerLines({name, place})           → ["會議：…", "地點：…"]（沒填的不列）
//   RecapFiles.fmtHms(ms)                           → "01:02:03"（沒有時間是 "--:--:--"）
//   RecapFiles.introText(intro, chapters)           → 簡介＋「[ 分段章節 ]」（chapters：[{t_ms, title}]）
//   RecapFiles.summaryMarkdown({header, intro, chapters, full, short, transcript})  → summary.md
//     transcript 由呼叫的人自己組好（App 有優化版＋原始，工作室用剪輯後的時間）
//   RecapFiles.extraFileName(label)                 → 延伸的檔名（"視角回饋（家長）.md"），和 server.py 的 extra_file_base 同規則
//   RecapFiles.extraMarkdown({label, header, markdown})  → 延伸檔的內容
//   RecapFiles.extraFiles(list, {header, taken})    → [{label, file, markdown}]：list 是 [{label, markdown}]，空的略過；
//     和 taken（已經有的或要保留的檔名，不分大小寫）或彼此撞名就加 -2、-3
//   RecapFiles.parseTranscript(text)                → [{start, speaker, text}]：讀回逐字稿檔，交給 AI 重新整理（#174）
//     本 App 的 transcript.txt（或 summary.md 的逐字稿段）讀【原始逐字稿】的「[講者 N]」與「[時:分:秒] 句子」；
//     SRT／VTT 每則字幕一句、留開始時間；其他純文字／Markdown 每行一句、太長的在句尾切開，沒有時間（start 是 null）
(function () {
  "use strict";
  const VERSION = "1.1.0";

  const fmtHms = (ms) => {
    if (ms == null || !Number.isFinite(Number(ms))) return "--:--:--";
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const headBlock = (header) => (header && header.length ? header.join("\n") + "\n\n" : "");
  // 內容裡的標題往下降一級：檔案自己的標題是「#」
  const demote = (md) => String(md ?? "").replace(/^(#{1,5})(\s)/gm, "#$1$2");

  function headerLines({ name, place } = {}) {
    return [name && `會議：${name}`, place && `地點：${place}`].filter(Boolean);   // 不翻：存檔內容與讀回存檔的標記
  }

  function introText(intro, chapters) {
    const ch = Array.isArray(chapters) ? chapters : [];
    return String(intro ?? "") + (ch.length ? "\n\n[ 分段章節 ]\n" + ch.map((c) => `${fmtHms(c.t_ms)} ${c.title}`).join("\n") : "");   // 不翻：存檔內容與讀回存檔的標記
  }

  function summaryMarkdown({ header = [], intro, chapters = [], full, short, transcript } = {}) {
    return `# 會後總結\n\n${headBlock(header)}## 簡介\n\n${introText(intro, chapters)}\n\n## 完整總結\n\n${demote(full)}\n\n`   // 不翻：存檔內容與讀回存檔的標記
      + `## 短總結\n\n${String(short ?? "")}\n\n## 逐字稿\n\n${String(transcript ?? "")}\n`;   // 不翻：存檔內容與讀回存檔的標記
  }

  // 檔名：不能用的字換成 _、拿掉開頭的點、最多 80 字（照字算，不是照 UTF-16），空的叫「延伸」
  function extraFileBase(label) {
    // 頭尾空白用明確的一組字（JS 的 trim 和 Python 的 strip 認得的字不一樣，server.py 用同一組）
    const name = String(label ?? "").replace(/^[ \t\n\r\f\v\u00a0\u3000\ufeff]+|[ \t\n\r\f\v\u00a0\u3000\ufeff]+$/g, "").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "");
    return Array.from(name).slice(0, 80).join("") || "延伸";   // 不翻：存檔內容與讀回存檔的標記
  }
  const extraFileName = (label) => extraFileBase(label) + ".md";

  function extraMarkdown({ label, header = [], markdown } = {}) {
    return `# ${String(label ?? "")}\n\n${headBlock(header)}${demote(markdown)}\n`;
  }

  function extraFiles(list, { header = [], taken = [] } = {}) {
    const used = new Set((taken || []).map((n) => String(n).toLowerCase())), out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || !String(x.markdown ?? "").trim()) continue;
      const base = extraFileBase(x.label);
      let file = base + ".md";
      for (let n = 2; used.has(file.toLowerCase()); n++) file = `${base}-${n}.md`;
      used.add(file.toLowerCase());
      out.push({ label: x.label, file, markdown: extraMarkdown({ label: x.label, header, markdown: x.markdown }) });
    }
    return out;
  }

  // ---- 讀回逐字稿（#174）----
  const toMs = (t) => {
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(t);
    return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] || "").padEnd(3, "0")) : null;
  };
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  const cueText = (s) => s.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ENTITIES[k]);
  // 太長的一行在句尾標點後切開；沒有標點的長句就整句
  const sentences = (s) => (s.length <= 120 ? [s] : s.match(/[^。！？!?]+[。！？!?]*\s*/g) || [s]);

  function parseTranscript(raw) {
    const out = [];
    const push = (start, speaker, t) => {
      const text = String(t).replace(/\s+/g, " ").trim();
      if (text) out.push({ start, speaker, text });
    };
    const all = String(raw ?? "").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
    // 優化逐字稿是 AI 改寫過的：有原始的就只讀原始
    const mark = all.indexOf("【原始逐字稿】");   // 不翻：存檔內容與讀回存檔的標記
    const lines = (mark >= 0 ? all.slice(mark + "【原始逐字稿】".length) : all).split("\n").map((l) => l.trim());   // 不翻：存檔內容與讀回存檔的標記
    const TS = /^\[(\d{2}:\d{2}:\d{2}|--:--:--)\] ?(.*)$/, SPK = /^\[講者 ([^\]]{1,20})\]$/;
    if (lines.some((l) => TS.test(l))) {
      let spk = null;
      for (const l of lines) {
        const k = SPK.exec(l), m = TS.exec(l);
        if (k) spk = k[1];
        else if (m) push(toMs(m[1]), spk, m[2]);
      }
      return out;
    }
    const CUE = /^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->/;
    if (lines.some((l) => CUE.test(l))) {
      // 字幕：時間那行之後到空行是內容；序號、WEBVTT 表頭、NOTE 都在內容外面，不讀
      let start = null, buf = null;
      const flush = () => { if (buf) push(start, null, cueText(buf.join(" "))); buf = null; };
      for (const l of lines) {
        const m = CUE.exec(l);
        if (m) { flush(); start = toMs(m[1]); buf = []; }
        else if (!l) flush();
        else if (buf) buf.push(l);
      }
      flush();
      return out;
    }
    for (const l of lines) {
      const s = l.replace(/^(#{1,6}\s+|[-*+]\s+|>\s?)/, "");
      for (const x of sentences(s)) push(null, null, x);
    }
    return out;
  }

  const api = Object.freeze({ version: VERSION, fmtHms, headerLines, introText, summaryMarkdown, extraFileName, extraMarkdown, extraFiles, parseTranscript });
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RecapFiles = Object.freeze(api);
})();
