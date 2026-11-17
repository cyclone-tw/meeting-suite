"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：Ask AI 分頁（#171）：問這支影片的內容，答案裡的時間點一下就跳過去播。
// 回答是 AI 寫的不可信內容：只用 MdView（DOM 組畫面）排版，時間按鈕只收影片長度內的值（lib/ask-ai.mjs findTimes）。

const ask = { id: "", messages: [], templates: [], busy: false, pending: null, tpl: "", hist: [], histAt: -1, draft: "", clearArmed: 0, poll: 0,
  src: { agent: "claude", web: false, wiki: "off" } };   // 外部來源能不能用（#192，伺服器給）
const ASK_SRC_TITLE = { web: _("讓 AI 上網搜尋外部資料（只有搜尋，不會打開任意網址）"), wiki: _("讓 AI 查你的 wiki 筆記（唯讀）") };
const ASK_SRC_USED = { web: _("有查網路"), wiki: _("有查 wiki") };
const ASK_SRC_ASKED = { web: _("網路搜尋"), wiki: _("查 wiki") };
// 範本：按了在輸入框放一句短指令，送出時帶範本 id，詳細規則在伺服器（lib/ask-ai.mjs）
const ASK_TPL = {
  chapters: { label: _("章節重點"), desc: _("切成段落，整理每段重點與金句，附時間"), text: _("請幫我整理這支影片的章節重點。") },
  quiz: { label: _("出考題（先不給答案）"), desc: _("出一道考題，等你回答後再批改"), text: _("請出一道考題測驗我有沒有看懂。") },
  glossary: { label: _("名詞小百科"), desc: _("專有名詞、人物、工具，第一次接觸也看得懂"), text: _("請整理影片裡的專有名詞和人物。") },
  actions: { label: _("行動清單"), desc: _("把講者的建議整理成看完就能做的事"), text: _("請把講者的建議整理成行動清單。") },
  vocab: { label: _("高階單字 20 個"), desc: _("外語片：B2 以上的單字，附原句和時間"), text: _("請從字幕挑 20 個最值得學的高階單字。") },
};
const ASK_STARTERS = [_("這支影片的重點是什麼？"), _("目前這一段在講什麼？"), _("有哪些關鍵概念或操作步驟？"), _("根據內容整理三個常見問題並回答。")];

// 編輯頁打開時（showEditor 呼叫）：換成這支影片的對話
function askReset() {
  clearTimeout(ask.poll);
  const keep = ask.id === state.id ? $("#askIn").value : "";   // 同一支影片重新進編輯頁：打到一半的問題留著（#175）
  Object.assign(ask, { id: state.id, messages: [], templates: [], busy: false, pending: null, tpl: "", hist: [], histAt: -1, draft: "" });
  $("#askIn").value = keep;
  $("#askNote").textContent = "";
  renderAsk();
  loadAsk();
}
async function loadAsk() {
  const id = state.id;
  let r;
  try { r = await api(`/api/projects/${id}/ask`); } catch (e) { return; }
  if (state.id !== id) return;
  ask.messages = r.messages || [];
  ask.templates = r.templates || [];
  if (r.sources) ask.src = r.sources;
  // 這個頁面送出的還在等：照舊 busy。重新整理前送出、還在回答的（伺服器說 busy）：每 3 秒再看一次，答完就出現
  ask.busy = ask.pending ? true : Boolean(r.busy);
  ask.hist = ask.messages.filter((m) => m.role === "user").map((m) => m.text);
  renderAsk();
  clearTimeout(ask.poll);
  if (ask.busy && !ask.pending) ask.poll = setTimeout(() => (state.id === id ? loadAsk() : undefined), 3000);
}

function renderAsk() {
  const log = $("#askLog");
  log.textContent = "";
  const shown = ask.pending ? [...ask.messages, ask.pending] : ask.messages;
  for (const m of shown) log.append(askBubble(m));
  if (ask.busy) {
    const w = document.createElement("div");
    w.className = "ask-msg assistant ask-wait";
    w.textContent = ask.pending?.sources?.length ? _("AI 正在查資料、看字幕回答…") : _("AI 正在看字幕回答…");
    log.append(w);
  }
  $("#askEmpty").hidden = shown.length > 0;
  $("#askStarters").innerHTML = ASK_STARTERS.map((q, i) => `<button type="button" class="btn sm" data-starter="${i}">${esc(q)}</button>`).join("");
  $("#askSend").hidden = ask.busy;
  $("#askStop").hidden = !ask.busy;
  $("#askSend").disabled = !$("#askIn").value.trim();
  $("#askClear").disabled = ask.busy || !ask.messages.length;
  const tpl = ASK_TPL[ask.tpl];
  $("#askTplChip").hidden = !tpl;
  $("#askTplName").textContent = tpl ? _("範本：{name}", { name: tpl.label }) : "";
  $("#askTplMenu").innerHTML = ask.templates.filter((k) => ASK_TPL[k]).map((k) => `<button type="button" role="menuitem" data-tpl="${k}"><b>${esc(ASK_TPL[k].label)}</b><span>${esc(ASK_TPL[k].desc)}</span></button>`).join("");
  $("#askTplBtn").disabled = !ask.templates.length;
  renderAskSources();
  log.scrollTop = log.scrollHeight;
}

// 網路搜尋／查 wiki 的開關：不能用就停用、取消勾選，滑鼠移上去說原因（伺服器也會擋）
function renderAskSources() {
  const why = ask.src.web ? "" : _("只有校對 agent 是 claude 時能用（這支影片是 {agent}）", { agent: ask.src.agent });
  const web = $("#askWeb"), wiki = $("#askWiki");
  web.disabled = ask.busy || !ask.src.web;
  if (!ask.src.web) web.checked = false;
  $("#askWebWrap").title = why || ASK_SRC_TITLE.web;
  $("#askWikiWrap").hidden = ask.src.wiki === "off";
  const wikiWhy = why || (ask.src.wiki === "missing" ? _("這台電腦找不到 wiki 查詢工具，不能查 wiki") : "");
  wiki.disabled = ask.busy || Boolean(wikiWhy);
  if (wikiWhy) wiki.checked = false;
  $("#askWikiWrap").title = wikiWhy || ASK_SRC_TITLE.wiki;
}
const askSourcesOn = () => [["web", $("#askWeb")], ["wiki", $("#askWiki")]].filter(([, el]) => el.checked && !el.disabled).map(([k]) => k);

function askBubble(m) {
  const box = document.createElement("div");
  box.className = `ask-msg ${m.role === "user" ? "user" : "assistant"}`;
  const head = document.createElement("div");
  head.className = "ask-head";
  if (Number.isFinite(m.t_ms)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ask-time";
    b.dataset.seek = String(m.t_ms);
    b.textContent = ops.fmtTime(m.t_ms);
    b.title = _("提問時的播放位置：點一下跳回去");
    head.append(b);
  }
  if (m.role === "user" && ASK_TPL[m.template]) {
    const t = document.createElement("span");
    t.className = "badge";
    t.textContent = ASK_TPL[m.template].label;
    head.append(t);
  }
  // 這題勾了哪些來源（提問）／實際查了哪些（回答）
  for (const k of Array.isArray(m.sources) ? m.sources : []) {
    const label = (m.role === "user" ? ASK_SRC_ASKED : ASK_SRC_USED)[k];
    if (!label) continue;
    const t = document.createElement("span");
    t.className = "badge ask-src";
    t.textContent = label;
    head.append(t);
  }
  if (m.role !== "user") {
    // 存成學習筆記（#172）：掛在提問當下的時間，先打開編輯框讓你改
    const n = document.createElement("button");
    n.type = "button";
    n.className = "btn sm ghost ask-note";
    n.textContent = _("存成筆記");
    n.title = _("把這則回答存成學習筆記，掛在提問時的時間");
    n.addEventListener("click", () => addNoteAt(Number.isFinite(m.t_ms) ? m.t_ms : video.currentTime * 1000, clipNote(m.text)));
    head.append(n);
    const c = document.createElement("button");
    c.type = "button";
    c.className = "btn sm ghost ask-copy";
    c.textContent = _("複製");
    c.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(m.text); toast(_("已複製回答。"), [], 2500); } catch (e) { showAlert(_("沒辦法複製，請自己選取文字。")); }
    });
    head.append(c);
  }
  if (head.childNodes.length) box.append(head);
  const body = document.createElement("div");
  if (m.role === "user") { body.className = "ask-text"; body.textContent = m.text; } else if (window.MdView) window.MdView.render(body, m.text, { top: 4 });
  else { body.className = "ask-text"; body.textContent = m.text; }   // 會議轉錄 App 的共用元件不在：照原文
  if (m.role !== "user") linkTimes(body);
  box.append(body);
  return box;
}

// 筆記一則最多 NOTE_MAX 字：太長的回答先截掉，讓使用者在編輯框裡自己挑
const clipNote = (text) => ([...text].length > notesOps.NOTE_MAX ? `${[...text].slice(0, notesOps.NOTE_MAX - 1).join("")}…` : text);

// 回答裡的 [HH:MM:SS]／[MM:SS] 換成可以點的按鈕；程式碼與連結裡的不動
function linkTimes(node) {
  for (const c of [...node.childNodes]) {
    if (c.nodeType === 3) {
      const found = askOps.findTimes(c.nodeValue, eDur());
      if (!found.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const f of found) {
        frag.append(c.nodeValue.slice(at, f.index));
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ask-time";
        b.dataset.seek = String(f.ms);
        b.textContent = f.label;
        b.title = _("跳到 {time} 播放", { time: f.label });
        frag.append(b);
        at = f.index + f.length;
      }
      frag.append(c.nodeValue.slice(at));
      c.replaceWith(frag);
    } else if (c.nodeType === 1 && !/^(CODE|PRE|A|BUTTON)$/.test(c.tagName)) linkTimes(c);
  }
}

async function askSend(text) {
  const q = String(text ?? $("#askIn").value).trim();
  if (!q || ask.busy) return;
  const id = state.id;
  const tMs = $("#askWithTime").checked ? Math.round(video.currentTime * 1000) : null;
  const tpl = ask.tpl;
  const sources = askSourcesOn();
  ask.busy = true;
  ask.pending = { role: "user", text: q, ...(tMs !== null ? { t_ms: tMs } : {}), ...(tpl ? { template: tpl } : {}), ...(sources.length ? { sources } : {}) };
  ask.hist.push(q);
  ask.histAt = -1;
  ask.tpl = "";
  $("#askIn").value = "";
  $("#askNote").textContent = "";
  renderAsk();
  try {
    const r = await post(`/api/projects/${id}/ask`, { question: q, ...(tMs !== null ? { t_ms: tMs } : {}), ...(tpl ? { template: tpl } : {}), ...(sources.length ? { sources } : {}) });
    if (state.id !== id) return;
    ask.messages = r.messages || [];
  } catch (e) {
    if (state.id !== id) return;
    $("#askNote").textContent = e.message;
    // 沒問成功：問題放回輸入框，改一改可以再送
    if (!$("#askIn").value.trim()) { $("#askIn").value = q; ask.tpl = tpl; }
  } finally {
    if (state.id === id) { ask.busy = false; ask.pending = null; renderAsk(); }
  }
}

$("#askIn").addEventListener("input", () => { $("#askSend").disabled = ask.busy || !$("#askIn").value.trim(); });
$("#askIn").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;   // 中文選字時的 Enter 不送出
  const el = $("#askIn");
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); askSend(); return; }
  if (e.key === "Escape") { e.preventDefault(); if (ask.busy) askStop(); else el.blur(); return; }
  // ↑↓ 叫回之前的提問（游標在第一行／最後一行時才換，免得擋到多行編輯）
  if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n") && ask.hist.length) {
    e.preventDefault();
    if (ask.histAt === -1) { ask.draft = el.value; ask.histAt = ask.hist.length; }
    ask.histAt = Math.max(0, ask.histAt - 1);
    el.value = ask.hist[ask.histAt];
  } else if (e.key === "ArrowDown" && ask.histAt !== -1 && !el.value.slice(el.selectionEnd).includes("\n")) {
    e.preventDefault();
    ask.histAt += 1;
    if (ask.histAt >= ask.hist.length) { el.value = ask.draft; ask.histAt = -1; } else el.value = ask.hist[ask.histAt];
  }
  $("#askSend").disabled = ask.busy || !el.value.trim();
});
$("#askSend").addEventListener("click", () => askSend());
async function askStop() {
  try { await post(`/api/projects/${state.id}/ask-stop`); } catch (e) { showAlert(e.message); }
  if (!ask.pending) loadAsk();   // 重新整理前送出的那題：停掉後重讀，按鈕才會回來
}
$("#askStop").addEventListener("click", () => askStop());
$("#askStarters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-starter]");
  if (b) askSend(ASK_STARTERS[Number(b.dataset.starter)]);
});
$("#askLog").addEventListener("click", (e) => {
  const b = e.target.closest("[data-seek]");
  if (!b) return;
  seekMs(Number(b.dataset.seek));
  if (video.paused) togglePlay();
});
// 範本選單
$("#askTplBtn").addEventListener("click", () => {
  const open = $("#askTplMenu").hidden;
  $("#askTplMenu").hidden = !open;
  $("#askTplBtn").setAttribute("aria-expanded", String(open));
});
$("#askTplMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tpl]");
  if (!b) return;
  ask.tpl = b.dataset.tpl;
  if (!$("#askIn").value.trim()) $("#askIn").value = ASK_TPL[ask.tpl].text;
  $("#askTplMenu").hidden = true;
  $("#askTplBtn").setAttribute("aria-expanded", "false");
  renderAsk();
  $("#askIn").focus();
});
$("#askTplClear").addEventListener("click", () => { ask.tpl = ""; renderAsk(); });
// 清除對話：按兩次才清（4 秒內），不跳確認視窗
$("#askClear").addEventListener("click", async () => {
  if (Date.now() - ask.clearArmed > 4000) {
    ask.clearArmed = Date.now();
    $("#askClear").textContent = _("再按一次清除");
    setTimeout(() => { $("#askClear").textContent = _("清除對話"); }, 4000);
    return;
  }
  ask.clearArmed = 0;
  $("#askClear").textContent = _("清除對話");
  try { const r = await api(`/api/projects/${state.id}/ask`, { method: "DELETE" }); ask.messages = r.messages || []; ask.hist = []; renderAsk(); } catch (e) { showAlert(e.message); }
});
// 「附上目前時間」旁顯示現在的播放位置
video.addEventListener("timeupdate", () => {
  const label = _("附上目前時間（{time}）", { time: ops.fmtTime(video.currentTime * 1000) });
  if ($("#askTimeLabel").textContent !== label) $("#askTimeLabel").textContent = label;
});
