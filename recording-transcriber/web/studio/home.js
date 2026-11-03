"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：首頁：選影片、最近專案、管理。

// ---- 首頁 ----
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

async function showHome() {
  clearTimeout(pollTimer);
  leaveTrim();
  state.id = "";
  if (location.hash) history.replaceState(null, "", location.pathname);
  setView("home");
  setStep(1);
  let h;
  try { h = await api("/api/home"); } catch (e) { showAlert(`讀不到首頁資料：${e.message}`); return; }
  home.tools = h.tools;
  $("#videoList").innerHTML = h.videos.map((v) => `<li><button type="button" data-path="${esc(v.path)}" title="${esc(v.name)}">`
    + `<span class="v-thumb" data-key="${esc(v.key)}">${v.offline ? "在 iCloud，點了會先下載" : '<svg class="icon"><use href="#i-play"/></svg>'}</span>`
    + `<span class="v-text"><span class="v-name">${esc(v.name)}</span><span class="v-meta">${v.icloud ? '<span class="badge">iCloud</span> ' : ""}${fmtDate(v.mtime)} · ${fmtSize(v.size)}</span></span></button></li>`).join("");
  $("#videoEmpty").hidden = h.videos.length > 0;
  $("#videoNote").hidden = !h.videos.some((v) => v.icloud);
  loadPosters();
  $("#proofSeg").innerHTML = Object.keys(h.tools.proofreaders).map((n) => `<button type="button" data-v="${n}" aria-pressed="false">${n === "claude" ? "Claude（預設）" : esc(n)}</button>`).join("");
  $("#projCard").hidden = !h.recent.length;
  const label = { ready: "可以編輯", processing: "處理中", failed: "處理失敗", cancelled: "已經停止", burning: "燒字幕中", uploading: "上傳 YouTube 中" };
  $("#projList").innerHTML = h.recent.map((p) => `<li><span class="p-main"><span class="p-name">${esc(p.name)}</span><span class="p-meta">${label[p.status] || p.status} · ${p.cues} 句 · ${p.updated ? fmtDate(Date.parse(p.updated)) : ""}${p.privacy !== "public" ? " · 含個資" : ""}</span></span><button class="btn sm solid" data-open="${p.id}">打開</button><button class="btn sm ghost" data-manage="${p.id}" title="移出清單，或清掉這支的處理資料">整理…</button></li>`).join("");
  homeRecent = h.recent;
  $("#ytGo").disabled = !h.tools.ytdlp || !youtubeUrl();
  $("#ytUrl").disabled = !h.tools.ytdlp;
  if (!h.tools.ytdlp) $("#ytHint").textContent = "這台電腦沒有 yt-dlp，沒辦法下載 YouTube 影片；請 agent 協助安裝。";
  if (importKey) pollImport();
  if (!h.tools.soniox) showAlert("這台電腦找不到 Soniox 金鑰，沒辦法辨識；請 agent 協助設定。");
}

// ---- 從 YouTube 下載外語影片（#56）----
let importKey = "", importTimer = 0;
const youtubeUrl = () => $("#ytUrl").value.trim();
const IMPORT_STEP = { info: "讀取影片資訊…", download: "下載影片中", captions: "下載作者上傳的字幕…" };
$("#ytUrl").oninput = () => { $("#ytGo").disabled = !youtubeUrl() || Boolean(importKey); };
$("#ytUrl").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing && youtubeUrl() && !importKey) startImport(); };
$("#ytGo").onclick = () => startImport();
async function startImport() {
  $("#ytGo").disabled = true;
  try {
    const r = await post("/api/import", { url: youtubeUrl(), lang: $("#ytLangSel").value });
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
  $("#impTitle").textContent = x.title || "讀取影片資訊…";
  $("#impBar").value = x.step === "download" ? x.progress || 0 : 0;
  $("#impBar").hidden = x.step !== "download" || x.status !== "running";
  const cap = { author: "作者有上傳字幕，直接用，不用辨識。", auto: "只有 YouTube 自動字幕，會改用 Soniox 辨識。", none: "沒有字幕，會用 Soniox 辨識。" }[x.captions] || "";
  if (x.status === "running") {
    $("#impStep").textContent = `${IMPORT_STEP[x.step] || ""}${x.step === "download" ? ` ${Math.round((x.progress || 0) * 100)}%` : ""}　${cap}`;
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
    if ($("#home").hidden) return;   // 已經離開首頁：專案在「繼續編輯」裡
    toast(x.reopened ? "這支之前下載過，直接打開上次的字幕。" : `下載好了。${cap}字幕做好後會自動翻成中文。`, [], 6000);
    openProject(x.project);
    return;
  }
  $("#impStep").textContent = x.status === "cancelled" ? "已經停止。" : `沒有下載成功：${x.error || ""}`;
  setTimeout(() => { if (!importKey && key) $("#importBox").hidden = true; }, 8000);
}
$("#impCancel").onclick = async () => { try { await post(`/api/import/${importKey}/cancel`); } catch (e) { showAlert(e.message); } };

// 首頁縮圖：伺服器一支一支抓好就送來（只在記憶體裡，不存檔）
function loadPosters() {
  homePosters?.abort();
  homePosters = new AbortController();
  streamTiles("/api/home/posters", homePosters.signal, (x) => {
    const box = document.querySelector(`#videoList .v-thumb[data-key="${x.key}"]`);
    if (!box) return;
    if (x.jpg) {
      const img = new Image();
      img.alt = "";
      img.src = `data:image/jpeg;base64,${x.jpg}`;
      box.replaceChildren(img);
    }
    if (x.duration_ms > 0) {
      const dur = document.createElement("span");
      dur.className = "v-dur";
      dur.textContent = fmtClock(x.duration_ms);
      box.append(dur);
    }
  });
}

$("#videoList").onclick = (e) => {
  const b = e.target.closest("button[data-path]");
  if (b) openTrim(b.dataset.path);
};
const typedPath = () => $("#pathIn").value.trim().replace(/^['"]|['"]$/g, "");
$("#pathIn").oninput = () => { $("#pathGo").disabled = !typedPath(); };
$("#pathIn").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing && typedPath()) openTrim(typedPath()); };
$("#pathGo").onclick = () => typedPath() && openTrim(typedPath());
$("#pickBtn").onclick = async () => {
  $("#pickBtn").disabled = true;
  try {
    const r = await post("/api/pick");
    if (r.path) openTrim(r.path);
  } catch (e) { showAlert(e.message); } finally { $("#pickBtn").disabled = false; }
};
$("#langSel").onchange = () => { $("#langHint").hidden = home.sub.mode === "file" || $("#langSel").value === "zh"; if (trim.info) renderTrim(); };
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
    const own = home.sub.mode === "file";
    const r = await post("/api/open", { video: trim.info.video, privacy: home.privacy, proofreader: home.proofreader, cuts: trim.cuts, lang: $("#langSel").value,
      ...(own ? { subtitles: home.sub.file } : { tracks: trkPayload() }) });
    if (r.reopened) toast("這支影片之前做過，直接打開上次的字幕。");
    if (r.imported) toast("找到之前用指令做好的字幕，直接打開來改。");
    leaveTrim();
    await openProject(r.id);
  } catch (e) { showAlert(e.message); refreshStart(); }
};
// 字幕從哪裡來（#148）：自動辨識，或用已經有的字幕檔；影片旁邊有同名的字幕檔就先帶入
function subShow(found) {
  home.sub = found?.length ? { mode: "file", file: found[0].path, found } : { mode: "asr", file: "", found: [] };
  subRender();
}
function subRender() {
  const own = home.sub.mode === "file", name = home.sub.file.split("/").pop();
  for (const b of document.querySelectorAll("#subSeg button")) b.setAttribute("aria-pressed", String(b.dataset.v === home.sub.mode));
  $("#subBox").hidden = !own;
  $("#subFile").textContent = !home.sub.file ? "還沒選字幕檔。"
    : `用「${name}」${home.sub.found.some((x) => x.path === home.sub.file) ? "（影片旁邊找到的同名字幕檔）" : ""}`;
  // 分軌是替辨識出來的字幕標講者：用字幕檔時不顯示
  $("#trkQ").hidden = own;
  $("#trkBox").hidden = own;
  $("#langHint").hidden = own || $("#langSel").value === "zh";   // 「會用 Soniox 辨識原文」只在自動辨識時對
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
$("#projList").onclick = (e) => {
  const o = e.target.closest("[data-open]"), m = e.target.closest("[data-manage]");
  if (o) openProject(o.dataset.open);
  if (m) openManage(m.dataset.manage);
};
// 整理一支影片（#39）：只移出清單（檔案留著），或清掉處理資料（資料夾丟垃圾桶，輸出的影片可以先搬出來）
let homeRecent = [], manageId = "";
function openManage(id) {
  const p = homeRecent.find((x) => x.id === id);
  if (!p) return;
  manageId = id;
  $("#manageTitle").textContent = `整理「${p.name}」`;
  $("#manageSize").textContent = `處理資料在「${p.name}-字幕」資料夾，${(p.bytes || 0) < 1e6 ? "不到 1 MB" : `共 ${fmtSize(p.bytes)}`}：字幕、逐字時間、說明欄、剪輯與 AI 建議${p.outputs?.length ? "，還有輸出的影片" : ""}。`;
  $("#manageKeepRow").hidden = !p.outputs?.length;
  $("#manageKeep").checked = true;
  $("#manageOutputs").textContent = p.outputs?.length ? `（${p.outputs.join("、")}）` : "";
  $("#manageVideoRow").hidden = !p.downloaded;
  $("#manageVideo").checked = true;
  // 上傳到 YouTube 的自己的錄影（#75）：可以連原始錄影一起丟，預設不勾；還沒掛 CC 的先提醒
  $("#manageOrigRow").hidden = !p.original_bytes;
  $("#manageOrig").checked = false;
  $("#manageOrigSize").textContent = p.original_bytes ? `（${fmtSize(p.original_bytes)}）` : "";
  $("#manageCcWarn").hidden = !p.youtube?.needs_cc;
  manageNote();
  $("#manageClear").disabled = Boolean(p.busy);
  $("#manageBusy").hidden = !p.busy;
  $("#manageDlg").showModal();
}
function manageNote() {
  const orig = !$("#manageOrigRow").hidden && $("#manageOrig").checked;
  $("#manageNote").textContent = `清掉後${orig ? "資料夾和原始錄影都" : "整個資料夾"}會在垃圾桶，救得回來${orig ? "；要真的空出空間，再清空垃圾桶" : "；原始影片不動"}。之後想再改這支的字幕，就要重新辨識（會再付一次辨識費）。`;
}
$("#manageOrig").onchange = manageNote;
$("#manageCancel").onclick = () => $("#manageDlg").close();
$("#manageForget").onclick = async () => {
  try { await post(`/api/projects/${manageId}/forget`); } catch (err) { showAlert(err.message); return; }
  $("#manageDlg").close();
  showHome();
};
$("#manageClear").onclick = async () => {
  $("#manageClear").disabled = true;
  try {
    const p = homeRecent.find((x) => x.id === manageId);
    const r = await post(`/api/projects/${manageId}/clear`, { keepOutputs: $("#manageKeep").checked, trashVideo: Boolean(p?.downloaded) && $("#manageVideo").checked,
      trashOriginal: Boolean(p?.original_bytes) && $("#manageOrig").checked });
    $("#manageDlg").close();
    toast(`已把「${esc(r.trashed)}」${r.video_trashed ? "和下載的影片" : r.original_trashed ? "和原始錄影" : ""}丟到垃圾桶${r.moved.length ? `，${esc(r.moved.join("、"))} 搬到原片旁邊` : ""}。要救回來可以到垃圾桶「放回原處」。${r.original_failed ? "原始錄影沒丟成，請到 Finder 自己丟。" : ""}`, [], 8000);
    showHome();
  } catch (err) { showAlert(err.message); } finally { $("#manageClear").disabled = false; }
};
$("#homeBtn").onclick = async () => { await flushSave(); showHome(); };
$("#procHome").onclick = () => showHome();
