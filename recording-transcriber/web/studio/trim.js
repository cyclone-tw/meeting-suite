"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：預覽與粗剪。

// ---- 預覽與粗剪（recording-transcriber#4）：還沒建專案，只在瀏覽器裡記剪輯區段 ----
const trim = { info: null, cuts: [], undo: [], selIn: null, selOut: null, picked: -1, ac: null };
const pvideo = $("#pvideo");
const tl = makeTimeline($("#tl"), {
  seek: (ms) => { trim.picked = -1; pSeek(ms); renderTrim(); },
  select: (sel) => { [trim.selIn, trim.selOut] = sel; trim.picked = -1; pSeek(sel[0]); renderTrim(); },
  pickCut: (i) => { trim.picked = i; trim.selIn = trim.selOut = null; renderTrim(); },
});
const pNow = () => pvideo.currentTime * 1000;
const tDur = () => trim.info?.duration_ms || (pvideo.duration || 0) * 1000;
const fmtLen = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)} 小時 ${Math.floor(s / 60) % 60} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`; };

// 還在 iCloud 的影片：伺服器先請 iCloud 下載，這裡每 2 秒再問一次，下載好就進預覽（#20）
async function openTrim(videoPath) {
  const run = ++dlRun, began = Date.now();
  let info;
  for (;;) {
    try { info = await post("/api/preview", { video: videoPath }); } catch (e) { if (run === dlRun) { $("#toast").hidden = true; showAlert(e.message); } return; }
    if (run !== dlRun) return;   // 下載中又點了別支，或按了取消
    if (!info.downloading) break;
    const waited = Math.round((Date.now() - began) / 1000);
    const pct = info.progress > 0 ? `${Math.round(info.progress * 100)}%` : `已等 ${waited} 秒`;
    const slow = waited >= 180 ? "<br>一直沒動的話，可以在 Finder 對這個檔案按右鍵，選「立即下載」。" : "";
    toast(`「${esc(info.name)}」還在 iCloud，正在下載到這台電腦（${fmtSize(info.size)}，${pct}）…${slow}`, [{ label: "取消", run: () => { dlRun += 1; } }], 0);
    await new Promise((x) => setTimeout(x, 2000));
    if (run !== dlRun) return;
  }
  if ($("#toast").textContent.includes("正在下載到這台電腦")) $("#toast").hidden = true;
  leaveTrim();
  trim.ac = new AbortController();
  Object.assign(trim, { info, cuts: [], undo: [], selIn: null, selOut: null, picked: -1 });
  setView("trim");
  setStep(2);
  $("#projName").textContent = info.name;
  $("#tName").textContent = info.name;
  $("#langSel").value = "zh";   // 每支影片預設中文；外語要自己選（#56）
  $("#langHint").hidden = true;
  trkShow(info.craig);   // 下載資料夾裡錄音時間對得上的 Discord 分軌（#129）
  $("#tMeta").textContent = `${fmtLen(info.duration_ms)} · ${fmtSize(info.size)}${info.playable ? "" : " · 這種格式要先轉成瀏覽器能播的版本，第一次打開會慢一點"}`;
  // 已經做過字幕的影片：這裡只能看；要剪輯到專案的編輯頁剪（#5）
  $("#tExisting").hidden = !info.project;
  $("#tExistingText").textContent = { failed: "這支影片上次處理到一半失敗了，打開後按「重試」。", cancelled: "這支影片上次處理到一半停止了，打開後按「重新開始」。", processing: "這支影片正在處理中。" }[info.project_status] || "這支影片之前做過字幕，不用重新辨識。";
  $("#tStartBox").hidden = !!info.project;
  for (const id of ["#cutTools", "#trimKeys", "#tlHint"]) $(id).hidden = !!info.project;
  $("#tlEnd").textContent = ops.fmtTime(info.duration_ms);
  pvideo.src = `/api/preview/${info.id}/video?t=${TOKEN}`;
  tl.reset(info.duration_ms);
  $("#zoomLabel").textContent = "整支";
  renderTrim();
  loadTiles(info.id, trim.ac.signal);
  api(`/api/preview/${info.id}/wave`).then((w) => {
    if (trim.info?.id !== info.id) return;
    tl.setWave({ bucket_ms: w.bucket_ms, peaks: Uint8Array.from(atob(w.peaks), (c) => c.charCodeAt(0)) });
  }).catch(() => tl.setWave({ bucket_ms: 0, peaks: new Uint8Array(0) }));
}

const loadTiles = (id, signal) => streamTiles(`/api/preview/${id}/thumbs`, signal, (tile) => tl.addTile(tile));

function leaveTrim() {
  trim.ac?.abort();
  trim.ac = null;
  pvideo.pause();
  if (pvideo.getAttribute("src")) { pvideo.removeAttribute("src"); pvideo.load(); }
  trim.info = null;
}

function setCuts(next) {
  trim.undo.push(trim.cuts);
  if (trim.undo.length > 200) trim.undo.shift();
  trim.cuts = cutOps.normalizeCuts(next, tDur());
  trim.selIn = trim.selOut = null;
  trim.picked = -1;
  renderTrim();
}
const trimSel = () => (trim.selIn !== null && trim.selOut !== null && trim.selOut > trim.selIn ? [trim.selIn, trim.selOut] : null);

function renderTrim() {
  const sel = trimSel(), dur = tDur();
  tl.setCuts(trim.cuts, trim.picked);
  tl.setSel(sel, sel ? null : trim.selIn ?? trim.selOut);
  $("#cutSel").disabled = !sel;
  $("#cutSel").textContent = sel ? `剪掉選取的範圍（${fmtLen(sel[1] - sel[0])}）` : "剪掉選取的範圍";
  $("#tUndo").disabled = !trim.undo.length;
  const c = trim.cuts[trim.picked];
  $("#cutNote").hidden = !c;
  if (c) $("#cutNote").innerHTML = `剪掉的區段 ${ops.fmtTime(c.start, true)}–${ops.fmtTime(c.end, true)}（${fmtLen(c.end - c.start)}）${c.reason ? `：${esc(c.reason)}` : ""} <button class="btn sm" data-restore>恢復這段</button><button class="btn sm" data-try>從前面 3 秒試播</button>`;
  const keep = cutOps.keepSegments(trim.cuts, dur), kept = cutOps.keptDuration(keep);
  const removed = dur - kept;
  $("#tSum").innerHTML = trim.cuts.length
    ? `原片 ${fmtLen(dur)} → 剪完 <b>${fmtLen(kept)}</b><br><span class="muted">剪掉 ${trim.cuts.length} 段，共 ${fmtLen(removed)}；剪掉的部分不會送去辨識</span>`
    : `原片 <b>${fmtLen(dur)}</b><br><span class="muted">還沒剪。不剪也可以直接開始，之後在編輯頁也能剪。</span>`;
  $("#cutList").innerHTML = trim.cuts.map((x, i) => `<li><button class="t" data-pick="${i}">${ops.fmtTime(x.start)}–${ops.fmtTime(x.end)}</button><span class="why">${fmtLen(x.end - x.start)}${x.reason ? ` · ${esc(x.reason)}` : ""}</span><button class="btn sm ghost" data-unc="${i}">恢復</button></li>`).join("");
  $("#costHint").textContent = kept > 0 ? `辨識約 NT$${Math.max(0.1, (kept / 3600000) * 3).toFixed(1)}（Soniox，每小時約 NT$3），${$("#langSel").value === "zh" ? "校對" : "翻譯"}走 Claude 訂閱。` : "整支都剪掉了，至少要留一段。";
  refreshStart();
}

function pSeek(ms) { pvideo.currentTime = Math.max(0, Math.min(tDur(), ms) / 1000); pTick(); }
function pTick() {
  const ms = pNow();
  $("#pTime").textContent = `${ops.fmtTime(ms, true)} / ${ops.fmtTime(tDur())}`;
  tl.setNow(ms, !pvideo.paused);
}
// 播放時跳過剪掉的部分：直接預覽剪完的樣子
function pLoop() {
  if (pvideo.paused || !trim.info) return;
  const c = $("#pSkip").checked && cutOps.cutAt(trim.cuts, pNow());
  if (c) {
    if (c.end >= tDur() - 50) { pvideo.pause(); pSeek(c.start); } else pvideo.currentTime = c.end / 1000;
  }
  pTick();
  requestAnimationFrame(pLoop);
}
pvideo.addEventListener("play", () => { setPPlay(); pLoop(); });
pvideo.addEventListener("pause", () => { setPPlay(); pTick(); });
pvideo.addEventListener("seeked", pTick);
pvideo.addEventListener("loadedmetadata", () => { fitPStage(); pTick(); });
pvideo.addEventListener("error", () => { if (trim.info && !$("#trim").hidden) showAlert("這支影片播不了：可能被移動、刪除，或格式瀏覽器不支援。"); });
function setPPlay() {
  $("#pPlay").innerHTML = `<svg class="icon"><use href="#i-${pvideo.paused ? "play" : "pause"}"/></svg>`;
  $("#pPlay").setAttribute("aria-label", pvideo.paused ? "播放" : "暫停");
}
function fitPStage() {
  const w = pvideo.videoWidth || 16, h = pvideo.videoHeight || 9, wrap = $("#pStageWrap");
  const maxW = wrap.clientWidth, maxH = Math.max(200, window.innerHeight * (window.innerWidth < 1000 ? 0.42 : 0.48));
  let W = maxW, H = (maxW * h) / w;
  if (H > maxH) { H = maxH; W = (maxH * w) / h; }
  Object.assign($("#pStage").style, { width: `${W}px`, height: `${H}px` });
}
new ResizeObserver(fitPStage).observe($("#pStageWrap"));
const pToggle = () => (pvideo.paused ? pvideo.play() : pvideo.pause());
$("#pPlay").onclick = pToggle;
$("#pBack").onclick = () => pSeek(pNow() - 1000);
$("#pFwd").onclick = () => pSeek(pNow() + 1000);
const markIn = () => { trim.selIn = pNow(); if (trim.selOut !== null && trim.selOut <= trim.selIn) trim.selOut = null; trim.picked = -1; renderTrim(); };
const markOut = () => { trim.selOut = pNow(); if (trim.selIn !== null && trim.selIn >= trim.selOut) trim.selIn = null; trim.picked = -1; renderTrim(); };
const cutSelection = () => { const sel = trimSel(); if (sel) setCuts([...trim.cuts, { start: sel[0], end: sel[1], by: "user" }]); };
const trimUndo = () => { if (!trim.undo.length) return; trim.cuts = trim.undo.pop(); trim.picked = -1; renderTrim(); };
$("#markIn").onclick = markIn;
$("#markOut").onclick = markOut;
$("#cutSel").onclick = cutSelection;
$("#cutHead").onclick = () => { if (pNow() > 0) setCuts([...trim.cuts, { start: 0, end: pNow(), by: "user" }]); };
$("#cutTail").onclick = () => { if (pNow() < tDur()) setCuts([...trim.cuts, { start: pNow(), end: tDur(), by: "user" }]); };
$("#tUndo").onclick = trimUndo;
// 粗剪時先把長時間的靜音剪掉（本機偵測，#6）：直接套用，可以復原，也可以點紅色區段個別恢復
$("#cutSilence").onclick = async () => {
  const id = trim.info?.id;
  if (!id) return;
  const b = $("#cutSilence");
  b.disabled = true;
  b.textContent = "找靜音中…";
  try {
    const r = await api(`/api/preview/${id}/silence`);
    if (trim.info?.id !== id) return;
    const fresh = r.items.filter((x) => cutOps.cutShare(trim.cuts, x.start, x.end) < 0.9);
    if (!fresh.length) { toast("沒有找到超過 2 秒的靜音。", [], 4000); return; }
    setCuts([...trim.cuts, ...fresh.map((x) => ({ start: x.start, end: x.end, by: "ai", reason: x.reason }))]);
    toast(`剪掉了 ${fresh.length} 段靜音（共 ${fmtLen(fresh.reduce((n, x) => n + x.end - x.start, 0))}）。點紅色區段可以個別恢復。`, [{ label: "復原", run: trimUndo }], 9000);
  } catch (e) { showAlert(`找靜音失敗：${e.message}`); } finally { b.disabled = false; b.textContent = "剪掉長時間的靜音"; }
};
$("#zoomIn").onclick = () => { const z = tl.zoom(1); $("#zoomLabel").textContent = z === 1 ? "整支" : `×${z}`; };
$("#zoomOut").onclick = () => { const z = tl.zoom(-1); $("#zoomLabel").textContent = z === 1 ? "整支" : `×${z}`; };
$("#cutNote").onclick = (e) => {
  const c = trim.cuts[trim.picked];
  if (!c) return;
  if (e.target.closest("[data-restore]")) setCuts(trim.cuts.filter((_, i) => i !== trim.picked));
  if (e.target.closest("[data-try]")) { pSeek(Math.max(0, c.start - 3000)); pvideo.play(); }
};
$("#cutList").onclick = (e) => {
  const p = e.target.closest("[data-pick]"), u = e.target.closest("[data-unc]");
  if (p) { trim.picked = Number(p.dataset.pick); trim.selIn = trim.selOut = null; pSeek(trim.cuts[trim.picked].start); renderTrim(); }
  if (u) setCuts(trim.cuts.filter((_, i) => i !== Number(u.dataset.unc)));
};
$("#tOpenExisting").onclick = () => { const id = trim.info?.project; if (id) { leaveTrim(); openProject(id); } };
document.addEventListener("keydown", (e) => {
  if ($("#trim").hidden || document.querySelector("dialog[open]") || e.isComposing || e.keyCode === 229) return;
  if (trim.info?.project && !["Space", "ArrowLeft", "ArrowRight"].includes(e.code)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping(e)) { e.preventDefault(); trimUndo(); return; }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === "Enter" || e.code === "Space") && e.target.closest?.("button, a, summary, select, input")) return;
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); pToggle(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); pSeek(pNow() - (e.shiftKey ? 5000 : 1000)); }
  else if (e.key === "ArrowRight") { e.preventDefault(); pSeek(pNow() + (e.shiftKey ? 5000 : 1000)); }
  else if (k === "i") markIn();
  else if (k === "o") markOut();
  else if (k === "x" || e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); cutSelection(); }
  else if (e.key === "Escape") { trim.selIn = trim.selOut = null; trim.picked = -1; renderTrim(); }
});
