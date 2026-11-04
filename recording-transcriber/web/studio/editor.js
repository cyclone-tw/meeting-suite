"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：專案、處理中畫面、編輯頁的影片舞台、時間軸剪輯與 AI 剪輯建議。

// ---- 專案 ----
const state = { id: "", p: null, cues: [], cuts: [], rev: 0, sel: -1, play: -1, filter: "all", undo: [], size: "medium", style: "box", fps: 30, corr: null, editBefore: null, desc: "",
  foreign: false, langMode: "both", trBefore: null, trSeen: new Map() };
const video = $("#video");
let pollTimer = 0;

async function openProject(id) {
  clearTimeout(pollTimer);
  state.id = id;
  let p;
  try { p = await api(`/api/projects/${id}`); } catch (e) { if (state.id === id) { showAlert(e.message); showHome(); } return; }
  if (state.id !== id) return;   // 等回應時已經回首頁或開了別的專案
  state.p = p;
  history.replaceState(null, "", `#${id}`);
  $("#projName").textContent = p.name;
  $("#privBadge").hidden = p.privacy === "public";
  if (p.status === "ready") return showEditor(p);
  showProcessing(p);
}

function showProcessing(p) {
  setView("processing");
  setStep(3);
  const stopped = p.status === "cancelled";   // 使用者按了停止（#67）
  const failed = p.status === "failed" || stopped;
  $("#procTitle").textContent = stopped ? _("已經停止") : failed ? _("處理沒有完成") : _("正在自動辨識與校對");
  $("#procSub").hidden = failed;
  $("#procFail").hidden = !failed;
  $("#procRun").hidden = failed || !p.job;
  $("#retryBtn").textContent = stopped ? _("重新開始") : _("重試");
  $("#procError").style.color = stopped ? "inherit" : "var(--warn)";
  $("#procError").textContent = stopped
    ? _("停在「{step}」。按「重新開始」從頭再跑{note}。", { step: stepName(p.stopped_at), note: p.has_asr ? _("；辨識結果已經存下來，不用再付辨識費") : "" })
    : p.error ? I18N.msg(p.error) : "";
  const step = p.job?.step || "";
  const at = STEP_ORDER.indexOf(step);
  for (const li of document.querySelectorAll("#procSteps li")) {
    const k = STEP_ORDER.indexOf(li.dataset.k);
    // Discord 分軌（#129）的步驟只在有分軌時出現；補聲音只在真的有人沒錄到時出現
    const kk = li.dataset.k;
    li.hidden = (kk === "preview" && step !== "preview") || ((kk === "tracks" || kk === "speakers") && !p.tracks)
      || (kk === "fill" && step !== "fill" && !(p.tracks?.filled || []).length);
    li.classList.toggle("now", !failed && k === at);
    li.classList.toggle("done", !failed && at > k);
    li.querySelector("i").textContent = !failed && at > k ? "✓" : "";
  }
  $("#procElapsed").textContent = p.job ? _("已經過 {sec} 秒", { sec: Math.round((Date.now() - p.job.started) / 1000) }) : "";
  if (!failed) pollTimer = setTimeout(() => openProject(state.id), 1500);
}
// 重新處理做好的專案（#30）：有存著的辨識結果就不再送 Soniox
let reprocMode = "reprocess";
$("#reprocBtn").onclick = () => {
  const p = state.p;
  const usd = Math.max(0.01, ((p?.duration_ms || 0) / 3600000) * 0.10).toFixed(2);
  reprocMode = "reprocess";
  $("#reprocTitle").textContent = _("重新處理這支影片？");
  $("#reprocCost").textContent = p?.has_asr
    ? _("這支影片的辨識結果還留著，不會再送 Soniox，也不用再付辨識費。")
    : _("這支影片沒有留下辨識結果，會重新送 Soniox 辨識（約 US${usd}）。之後的結果會留著，下次重新處理就不用再付。", { usd });
  $("#reprocWhat").innerHTML = _("會重新對時間、斷句、跑 AI 校對和 YouTube 說明欄。{warn}；剪輯的段落會保留。", { warn: `<b>${_("目前的字幕和你改過的地方都會被取代")}</b>` });
  $("#reprocGo").textContent = _("重新處理");
  $("#reprocDlg").showModal();
};
// 重新排字幕（#33）：只用每個字的時間重新斷句，不花錢、幾秒就好
$("#relayoutBtn").onclick = () => {
  if (!state.p?.has_timing) { showAlert(_("這支影片沒有每個字的時間，請用「重新處理這支影片」。")); return; }
  reprocMode = "relayout";
  $("#reprocTitle").textContent = _("重新排字幕？");
  $("#reprocCost").textContent = _("只用已經有的每個字的時間重新斷句：不重新辨識、不跑 AI，不花錢，幾秒就好。");
  $("#reprocWhat").innerHTML = _("字幕的文字不變，只是分句的位置會重新排。{warn}；剪輯的段落和「AI 改過」的標記會保留。", { warn: `<b>${_("你手動改過的字和時間會被取代")}</b>` });
  $("#reprocGo").textContent = _("重新排字幕");
  $("#reprocDlg").showModal();
};
// 只重新寫說明欄（#46）：字幕不動；說明欄有內容時先確認，因為會被取代
$("#descRedo").onclick = () => {
  if (!state.desc.trim()) { rewriteDescription(); return; }
  reprocMode = "describe";
  $("#reprocTitle").textContent = _("重新寫 YouTube 說明欄？");
  $("#reprocCost").textContent = _("會請 AI 依目前的字幕重新寫簡介、章節和每章重點，也會重新建議影片名稱和標籤。字幕不會變動，大約一分鐘。");
  $("#reprocWhat").innerHTML = _("{warn}，包括你手動改過的地方。", { warn: `<b>${_("目前說明欄的內容會被取代")}</b>` });
  $("#reprocGo").textContent = _("重新寫");
  $("#reprocDlg").showModal();
};
$("#reprocCancel").onclick = () => $("#reprocDlg").close();
$("#reprocGo").onclick = async () => {
  $("#reprocDlg").close();
  if (reprocMode === "describe") { rewriteDescription(); return; }
  try {
    await flushSave();
    const r = await post(`/api/projects/${state.id}/${reprocMode}`);
    await openProject(state.id);
    if (reprocMode === "relayout") toast(_("重新排好了，共 {n} 句。", { n: r.cues }), [], 5000);
  } catch (e) { showAlert(e.message); }
};

// 停在哪一步：用處理畫面上那一步的文字，去掉括號裡的說明
function stepName(k) {
  const li = document.querySelector(`#procSteps li[data-k="${k}"]`);
  return li ? li.textContent.replace(/[（(].*[）)]/, "").trim() : _("處理中");   // 不翻：正規式（全形與半形括號都去掉）
}

$("#procStop").onclick = () => $("#stopDlg").showModal();
$("#stopCancel").onclick = () => $("#stopDlg").close();
$("#stopGo").onclick = async () => {
  $("#stopDlg").close();
  $("#procStop").disabled = true;
  try {
    await post(`/api/projects/${state.id}/cancel`);
    toast(_("正在停止，雲端的副本會一起刪掉。"), [], 5000);
  } catch (e) { showAlert(e.message); }
  finally { $("#procStop").disabled = false; }
};

$("#retryBtn").onclick = async () => {
  try { await post(`/api/projects/${state.id}/retry`); openProject(state.id); } catch (e) { showAlert(e.message); }
};

function showEditor(p) {
  setView("editor");
  setStep(4);
  state.cues = p.cues;
  state.cuts = p.cuts || [];
  state.rev = p.rev;
  state.size = p.size || "medium";
  state.style = p.subtitle_style || "box";
  state.fps = p.fps || 30;
  state.undo = [];
  state.sel = -1;
  saveFailed = false;
  state.desc = p.description || "";
  $("#undoBtn").disabled = true;
  $("#descText").value = state.desc;
  descCount();
  showDescBusy();
  namesReset();
  spkReset(p);
  recapView = "intro";
  mmReset();
  renderRecap();
  renderModules();
  renderMind(true);
  renderDrive();
  const src = `/api/projects/${state.id}/video?t=${TOKEN}`;
  if (video.getAttribute("src") !== src) video.src = src;
  document.documentElement.style.setProperty("--fs", SIZE_PX[state.size]);
  $("#overlay").classList.toggle("box", state.style === "box");
  showLang(p);
  renderList();
  select(0, false);
  openEditorTimeline(p);
  aiChecked.clear();
  for (const x of p.suggestions?.items || []) aiChecked.add(x.id);
  renderAi(p);
  footNote(p.report);
  $("#saveNote").textContent = p.updated ? _("已儲存 {time}", { time: new Date(p.updated).toLocaleTimeString(UI_LANG === "en" ? "en-US" : "zh-TW", { hour: "2-digit", minute: "2-digit" }) }) : "";
  loadCorr();
  if (p.burn?.status === "running") openBurn();
  showPlain(p);
}

// 不要字幕的專案（#158）：只留影片、時間軸剪輯與說明欄，字幕相關的畫面藏起來
function showPlain(p) {
  const plain = p.source?.captions === "none", was = document.documentElement.classList.contains("no-subs");
  document.documentElement.classList.toggle("no-subs", plain);
  $("#descHint").hidden = plain;
  $("#descPlainHint").hidden = !plain;
  $("#descRedo").hidden = plain;
  if (plain) document.querySelector('.tabs button[data-tab="descPane"]').click();
  else if (was) $("#tabCues").click();
}

// ---- 外語影片（#56）：中文／原文／雙語，翻譯 ----
let trPoll = 0;
const trKey = (c) => `${c.start}\u0000${c.text}`;
function showLang(p) {
  state.foreign = Boolean(p.foreign);
  state.langMode = p.lang_mode || "both";
  state.trBefore = null;
  // 頁面上次拿到的譯文：輪詢時只更新使用者沒動過的句子
  state.trSeen = new Map(p.cues.map((c) => [trKey(c), c.tr]));
  $("#langBar").hidden = !state.foreign;
  $("#cueTr").hidden = !state.foreign;
  $("#relayoutBtn").hidden = state.foreign;   // 重新斷句後譯文會對不上
  renderLangSeg();
  renderTranslate(p);
}
function renderLangSeg() {
  for (const b of document.querySelectorAll("#langSeg button, #burnLangSeg button")) b.setAttribute("aria-pressed", String(b.dataset.m === state.langMode));
}
function setLangMode(m) {
  if (!state.foreign || m === state.langMode) return;
  state.langMode = m;
  renderLangSeg();
  drawOverlay();
  changed();
  if ($("#burnDlg").open) refreshBurn();
}
$("#langSeg").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) setLangMode(b.dataset.m); };
function renderTranslate(p) {
  clearTimeout(trPoll);
  if (!state.foreign) return;
  const running = p.job?.kind === "translate", t = p.translate;
  const missing = state.cues.filter((c) => c.text.trim() && !String(c.tr || "").trim()).length;
  $("#trStop").hidden = !running;
  $("#trBtn").disabled = Boolean(p.job);
  $("#trBtn").textContent = missing && missing < state.cues.length ? _("翻譯沒翻的…") : _("翻譯…");
  let msg = "";
  if (running) msg = _("翻譯中 {done}／{total} 句，可以先看、先改", { done: t?.done || 0, total: t?.total || "…" });
  else if (t?.status === "failed") msg = _("翻譯沒完成：{err}", { err: t.error ? I18N.msg(t.error) : "" });
  else if (t?.status === "cancelled") msg = _("翻譯停在 {done}／{total} 句", { done: t.done || 0, total: t.total || 0 });
  else if (missing) msg = _("{n} 句還沒有譯文", { n: missing });
  else if (state.cues.length) msg = _("每句都有譯文");
  $("#trStatus").textContent = msg;
  $("#trStatus").style.color = !running && t?.status === "failed" ? "var(--warn)" : "";
  if (running) trPoll = setTimeout(pollTranslate, 2000);
}
async function pollTranslate() {
  const id = state.id;
  let p;
  try { p = await api(`/api/projects/${id}`); } catch { if (state.id === id) trPoll = setTimeout(pollTranslate, 4000); return; }
  if (state.id !== id || $("#editor").hidden) return;
  const got = new Map(p.cues.filter((c) => c.tr !== undefined).map((c) => [trKey(c), c.tr]));
  let n = 0;
  state.cues.forEach((c, i) => {
    const k = trKey(c), t = got.get(k);
    if (t === undefined || t === c.tr || state.trBefore?.i === i || c.tr !== state.trSeen.get(k)) return;   // 使用者改過的不蓋
    c.tr = t;
    state.trSeen.set(k, t);
    n += 1;
    updateRow(i);
  });
  if (n) { showCue(); drawOverlay(); }
  const wasRunning = state.p?.job?.kind === "translate";
  state.p = { ...state.p, translate: p.translate, job: p.job };
  if (wasRunning && !p.job && p.translate?.status === "done") toast(_("翻譯好了，共 {n} 句。上面可以切換「中文／原文／雙語」。", { n: p.translate.done }), [], 6000);
  renderTranslate(state.p);
}
async function startTranslate(all) {
  const id = state.id;
  await flushSave();
  try { await post(`/api/projects/${id}/translate`, { all }); } catch (e) { showAlert(e.message); return; }
  if (state.id !== id) return;
  state.p = { ...state.p, job: { kind: "translate", started: Date.now() }, translate: { status: "running", done: 0, total: 0 } };
  renderTranslate(state.p);
}
$("#trBtn").onclick = () => {
  const missing = state.cues.filter((c) => c.text.trim() && !String(c.tr || "").trim()).length;
  const have = state.cues.filter((c) => String(c.tr || "").trim()).length;
  if (!have) { startTranslate(false); return; }
  const actions = [];
  if (missing) actions.push({ label: _("只翻沒翻的 {n} 句", { n: missing }), solid: true, run: () => startTranslate(false) });
  actions.push({ label: _("全部重翻"), solid: !missing, run: () => startTranslate(true) }, { label: _("先不要") });
  toast(missing ? _("要翻哪些？全部重翻會取代目前的譯文，包括你改過的。") : _("每句都有譯文了。全部重翻會取代目前的譯文，包括你改過的。"), actions, 0);
};
$("#trStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };

// 剪掉的區段：預覽頁粗剪的，和編輯頁剪的（#5）都在 state.cuts，存檔時一起送
const pCuts = () => state.cuts;
function renderScrubCuts() {
  const dur = state.p?.duration_ms || (video.duration || 0) * 1000;
  $("#scrubCuts").innerHTML = dur ? pCuts().map((c) => `<div style="left:${(c.start / dur) * 100}%;width:${((c.end - c.start) / dur) * 100}%"></div>`).join("") : "";
}

function footNote(r) {
  if (!r) { $("#listFoot").textContent = _("{n} 句", { n: state.cues.length }) + (pCuts().length ? " · " + _("剪掉 {n} 段", { n: pCuts().length }) : ""); return; }
  const parts = [_("{n} 句", { n: state.cues.length })];
  if (r.edits) parts.push(_("AI 改了 {n} 處", { n: r.edits.applied }));
  if (r.soniox?.audio_ms) parts.push(_("Soniox {min} 分鐘 ≈ NT${cost}", { min: (r.soniox.audio_ms / 60000).toFixed(1), cost: (r.soniox.cost_usd * 32).toFixed(1) }));
  if (r.claude?.calls) parts.push(r.proofreader === "claude" ? _("Claude {n} 次（訂閱，API 等值 NT${cost}）", { n: r.claude.calls, cost: (r.claude.cost_usd * 32).toFixed(1) }) : _("{name} {n} 次", { name: r.proofreader, n: r.claude.calls }));
  if (r.corrections) parts.push(_("錯字表 {n} 組{note}", { n: r.corrections.hints + r.corrections.fixed, note: r.corrections.source === "cache" ? _("（mini 連不上，用本機快取）") : "" }));
  if (pCuts().length) parts.push(_("剪掉 {n} 段（紅色），燒字幕時一起剪掉", { n: pCuts().length }));
  $("#listFoot").textContent = parts.join(" · ");
}

// ---- 影片大小：舞台和影片同比例，字幕預覽才會和燒出來的一樣 ----
function fitStage() {
  const w = video.videoWidth || 16, h = video.videoHeight || 9;
  const wrap = $("#stageWrap");
  const maxW = wrap.clientWidth, maxH = Math.max(220, window.innerHeight * (window.innerWidth < 1000 ? 0.5 : 0.56));
  let W = maxW, H = (maxW * h) / w;
  if (H > maxH) { H = maxH; W = (maxH * w) / h; }
  Object.assign($("#stage").style, { width: `${W}px`, height: `${H}px` });
}
new ResizeObserver(fitStage).observe($("#stageWrap"));
window.addEventListener("resize", fitStage);
video.addEventListener("loadedmetadata", () => { fitStage(); renderScrubCuts(); tick(); });
video.addEventListener("error", () => { if (state.id && !$("#editor").hidden) showAlert(_("影片播不了：原始影片可能被移動、刪除，或格式瀏覽器不支援。")); });

// ---- 編輯頁的時間軸與剪輯（#5）----
const ed = { selIn: null, selOut: null, picked: -1, ac: null };
const etl = makeTimeline($("#etl"), {
  seek: (ms) => { ed.picked = -1; seekMs(ms); renderECuts(); },
  select: (sel) => { [ed.selIn, ed.selOut] = sel; ed.picked = -1; seekMs(sel[0]); renderECuts(); },
  pickCut: (i) => { ed.picked = i; ed.selIn = ed.selOut = null; renderECuts(); },
});
const eDur = () => state.p?.duration_ms || (video.duration || 0) * 1000;
const eSel = () => (ed.selIn !== null && ed.selOut !== null && ed.selOut > ed.selIn ? [ed.selIn, ed.selOut] : null);

function openEditorTimeline(p) {
  ed.ac?.abort();
  ed.ac = new AbortController();
  Object.assign(ed, { selIn: null, selOut: null, picked: -1 });
  etl.reset(eDur() || 1);
  $("#eZoomLabel").textContent = _("整支");
  $("#etlEnd").textContent = ops.fmtTime(eDur());
  renderECuts();
  const id = p.id, signal = ed.ac.signal;
  streamTiles(`/api/projects/${id}/thumbs`, signal, (tile) => etl.addTile(tile));
  fetch(`/api/projects/${id}/wave`, { headers: { "X-Studio-Token": TOKEN }, signal }).then((r) => r.json()).then((w) => {
    if (state.id !== id) return;
    etl.setWave({ bucket_ms: w.bucket_ms, peaks: Uint8Array.from(atob(w.peaks || ""), (c) => c.charCodeAt(0)) });
  }).catch(() => {});
}
function leaveEditorTimeline() { ed.ac?.abort(); ed.ac = null; clearTimeout(aiPoll); }

function renderECuts() {
  const sel = eSel();
  etl.setCuts(state.cuts, ed.picked);
  etl.setSel(sel, sel ? null : ed.selIn ?? ed.selOut);
  $("#eCutSel").disabled = !sel;
  $("#eCutSel").textContent = sel ? _("剪掉選取的範圍（{len}）", { len: fmtLen(sel[1] - sel[0]) }) : _("剪掉選取的範圍");
  const c = state.cuts[ed.picked];
  $("#eCutNote").hidden = !c;
  if (c) $("#eCutNote").innerHTML = `${_("剪掉的區段 {from}–{to}（{len}）", { from: ops.fmtTime(c.start, true), to: ops.fmtTime(c.end, true), len: fmtLen(c.end - c.start) })}${c.reason ? _("：{reason}", { reason: esc(c.reason) }) : ""} <button class="btn sm" data-restore>${_("恢復這段")}</button><button class="btn sm" data-try>${_("從前面 3 秒試播")}</button>`;
  renderScrubCuts();
  footNote(state.p?.report);
}

// 改剪輯：可以復原、會自動存檔；整支都剪掉的不收
function setECuts(next, message) {
  const cuts = cutOps.normalizeCuts(next, eDur());
  if (cuts.length && !cutOps.keepSegments(cuts, eDur()).length) { showAlert(_("整支影片都剪掉了，至少要留一段")); return; }
  pushUndo();
  state.cuts = cuts;
  ed.selIn = ed.selOut = null;
  ed.picked = -1;
  changed();
  renderECuts();
  renderList();
  showCue();
  if (message) toast(message, [{ label: _("復原"), run: undo }], 5000);
}
const eMarkIn = () => { ed.selIn = video.currentTime * 1000; if (ed.selOut !== null && ed.selOut <= ed.selIn) ed.selOut = null; ed.picked = -1; renderECuts(); };
const eMarkOut = () => { ed.selOut = video.currentTime * 1000; if (ed.selIn !== null && ed.selIn >= ed.selOut) ed.selIn = null; ed.picked = -1; renderECuts(); };
const eCutSelection = () => { const sel = eSel(); if (sel) setECuts([...state.cuts, { start: sel[0], end: sel[1], by: "user" }], _("剪掉了一段。")); };
$("#eMarkIn").onclick = eMarkIn;
$("#eMarkOut").onclick = eMarkOut;
$("#eCutSel").onclick = eCutSelection;
$("#eZoomIn").onclick = () => { const z = etl.zoom(1); $("#eZoomLabel").textContent = z === 1 ? _("整支") : `×${z}`; };
$("#eZoomOut").onclick = () => { const z = etl.zoom(-1); $("#eZoomLabel").textContent = z === 1 ? _("整支") : `×${z}`; };
$("#eCutNote").onclick = (e) => {
  const c = state.cuts[ed.picked];
  if (!c) return;
  if (e.target.closest("[data-restore]")) setECuts(state.cuts.filter((x0, i) => i !== ed.picked), _("恢復了這一段。"));
  if (e.target.closest("[data-try]")) { seekMs(Math.max(0, c.start - 3000)); video.play(); }
};
// 剪掉這一句：連同前後一點點空白（不超過前後句）；已經剪掉的就恢復這一句的範圍
$("#cutCueBtn").onclick = () => {
  const i = state.sel, c = state.cues[i];
  if (!c) return;
  // 和「剪掉這一句」用同一個範圍，恢復時才不會在前後留下一小段
  const start = Math.max(state.cues[i - 1]?.end ?? 0, c.start - 100), end = Math.min(state.cues[i + 1]?.start ?? eDur(), c.end + 100);
  if ($("#cutCueBtn").dataset.gone) { setECuts(cutOps.subtractRange(state.cuts, start, end), _("恢復了這一句。")); return; }
  setECuts([...state.cuts, { start, end, by: "user" }], _("剪掉了這一句，畫面和聲音都會從影片拿掉。"));
};

// 縮圖一張一張串流進來（NDJSON）
async function streamTiles(url, signal, onTile) {
  try {
    const r = await fetch(url, { headers: { "X-Studio-Token": TOKEN }, signal });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onTile(JSON.parse(l));
    }
  } catch { /* 離開頁面時中止，沒關係 */ }
}

// ---- AI 剪輯建議（#6）----
const AI_STEPS = { silence: _("找長時間的靜音（本機）…"), black: _("找黑畫面（本機）…"), ai: _("AI 看逐字稿，找講錯重講、贅詞、離題…") };
const aiChecked = new Set();
let aiPoll = 0;
const aiItems = () => state.p?.suggestions?.items || [];
const aiWhy = (reason) => I18N.msg(reason.replace(/^[^：]*：/, ""));   // 不翻：正規式去掉「類型：」前綴；說明文字是主機給的，查字典換語言
function renderAi(p) {
  clearTimeout(aiPoll);
  $("#aiWho").textContent = p.proofreader === "claude" || !p.proofreader ? "Claude" : p.proofreader;
  const running = p.job?.kind === "suggest";
  const sug = p.suggestions;
  $("#aiRun").hidden = !running;
  $("#aiIntro").hidden = running || !!(sug && sug.status === "done" && sug.items.length);
  $("#aiResult").hidden = running || !(sug && sug.status === "done" && sug.items.length);
  $("#tabAi").textContent = sug?.items?.length ? _("AI 剪輯 {count}", { count: sug.items.length }) : _("AI 剪輯");
  etl.setHints(running ? [] : aiItems().filter((x) => aiChecked.has(x.id)));
  if (running) {
    $("#aiStep").textContent = AI_STEPS[p.job.step] || _("處理中…");
    $("#aiElapsed").textContent = _("已經過 {sec} 秒；可以先繼續改字幕。", { sec: Math.round((Date.now() - p.job.started) / 1000) });
    aiPoll = setTimeout(pollAi, 1500);
    return;
  }
  // 失敗只在剛發生時提示一次，之後打開專案不再跳
  const recent = (t) => t && Date.now() - Date.parse(t) < 15_000;
  if (sug?.status === "failed" && recent(sug.created)) showAlert(_("沒找成功：{err}", { err: I18N.msg(sug.error) }));
  if (sug?.lastError && recent(sug.lastErrorAt)) showAlert(_("這次沒找成功（{err}），先留著上一次的建議。", { err: I18N.msg(sug.lastError) }));
  if (!sug || sug.status !== "done") return;
  if (!sug.items.length) {
    $("#aiFind").textContent = _("重新找");
    if (sug.created && Date.now() - Date.parse(sug.created) < 10_000) toast(sug.error ? _("AI 那段沒成功（{err}），本機也沒找到可以剪的地方。", { err: esc(I18N.msg(sug.error)) }) : _("沒有找到可以剪掉的地方。{warn}", { warn: esc(I18N.msg(sug.warning || "")) }), [], 6000);
    return;
  }
  const items = sug.items;
  const total = items.filter((x) => aiChecked.has(x.id)).reduce((n, x) => n + x.end - x.start, 0);
  const kept = cutOps.keptDuration(cutOps.keepSegments(state.cuts, eDur()));
  $("#aiSum").innerHTML = _("找到 {found} 處可以剪，勾選的共 {sel}，全部剪完約 {left}。", { found: `<b>${items.length}</b>`, sel: `<b>${fmtLen(total)}</b>`, left: fmtLen(Math.max(0, kept - total)) }) +
    (sug.usage?.calls ? `<br><span class="muted">${_("AI 呼叫 {n} 次{note}", { n: sug.usage.calls, note: p.proofreader === "claude" ? _("（訂閱，API 等值 NT${cost}）", { cost: (sug.usage.cost_usd * 32).toFixed(1) }) : "" })}</span>` : "") +
    (sug.error ? `<br><span style="color:var(--warn)">${_("AI 那段沒成功，只列出本機找到的：{err}", { err: esc(I18N.msg(sug.error)) })}</span>` : "") +
    (sug.warning ? `<br><span style="color:var(--warn)">${esc(I18N.msg(sug.warning))}</span>` : "") +
    (sug.dropped ? `<br><span style="color:var(--warn)">${esc(I18N.msg(sug.dropped))}</span>` : "");
  const label = { silence: _("靜音"), black: _("黑畫面"), retake: _("口誤重講"), filler: _("贅詞"), offtopic: _("離題"), waiting: _("等待") };
  $("#aiList").innerHTML = items.map((x) => `<li class="${aiChecked.has(x.id) ? "" : "off"}"><input type="checkbox" data-sid="${x.id}"${aiChecked.has(x.id) ? " checked" : ""} aria-label="${_("套用這一條")}"><div class="head"><button class="t" data-try="${x.id}" title="${_("從前 2 秒試播到後 1 秒")}">${ops.fmtTime(x.start)}–${ops.fmtTime(x.end)}</button><span class="badge ${x.kind === "silence" || x.kind === "black" ? "" : "ai"}">${label[x.kind] || esc(x.kind)}</span><span class="muted">${fmtLen(x.end - x.start)}</span></div><span class="why">${esc(aiWhy(x.reason))}</span>${x.text ? `<span class="ex" title="${esc(x.text)}">${_("「{text}」", { text: esc(x.text) })}</span>` : ""}</li>`).join("");
  $("#aiAll").checked = items.every((x) => aiChecked.has(x.id));
  const n = items.filter((x) => aiChecked.has(x.id)).length;
  $("#aiApply").textContent = _("套用勾選的 {n} 段", { n });
  $("#aiApply").disabled = $("#aiApplyRender").disabled = !n;
}
async function pollAi() {
  const id = state.id;
  let p;
  try { p = await api(`/api/projects/${id}`); } catch { return; }
  if (state.id !== id || $("#editor").hidden) return;
  const wasRunning = state.p?.job?.kind === "suggest";
  state.p.job = p.job;
  state.p.suggestions = p.suggestions;
  if (wasRunning && p.job?.kind !== "suggest") { aiChecked.clear(); for (const x of aiItems()) aiChecked.add(x.id); }
  renderAi(state.p);
}
$("#aiFind").onclick = async () => {
  await flushSave();
  try { await post(`/api/projects/${state.id}/suggest`, { ai: $("#aiUseAi").checked }); } catch (e) { showAlert(e.message); return; }
  state.p.job = { kind: "suggest", step: "silence", started: Date.now() };
  renderAi(state.p);
};
$("#aiAgain").onclick = () => { $("#aiResult").hidden = true; $("#aiIntro").hidden = false; };
$("#aiStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };
$("#aiList").onclick = (e) => {
  const c = e.target.closest("[data-sid]"), t = e.target.closest("[data-try]");
  if (c) { if (c.checked) aiChecked.add(c.dataset.sid); else aiChecked.delete(c.dataset.sid); renderAi(state.p); }
  if (t) {
    const x = aiItems().find((y) => y.id === t.dataset.try);
    if (x) { video.currentTime = Math.max(0, x.start - 2000) / 1000; stopAt = (x.end + 1000) / 1000; video.play(); }
  }
};
$("#aiAll").onchange = () => { aiChecked.clear(); if ($("#aiAll").checked) for (const x of aiItems()) aiChecked.add(x.id); renderAi(state.p); };
// 套用：勾選的變成剪輯（標成 AI 建議，可以在時間軸上恢復）；沒勾的留在清單
function applyAi() {
  const chosen = aiItems().filter((x) => aiChecked.has(x.id));
  if (!chosen.length) return false;
  const next = [...state.cuts, ...chosen.map((x) => ({ start: x.start, end: x.end, by: "ai", reason: x.reason }))];
  const before = state.cuts;
  setECuts(next, _("套用了 {n} 段 AI 建議。", { n: chosen.length }));
  if (state.cuts === before) return false;   // 沒套成（例如會把整支剪掉）
  state.p.suggestions.items = aiItems().filter((x) => !aiChecked.has(x.id));
  aiChecked.clear();
  changed();
  renderAi(state.p);
  return true;
}
$("#aiApply").onclick = () => applyAi();
// 全自動：套用勾選的，接著直接剪接＋燒字幕
$("#aiApplyRender").onclick = async () => {
  if (!applyAi()) return;
  await openBurn();
  burnKind = "burn";
  renderOutKind();
  $("#burnStart").click();
};
$("#aiDismiss").onclick = () => {
  state.p.suggestions.items = [];
  aiChecked.clear();
  changed();
  renderAi(state.p);
};
