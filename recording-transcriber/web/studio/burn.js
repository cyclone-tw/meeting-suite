"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：燒字幕與剪輯輸出。

// ---- 燒字幕 ----
const dlg = $("#burnDlg");
let burnPoll = 0;
async function openBurn() {
  await flushSave();
  setStep(5);
  if (!dlg.open) dlg.showModal();
  for (const b of document.querySelectorAll("#sizeSeg button")) b.setAttribute("aria-pressed", String(b.dataset.z === state.size));
  for (const b of document.querySelectorAll("#styleSeg button")) b.setAttribute("aria-pressed", String(b.dataset.s === state.style));
  renderLangSeg();
  $("#assExport").hidden = !state.foreign;
  renderOutKind();
  refreshBurn();
}
async function refreshBurn() {
  clearTimeout(burnPoll);
  let p;
  try { p = await api(`/api/projects/${state.id}`); } catch (e) { $("#burnMsg").hidden = false; $("#burnMsg").textContent = e.message; return; }
  const b = p.burn || {}, running = p.job?.kind === "burn";
  $("#burnSetup").hidden = running;
  $("#burnRun").hidden = !running;
  $("#burnStart").hidden = running || Boolean($("#burnStart").dataset.plain);
  $("#burnCancel").hidden = !running;
  $("#revealBurn").hidden = !b.output || running;
  // 字幕改過，或燒的時候是另一種樣式（#55 之前燒的都是白字黑邊）
  // 外語影片（#56）燒的時候是另一種顯示方式（中文／原文／雙語）也算過期
  $("#burnStale").hidden = !(b.output && b.rev !== undefined && (b.rev !== state.rev || (b.subtitles !== false && ((b.style || "outline") !== state.style
    || (state.foreign && (b.lang_mode || "both") !== state.langMode)))));
  $("#burnMsg").hidden = running || !b.status;
  if (running && b.subtitles !== undefined) { burnKind = b.subtitles === false ? "cut" : "burn"; renderOutKind(); }   // 重新整理後對上正在跑的那一種
  if (running) {
    const x = p.job.progress || 0, secs = (Date.now() - p.job.started) / 1000;
    $("#burnBar").value = x;
    $("#burnPct").textContent = _("{pct}%{eta}　燒的時候可以繼續改字，但要燒完再燒一次才會更新。", { pct: Math.round(x * 100), eta: x > 0.03 ? _("，大約還要 {n} 秒", { n: Math.max(1, Math.round((secs / x - secs) / 6) * 6) }) : "" });
    burnPoll = setTimeout(refreshBurn, 1000);
    return;
  }
  const msg = { done: _("燒好了（花了 {n} 秒）。", { n: b.seconds || "?" }), failed: _("沒燒成功：{msg}", { msg: I18N.msg(b.error || "") }), cancelled: _("已停止。") }[b.status] || "";
  $("#burnMsg").textContent = msg;
  $("#burnMsg").style.color = b.status === "failed" ? "var(--warn)" : "";
  $("#burnStart").textContent = b.output ? _("重新輸出一次") : burnKind === "cut" ? _("開始輸出") : _("開始燒字幕");
}
$("#burnOpen").onclick = openBurn;
$("#sizeSeg").onclick = (e) => {
  const b = e.target.closest("button[data-z]");
  if (!b) return;
  state.size = b.dataset.z;
  document.documentElement.style.setProperty("--fs", SIZE_PX[state.size]);
  for (const x of document.querySelectorAll("#sizeSeg button")) x.setAttribute("aria-pressed", String(x === b));
  changed();
};
// 字幕樣式（#55）：圓角底框或白字黑邊，預覽跟著換，存進專案
$("#styleSeg").onclick = (e) => {
  const b = e.target.closest("button[data-s]");
  if (!b) return;
  state.style = b.dataset.s;
  $("#overlay").classList.toggle("box", state.style === "box");
  for (const x of document.querySelectorAll("#styleSeg button")) x.setAttribute("aria-pressed", String(x === b));
  changed();
};
// 輸出哪一種：剪接＋燒字幕，或只剪接（字幕另外用 SRT 上傳，#5）
let burnKind = "burn";
function renderOutKind() {
  for (const b of document.querySelectorAll("#outSeg button")) b.setAttribute("aria-pressed", String(b.dataset.o === burnKind));
  const kept = cutOps.keptDuration(cutOps.keepSegments(pCuts(), state.p.duration_ms || 0));
  const file = burnKind === "cut" ? `${state.p.name}-剪輯.mp4` : `${state.p.name}-字幕.mp4`;   // 不翻：實際的檔名
  const folder = `${state.p.name}-字幕`;   // 不翻：實際的資料夾名稱
  const plain = burnKind === "cut" && !pCuts().length;   // 沒剪輯又不燒字幕：原片就是成品（#39）
  $("#burnWhere").textContent = plain
    ? _("沒有剪輯，原始影片就是不燒字幕的版本，不用另外輸出。字幕檔（SRT）已經存在影片旁邊的「{folder}」資料夾，上傳 YouTube 時當 CC 字幕，觀眾可以自己開關。", { folder })
    : _("會存成「{file}」，放在影片旁邊的「{folder}」資料夾。SRT 和說明欄已經自動存在同一個資料夾。", { file, folder }) +
      (burnKind === "cut" ? _("字幕不燒進畫面，上傳 YouTube 時另外附上 SRT 當 CC 字幕，觀眾可以自己開關。") : "") +
      (pCuts().length ? _("會剪掉 {n} 段，剪完長 {len}；SRT 和說明欄的章節時間已經換算成剪完的時間。", { n: pCuts().length, len: fmtLen(kept) }) : "");
  $("#burnStart").dataset.plain = plain ? "1" : "";
  if (!$("#burnRun").hidden) return;
  $("#burnStart").hidden = plain;
  $("#sizeSeg").hidden = burnKind === "cut";
  $("#styleSeg").hidden = burnKind === "cut";
  $("#burnLangSeg").hidden = burnKind === "cut" || !state.foreign;
  $("#styleSeg").previousElementSibling.hidden = burnKind === "cut";
  $("#burnTitle").textContent = burnKind === "cut" ? _("輸出不燒字幕的影片") : _("把字幕燒進影片");
}
$("#burnLangSeg").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) setLangMode(b.dataset.m); };
// 雙語 ASS 字幕檔（#56）：給播放器外掛字幕用，存在專案資料夾
$("#assExport").onclick = async () => {
  await flushSave();
  try {
    const r = await post(`/api/projects/${state.id}/subtitle-file`);
    toast(_("已匯出「{file}」，在 Finder 打開了。用 IINA 或 VLC 播影片時把它拖進去，就有雙語字幕。", { file: esc(r.file) }), [], 8000);
  } catch (e) { showAlert(e.message); }
};
$("#outSeg").onclick = (e) => {
  const b = e.target.closest("button[data-o]");
  if (!b) return;
  burnKind = b.dataset.o;
  renderOutKind();
};
$("#burnStart").onclick = async () => {
  await flushSave();
  try { await post(`/api/projects/${state.id}/burn`, burnKind === "cut" ? { subtitles: false } : {}); } catch (e) { showAlert(e.message); return; }
  setTimeout(refreshBurn, 300);
};
$("#burnCancel").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } setTimeout(refreshBurn, 500); };
$("#burnClose").onclick = () => { dlg.close(); };
dlg.addEventListener("close", () => { clearTimeout(burnPoll); if (!$("#shortsDlg").open) setStep(4); });   // 換到直式短片時留在第 5 步
$("#revealSrt").onclick = () => post(`/api/projects/${state.id}/reveal`, { what: "srt" }).catch((e) => showAlert(e.message));
$("#revealBurn").onclick = () => post(`/api/projects/${state.id}/reveal`, { what: "burned" }).catch((e) => showAlert(e.message));
