"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：空狀態、預覽粗剪的右欄（開始上字幕）、網址匯入、整理視窗。

// ---- 預覽粗剪的設定與空狀態 ----
const home = { video: "", privacy: "public", proofreader: "claude", tools: null, sub: { mode: "asr", file: "", found: [] } };

function refreshStart() {
  const kept = trim.info ? cutOps.keptDuration(cutOps.keepSegments(trim.cuts, tDur())) : 0;
  $("#startBtn").disabled = !(trim.info && !trim.info.project && kept > 0) || (home.sub.mode === "file" && !home.sub.file);
  const withPii = home.privacy !== "public";
  const blocked = (n) => withPii && (home.tools?.chinaCloudProofreaders || []).includes(n);
  if (blocked(home.proofreader)) home.proofreader = "claude";
  for (const b of document.querySelectorAll("#proofSeg button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === home.proofreader));
    b.disabled = blocked(b.dataset.v) || !home.tools?.proofreaders?.[b.dataset.v];
  }
  for (const b of document.querySelectorAll("#privSeg button")) b.setAttribute("aria-pressed", String(b.dataset.v === home.privacy));
}

// 沒選影片的空狀態（#184，取代原本的首頁）：左欄影片庫照常，右邊提示從左邊挑或按「＋」
async function showHome() {
  clearTimeout(pollTimer);
  leaveTrim();
  state.id = "";
  if (location.hash) history.replaceState(null, "", location.pathname);
  setView("empty");
  setStep(1);
  renderLib();
  loadTools();
}
// 這台電腦有哪些校對 agent、有沒有 yt-dlp 和 Soniox 金鑰：預覽粗剪的右欄要用，開機讀一次
let toolsLoaded = false;
async function loadTools() {
  if (toolsLoaded) return;
  let h;
  try { h = await api("/api/tools"); } catch (e) { showAlert(_("讀不到這台電腦的工具設定：{msg}", { msg: e.message })); return; }
  toolsLoaded = true;
  home.tools = h.tools;
  $("#proofSeg").innerHTML = Object.keys(h.tools.proofreaders).map((n) => `<button type="button" data-v="${n}" aria-pressed="false">${n === "claude" ? _("Claude（預設）") : esc(n)}</button>`).join("");
  $("#ytGo").disabled = !h.tools.ytdlp || !youtubeUrl();
  $("#ytUrl").disabled = !h.tools.ytdlp;
  if (!h.tools.ytdlp) $("#ytHint").textContent = _("這台電腦沒有 yt-dlp，沒辦法下載網路影片；請 agent 協助安裝。");
  if (importKey) pollImport();
  if (!h.tools.soniox) showAlert(_("這台電腦找不到 Soniox 金鑰，沒辦法辨識；請 agent 協助設定。"));
}

// ---- 從 YouTube 下載外語影片（#56）----
let importKey = "", importTimer = 0;
const youtubeUrl = () => $("#ytUrl").value.trim();
const isYouTubeLink = (u) => /^https?:\/\/(?:[a-z]+\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(u);
const IMPORT_STEP = { info: _("讀取影片資訊…"), download: _("下載影片中"), captions: _("下載作者上傳的字幕…") };
$("#ytUrl").oninput = () => {
  $("#ytGo").disabled = !youtubeUrl() || Boolean(importKey);
  $("#ytModeSel").hidden = Boolean(youtubeUrl()) && !isYouTubeLink(youtubeUrl());   // 只連結只有 YouTube 能用（#181）
  showCapSel();
};
// 沒有作者字幕時的做法（#182）：只在 YouTube「只連結」時有意義
function showCapSel() { $("#ytCapSel").hidden = $("#ytModeSel").hidden || $("#ytModeSel").value !== "link"; }
$("#ytModeSel").addEventListener("change", () => showCapSel());
$("#ytUrl").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing && youtubeUrl() && !importKey) startImport(); };
$("#ytGo").onclick = () => startImport();
async function startImport() {
  $("#ytGo").disabled = true;
  try {
    // YouTube 預設只連結（#181）；Facebook、X 一定要下載
    const r = await post("/api/import", { url: youtubeUrl(), lang: $("#ytLangSel").value, ...(isYouTubeLink(youtubeUrl()) ? { mode: $("#ytModeSel").value, captions: $("#ytCapSel").value } : {}) });
    importKey = r.import;
    pollImport();
  } catch (e) { showAlert(e.message); $("#ytGo").disabled = !youtubeUrl(); }
}
async function pollImport() {
  clearTimeout(importTimer);
  if (!importKey) return;
  let x;
  try { x = await api(`/api/import/${importKey}`); } catch (e) { importKey = ""; $("#importBox").hidden = true; showAlert(e.message); return; }
  $("#importBox").hidden = false;
  $("#impTitle").textContent = x.title || _("讀取影片資訊…");
  $("#impBar").value = x.step === "download" ? x.progress || 0 : 0;
  $("#impBar").hidden = x.step !== "download" || x.status !== "running";
  const cap = { author: _("作者有上傳字幕，直接用，不用辨識。"), auto: _("只有 YouTube 自動字幕，會改用 Soniox 辨識。"), none: _("沒有字幕，會用 Soniox 辨識。") }[x.captions] || "";
  if (x.status === "running") {
    $("#impStep").textContent = _("{step}　{cap}", { step: `${IMPORT_STEP[x.step] || ""}${x.step === "download" ? ` ${Math.round((x.progress || 0) * 100)}%` : ""}`, cap });
    $("#impCancel").hidden = false;
    importTimer = setTimeout(pollImport, 1000);
    return;
  }
  const key = importKey;
  importKey = "";
  $("#impCancel").hidden = true;
  $("#ytGo").disabled = !youtubeUrl();
  if (x.status === "done") {
    $("#importBox").hidden = true;
    $("#ytUrl").value = "";
    // 對話框還開著（在等它）才直接打開；已經關掉去編輯別支的，不把人拉走，只提示＋更新左欄
    const waiting = $("#addUrlDlg").open;
    renderLib();
    if (!waiting) {
      toast(_("「{name}」匯入好了，在左欄的影片庫。", { name: esc(x.title || "") }), [{ label: _("打開"), run: async () => { await flushSave(); openProject(x.project); } }], 10000);
      return;
    }
    $("#addUrlDlg").close();
    toast(x.reopened ? _("這支之前下載過，直接打開上次的字幕。") : _("下載好了。{cap}字幕做好後會自動翻成中文。", { cap }), [], 6000);
    await flushSave();
    await openProject(x.project);
    return;
  }
  $("#impStep").textContent = x.status === "cancelled" ? _("已經停止。") : _("沒有下載成功：{msg}", { msg: I18N.msg(x.error || "") });
  setTimeout(() => { if (!importKey && key) $("#importBox").hidden = true; }, 8000);
}
$("#impCancel").onclick = async () => { try { await post(`/api/import/${importKey}/cancel`); } catch (e) { showAlert(e.message); } };

$("#langSel").onchange = () => { $("#langHint").hidden = home.sub.mode !== "asr" || $("#langSel").value === "zh"; if (trim.info) renderTrim(); };
$("#privSeg").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  home.privacy = b.dataset.v;
  refreshStart();
};
$("#proofSeg").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b || b.disabled) return;
  home.proofreader = b.dataset.v;
  refreshStart();
};
$("#startBtn").onclick = async () => {
  $("#startBtn").disabled = true;
  try {
    const own = home.sub.mode === "file", none = home.sub.mode === "none";
    const r = await post("/api/open", { video: trim.info.video, privacy: none ? "public" : home.privacy, proofreader: home.proofreader, cuts: trim.cuts, lang: $("#langSel").value,
      ...(none ? { noSubtitles: true } : own ? { subtitles: home.sub.file } : { tracks: trkPayload() }) });
    if (r.reopened) toast(_("這支影片之前做過，直接打開上次的字幕。"));
    if (r.imported) toast(_("找到之前用指令做好的字幕，直接打開來改。"));
    leaveTrim();
    await openProject(r.id);
    renderLib();   // 左欄這支影片改標「處理中」
    if (r.ready) openYoutube();   // 不要字幕（#158）：沒有東西要等，直接到上傳視窗
  } catch (e) { showAlert(e.message); refreshStart(); }
};
// 字幕從哪裡來（#148）：自動辨識，或用已經有的字幕檔，或不要字幕（#158）；影片旁邊有同名的字幕檔就先帶入
function subShow(found) {
  home.sub = found?.length ? { mode: "file", file: found[0].path, found } : { mode: "asr", file: "", found: [] };
  subRender();
}
function subRender() {
  const own = home.sub.mode === "file", none = home.sub.mode === "none", name = home.sub.file.split("/").pop();
  for (const b of document.querySelectorAll("#subSeg button")) b.setAttribute("aria-pressed", String(b.dataset.v === home.sub.mode));
  $("#subBox").hidden = !own;
  $("#subFile").textContent = !home.sub.file ? _("還沒選字幕檔。")
    : _("用「{name}」{note}", { name, note: home.sub.found.some((x) => x.path === home.sub.file) ? _("（影片旁邊找到的同名字幕檔）") : "" });
  // 分軌是替辨識出來的字幕標講者：用字幕檔時不顯示
  $("#trkQ").hidden = own || none;
  $("#trkBox").hidden = own || none;
  // 不要字幕：沒有語言、個資、校對可選（不送辨識也不送 AI）
  $("#plainHint").hidden = !none;
  $("#langBlock").hidden = none;
  $("#privBlock").hidden = none;
  $("#startBtn").textContent = none ? _("下一步：上傳 YouTube") : _("開始上字幕");
  $("#langHint").hidden = own || none || $("#langSel").value === "zh";   // 「會用 Soniox 辨識原文」只在自動辨識時對
  if (trim.info) renderTrim(); else refreshStart();
}
$("#subSeg").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  home.sub.mode = b.dataset.v;
  subRender();
};
$("#subPick").onclick = async () => {
  $("#subPick").disabled = true;
  try {
    const r = await post("/api/pick-subtitles");
    if (r.path) Object.assign(home.sub, { mode: "file", file: r.path });
    subRender();
  } catch (e) { showAlert(e.message); } finally { $("#subPick").disabled = false; }
};
// 整理一支影片（#39）：只移出清單（檔案留著），或清掉處理資料（資料夾丟垃圾桶，輸出的影片可以先搬出來）
let manageInfo = null, manageId = "";
// 從左欄的「⋯」打開（#184）：只讀這一支的大小、輸出、上傳狀態
async function openManage(id) {
  let p;
  try { p = await api(`/api/projects/${id}/manage`); } catch (e) { showAlert(e.message); return; }
  manageInfo = p;
  manageId = id;
  $("#manageForget").hidden = !p.recent;   // 不在最近清單上的（資料夾裡的影片）沒有清單可移出
  $("#manageTitle").textContent = _("整理「{name}」", { name: p.name });
  const folder = `${p.name}-字幕`;   // 不翻：實際的資料夾名稱
  $("#manageSize").textContent = _("處理資料在「{folder}」資料夾，{size}：字幕、逐字時間、說明欄、剪輯與 AI 建議{out}。", { folder, size: (p.bytes || 0) < 1e6 ? _("不到 1 MB") : _("共 {size}", { size: fmtSize(p.bytes) }), out: p.outputs?.length ? _("，還有輸出的影片") : "" });
  $("#manageKeepRow").hidden = !p.outputs?.length;
  $("#manageKeep").checked = true;
  $("#manageOutputs").textContent = p.outputs?.length ? _("（{list}）", { list: p.outputs.join(_("、")) }) : "";
  $("#manageVideoRow").hidden = !p.downloaded;
  $("#manageVideo").checked = true;
  // 上傳到 YouTube 的自己的錄影（#75）：可以連原始錄影一起丟，預設不勾；還沒掛 CC 的先提醒
  $("#manageOrigRow").hidden = !p.original_bytes;
  $("#manageOrig").checked = false;
  $("#manageOrigSize").textContent = p.original_bytes ? _("（{size}）", { size: fmtSize(p.original_bytes) }) : "";
  $("#manageCcWarn").hidden = !p.youtube?.needs_cc;
  manageNote();
  $("#manageClear").disabled = Boolean(p.busy);
  $("#manageBusy").hidden = !p.busy;
  $("#manageDlg").showModal();
}
function manageNote() {
  const orig = !$("#manageOrigRow").hidden && $("#manageOrig").checked;
  $("#manageNote").textContent = _("清掉後{what}會在垃圾桶，救得回來{tail}。之後想再改這支的字幕，就要重新辨識（會再付一次辨識費）。", { what: orig ? _("資料夾和原始錄影都") : _("整個資料夾"), tail: orig ? _("；要真的空出空間，再清空垃圾桶") : _("；原始影片不動") });
}
$("#manageOrig").onchange = manageNote;
// 移出清單或清掉的剛好是上次開的：下次開機不要再自動打開它（#184）
function forgetLast(id) { if (layoutGet(LAYOUT_KEYS.last) === id) layoutSet(LAYOUT_KEYS.last, null); }
$("#manageCancel").onclick = () => $("#manageDlg").close();
$("#manageForget").onclick = async () => {
  try { await post(`/api/projects/${manageId}/forget`); } catch (err) { showAlert(err.message); return; }
  $("#manageDlg").close();
  forgetLast(manageId);
  if (state.id === manageId) showHome(); else renderLib();
};
$("#manageClear").onclick = async () => {
  $("#manageClear").disabled = true;
  try {
    const p = manageInfo;
    const r = await post(`/api/projects/${manageId}/clear`, { keepOutputs: $("#manageKeep").checked, trashVideo: Boolean(p?.downloaded) && $("#manageVideo").checked,
      trashOriginal: Boolean(p?.original_bytes) && $("#manageOrig").checked });
    $("#manageDlg").close();
    forgetLast(manageId);
    toast(_("已把「{name}」{extra}丟到垃圾桶{moved}。要救回來可以到垃圾桶「放回原處」。{fail}", { name: esc(r.trashed), extra: r.video_trashed ? _("和下載的影片") : r.original_trashed ? _("和原始錄影") : "", moved: r.moved.length ? _("，{list} 搬到原片旁邊", { list: esc(r.moved.join(_("、"))) }) : "", fail: r.original_failed ? _("原始錄影沒丟成，請到 Finder 自己丟。") : "" }), [], 8000);
    if (state.id === manageId) showHome(); else renderLib();
  } catch (err) { showAlert(err.message); } finally { $("#manageClear").disabled = false; }
};
$("#procHome").onclick = () => showHome();
$("#addUrlClose").onclick = () => $("#addUrlDlg").close();
