"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：關閉工作室與啟動。

// ---- 關閉工作室 ----
// 先存檔；有工作在跑時伺服器回 409，在頁面上問一次再帶 force
async function quit(force = false) {
  await flushSave();
  if (state.id && (saveFailed || dirty)) {
    showAlert(_("還有修改沒存成功，先不關閉。等右上角顯示「已儲存」再關；如果是別的分頁改過，先重新整理。"));
    return;
  }
  try {
    await post("/api/shutdown", force ? { force: true } : {});
  } catch (e) {
    if (e.status === 409 && e.busy) {
      const kind = { prepare: _("辨識校對中"), burn: _("燒字幕中"), upload: _("上傳 YouTube 中"), suggest: _("找剪輯建議中"), clear: _("清理中"), short: _("輸出直式短片中"), shorts: _("AI 挑短片中"), names: _("AI 找名字中") };
      $("#quitBusy").innerHTML = e.busy.map((b) => `<li>${_("{name}：{kind}", { name: esc(b.name || _("一支影片")), kind: kind[b.kind] || b.kind })}</li>`).join("");
      if (!$("#quitDlg").open) $("#quitDlg").showModal();
      return;
    }
    showAlert(_("沒關成功：{msg}", { msg: e.message }));
    return;
  }
  for (const x of document.querySelectorAll("dialog[open]")) x.close();
  clearTimeout(pollTimer);
  clearTimeout(ytPoll);
  clearTimeout(burnPoll);
  clearTimeout(saveTimer);
  state.id = "";
  setView("closed");
  for (const id of ["#homeBtn", "#burnOpen", "#ytOpen", "#wikiOpen", "#settingsBtn", "#langBtn", "#quitBtn", "#steps"]) $(id).hidden = true;
  $("#projName").textContent = "";
  $("#privBadge").hidden = true;
  video.removeAttribute("src");
  video.load();
}
$("#quitBtn").onclick = () => quit();
$("#quitForce").onclick = () => quit(true);
$("#quitCancel").onclick = () => $("#quitDlg").close();

// ---- 介面語言（#152）：按鈕寫要切過去的語言；先存檔，沒存成功就不切。切換是重新載入，主機上跑的工作不受影響 ----
// 會議轉錄 App 的 checkout 不在（翻譯引擎載不到）時不顯示
$("#langBtn").hidden = !ENGINE;
$("#langBtn").textContent = UI_LANG === "en" ? "中文" : "EN";   // 不翻：寫的是要切過去的語言
$("#langBtn").title = UI_LANG === "en" ? "切換成中文介面" : "Switch to English";   // 不翻：同上
async function switchLang() {
  // 還沒建專案時只在頁面上的東西（預覽粗剪、打到一半的路徑、選好的字幕檔、改過的隱私或校對選項、正在下載的 YouTube）：重新載入就沒了，先問
  const pageOnly = !state.id && (!$("#trim").hidden || Boolean(typedPath()) || Boolean(home.sub.file) || Boolean(importKey)
    || home.privacy !== "public" || home.proofreader !== "claude");
  if (pageOnly && !confirm(_("切換語言會重新載入頁面，這裡還沒開始處理的剪輯與選項會不見。要切換嗎？"))) return;
  await flushSave();
  if (state.id && (saveFailed || dirty)) {
    showAlert(_("還有修改沒存成功，先不切換語言。等右上角顯示「已儲存」再切。"));
    return;
  }
  try { localStorage.setItem("studio.lang", UI_LANG === "en" ? "zh" : "en"); } catch (e) { /* 無痕模式：這次不記 */ }
  location.reload();
}
$("#langBtn").onclick = () => switchLang();


// ---- 開始 ----
const hashId = location.hash.slice(1);
if (/^[0-9a-f]{16}$/.test(hashId)) openProject(hashId); else showHome();
