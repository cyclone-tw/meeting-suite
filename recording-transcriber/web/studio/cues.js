"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：字幕清單、目前這一句、拆合刪、播放、鍵盤、自動存檔、說明欄、分頁、錯字表。

// ---- 字幕清單 ----
// 外語影片（#56）看的是中文譯文太不太長；原文在圓角底框裡會自動換行
const longOf = (c) => (state.foreign ? ops.tooLong(c.tr || "") : ops.tooLong(c.text));
const visible = (c) => state.filter === "all" || (state.filter === "ai" && c.ai?.length) || (state.filter === "long" && longOf(c));
function rowTags(c) {
  const t = [];
  if (c.ai?.length) t.push(`<span class="badge ai" title="${_("AI 修正")}">${_("AI：{list}", { list: c.ai.map((e) => `${esc(e.find)}→${esc(e.replace)}`).join(_("、")) })}</span>`);
  if (longOf(c)) t.push(`<span class="badge warn">${state.foreign ? _("譯文太長") : _("一行太長")}</span>`);
  if (!c.text.trim()) t.push(`<span class="badge warn">${_("空白（不會輸出）")}</span>`);
  const share = cutOps.cutShare(state.cuts, c.start, c.end);
  if (share >= 0.99) t.push(`<span class="badge warn">${_("剪掉了")}</span>`);
  else if (share > 0.2) t.push(`<span class="badge warn">${_("部分剪掉")}</span>`);
  return t.join("");
}
function renderList() {
  const find = $("#findIn").value;
  const rows = [];
  state.cues.forEach((c, i) => {
    if (!visible(c) || (find && !c.text.includes(find) && !String(c.tr || "").includes(find))) return;
    const tr = state.foreign ? `<input class="tr" value="${esc(c.tr || "")}" data-tr="${i}" spellcheck="false" placeholder="${_("（還沒有譯文）")}" aria-label="${_("第 {n} 句的中文譯文", { n: i + 1 })}">` : "";
    rows.push(`<li class="row${!state.foreign && ops.tooLong(c.text) ? " long" : ""}${cutOps.cutShare(state.cuts, c.start, c.end) >= 0.99 ? " cut" : ""}" data-i="${i}"><time data-seek="${i}">${ops.fmtTime(c.start)}</time><input value="${esc(c.text)}" data-i="${i}" spellcheck="false" aria-label="${_("第 {n} 句", { n: i + 1 })}">${tr}<div class="tags">${rowTags(c)}</div></li>`);
  });
  $("#cueList").innerHTML = rows.join("") || `<li class="muted" style="padding:16px">${_("沒有符合的字幕")}</li>`;
  const counts = { ai: state.cues.filter((c) => c.ai?.length).length, long: state.cues.filter(longOf).length };
  for (const b of document.querySelectorAll("#filterSeg button")) {
    b.setAttribute("aria-pressed", String(b.dataset.f === state.filter));
    if (b.dataset.f !== "all") b.textContent = b.dataset.f === "ai" ? _("AI 改過 {count}", { count: counts[b.dataset.f] }) : _("太長 {count}", { count: counts[b.dataset.f] });
  }
  footNote(state.p?.report);
  $("#repBtn").disabled = !find;
  $("#repBtn").textContent = find ? _("全部取代（{n}）", { n: ops.countIn(state.cues, find) }) : _("全部取代");
  markRows();
}
const rowOf = (i) => $(`#cueList li[data-i="${i}"]`);
function markRows() {
  for (const li of document.querySelectorAll("#cueList li.sel, #cueList li.play")) li.classList.remove("sel", "play");
  rowOf(state.sel)?.classList.add("sel");
  rowOf(state.play)?.classList.add("play");
}
function updateRow(i) {
  const li = rowOf(i);
  if (!li) return;
  const c = state.cues[i];
  li.classList.toggle("long", !state.foreign && ops.tooLong(c.text));
  li.querySelector(".tags").innerHTML = rowTags(c);
  const inp = li.querySelector("input[data-i]");
  if (document.activeElement !== inp) inp.value = c.text;
  const tr = li.querySelector("input[data-tr]");
  if (tr && document.activeElement !== tr) tr.value = c.tr || "";
}
let lastScroll = 0;
$("#cueList").addEventListener("scroll", () => { lastScroll = Date.now(); }, { passive: true });
function scrollToRow(i, force = false) {
  const li = rowOf(i);
  if (!li) return;
  if (!force && (!$("#follow").checked || Date.now() - lastScroll < 2500)) return;
  const box = $("#cueList"), top = li.offsetTop - box.offsetTop;
  if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 80) {
    box.scrollTo({ top: top - box.clientHeight / 3, behavior: "smooth" });
    setTimeout(() => { lastScroll = 0; }, 600);
  }
}

$("#filterSeg").onclick = (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; state.filter = b.dataset.f; renderList(); };
$("#findIn").oninput = () => renderList();
$("#repBtn").onclick = () => {
  const find = $("#findIn").value, rep = $("#repIn").value;
  if (!find) return;
  pushUndo();
  const r = ops.replaceAll(state.cues, find, rep);
  state.cues = r.cues;
  changed();
  renderList();
  showCue();
  toast(_("已取代 {n} 處。", { n: r.count }), [{ label: _("復原"), run: undo }]);
};

$("#cueList").addEventListener("click", (e) => {
  const t = e.target.closest("[data-seek]");
  if (t) { select(Number(t.dataset.seek), true); return; }
});
$("#cueList").addEventListener("focusin", (e) => {
  const tr = e.target.closest("input[data-tr]");
  if (tr) {
    const i = Number(tr.dataset.tr);
    beginTr(i);
    if (state.sel !== i) select(i, true, false);
    return;
  }
  const inp = e.target.closest("input[data-i]");
  if (!inp) return;
  const i = Number(inp.dataset.i);
  beginEdit(i);
  if (state.sel !== i) select(i, true, false);
});
$("#cueList").addEventListener("input", (e) => {
  const tr = e.target.closest("input[data-tr]");
  if (tr) { typedTr(Number(tr.dataset.tr), tr.value); return; }
  const inp = e.target.closest("input[data-i]");
  if (!inp) return;
  typed(Number(inp.dataset.i), inp.value);
});
$("#cueList").addEventListener("focusout", (e) => {
  const tr = e.target.closest("input[data-tr]");
  if (tr) { commitTr(Number(tr.dataset.tr)); return; }
  const inp = e.target.closest("input[data-i]");
  if (inp) commitEdit(Number(inp.dataset.i));
});
$("#cueList").addEventListener("keydown", (e) => {
  const tr = e.target.closest("input[data-tr]");
  if (tr && !e.isComposing && e.keyCode !== 229) {
    const i = Number(tr.dataset.tr);
    if (e.key === "Enter") {
      e.preventDefault();
      commitTr(i);
      const n = e.shiftKey ? i - 1 : i + 1;
      if (n >= 0 && n < state.cues.length) { select(n, true); rowOf(n)?.querySelector("input[data-tr]")?.focus(); }
    } else if (e.key === "Escape") tr.blur();
    return;
  }
  const inp = e.target.closest("input[data-i]");
  if (!inp || e.isComposing || e.keyCode === 229) return;   // 注音選字中的 Enter 不算
  const i = Number(inp.dataset.i);
  if (e.key === "Enter") {
    e.preventDefault();
    commitEdit(i);
    const n = e.shiftKey ? i - 1 : i + 1;
    if (n >= 0 && n < state.cues.length) { select(n, true); rowOf(n)?.querySelector("input")?.focus(); }
  } else if (e.key === "Escape") { inp.blur(); }
});

// ---- 目前這一句 ----
function select(i, seek = true, focusRow = false) {
  if (!state.cues.length) { state.sel = -1; showCue(); return; }
  state.sel = Math.max(0, Math.min(i, state.cues.length - 1));
  if (seek) seekMs(state.cues[state.sel].start + 1);
  $("#cueText").value = state.cues[state.sel].text;   // 換句了：輸入框就算正在輸入也換成新的這句
  $("#cueTr").value = state.cues[state.sel].tr || "";
  showCue();
  markRows();
  scrollToRow(state.sel, true);
  if (focusRow) rowOf(state.sel)?.querySelector("input")?.focus();
}

function showCue() {
  const c = state.cues[state.sel];
  // 停在兩句之間：提示可以在這裡加一句；編輯區仍顯示選取的那句
  $("#gapNote").hidden = !(state.play === -1 && video.paused && video.readyState > 0 && state.cues.length > 0);
  $("#cueBox").hidden = !c;
  if (!c) return;
  $("#cueNo").textContent = _("第 {n} 句 / {total}", { n: state.sel + 1, total: state.cues.length });
  $("#cueTime").textContent = _("{from} → {to}（{sec} 秒）", { from: ops.fmtTime(c.start, true), to: ops.fmtTime(c.end, true), sec: ((c.end - c.start) / 1000).toFixed(1) });
  if (document.activeElement !== $("#cueText")) $("#cueText").value = c.text;
  if (document.activeElement !== $("#cueTr")) $("#cueTr").value = c.tr || "";
  const long = longOf(c);
  $(state.foreign ? "#cueTr" : "#cueText").classList.toggle("long", long);
  $("#cueLong").textContent = state.foreign ? _("譯文太長") : _("一行太長");
  $("#cueLong").hidden = !long;
  $("#mergeBtn").disabled = state.sel >= state.cues.length - 1;
  const gone = cutOps.cutShare(state.cuts, c.start, c.end) >= 0.99;
  $("#cutCueBtn").textContent = gone ? _("恢復這一句") : _("剪掉這一句");
  $("#cutCueBtn").dataset.gone = gone ? "1" : "";
  const ai = $("#aiNote");
  ai.hidden = !c.ai?.length;
  ai.innerHTML = c.ai?.length ? `${_("AI 修正了這句：{list}", { list: c.ai.map((e, k) => `${_("「{find}」→「{replace}」", { find: esc(e.find), replace: esc(e.replace) })} <button class="btn sm" data-revert="${k}">${_("改回原字")}</button>`).join(" ") })} <button class="btn sm" data-ok>${_("沒問題")}</button>` : "";
}
const isEditing = () => document.activeElement === $("#cueText") || document.activeElement === $("#cueTr") || !!document.activeElement?.closest?.("#cueList input");

$("#aiNote").onclick = (e) => {
  const c = state.cues[state.sel];
  if (!c) return;
  const r = e.target.closest("[data-revert]"), ok = e.target.closest("[data-ok]");
  if (!r && !ok) return;
  pushUndo();
  if (r) {
    const edit = c.ai[Number(r.dataset.revert)];
    const target = edit.replace.replace(/[，。、！？；：]/gu, " ").trim();   // 不翻：正規式（比對中文標點）
    c.text = c.text.replace(target, edit.find.replace(/[，。、！？；：]/gu, " ").trim());   // 不翻：正規式（比對中文標點）
    c.ai = c.ai.filter((x0, k) => k !== Number(r.dataset.revert));
  } else {
    delete c.ai;
  }
  if (!c.ai?.length) delete c.ai;
  changed();
  updateRow(state.sel);
  renderListCountsOnly();
  showCue();
};
function renderListCountsOnly() {
  const counts = { ai: state.cues.filter((c) => c.ai?.length).length, long: state.cues.filter(longOf).length };
  for (const b of document.querySelectorAll("#filterSeg button")) if (b.dataset.f !== "all") b.textContent = b.dataset.f === "ai" ? _("AI 改過 {count}", { count: counts[b.dataset.f] }) : _("太長 {count}", { count: counts[b.dataset.f] });
}

$("#cueText").addEventListener("focus", () => beginEdit(state.sel));
$("#cueText").addEventListener("input", () => typed(state.sel, $("#cueText").value));
$("#cueText").addEventListener("blur", () => commitEdit(state.sel));
$("#cueText").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitEdit(state.sel);
    const n = e.shiftKey ? state.sel - 1 : state.sel + 1;
    if (n >= 0 && n < state.cues.length) { select(n, true); beginEdit(n); }
  } else if (e.key === "Escape") { $("#cueText").blur(); }
});

// 開始改某一句：記下原文（給「錯→對」的建議與復原用）
function beginEdit(i) {
  if (state.editBefore?.i === i) return;
  if (state.editBefore) commitEdit(state.editBefore.i);
  const c = state.cues[i];
  if (c) state.editBefore = { i, text: c.text, snapshot: snapshot() };
}
function typed(i, value) {
  const c = state.cues[i];
  if (!c) return;
  c.text = value;
  if (i === state.sel && document.activeElement !== $("#cueText")) $("#cueText").value = value;
  if (i === state.sel && !state.foreign) { const long = ops.tooLong(value); $("#cueText").classList.toggle("long", long); $("#cueLong").hidden = !long; }
  const inp = rowOf(i)?.querySelector("input");
  if (inp && document.activeElement !== inp) inp.value = value;
  drawOverlay();
}
function commitEdit(i) {
  const before = state.editBefore;
  if (!before || before.i !== i) return;
  state.editBefore = null;
  const c = state.cues[i];
  if (!c) return;
  c.text = c.text.replace(/\s+/gu, " ").trim();
  if (c.text === before.text) return;
  state.undo.push(before.snapshot);
  if (state.undo.length > 200) state.undo.shift();
  $("#undoBtn").disabled = false;
  changed();
  updateRow(i);
  renderListCountsOnly();
  if (!state.foreign) suggestCorrection(before.text, c.text, i);   // 錯字表是中文辨識用的
}

// ---- 譯文（外語影片，#56）：和原文一樣，改完才記一次復原 ----
$("#cueTr").addEventListener("focus", () => beginTr(state.sel));
$("#cueTr").addEventListener("input", () => typedTr(state.sel, $("#cueTr").value));
$("#cueTr").addEventListener("blur", () => commitTr(state.sel));
$("#cueTr").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitTr(state.sel);
    const n = e.shiftKey ? state.sel - 1 : state.sel + 1;
    if (n >= 0 && n < state.cues.length) { select(n, true); beginTr(n); }
  } else if (e.key === "Escape") { $("#cueTr").blur(); }
});
function beginTr(i) {
  if (state.trBefore?.i === i) return;
  if (state.trBefore) commitTr(state.trBefore.i);
  const c = state.cues[i];
  if (c) state.trBefore = { i, tr: c.tr, snapshot: snapshot() };
}
function typedTr(i, value) {
  const c = state.cues[i];
  if (!c) return;
  c.tr = value;
  if (i === state.sel && document.activeElement !== $("#cueTr")) $("#cueTr").value = value;
  const inp = rowOf(i)?.querySelector("input[data-tr]");
  if (inp && document.activeElement !== inp) inp.value = value;
  if (i === state.sel) { const long = ops.tooLong(value); $("#cueTr").classList.toggle("long", long); $("#cueLong").hidden = !long; }
  drawOverlay();
}
function commitTr(i) {
  const before = state.trBefore;
  if (!before || before.i !== i) return;
  state.trBefore = null;
  const c = state.cues[i];
  if (!c) return;
  c.tr = String(c.tr ?? "").replace(/\s+/gu, " ").trim();
  if (c.tr === String(before.tr ?? "")) { if (before.tr === undefined && !c.tr) delete c.tr; return; }
  state.undo.push(before.snapshot);
  if (state.undo.length > 200) state.undo.shift();
  $("#undoBtn").disabled = false;
  changed();
  updateRow(i);
  renderListCountsOnly();
}

// 改了字：問要不要加進錯字表、其他地方要不要一起改
function suggestCorrection(before, after, i) {
  const s = ops.correctionFromEdit(before, after);
  if (!s) return;
  const others = ops.countIn(state.cues, s.wrong, i);
  const known = state.corr && [...state.corr.hints, ...state.corr.fixed].some(([w, r]) => w === s.wrong && r === s.right);
  const actions = [];
  if (!known) actions.push({ label: _("加入錯字表"), solid: true, run: () => addCorr(s.wrong, s.right) });
  if (others) actions.push({ label: _("其他 {n} 處也改", { n: others }), run: () => {
    pushUndo();
    state.cues = ops.replaceAll(state.cues, s.wrong, s.right, i).cues;
    changed();
    renderList();
    toast(_("已改 {n} 處。", { n: others }), [{ label: _("復原"), run: undo }]);
  } });
  if (!actions.length) return;
  actions.push({ label: _("不用") });
  toast(_("「{wrong}」改成「{right}」。{note}", { wrong: esc(s.wrong), right: esc(s.right), note: known ? "" : _("加進錯字表，之後會議轉錄和字幕都會更準。") }), actions, 15000);
}

async function addCorr(wrong, right) {
  try {
    const r = await post("/api/corrections", { wrong, right });
    toast(r.added ? _("已加入錯字表（共 {n} 組，存在 mini）。", { n: r.hints + r.fixed }) : _("錯字表裡已經有了。"), [], 5000);
    loadCorr(true);
  } catch (e) { showAlert(_("沒加成功：{err}", { err: e.message })); }
}

// ---- 結構性修改：拆、合、刪、調時間 ----
const snapshot = () => ({ cues: state.cues.map((c) => ({ ...c, ...(c.ai ? { ai: c.ai.map((e) => ({ ...e })) } : {}) })), cuts: state.cuts });
function pushUndo() {
  if (state.editBefore) commitEdit(state.editBefore.i);
  if (state.trBefore) commitTr(state.trBefore.i);
  state.undo.push(snapshot());
  if (state.undo.length > 200) state.undo.shift();
  $("#undoBtn").disabled = false;
}
function undo() {
  const prev = state.undo.pop();
  if (!prev) return;
  state.editBefore = null;
  state.trBefore = null;
  state.cues = prev.cues;
  state.cuts = prev.cuts;
  $("#undoBtn").disabled = !state.undo.length;
  changed();
  renderECuts();
  renderList();
  if (state.sel >= state.cues.length) state.sel = state.cues.length - 1;
  showCue();
  drawOverlay();
}
$("#undoBtn").onclick = undo;

function structural(fn, keepSel) {
  pushUndo();
  const out = fn();
  if (!out || out === state.cues) { state.undo.pop(); $("#undoBtn").disabled = !state.undo.length; return; }
  state.cues = out;
  changed();
  renderList();
  select(keepSel ?? state.sel, false);
  drawOverlay();
}
$("#splitBtn").onclick = () => {
  const pos = $("#cueText").selectionStart ?? 0;
  const cut = [...$("#cueText").value.slice(0, pos)].length;
  structural(() => ops.splitCue(state.cues, state.sel, cut));
};
$("#mergeBtn").onclick = () => structural(() => ops.mergeNext(state.cues, state.sel));
$("#delBtn").onclick = () => {
  const i = state.sel;
  structural(() => ops.removeCue(state.cues, i), Math.min(i, state.cues.length - 2));
  toast(_("刪掉了一句。"), [{ label: _("復原"), run: undo }]);
};
for (const b of document.querySelectorAll(".cue-tools .grp .btn")) {
  b.onclick = () => {
    const which = b.dataset.t, d = b.dataset.d;
    structural(() => (d === "now" ? ops.setTime(state.cues, state.sel, which, video.currentTime * 1000) : ops.nudge(state.cues, state.sel, which, Number(d))));
    showCue();
  };
}
$("#insertBtn").onclick = () => {
  pushUndo();
  const r = ops.insertAt(state.cues, video.currentTime * 1000);
  if (r.index < 0) { state.undo.pop(); return; }
  state.cues = r.cues;
  changed();
  renderList();
  state.play = r.index;
  select(r.index, false);
  $("#cueText").focus();
};

// ---- 播放 ----
function seekMs(ms) { video.currentTime = Math.max(0, ms / 1000); tick(); }
let stopAt = null;
function togglePlay() { if (video.paused) { stopAt = null; video.play(); } else video.pause(); }
$("#playBtn").onclick = togglePlay;
$("#playCue").onclick = () => playCue();
function playCue() {
  const c = state.cues[state.sel];
  if (!c) return;
  video.currentTime = c.start / 1000;
  stopAt = c.end / 1000;
  video.play();
}
const frame = (n) => { video.pause(); seekMs(video.currentTime * 1000 + (n * 1000) / state.fps); };
$("#frameBack").onclick = () => frame(-1);
$("#frameFwd").onclick = () => frame(1);
$("#prevCue").onclick = () => select(state.sel - 1);
$("#nextCue").onclick = () => select(state.sel + 1);
$("#rate").onchange = () => { video.playbackRate = Number($("#rate").value); };
$("#scrub").oninput = () => { if (video.duration) seekMs(($("#scrub").value / 1000) * video.duration * 1000); };
video.addEventListener("play", () => { setPlayIcon(); loop(); });
video.addEventListener("pause", () => { setPlayIcon(); tick(); });
video.addEventListener("seeked", tick);
function setPlayIcon() {
  $("#playBtn").innerHTML = `<svg class="icon"><use href="#i-${video.paused ? "play" : "pause"}"/></svg>`;
  $("#playBtn").setAttribute("aria-label", video.paused ? _("播放") : _("暫停"));
}
function loop() { if (video.paused) return; tick(); requestAnimationFrame(loop); }

// 外語影片（#56）照「中文／原文／雙語」畫一到兩行；一般影片只有原文一行。內容沒變就不重畫（播放時每一格都會呼叫）
let overlayHtml = null;
function drawOverlay() {
  const c = state.cues[state.play];
  const parts = c ? boxOps.displayParts(c, state.foreign ? state.langMode : "orig") : [];
  const html = parts.map((x) => `<span class="${x.role === "sub" ? "l2" : "l1"}">${esc(x.text)}</span>`).join("");
  if (html !== overlayHtml) { $("#overlay").innerHTML = html; overlayHtml = html; }
  $("#overlay").classList.toggle("editing", state.play >= 0 && (state.play === state.editBefore?.i || state.play === state.trBefore?.i));
}
function tick() {
  etl.setNow(video.currentTime * 1000, !video.paused);
  const cut = !video.paused && $("#eSkip").checked && cutOps.cutAt(pCuts(), video.currentTime * 1000);
  if (cut) {
    if (cut.end >= (video.duration || 0) * 1000 - 50) video.pause();
    else video.currentTime = cut.end / 1000;
  }
  const ms = video.currentTime * 1000;
  if (stopAt !== null && video.currentTime >= stopAt) { video.pause(); stopAt = null; }
  $("#timeNow").textContent = `${ops.fmtTime(ms, true)} / ${ops.fmtTime((video.duration || 0) * 1000)}`;
  if (video.duration && document.activeElement !== $("#scrub")) $("#scrub").value = String(Math.round((video.currentTime / video.duration) * 1000));
  const idx = ops.cueIndexAt(state.cues, ms);
  const gap = idx === -1 && video.paused && video.readyState > 0 && state.cues.length > 0;   // 和 showCue 的空檔條件一致
  if (idx !== state.play) {
    state.play = idx;
    // 沒在打字時，選取跟著播放走
    if (idx >= 0 && !isEditing()) { state.sel = idx; scrollToRow(idx); }
    markRows();
    showCue();
  } else if (gap !== !$("#gapNote").hidden) showCue();   // 只在「空檔提示」該出現或消失時重畫
  drawOverlay();
}

// ---- 鍵盤 ----
document.addEventListener("keydown", (e) => {
  if ($("#editor").hidden || document.querySelector("dialog[open]")) return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.altKey && e.code === "Space") { e.preventDefault(); togglePlay(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping(e)) { e.preventDefault(); undo(); return; }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  // 焦點在按鈕、分頁、連結上：Enter／空白照瀏覽器原本的意思（按下去）
  if ((e.key === "Enter" || e.code === "Space") && e.target.closest?.("button, [role=tab], a, summary, select, input")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? seekMs(video.currentTime * 1000 - 1000) : frame(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? seekMs(video.currentTime * 1000 + 1000) : frame(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); select(state.sel - 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); select(state.sel + 1); }
  else if (e.key === "Enter") { e.preventDefault(); $("#cueText").focus(); }
  else if (e.key.toLowerCase() === "p") { e.preventDefault(); playCue(); }
  else if (e.key.toLowerCase() === "i") eMarkIn();
  else if (e.key.toLowerCase() === "o") eMarkOut();
  else if (e.key.toLowerCase() === "x") eCutSelection();
});
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range" && e.target.type !== "checkbox";

// ---- 自動存檔 ----
let saveTimer = 0, saving = null, dirty = false, saveFailed = false;
function changed() {
  dirty = true;
  $("#saveNote").classList.remove("err");
  $("#saveNote").textContent = _("有修改，稍後自動儲存…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 800);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (state.editBefore) commitEdit(state.editBefore.i);
  if (state.trBefore) commitTr(state.trBefore.i);
  if (saving) await saving;
  if (!dirty || !state.id) return;
  dirty = false;
  $("#saveNote").textContent = _("儲存中…");
  const savingId = state.id;   // 等回應時可能已經換了專案：結果只算在原本那個專案上
  saving = api(`/api/projects/${state.id}`, { method: "PUT", body: JSON.stringify({ rev: state.rev, cues: state.cues, cuts: state.cuts, ...(descBusyId === state.id ? {} : { description: state.desc }), size: state.size, style: state.style, ...(state.foreign ? { lang_mode: state.langMode } : {}), ...(state.p?.suggestions ? { suggestions: (state.p.suggestions.items || []).map((x) => x.id), suggestionsCreated: state.p.suggestions.created } : {}) }) })
    .then((r) => {
      if (savingId !== state.id) return;
      saveFailed = false;
      state.rev = r.rev;
      $("#saveNote").textContent = _("已儲存 {time}", { time: new Date(r.updated).toLocaleTimeString(UI_LANG === "en" ? "en-US" : "zh-TW", { hour: "2-digit", minute: "2-digit" }) });
    })
    .catch((e) => {
      // 409 別的分頁改過、400 內容不合規（例如一句超過 200 字）：重試也沒用，請使用者處理
      if (savingId !== state.id) return;
      const final = e.status === 409 || e.status === 400;
      saveFailed = true;
      dirty = !final;
      $("#saveNote").classList.add("err");
      $("#saveNote").textContent = e.status === 409 ? _("別的分頁改過，請重新整理") : e.status === 400 ? _("沒存成功，請看提示") : _("沒存成功，會再試");
      if (final) showAlert(e.message);
      else saveTimer = setTimeout(() => flushSave(), 4000);
    })
    .finally(() => { saving = null; });
  await saving;
}
window.addEventListener("beforeunload", (e) => { if (dirty || state.editBefore || state.trBefore) { flushSave(); e.preventDefault(); } });
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });

// ---- 說明欄 ----
const utf8Len = (t) => new TextEncoder().encode(t).length;
function descCount() {
  const t = $("#descText").value;
  $("#descCount").textContent = _("{count} 字{note}", { count: t.length, note: utf8Len(t) > 5000 ? _("（超過 YouTube 上限：5000 位元組，中文約 1600 字）") : "" });
}
$("#descText").oninput = () => { state.desc = $("#descText").value; descCount(); changed(); };
// 寫說明欄的時候還可以改字幕；說明欄先鎖住，存檔也先不送說明欄，免得把等一下的新內容蓋掉。
// 只鎖正在寫的那支（中途換到別支影片不受影響）
let descBusyId = "";
function showDescBusy() {
  const on = Boolean(descBusyId) && descBusyId === state.id;
  $("#descText").readOnly = on;
  $("#descRedo").disabled = Boolean(descBusyId);
  $("#descRedo").textContent = on ? _("正在寫…（約一分鐘）") : _("重新寫說明欄…");
  $("#descStop").hidden = !on;
}
function setDescBusy(id) { descBusyId = id; showDescBusy(); }
async function rewriteDescription() {
  const id = state.id;
  await flushSave();
  setDescBusy(id);
  try {
    const r = await post(`/api/projects/${id}/describe`);
    if (state.id !== id) return;
    state.desc = r.description;
    $("#descText").value = state.desc;
    descCount();
    if (state.p) state.p.youtube_suggest = r.youtube_suggest;
    toast(_("說明欄寫好了{note}。上傳 YouTube 時也會帶入新的名稱和標籤建議。", { note: r.chapters >= 3 ? _("，共 {n} 章", { n: r.chapters }) : "" }), [], 6000);
  } catch (e) {
    if (state.id === id) showAlert(e.message);
  } finally {
    setDescBusy("");
  }
}
$("#descStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };
$("#copyDesc").onclick = async () => {
  try { await navigator.clipboard.writeText($("#descText").value); toast(_("已複製，可以貼到 YouTube 說明欄。"), [], 3000); } catch { $("#descText").select(); }
};

// ---- 分頁 ----
for (const t of document.querySelectorAll(".tabs button")) {
  t.onclick = () => {
    for (const x of document.querySelectorAll(".tabs button")) { x.setAttribute("aria-selected", String(x === t)); $(`#${x.dataset.tab}`).hidden = x !== t; }
  };
}

// ---- 錯字表（和會議轉錄共用，正本在 mini）----
async function loadCorr(refresh = false) {
  try {
    state.corr = await api(`/api/corrections${refresh ? "?refresh=1" : ""}`);
  } catch (e) { $("#corrSrc").textContent = _("讀不到錯字表：{err}", { err: e.message }); return; }
  const c = state.corr;
  const src = { "meeting-scribe": _("來自 mini（會議轉錄）"), cache: _("mini 連不上，這是本機快取"), local: _("本機正本"), none: _("還沒有錯字表") }[c.source] || c.source;
  $("#corrSrc").textContent = _("共 {n} 組，{src}。這份和會議轉錄共用：在這裡加的，開會轉錄也會用到。", { n: c.hints.length + c.fixed.length, src });
  $("#tabCorr").textContent = _("錯字表 {count}", { count: c.hints.length + c.fixed.length });
  renderCorr();
}
function renderCorr() {
  const q = $("#corrFind").value.trim();
  const all = [...state.corr.hints, ...state.corr.fixed].filter(([w, r]) => !q || w.includes(q) || r.includes(q));
  $("#corrList").innerHTML = all.map(([w, r]) => `<li>${esc(w)}<span class="arrow">→</span>${esc(r)}</li>`).join("");
}
$("#corrFind").oninput = () => state.corr && renderCorr();
$("#corrAdd").onclick = async () => {
  const w = $("#corrWrong").value.trim(), r = $("#corrRight").value.trim();
  if (!w || !r) return;
  await addCorr(w, r);
  $("#corrWrong").value = "";
  $("#corrRight").value = "";
};
