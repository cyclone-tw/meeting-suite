"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定。
// 這個檔：「心智圖」頁籤（#101、#106、#111）。內容由會議轉錄 App 的 mindmap 模組產生（meeting-scribe#150）；
// 圖與它的按鈕列（縮放、展開收合、深淺色、大畫面、編輯、複製 Mermaid、下載圖片、匯出 .opml）是 App 的
// 共用元件 MindMap（web/shared/mindmap.js，meeting-scribe#155），和 App 一模一樣。工作室只做產生、停止、
// 在 Finder 顯示，以及編輯後把 mindmap.md／.opml／.svg 存回去（也存 Drive）。

const mapMod = () => (modList || []).find((m) => m.output === "mindmap") || null;
const mapResult = () => {
  const mod = mapMod();
  return (state.p?.modules || []).find((x) => (mod ? x.key === modKeyOf(mod, {}) : x.output === "mindmap")) || null;
};
// 主版號 1 才用（介面不相容時 App 會換主版號）
const mmLib = () => (window.MindMap?.mount && /^1\./.test(String(window.MindMap.version || "")) ? window.MindMap : null);

let mmHandle = null, mmShown = "", mmSaveTimer = 0, mmArmed = 0, mmPending = null, mmSaving = Promise.resolve();
const mmFileName = () => `${state.p?.name || "會議"}-心智圖`;   // 不翻：下載的檔名

// 把圖存回去：元件轉好的文字版與圖片一起送，伺服器寫檔、排 Drive。
// 專案與哪一份在改的當下就記下來（換專案後才存也不會存錯地方）；一次只送一份，照順序
function saveMap(map, { edited = false, id = state.id, key = mapResult()?.key } = {}) {
  mmSaving = mmSaving.catch(() => {}).then(() => saveMapNow(map, { edited, id, key }));
  return mmSaving;
}
async function saveMapNow(map, { edited, id, key }) {
  const lib = mmLib();
  if (!lib || !key || !map) return;
  try {
    const out = await post(`/api/projects/${id}/mindmap`, {
      key, edited, mindmap: map,
      markdown: lib.toMarkdown(map), opml: lib.toOpml(map), mermaid: lib.toMermaid(map), svg: lib.toSvg(map),
    });
    if (state.id !== id) return;
    state.p = { ...state.p, modules: (state.p.modules || []).map((x) => (x.key === out.module.key ? out.module : x)), ...(out.drive !== undefined ? { drive: out.drive } : {}) };
    mmShown = JSON.stringify(out.module.mindmap);
    renderMindNote();
    renderDrive();
    pollDrive();
  } catch (e) {
    if (state.id === id) showAlert(_("心智圖沒有存起來：{err}", { err: e.message }));
  }
}

function mmMount(r) {
  const lib = mmLib();
  if (!lib) return;
  if (!mmHandle) {
    mmHandle = lib.mount($("#mindView"), {
      map: r.mindmap, theme: "auto", editable: true, fileName: mmFileName(),
      // 一次編輯完成就呼叫（失焦、Enter、加刪移動、復原）；連續改時等一下再一起存
      onChange: (map) => {
        clearTimeout(mmSaveTimer);
        mmPending = { map, id: state.id, key: mapResult()?.key };
        mmSaveTimer = setTimeout(mmFlush, 1200);
      },
    });
  } else {
    mmHandle.set(r.mindmap);
    mmHandle.setFileName?.(mmFileName());
  }
  mmShown = JSON.stringify(r.mindmap);
}

// 還沒送出的修改馬上存（換專案、收掉元件、重新產生之前）
function mmFlush() {
  clearTimeout(mmSaveTimer);
  const p = mmPending;
  mmPending = null;
  return p ? saveMap(p.map, { edited: true, id: p.id, key: p.key }) : mmSaving;
}
// 換專案：先把上一個專案沒送出的修改存掉，再清掉「重新產生」的確認
function mmReset() {
  mmFlush();
  mmArmed = 0;
}

function renderMindNote() {
  const mod = mapMod(), saved = mapResult();
  const on = Boolean(modBusyId) && modBusyId === state.id && modBusyOutput === "mindmap";
  const note = $("#mindNote");
  note.className = "hint";
  if (on) note.textContent = _("會議轉錄 App 正在整理心智圖，一兩分鐘就好。可以繼續改字幕。");
  else if (modListError) { note.textContent = _("連不到會議轉錄 App，心智圖暫時不能用：{err}", { err: modListError }); note.className = "hint warn-text"; }
  else if (!modList) note.textContent = _("正在向會議轉錄 App 要功能清單…");
  else if (!mod) note.textContent = _("會議轉錄 App 還沒提供心智圖。");
  else if (saved && !mmLib()) { note.textContent = _("找不到會議轉錄 App 的心智圖元件（這台的 meeting-scribe 程式），畫不出圖；mindmap.md、.opml 還在資料夾裡。"); note.className = "hint warn-text"; }
  else if (saved?.stale) { note.textContent = _("產生心智圖之後字幕改過了。要讓它跟上，按「重新產生」。"); note.className = "hint warn-text"; }
  else if (saved) {
    const date = fmtDate(Date.parse(saved.edited_at || saved.created));
    const files = ["mindmap.md", "mindmap.opml", ...(saved.extra_files?.includes("mindmap.svg") ? ["mindmap.svg"] : [])].join(_("、"));
    note.textContent = saved.edited
      ? _("{date} 改過，存成資料夾裡的 {files}。按「編輯」可以直接改字、加減項目、調順序。", { date, files })
      : _("{date} {how}，存成資料夾裡的 {files}。按「編輯」可以直接改字、加減項目、調順序。", { date, how: recapHow(saved), files });
  } else note.textContent = _("把整場整理成主題、議題、重點、細節，畫成心智圖。還沒產生。");
}

function renderMind(fit = false) {
  const mod = mapMod(), saved = mapResult();
  const on = Boolean(modBusyId) && modBusyId === state.id && modBusyOutput === "mindmap";
  $("#tabMind").dataset.busy = on ? "1" : "";
  $("#mindMake").textContent = on ? _("正在產生…（一兩分鐘）") : mmArmed && Date.now() - mmArmed < 5000 ? _("確定蓋掉改過的？") : saved ? _("重新產生") : _("產生心智圖");
  $("#mindMake").disabled = !mod || Boolean(recapBusyId || modBusyId);
  $("#mindStop").hidden = !on;
  $("#mindReveal").hidden = !saved;
  const show = Boolean(saved?.mindmap) && Boolean(mmLib());
  $("#mindView").hidden = !show;
  if (show && (fit || !mmHandle || JSON.stringify(saved.mindmap) !== mmShown)) mmMount(saved);
  else if (!show && mmHandle) { mmFlush(); mmHandle.destroy(); mmHandle = null; mmShown = ""; }
  renderMindNote();
}

// 改過的心智圖：重新產生要在 5 秒內再按一次才蓋掉（和 App 一樣）
$("#mindMake").onclick = async () => {
  const mod = mapMod(), saved = mapResult();
  // 還在等著存的修改也算改過
  if ((saved?.edited || mmPending) && !(mmArmed && Date.now() - mmArmed < 5000)) {
    mmArmed = Date.now();
    renderMind();
    setTimeout(() => { mmArmed = 0; renderMind(); }, 5000);
    return;
  }
  mmArmed = 0;
  await mmFlush();   // 先把手上的修改存好，再蓋掉
  await makeModule(mod, {});
  const r = mapResult();
  if (r?.mindmap && mmLib()) await saveMap(r.mindmap);   // 補上 mindmap.svg（圖是頁面畫的）
};
$("#mindStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };
$("#mindReveal").onclick = async () => {
  const r = mapResult();
  try { await post(`/api/projects/${state.id}/reveal`, { what: "module", key: r?.key || "mindmap" }); } catch (e) { showAlert(e.message); }
};
