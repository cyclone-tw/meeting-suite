"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：長片切直式短片（#54）。片段的對齊與微調用 lib/shorts.mjs（和伺服器同一份）。

const shDlg = $("#shortsDlg");
const shVideo = $("#shVideo");
const sh = { items: [], sel: "", job: null, ver: 0, saveTimer: 0, saving: null, poll: 0, aiBusy: false, playEnd: -1, raf: 0 };

async function openShorts() {
  await flushSave();
  if (dlg.open) dlg.close();
  setStep(5);
  const src = `/api/projects/${state.id}/video?t=${TOKEN}`;
  if (shVideo.getAttribute("src") !== src) shVideo.src = src;
  try { shVideo.currentTime = video.currentTime || 0; } catch { /* 還沒載入就從頭 */ }
  sh.items = [];
  sh.sel = "";
  shDlg.showModal();
  await refreshShorts(true);
}

// 讀最新的專案：片段清單（沒有還沒存的修改時才換掉）、正在跑的工作
async function refreshShorts(force = false) {
  clearTimeout(sh.poll);
  if (!shDlg.open) return;
  let p;
  try { p = await api(`/api/projects/${state.id}`); } catch (e) { showAlert(e.message); return; }
  state.p = { ...state.p, shorts: p.shorts, job: p.job };
  sh.job = p.job;
  if (force || (!sh.saveTimer && !sh.saving)) sh.items = p.shorts?.items || [];
  const lost = !sh.items.some((x) => x.id === sh.sel);
  if (lost) sh.sel = sh.items[0]?.id || "";
  renderShorts();
  if ((force || lost) && sh.sel) shSelect(sh.sel);   // 預覽跳到選到那段的開頭
  if (p.job?.kind === "short" || (p.job?.kind === "shorts" && !sh.aiBusy)) sh.poll = setTimeout(() => refreshShorts(), 1000);
}

const shCuts = () => cutOps.normalizeCuts(state.cuts);
const shLen = (x) => shortOps.shortLength(x, state.cuts);
const secText = (ms) => _("{n} 秒", { n: Math.round(ms / 1000) });

function renderShorts() {
  const busy = Boolean(sh.job) || sh.aiBusy;
  const aiRunning = sh.aiBusy || sh.job?.kind === "shorts";   // 重新整理後，AI 還在別的請求裡挑
  const exporting = sh.job?.kind === "short" ? sh.job.short : "";
  $("#shEmpty").hidden = sh.items.length > 0 || aiRunning;
  $("#shBusy").hidden = !aiRunning;
  $("#shList").hidden = aiRunning;
  $("#shAi").disabled = busy;
  $("#shAdd").disabled = aiRunning || sh.items.length >= shortOps.MAX_ITEMS;
  $("#shAi").textContent = sh.items.length ? _("請 AI 重新挑") : _("請 AI 挑精華");
  $("#shList").innerHTML = sh.items.map((x) => {
    const len = shLen(x), cutIn = shortOps.shortKeep(x, state.cuts).length > 1;
    const out = x.output;
    let status;
    if (exporting === x.id) {
      const pct = Math.round((sh.job.progress || 0) * 100);
      status = `<progress max="1" value="${sh.job.progress || 0}"></progress><span>${_("輸出中 {pct}%", { pct })}</span><button class="btn sm" data-a="stop">${_("停止")}</button>`;
    } else {
      const parts = [];
      if (out && out.fresh) parts.push(`<span class="ok">${_("已輸出「{file}」", { file: esc(out.file) })}</span>`);
      else if (out) parts.push(`<span class="stale">${_("片段或字幕改過了，要重新輸出才會更新")}</span>`);
      else if (x.export?.status === "failed") parts.push(`<span class="err">${_("沒輸出成功：{msg}", { msg: esc(I18N.msg(x.export.error || "")) })}</span>`);
      else if (x.export?.status === "cancelled") parts.push(`<span class="muted">${_("已停止")}</span>`);
      const again = out || x.export?.status === "failed";
      parts.push(`<button class="btn sm${out?.fresh ? "" : " solid"}" data-a="export"${busy ? " disabled" : ""}>${again ? _("重新輸出") : _("輸出這段")}</button>`);
      if (out) parts.push(`<button class="btn sm ghost" data-a="reveal"><svg class="icon"><use href="#i-folder"/></svg>${_("在 Finder 顯示")}</button>`);
      status = parts.join("");
    }
    const why = x.by === "ai" && x.reason ? ` · <span class="why">${_("AI：{reason}", { reason: esc(x.reason) })}</span>` : "";
    const long = len > shortOps.AI_TARGET_MAX_MS ? _("（短片通常 90 秒內比較好看）") : "";
    return `<li class="sh-item${x.id === sh.sel ? " sel" : ""}" data-id="${esc(x.id)}">
  <div class="sh-row1"><span class="sh-n">${String(x.n).padStart(2, "0")}</span><input class="text-in" data-a="title" maxlength="${shortOps.TITLE_MAX}" value="${esc(x.title)}" placeholder="${_("短片標題（會放在畫面上方）")}" aria-label="${_("短片標題")}"><button class="btn sm" data-a="play" title="${_("從頭播到尾")}"><svg class="icon"><use href="#i-play"/></svg>${_("播放")}</button></div>
  <div class="sh-meta">${fmtClock(x.start)}–${fmtClock(x.end)} · <b>${secText(len)}</b>${cutIn ? _("（含剪輯）") : ""}${long}${why}</div>
  <div class="sh-edges"><span class="grp"><span class="lbl">${_("開頭")}</span><button class="btn sm" data-a="start" data-d="-1">${_("早一句")}</button><button class="btn sm" data-a="start" data-d="1">${_("晚一句")}</button></span><span class="grp"><span class="lbl">${_("結尾")}</span><button class="btn sm" data-a="end" data-d="-1">${_("早一句")}</button><button class="btn sm" data-a="end" data-d="1">${_("晚一句")}</button></span><button class="btn sm ghost sh-del" data-a="del">${_("刪掉")}</button></div>
  <div class="sh-out">${status}</div>
</li>`;
  }).join("");
  renderShortPreview();
}

// 預覽框：照輸出的版面放影片、標題、字幕（版面依影片長寬比，和輸出同一套計算）
function renderShortPreview() {
  const x = sh.items.find((y) => y.id === sh.sel);
  const L = shortOps.shortLayout(shVideo.videoWidth, shVideo.videoHeight);
  const pct = (v, total) => `${(v / total) * 100}%`;
  Object.assign(shVideo.style, { left: pct(L.x, shortOps.W), width: pct(L.vw, shortOps.W), top: pct(L.top, shortOps.H), height: pct(L.vh, shortOps.H) });
  const place = (el, at) => {
    el.style.top = at.align === 8 ? pct(at.marginV, shortOps.H) : "";
    el.style.bottom = at.align === 2 ? pct(at.marginV, shortOps.H) : "";
  };
  place($("#shPrevTitle"), L.title);
  place($("#shPrevSub"), L.sub);
  $("#shPrevTitle").textContent = x?.title || "";
  shSubAt(shVideo.currentTime * 1000);
}
function shSubAt(ms) {
  const x = sh.items.find((y) => y.id === sh.sel);
  const i = ops.cueIndexAt(state.cues, ms);
  $("#shPrevSub").textContent = x && i >= 0 && ms >= x.start && ms < x.end ? state.cues[i].text : "";
}

// 播放：剪掉的地方跳過，播到片段結尾就停
function shTick() {
  cancelAnimationFrame(sh.raf);
  if (shVideo.paused) return;
  const ms = shVideo.currentTime * 1000;
  const cut = cutOps.cutAt(shCuts(), ms);
  if (cut) shVideo.currentTime = cut.end / 1000;
  if (sh.playEnd >= 0 && ms >= sh.playEnd) { shVideo.pause(); sh.playEnd = -1; }
  shSubAt(ms);
  sh.raf = requestAnimationFrame(shTick);
}
shVideo.addEventListener("play", shTick);
shVideo.addEventListener("seeked", () => shSubAt(shVideo.currentTime * 1000));
shVideo.addEventListener("loadedmetadata", () => renderShortPreview());

function shSelect(id, seek = true) {
  sh.sel = id;
  const x = sh.items.find((y) => y.id === id);
  for (const li of document.querySelectorAll("#shList .sh-item")) li.classList.toggle("sel", li.dataset.id === id);
  if (x && seek) { shVideo.pause(); shVideo.currentTime = x.start / 1000; }
  renderShortPreview();
}

// 存片段清單：不動字幕版本（rev）。改標題時不重畫清單，免得打字打到一半游標跑掉
function shChanged({ redraw = true } = {}) {
  sh.ver += 1;
  clearTimeout(sh.saveTimer);
  sh.saveTimer = setTimeout(() => saveShorts(), 600);
  if (redraw) renderShorts();
}
async function saveShorts() {
  clearTimeout(sh.saveTimer);
  sh.saveTimer = 0;
  if (sh.saving) await sh.saving;
  const ver = sh.ver, id = state.id;
  const items = sh.items.map(({ id: sid, n, title, reason, start, end, by }) => ({ id: sid, n, title, reason, start, end, by }));
  sh.saving = api(`/api/projects/${id}/shorts`, { method: "PUT", body: JSON.stringify({ items }) })
    .then((r) => {
      if (id !== state.id) return;
      if (state.p) state.p.shorts = r.shorts;   // 帶回用過的最大序號（max_n）
      if (ver !== sh.ver) return;
      // 伺服器重新對齊過句子、帶上輸出紀錄；標題正在打的那一格保留畫面上的字
      const typing = document.activeElement?.dataset?.a === "title";
      sh.items = r.shorts?.items || [];
      if (!typing) renderShorts();
    })
    .catch((e) => showAlert(_("片段沒存成功：{msg}", { msg: e.message })))
    .finally(() => { sh.saving = null; });
  await sh.saving;
}

$("#shList").addEventListener("input", (e) => {
  if (e.target.dataset.a !== "title") return;
  const x = sh.items.find((y) => y.id === e.target.closest(".sh-item").dataset.id);
  if (!x) return;
  x.title = e.target.value;
  if (x.id === sh.sel) $("#shPrevTitle").textContent = x.title;
  shChanged({ redraw: false });
});
$("#shList").addEventListener("focusin", (e) => {
  const li = e.target.closest(".sh-item");
  if (li && li.dataset.id !== sh.sel) shSelect(li.dataset.id);
});
$("#shList").addEventListener("click", async (e) => {
  const li = e.target.closest(".sh-item");
  if (!li) return;
  const b = e.target.closest("button[data-a]");
  const x = sh.items.find((y) => y.id === li.dataset.id);
  if (!x) return;
  if (!b) { if (li.dataset.id !== sh.sel) shSelect(li.dataset.id); return; }
  const a = b.dataset.a;
  if (a === "play") {
    shSelect(x.id, false);
    sh.playEnd = x.end;
    shVideo.currentTime = x.start / 1000;
    shVideo.play().catch(() => {});
  } else if (a === "start" || a === "end") {
    const next = shortOps.moveEdge(x, a, Number(b.dataset.d), state.cues, state.cuts);
    if (!next) { showAlert(a === "start" ? _("開頭沒辦法再移了（已經是第一句，或會變得太短）。") : _("結尾沒辦法再移了（已經是最後一句，或會變得太短）。")); return; }
    Object.assign(x, next);
    sh.sel = x.id;
    shChanged();
    shVideo.pause();
    shVideo.currentTime = (a === "start" ? x.start : Math.max(x.start, x.end - 3000)) / 1000;
  } else if (a === "del") {
    sh.items = sh.items.filter((y) => y.id !== x.id);
    if (sh.sel === x.id) sh.sel = sh.items[0]?.id || "";
    shChanged();
    if (x.output) toast(_("已經輸出的「{file}」還留在資料夾裡。", { file: esc(x.output.file) }));
  } else if (a === "export") {
    await saveShorts();
    try { await post(`/api/projects/${state.id}/shorts/${x.id}/export`); } catch (e2) { showAlert(e2.message); return; }
    setTimeout(() => refreshShorts(), 300);
  } else if (a === "stop") {
    try { await post(`/api/projects/${state.id}/cancel`); } catch (e2) { showAlert(e2.message); }
    setTimeout(() => refreshShorts(), 500);
  } else if (a === "reveal") {
    post(`/api/projects/${state.id}/shorts/${x.id}/reveal`).catch((e2) => showAlert(e2.message));
  }
});

$("#shAdd").onclick = () => {
  const r = shortOps.rangeFrom(shVideo.currentTime * 1000, state.cues, state.cuts);
  if (!r) { showAlert(_("這個位置之後沒有字幕了，請先在影片上往前找一個地方。")); return; }
  const n = Math.max(shortOps.nextN(sh.items), (state.p?.shorts?.max_n || 0) + 1);   // 伺服器存檔時會再確認
  const x = { id: `u${Date.now().toString(36)}`, n, title: "", reason: "", by: "user", ...r };
  sh.items = [...sh.items, x].sort((p, q) => p.start - q.start);
  shChanged();
  shSelect(x.id);
  document.querySelector(`#shList .sh-item[data-id="${x.id}"] [data-a="title"]`)?.focus();
};

async function runShortsAi() {
  await saveShorts();
  sh.aiBusy = true;
  renderShorts();
  try {
    const r = await post(`/api/projects/${state.id}/shorts/suggest`);
    sh.items = r.shorts?.items || [];
    sh.sel = sh.items.find((x) => x.by === "ai" && !x.output)?.id || sh.items[0]?.id || "";
    if (sh.sel) shSelect(sh.sel);
    if (r.added) toast(_("AI 挑了 {n} 段。可以先播放看看，改標題、調整開頭結尾，滿意了再輸出。", { n: r.added }));
  } catch (e) {
    if (e.status !== 409 || !/停止|stop/i.test(e.message)) showAlert(e.message);   // 不翻：比對伺服器的訊息（英文模式下已換成英文）
  } finally {
    sh.aiBusy = false;
    await refreshShorts(true);
  }
}
$("#shAi").onclick = () => {
  const replace = sh.items.filter((x) => !x.output).length;
  if (!replace) { runShortsAi(); return; }
  toast(_("還沒輸出的 {n} 段會換成 AI 新挑的；已經輸出的會留著。", { n: replace }), [{ label: _("重新挑"), solid: true, run: runShortsAi }, { label: _("先不要") }], 0);
};
$("#shStop").onclick = () => post(`/api/projects/${state.id}/cancel`).catch((e) => showAlert(e.message));
$("#shortsOpen").onclick = openShorts;
$("#shClose").onclick = () => shDlg.close();
shDlg.addEventListener("close", () => {
  clearTimeout(sh.poll);
  shVideo.pause();
  if (sh.saveTimer) saveShorts();
  setStep(4);
});
