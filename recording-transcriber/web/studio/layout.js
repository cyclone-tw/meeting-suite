"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：三欄版面（#170、#184）：左欄影片庫、可以拖的分隔線、時間軸章節。

// ---- 記在這台瀏覽器的版面偏好（讀寫失敗就照預設，不影響使用）----
const LAYOUT_KEYS = { lib: "studio.libW", right: "studio.rightW", off: "studio.libOff", fold: "studio.libFold", last: "studio.lastProject" };
function layoutGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function layoutSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (e) { /* 私密視窗之類：不記 */ } }

// ---- 左欄：影片庫（#184）：加入的資料夾（子資料夾可以收合）、單獨加入的影片檔、YouTube 連結、其他專案 ----
const lib = { view: null, loading: 0, at: 0 };
const LIB_STATUS = { ready: _("有字幕"), processing: _("處理中"), failed: _("處理失敗"), cancelled: _("已經停止"), burning: _("燒字幕中"), uploading: _("上傳 YouTube 中") };
// 哪些資料夾打開著：記在這台瀏覽器，只記和預設不一樣的；加入的資料夾和群組預設打開（鍵前面加 root:，
// 同一個資料夾也是別的資料夾的子資料夾時才不會共用），子資料夾預設收著
let libFold = {};
try { libFold = JSON.parse(layoutGet(LAYOUT_KEYS.fold) || "{}") || {}; } catch (e) { libFold = {}; }
const foldOpen = (key, dflt) => (Object.prototype.hasOwnProperty.call(libFold, key) ? libFold[key] : dflt);

// 讀清單要掃資料夾：開機、加入或移除、建了新專案、按重新整理時才讀；切回這個分頁時隔夠久（Finder 裡可能多了影片）再讀
const LIB_STALE_MS = 60000;
async function renderLib() {
  const run = ++lib.loading;
  let r;
  try { r = await api("/api/library"); } catch (e) { return; }   // 清單讀不到不擋編輯
  if (run !== lib.loading) return;
  lib.view = r;
  lib.at = Date.now();
  drawLib();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lib.view && Date.now() - (lib.at || 0) > LIB_STALE_MS) renderLib();
});
// 這支專案的狀態變了（例如處理完）：改清單上的那一列，不重掃
function libNoteStatus(id, status) {
  const v = lib.view;
  if (!v || !id || !status) return;
  let changed = false;
  const fix = (o) => { if (o && o.id === id && o.status !== status) { o.status = status; changed = true; } };
  const walk = (n) => { n.videos.forEach((x) => fix(x.project)); n.dirs.forEach(walk); };
  v.folders.forEach(walk);
  v.files.forEach((x) => fix(x.project));
  v.links.forEach(fix);
  v.others.forEach(fix);
  if (changed) drawLib();
}

const libIcon = (kind, done) => kind === "yt"
  ? `<svg class="l-icon yt" aria-label="${esc(_("YouTube 連結"))}" role="img"><use href="#i-yt"/></svg>`
  : `<svg class="l-icon${done ? " done" : ""}" aria-label="${esc(done ? _("有字幕") : _("本機影片"))}" role="img"><use href="#i-film"/></svg>`;
const libRow = (attr, icon, name, meta, extra = "") => `<li><button type="button" ${attr} title="${esc(name)}">${icon}<span class="l-text"><span class="l-name">${esc(name)}</span><span class="l-meta">${esc(meta)}</span></span></button>${extra}</li>`;
// 有專案的才有「整理…」（清掉處理資料、從清單拿掉）
const manageBtn = (id, name) => `<button type="button" class="i-act" data-manage="${esc(id)}" title="${esc(_("整理…"))}" aria-label="${esc(_("整理 {name}", { name }))}">⋯</button>`;
// 本機影片：做過字幕的直接開專案，還沒做的開預覽粗剪
function videoRow(v, removable = false) {
  const meta = [v.missing ? _("找不到這個檔案") : v.size ? fmtSize(v.size) : "", v.project ? LIB_STATUS[v.project.status] || v.project.status : "", v.offline ? _("在 iCloud") : ""].filter(Boolean).join(" · ");
  const attr = v.project ? `data-open="${esc(v.project.id)}"` : `data-video="${esc(v.path)}"${v.missing ? " disabled" : ""}`;
  const x = (v.project ? manageBtn(v.project.id, v.name) : "") + (!removable ? "" : `<button type="button" class="i-act" data-remove="${esc(v.path)}" title="${esc(_("從影片庫移除（不會刪掉檔案）"))}" aria-label="${esc(_("從影片庫移除 {name}", { name: v.name }))}">×</button>`);
  return libRow(attr, libIcon("file", v.project?.status === "ready"), v.name, meta, x);
}
// 專案（YouTube 連結、影片不在影片庫裡的）
function projectRow(p) {
  const meta = [p.duration_ms ? fmtClock(p.duration_ms) : "", p.status === "ready" ? "" : LIB_STATUS[p.status] || p.status].filter(Boolean).join(" · ");
  return libRow(`data-open="${esc(p.id)}"`, libIcon(p.link ? "yt" : "file", !p.link && p.status === "ready"), p.name, meta, manageBtn(p.id, p.name));
}
const countVideos = (n) => n.videos.length + n.dirs.reduce((s, d) => s + countVideos(d), 0);

// 資料夾 → HTML；搜尋時只留找得到的，而且全部打開
function dirHtml(node, q, cls = "lib-dir", head = "") {
  const key = cls === "lib-group" ? `root:${node.path}` : node.path;
  const hit = (name) => !q || name.toLowerCase().includes(q);
  const videos = node.videos.filter((v) => hit(v.name));
  const dirs = node.dirs.map((d) => dirHtml(d, q)).filter(Boolean);
  if (q && !videos.length && !dirs.length) return "";
  const open = q ? true : foldOpen(key, cls === "lib-group");
  const body = `${dirs.join("")}${videos.length ? `<ul class="lib-items">${videos.map((v) => videoRow(v)).join("")}</ul>` : ""}`;
  return `<details class="${cls}" data-fold="${esc(key)}"${open ? " open" : ""}><summary title="${esc(node.path)}"><svg class="l-icon dir" aria-hidden="true"><use href="#i-folder"/></svg><span class="g-name">${esc(node.name)}</span><span class="g-count">${q ? videos.length + dirs.length : countVideos(node)}</span>${head}</summary>${body}</details>`;
}
function groupHtml(key, title, icon, rows, q) {
  if (!rows.length) return "";
  const open = q ? true : foldOpen(key, true);
  return `<details class="lib-group" data-fold="${esc(key)}"${open ? " open" : ""}><summary><svg class="l-icon ${icon === "i-yt" ? "yt" : "dir"}" aria-hidden="true"><use href="#${icon}"/></svg><span class="g-name">${esc(title)}</span><span class="g-count">${rows.length}</span></summary><ul class="lib-items">${rows.join("")}</ul></details>`;
}

function drawLib() {
  const v = lib.view;
  if (!v) return;
  const q = $("#libFind").value.trim().toLowerCase();
  const hit = (name) => !q || String(name).toLowerCase().includes(q);
  const removeBtn = (p, name) => `<button type="button" class="g-remove" data-remove="${esc(p)}" title="${esc(_("從影片庫移除（不會刪掉資料夾裡的檔案）"))}" aria-label="${esc(_("從影片庫移除 {name}", { name }))}">×</button>`;
  const parts = [
    groupHtml("g:links", _("YouTube 連結"), "i-yt", v.links.filter((p) => hit(p.name)).map(projectRow), q),
    ...v.folders.map((f) => {
      if (f.missing) return q ? "" : `<details class="lib-group" data-fold="${esc(`root:${f.path}`)}" open><summary title="${esc(f.path)}"><svg class="l-icon dir" aria-hidden="true"><use href="#i-folder"/></svg><span class="g-name">${esc(f.name)}</span>${removeBtn(f.path, f.name)}</summary><p class="lib-missing">${esc(_("找不到這個資料夾，可能搬走或改名了。"))}</p></details>`;
      const html = dirHtml(f, q, "lib-group", removeBtn(f.path, f.name));
      return html && f.truncated ? html.replace(/<\/details>$/, `<p class="lib-missing">${esc(_("影片太多，只列出前面一部分。可以改加入裡面的子資料夾。"))}</p></details>`) : html;
    }),
    groupHtml("g:files", _("單獨加入的影片"), "i-film", v.files.filter((f) => hit(f.name)).map((f) => videoRow(f, true)), q),
    groupHtml("g:others", _("其他專案"), "i-folder", v.others.filter((p) => hit(p.name)).map(projectRow), q),
  ].filter(Boolean);
  // 清單檔壞掉：伺服器先當空的、不覆寫；講清楚，免得以為資料夾都不見了
  if (v.broken && !q) parts.unshift(`<p class="lib-missing">${esc(_("影片庫的清單檔讀不到，先顯示空的。加入或移除時會把舊檔留一份成 library.json.broken。"))}</p>`);
  $("#libTree").innerHTML = parts.join("");
  $("#libEmpty").hidden = parts.length > 0;
  $("#libEmpty").textContent = q ? _("找不到符合的影片或專案。") : _("影片庫是空的。按「＋」加入資料夾、影片檔或影片網址。");
  markLibNow();
}
// 標出現在開著的：專案用 id，預覽粗剪用影片路徑
function markLibNow() {
  const vid = !$("#trim").hidden && trim.info ? trim.info.video : "";
  for (const b of $("#libTree").querySelectorAll("button[data-open], button[data-video]")) {
    const now = Boolean((state.id && b.dataset.open === state.id) || (vid && b.dataset.video === vid));
    b.classList.toggle("now", now);
    b.setAttribute("aria-current", now ? "true" : "false");
  }
}
$("#libFind").addEventListener("input", () => drawLib());
// 收合狀態：只記和預設不一樣的（畫出來時帶 open 的也會觸發 toggle，那和預設一樣，不記）；搜尋時全部打開的不記
$("#libTree").addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches?.("details[data-fold]") || $("#libFind").value.trim()) return;
  if (d.open === d.classList.contains("lib-group")) delete libFold[d.dataset.fold];
  else libFold[d.dataset.fold] = d.open;
  layoutSet(LAYOUT_KEYS.fold, JSON.stringify(libFold));
}, true);

// 離開正在開的專案（存好、停止輪詢），再開別的
async function leaveProject() {
  await flushSave();
  clearTimeout(pollTimer);
  state.id = "";
  if (location.hash) history.replaceState(null, "", location.pathname);
}
async function openLibVideo(videoPath) {
  if (!$("#trim").hidden && trim.info?.video === videoPath) return;
  await leaveProject();
  openTrim(videoPath);
}
$("#libTree").addEventListener("click", async (e) => {
  const mg = e.target.closest("[data-manage]");
  if (mg) { openManage(mg.dataset.manage); return; }
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    e.preventDefault();   // 在 summary 裡：不要順便收合
    let r;
    try { r = await post("/api/library/remove", { path: rm.dataset.remove }); } catch (err) { showAlert(err.message); return; }
    lib.view = r;
    drawLib();
    toast(_("已經從影片庫移除，檔案沒有動。"));
    return;
  }
  const b = e.target.closest("button[data-open], button[data-video]");
  if (!b || b.disabled) return;
  if (b.dataset.open) {
    if (b.dataset.open === state.id) return;
    await flushSave();
    openProject(b.dataset.open);
  } else openLibVideo(b.dataset.video);
});
$("#libRefresh").addEventListener("click", () => renderLib());

// ---- 「＋」：影片網址、加入資料夾、加入影片檔（空狀態的三個按鈕也走這裡）----
function setAddMenu(open) {
  $("#addMenu").hidden = !open;
  $("#libAdd").setAttribute("aria-expanded", String(open));
  if (open) $("#addMenu button").focus();
}
$("#libAdd").addEventListener("click", () => setAddMenu($("#addMenu").hidden));
document.addEventListener("click", (e) => { if (!$("#addMenu").hidden && !e.target.closest("#addMenu, #libAdd")) setAddMenu(false); });
$("#addMenu").addEventListener("keydown", (e) => {
  const items = [...$("#addMenu").querySelectorAll("button")], i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); setAddMenu(false); $("#libAdd").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
});
async function addToLib(kind) {
  if (kind === "url") {
    $("#addUrlDlg").showModal();
    $("#ytUrl").focus();
    return;
  }
  toast(kind === "folder" ? _("在 Finder 視窗選一個資料夾…") : _("在 Finder 視窗選一支影片…"), [], 0);
  let r;
  try { r = await post("/api/library/add", { kind }); } catch (e) { $("#toast").hidden = true; showAlert(e.message); return; }
  $("#toast").hidden = true;
  if (r.cancelled) return;
  if (libIsOff()) setLibOff(false);
  lib.view = r;
  $("#libFind").value = "";
  if (kind === "folder") delete libFold[`root:${r.added}`];   // 新加的資料夾打開
  drawLib();
  const el = [...$("#libTree").querySelectorAll("[data-fold], [data-video], [data-remove]")].find((x) => x.dataset.fold === `root:${r.added}` || x.dataset.video === r.added);
  el?.scrollIntoView({ block: "nearest" });
  if (kind === "file") {
    const f = r.files.find((x) => x.path === r.added);
    if (f?.project) { await flushSave(); openProject(f.project.id); } else openLibVideo(r.added);
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-add]");
  if (!b) return;
  setAddMenu(false);
  addToLib(b.dataset.add);
});

// ---- 收起／打開左欄（⌘B）----
function setLibOff(off, remember = true) {
  $("#shell").classList.toggle("lib-off", off);
  $("#libToggle").setAttribute("aria-pressed", String(!off));
  if (remember) layoutSet(LAYOUT_KEYS.off, off ? "1" : null);
  if (!off && Number(layoutGet(LAYOUT_KEYS.lib)) > 0) setSplit("splitL", Number(layoutGet(LAYOUT_KEYS.lib)), false);   // 打開時照記住的寬度，再夾回範圍
}
const libIsOff = () => $("#shell").classList.contains("lib-off");
$("#libToggle").addEventListener("click", () => setLibOff(!libIsOff()));
$("#libClose").addEventListener("click", () => setLibOff(true));
document.addEventListener("keydown", (e) => {
  if ($("#shell").hidden || document.querySelector("dialog[open]") || e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b" && !isTyping(e)) { e.preventDefault(); setLibOff(!libIsOff()); }
});

// ---- 分隔線：滑鼠拖、方向鍵調、雙擊回到預設；中間的影片至少留 360px。寬度設在外框上，左欄在每個畫面都一樣寬 ----
const SPLITS = {
  splitL: { key: LAYOUT_KEYS.lib, prop: "--lib-w", min: 200, max: 480, side: "left" },
  splitR: { key: LAYOUT_KEYS.right, prop: "--right-w", min: 320, max: 900, side: "right" },
};
const SPLIT_STEP = 24;
const splitEl = (id) => $(`#${id}`);
// 分隔線旁邊那一欄目前多寬（splitL → 左欄，splitR → 右欄）；收起來的左欄算 0
function paneWidth(id) {
  if (id === "splitL" && libIsOff()) return 0;
  return (id === "splitL" ? $("#lib") : $("#right")).getBoundingClientRect().width;
}
// 能拉到多寬要看「對面那一欄」：拉左欄扣右欄，拉右欄扣左欄（lib/studio-layout.mjs）
function splitLimit(id) {
  const s = SPLITS[id];
  return layoutOps.splitBounds({ editorW: $("#shell").getBoundingClientRect().width, otherW: paneWidth(id === "splitL" ? "splitR" : "splitL"), min: s.min, max: s.max });
}
function setSplit(id, px, remember = true) {
  const s = SPLITS[id], bounds = splitLimit(id), { min, max } = bounds;
  const w = layoutOps.clampWidth(px, bounds);
  $("#shell").style.setProperty(s.prop, `${w}px`);
  const el = splitEl(id);
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));
  el.setAttribute("aria-valuenow", String(w));
  if (remember) layoutSet(s.key, w);
}
function resetSplit(id) {
  $("#shell").style.removeProperty(SPLITS[id].prop);
  layoutSet(SPLITS[id].key, null);
  splitEl(id).setAttribute("aria-valuenow", String(Math.round(paneWidth(id))));
}
for (const id of Object.keys(SPLITS)) {
  const el = splitEl(id);
  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, w: paneWidth(id) };
    el.classList.add("drag");
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    setSplit(id, SPLITS[id].side === "left" ? drag.w + dx : drag.w - dx, false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove("drag");
    setSplit(id, paneWidth(id));
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => resetSplit(id));
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const grow = (e.key === "ArrowRight") === (SPLITS[id].side === "left");
    setSplit(id, paneWidth(id) + (grow ? SPLIT_STEP : -SPLIT_STEP));
  });
}

// 視窗變窄時，拉過的寬度重新夾回範圍，中間的影片不會被擠掉；變回寬時從記住的值夾，寬度會回來（只改畫面，不改記住的值）。
// 收起來的左欄不動，打開時再照記住的寬度（#175）
function reclampSplits() {
  if ($("#shell").hidden) return;
  for (const id of Object.keys(SPLITS)) {
    if (id === "splitL" && libIsOff()) continue;
    const saved = Number(layoutGet(SPLITS[id].key));
    if (saved > 0) setSplit(id, saved, false);
    else if ($("#shell").style.getPropertyValue(SPLITS[id].prop)) setSplit(id, paneWidth(id), false);
  }
}
window.addEventListener("resize", () => reclampSplits());

// 開機和開編輯頁時套用記住的寬度與收合狀態（編輯頁打開時右欄才量得到寬度）
function applyLayout() {
  setLibOff(layoutGet(LAYOUT_KEYS.off) === "1", false);
  for (const id of Object.keys(SPLITS)) {
    const saved = Number(layoutGet(SPLITS[id].key));
    if (saved > 0) setSplit(id, saved, false);
    else splitEl(id).setAttribute("aria-valuenow", String(Math.round(paneWidth(id))));
  }
}

// ---- 時間軸章節：說明欄的章節（沒有就用會後總結的），改說明欄就跟著變 ----
let chapTimer = 0, chapShown = "";
function renderChapters() {
  clearTimeout(chapTimer);
  const chapters = chapterOps.pickChapters(state.desc, state.p?.recap?.chapters);
  state.chaps = chapterOps.chapterSpans(chapters, eDur());
  etl.setChapters(state.chaps);
  showChapNow(video.currentTime * 1000);
}
function renderChaptersSoon() { clearTimeout(chapTimer); chapTimer = setTimeout(() => renderChapters(), 400); }
$("#descText").addEventListener("input", () => renderChaptersSoon());
// 播放時間旁邊顯示目前的章節
function showChapNow(ms) {
  const i = state.chaps?.length ? chapterOps.chapterAt(state.chaps, ms) : -1;
  const text = i >= 0 ? state.chaps[i].title : "";
  if (text === chapShown) return;
  chapShown = text;
  $("#chapNow").textContent = text;
  $("#chapNow").title = text;
}

// 編輯頁打開時（showEditor 呼叫）：影片庫已經讀過就不整份重掃，只更新這支的狀態（處理完變「有字幕」）
function enterLayout() {
  applyLayout();
  if (lib.view && state.id) { libNoteStatus(state.id, state.p?.status); markLibNow(); } else renderLib();
  renderChapters();
}
