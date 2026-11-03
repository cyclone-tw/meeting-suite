"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：會後總結（#80）。和會議轉錄 App 一樣的簡介＋分段章節、完整總結、短總結、逐字稿，
// 由會議轉錄 App 產生（同一份提示詞），伺服器另外存成資料夾裡的 summary.md。
// 下方「延伸」（#88）：會議轉錄 App 的延伸模組（讓會議發芽、視角回饋…），清單由 App 提供。

let recapView = "intro", recapBusyId = "";
const RECAP_VIEWS = ["intro", "full", "short", "transcript"];
const recapHms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
// 逐字稿用畫面上的字幕：剪輯後的時間（和上傳 YouTube 的影片一致），被剪掉的句子不列
function recapCuesNow() {
  const cues = (state.cues || []).filter((c) => c.text.trim());
  return state.cuts?.length ? cutOps.remapCues(cues, state.cuts) : cues;
}
const recapTranscriptText = () => recapCuesNow().map((c) => `[${recapHms(c.start)}] ${c.text.trim()}`).join("\n");
function recapIntroText(r) {
  const ch = r.chapters || [];
  return r.intro + (ch.length ? `\n\n[ 分段章節 ]\n${ch.map((c) => `${recapHms(c.t_ms)} ${c.title}`).join("\n")}` : "");   // 不翻：複製出去的總結內容（資料）
}
function recapViewText(v) {
  const r = state.p?.recap;
  if (v === "transcript") return recapTranscriptText();
  if (!r) return "";
  return v === "intro" ? recapIntroText(r) : v === "full" ? r.full : r.short;
}
// 和 App 的「複製全部」一樣：四段依序，完整總結的標題降一級
// 「複製全部」和存檔的 summary.md 一樣：格式是會議轉錄 App 的共用元件 RecapFiles（#116）
function recapAllText() {
  const r = state.p?.recap, rf = window.RecapFiles;
  if (!r) return "";
  if (!rf?.summaryMarkdown) return [recapIntroText(r), r.full, r.short, recapTranscriptText()].join("\n\n");   // 沒有元件：至少把內容都給
  return rf.summaryMarkdown({ header: rf.headerLines({ name: state.p.name }), intro: r.intro, chapters: r.chapters || [], full: r.full, short: r.short, transcript: recapTranscriptText() });
}

// 在哪裡產生的（#83）：先在這台，失敗才由主機產生
const recapWhere = (r) => (r.via === "local" ? _("在這台 Mac 產生") : r.via === "app" ? (r.local_error ? _("由主機產生（這台沒成功：{err}）", { err: I18N.msg(r.local_error) }) : _("由主機產生")) : "");
const recapHow = (r) => recapWhere(r) || _("產生");

function renderRecap() {
  const r = state.p?.recap, on = Boolean(recapBusyId) && recapBusyId === state.id;
  $("#tabRecap").dataset.busy = on ? "1" : "";
  for (const b of document.querySelectorAll("#recapSeg button")) b.setAttribute("aria-pressed", String(b.dataset.v === recapView));
  // 完整總結、短總結用會議 App 的共用元件 MdView 排版（#111）；簡介與逐字稿是一行行的文字，照舊
  const rich = Boolean(window.MdView) && (recapView === "full" || recapView === "short") && Boolean(r) && !on;
  $("#recapText").hidden = rich;
  $("#recapRich").hidden = !rich;
  $("#recapText").value = on && recapView !== "transcript" ? "" : recapViewText(recapView);
  if (rich) window.MdView.render($("#recapRich"), recapViewText(recapView), { top: 3 });
  $("#recapMake").textContent = on ? _("正在產生…（一兩分鐘）") : r ? _("重新產生") : _("產生會後總結");
  $("#recapMake").disabled = Boolean(recapBusyId || modBusyId);   // 一次只跑一份
  $("#recapStop").hidden = !on;
  $("#recapCopyAll").disabled = !r;
  $("#recapReveal").hidden = !r;
  const note = $("#recapNote");
  note.className = "hint";
  if (on) note.textContent = _("會議轉錄 App 正在整理整場內容，一兩分鐘就好。可以繼續改字幕。");
  else if (r?.stale) { note.textContent = _("產生總結之後字幕改過了。要讓總結跟上，按「重新產生」。"); note.className = "hint warn-text"; }
  else if (r) note.textContent = _("{date} {how}，也存成資料夾裡的 {file}。", { date: fmtDate(Date.parse(r.created)), how: recapHow(r), file: "summary.md" });
  else note.textContent = _("和會議轉錄 App 一樣的會後總結：簡介與分段章節、完整總結、短總結，再加上逐字稿。由會議轉錄 App 產生，約一兩分鐘。");
}

// 存到 Drive（有設定 studio_drive 才存）：產生就自動存；沒存成功或舊的結果還沒存過，可以按「存到 Drive」。
// 會後總結、心智圖、延伸三個頁籤底部都有同一行（#106）
let driveBusy = false;
const DRIVE_ROWS = ["recap", "mind", "ext"];
function renderDrive() {
  const p = state.p || {}, d = p.drive, has = Boolean(p.recap) || Boolean((p.modules || []).length);
  const failed = !d?.pending && d?.error && (!d.saved || d.failed > d.saved);
  const text = d?.pending ? _("正在存到 Drive…（Drive 卡住時最多等 30 秒，不影響其他操作）")
    : failed ? _("沒有存到 Drive：{err}", { err: d.error })
    : d?.folder ? (d.files?.length ? _("已存到{where}／{folder}（{files}）", { where: d.where || "Drive", folder: d.folder, files: d.files.join(_("、")) }) : _("已存到{where}／{folder}", { where: d.where || "Drive", folder: d.folder }))
    : _("還沒存到 Drive。");
  for (const r of DRIVE_ROWS) {
    // 沒設定 Drive：不顯示這一行；以前存過的照樣顯示位置，但不給「存到 Drive」
    $(`#driveRow_${r}`).hidden = !d && !(has && FEATURES.has("drive"));
    $(`#driveOpen_${r}`).hidden = !d?.folder;
    $(`#driveRetry_${r}`).hidden = Boolean(d?.pending) || !FEATURES.has("drive") || !(has && (failed || !d?.folder));
    $(`#driveRetry_${r}`).disabled = driveBusy;
    $(`#driveRetry_${r}`).textContent = driveBusy ? _("存檔中…") : failed ? _("再存一次") : _("存到 Drive");
    $(`#driveNote_${r}`).className = failed ? "hint warn-text" : "hint";
    $(`#driveNote_${r}`).textContent = text;
  }
}
// 背景存檔（#105）：存好之前每兩秒問一次專案，最多問一分半
let drivePolling = "";
async function pollDrive() {
  const id = state.id;
  if (!state.p?.drive?.pending || drivePolling === id) return;
  drivePolling = id;
  try {
    for (let i = 0; i < 45 && state.id === id; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await api(`/api/projects/${id}`);
      if (state.id !== id) return;
      state.p = { ...state.p, drive: p.drive };
      if (!p.drive?.pending) break;
    }
  } catch { /* 下次打開頁籤再看 */ } finally {
    if (drivePolling === id) drivePolling = "";
    renderDrive();
  }
}
async function saveDrive() {
  const id = state.id;
  driveBusy = true;
  renderDrive();
  try {
    const r = await post(`/api/projects/${id}/drive`);
    if (state.id === id) { state.p = { ...state.p, drive: r.drive }; toast(_("已存到 Drive。"), [], 3000); }
  } catch (e) {
    if (state.id === id) showAlert(e.message);
    try { const p = await api(`/api/projects/${id}`); if (state.id === id) state.p = { ...state.p, drive: p.drive }; } catch { /* 下次再說 */ }
  } finally {
    driveBusy = false;
    renderDrive();
  }
}

async function makeRecap() {
  const id = state.id;
  await flushSave();
  recapBusyId = id;
  renderRecap();
  try {
    const r = await post(`/api/projects/${id}/recap`);
    if (state.id !== id) return;
    state.p = { ...state.p, recap: r.recap, ...(r.drive !== undefined ? { drive: r.drive } : {}) };
    pollDrive();
    recapView = "intro";
    toast(r.recap.chapters?.length ? _("會後總結好了，共 {n} 章。", { n: r.recap.chapters.length }) : _("會後總結好了。"), [], 5000);
  } catch (e) {
    if (state.id === id) showAlert(e.message);
  } finally {
    recapBusyId = "";
    renderRecap();
    renderDrive();
  }
}
// 打開分頁時先存檔再問一次：剛改的字算進「總結是不是舊的」
// 共用元件的版本比對（#116）：這台的會議 App 程式和線上的不一樣時提醒一次（畫面或存檔格式可能和 App 不同）
let sharedChecked = false;
async function checkSharedVersion() {
  if (sharedChecked) return;
  sharedChecked = true;
  try {
    const v = await api("/api/shared-version");
    if (v.local && v.remote && !v.same) toast(_("工作室用的會議 App 元件（這台 {local}）和線上的（{remote}）不一樣，畫面或存檔格式可能和 App 不同。請更新 MacBook 的 meeting-scribe 程式。", { local: esc(v.local.slice(0, 8)), remote: esc(v.remote.slice(0, 8)) }), [], 12000);
    else if (!v.local) toast(_("找不到這台的會議 App 程式，總結、心智圖、延伸的畫面與存檔可能用不了。"), [], 12000);
  } catch { /* 查不到就算了，下次重新整理再查 */ }
}
async function refreshRecap() {
  checkSharedVersion();
  const id = state.id;
  if (!modList) loadModules();
  try { await flushSave(); const p = await api(`/api/projects/${id}`); if (state.id === id) state.p = { ...state.p, recap: p.recap, modules: p.modules, drive: p.drive }; } catch { /* 下次再說 */ }
  if (state.id === id) { renderRecap(); renderModules(); renderMind(); renderDrive(); pollDrive(); }
}

$("#recapSeg").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || !RECAP_VIEWS.includes(b.dataset.v)) return;
  recapView = b.dataset.v;
  renderRecap();
};
$("#recapMake").onclick = () => makeRecap();
$("#recapStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };
async function recapCopy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(_("已複製{what}。", { what }), [], 3000); } catch { $("#recapText").select(); }
}
$("#recapCopy").onclick = () => recapCopy(recapViewText(recapView), _("這一頁"));   // 排版呈現時也複製原文
$("#recapCopyAll").onclick = () => recapCopy(recapAllText(), _("全部（簡介、完整總結、短總結、逐字稿）"));
$("#recapReveal").onclick = async () => { try { await post(`/api/projects/${state.id}/reveal`, { what: "summary" }); } catch (e) { showAlert(e.message); } };
$("#tabRecap").addEventListener("click", () => refreshRecap());

// ---- 延伸模組（#88、#106、#111）----
// App 的模組依輸出分頁籤：markdown → 「延伸」頁籤，mindmap → 「心智圖」頁籤（mindmap.js）。
// 延伸頁籤用會議轉錄 App 的共用元件 ExtPanel（web/shared/ext.js），兩邊一模一樣；這裡只接資料與動作
let modList = null, modListError = "", modBusyId = "", modBusyLabel = "", modBusyOutput = "", modBusyKey = "";
// 和伺服器的 moduleKey 一樣：模組＋選項決定一份結果（心智圖也用）
const modKeyOf = (mod, options) => [mod.id, ...mod.options.map((o) => `${o.id}=${options[o.id]}`)].join(":");
const modLabelOf = (mod, options) => {
  const picked = mod.options.map((o) => o.choices.find(([c]) => c === options[o.id])?.[1]).filter(Boolean);
  return picked.length ? _("{title}（{picked}）", { title: mod.title, picked: picked.join(_("、")) }) : mod.title;
};
let extPanel = null;
function extMount() {
  if (extPanel || !window.ExtPanel?.mount) return extPanel;
  extPanel = window.ExtPanel.mount($("#extHost"), {
    onRun: (mod, options) => makeModule(mod, options),
    onStop: async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } },
    // 複製成功或失敗由 ExtPanel 自己在按鈕上閃字（1.1，和 App 一樣）；回 false 算失敗
    onCopy: async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } },
    onReveal: async (r) => { try { await post(`/api/projects/${state.id}/reveal`, { what: "module", key: r.key }); } catch (e) { showAlert(e.message); } },
  });
  return extPanel;
}

async function loadModules() {
  try {
    modList = (await api("/api/modules")).modules || [];
    modListError = "";
  } catch (e) {
    modList = null;
    modListError = e.message;
  }
  renderModules();
  renderMind();
}

function renderModules() {
  const on = Boolean(modBusyId) && modBusyId === state.id;
  $("#tabExt").dataset.busy = on && modBusyOutput !== "mindmap" ? "1" : "";
  const panel = extMount();
  if (!panel) {
    $("#extHost").textContent = _("找不到會議轉錄 App 的共用元件（這台的 meeting-scribe 程式），延伸暫時不能用。");
    return;
  }
  // 一次只跑一份：會後總結或別的模組在跑時，ExtPanel 的「產生」也不能按
  const busy = on ? { key: modBusyKey, label: modBusyLabel } : recapBusyId === state.id ? { key: "", label: "" } : null;
  panel.update({
    modules: modList || [],
    loading: !modList && !modListError,
    error: modListError ? _("連不到會議轉錄 App：{err}", { err: modListError }) : "",
    busy,
    results: (state.p?.modules || []).filter((x) => x.output !== "mindmap")
      .map((x) => ({ ...x, meta: _("{date} {how}，也存成資料夾裡的 {file}。", { date: fmtDate(Date.parse(x.created)), how: recapHow(x), file: x.file }) })),
  });
}

// 產生延伸或心智圖（mindmap.js 也用這個）
async function makeModule(mod, options) {
  const id = state.id;
  if (!mod || modBusyId) return;
  await flushSave();
  modBusyId = id;
  modBusyLabel = modLabelOf(mod, options);
  modBusyOutput = mod.output || "markdown";
  modBusyKey = modKeyOf(mod, options);
  renderModules();
  renderMind();
  renderRecap();
  try {
    const r = await post(`/api/projects/${id}/module`, { module: mod.id, options });
    if (state.id !== id) return;
    state.p = { ...state.p, modules: [r.module, ...(state.p.modules || []).filter((x) => x.key !== r.module.key)], ...(r.drive !== undefined ? { drive: r.drive } : {}) };
    pollDrive();
    const where = recapWhere(r.module).trim();
    toast(where ? _("「{label}」好了（{how}），也存成資料夾裡的 {file}。", { label: esc(r.module.label), how: esc(where), file: esc(r.module.file) }) : _("「{label}」好了，也存成資料夾裡的 {file}。", { label: esc(r.module.label), file: esc(r.module.file) }), [], 5000);   // 名稱來自 App：toast 是 HTML，要跳脫
  } catch (e) {
    if (state.id === id) showAlert(e.message);
  } finally {
    modBusyId = "";
    modBusyLabel = "";
    modBusyOutput = "";
    modBusyKey = "";
    renderModules();
    renderMind();
    renderRecap();
    renderDrive();
  }
}

for (const r of DRIVE_ROWS) {
  $(`#driveRetry_${r}`).onclick = () => saveDrive();
  $(`#driveOpen_${r}`).onclick = async () => { try { await post(`/api/projects/${state.id}/reveal`, { what: "drive" }); } catch (e) { showAlert(e.message); } };
}
for (const t of ["#tabMind", "#tabExt"]) $(t).addEventListener("click", () => refreshRecap());
// 會後的頁籤與 Drive 那一行用會議轉錄 App 的共用圖示（MeetingIcons，meeting-scribe#168），和 App 一樣；沒有元件就只有文字
function addMeetingIcons() {
  const icons = window.MeetingIcons;
  if (!icons?.icon) return;
  for (const [sel, name] of [["#tabRecap", "recap"], ["#tabMind", "mindmap"], ["#tabExt", "ext"], ...DRIVE_ROWS.map((r) => [`#driveRow_${r}`, "drive"])]) {
    const svg = icons.icon(name, { doc: document, className: "tab-icon" });
    if (svg) $(sel).prepend(svg);
  }
}
addMeetingIcons();
