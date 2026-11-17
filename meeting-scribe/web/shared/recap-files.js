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
//   RecapFiles.askMarkdown({header, items})        → ask.md：問 AI 的對話（items：[{q, a}]，#214）；沒有問答回 ""
//   RecapFiles.askBody(items)                       → 同上但沒有檔案標題與表頭，每題「## 編號. 問題」（給完整紀錄當一節）
//   RecapFiles.subtitleCues(segs)                   → [{start, end, speaker, text}]（#215）：segs 是 [{start, speaker, text}]，
//     沒有時間的句子略過；結束時間＝下一句開始，最長照字數估（每字 220 ms，1～7 秒）
//   RecapFiles.srt(segs)／RecapFiles.vtt(segs)      → 字幕檔；VTT 有講者時用 <v 講者 N> 標
//   RecapFiles.documentMarkdown({title, header, sections})  → 完整紀錄（#215）：sections 是 [{title, markdown}]，空的略過，
//     內容的標題往下降一級
//   RecapFiles.parseTranscript(text)                → [{start, speaker, text}]：讀回逐字稿檔，交給 AI 重新整理（#174）
//     本 App 的 transcript.txt（或 summary.md 的逐字稿段）讀【原始逐字稿】的「[講者 N]」與「[時:分:秒] 句子」；
//     SRT／VTT 每則字幕一句、留開始時間；其他純文字／Markdown 每行一句、太長的在句尾切開，沒有時間（start 是 null）
(function () {
  "use strict";
  const VERSION = "1.3.0";

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

  // 問 AI（#214）：每題一個「## 編號. 問題」（問題壓成一行、最多 120 字），回答的標題往下降一級
  function askBody(items) {
    const list = (Array.isArray(items) ? items : []).filter((x) => x && String(x.q ?? "").trim() && String(x.a ?? "").trim());
    const title = (q) => { const t = Array.from(String(q).replace(/\s+/g, " ").trim()); return t.length > 120 ? t.slice(0, 120).join("") + "…" : t.join(""); };
    return list.map((x, i) => `## ${i + 1}. ${title(x.q)}\n\n${demote(String(x.a).trim())}\n`).join("\n");
  }
  function askMarkdown({ header = [], items = [] } = {}) {
    const body = askBody(items);
    return body ? `# 問 AI\n\n${headBlock(header)}` + body : "";   // 不翻：存檔內容
  }

  // ---- 字幕（#215）：逐字稿每句只有開始時間，結束時間用下一句的開始，最長照字數估 ----
  const CUE_MS_PER_CHAR = 220, CUE_MIN = 1000, CUE_MAX = 7000;
  function subtitleCues(segs) {
    const list = (Array.isArray(segs) ? segs : [])
      .filter((x) => x && Number.isFinite(Number(x.start)) && x.start !== null && String(x.text ?? "").trim())
      .map((x) => ({ start: Math.max(0, Math.round(Number(x.start))), speaker: x.speaker == null || x.speaker === "" ? null : String(x.speaker), text: String(x.text).replace(/\s*\n\s*/g, " ").trim() }))
      .sort((a, b) => a.start - b.start);
    return list.map((c, i) => {
      const guess = c.start + Math.min(CUE_MAX, Math.max(CUE_MIN, Array.from(c.text).length * CUE_MS_PER_CHAR));
      const next = list[i + 1]?.start;
      const end = next > c.start ? Math.min(next, guess) : guess;   // 下一句同一個時間開始（或沒有下一句）：照字數估
      return { ...c, end };
    });
  }
  const cueTime = (ms, sep) => {
    const t = Math.max(0, Math.round(ms));
    return `${fmtHms(t)}${sep}${String(t % 1000).padStart(3, "0")}`;
  };
  function srt(segs) {
    return subtitleCues(segs).map((c, i) => `${i + 1}\n${cueTime(c.start, ",")} --> ${cueTime(c.end, ",")}\n${c.text}\n`).join("\n");
  }
  const vttEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function vtt(segs) {
    const cues = subtitleCues(segs).map((c) => `${cueTime(c.start, ".")} --> ${cueTime(c.end, ".")}\n${c.speaker ? `<v 講者 ${vttEsc(c.speaker)}>` : ""}${vttEsc(c.text)}\n`);   // 不翻：字幕檔內容
    return `WEBVTT\n\n${cues.join("\n")}`;
  }

  // ---- 完整紀錄（#215）：Markdown、Word、PDF 共用同一份內容 ----
  function documentMarkdown({ title, header = [], sections = [] } = {}) {
    const parts = (Array.isArray(sections) ? sections : []).filter((x) => x && String(x.markdown ?? "").trim())
      .map((x) => `## ${String(x.title ?? "")}\n\n${demote(String(x.markdown).trim())}\n`);
    return `# ${String(title ?? "") || "會議紀錄"}\n\n${headBlock(header)}${parts.join("\n")}`;   // 不翻：存檔內容
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

  const api = Object.freeze({ version: VERSION, fmtHms, headerLines, introText, summaryMarkdown, extraFileName, extraMarkdown, extraFiles, askMarkdown, askBody, subtitleCues, srt, vtt, documentMarkdown, parseTranscript });
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RecapFiles = Object.freeze(api);
})();
