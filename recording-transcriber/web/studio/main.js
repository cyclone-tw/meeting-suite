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
    showAlert("還有修改沒存成功，先不關閉。等右上角顯示「已儲存」再關；如果是別的分頁改過，先重新整理。");
    return;
  }
  try {
    await post("/api/shutdown", force ? { force: true } : {});
  } catch (e) {
    if (e.status === 409 && e.busy) {
      const kind = { prepare: "辨識校對中", burn: "燒字幕中", upload: "上傳 YouTube 中", suggest: "找剪輯建議中", clear: "清理中", short: "輸出直式短片中", shorts: "AI 挑短片中", names: "AI 找名字中" };
      $("#quitBusy").innerHTML = e.busy.map((b) => `<li>${esc(b.name || "一支影片")}：${kind[b.kind] || b.kind}</li>`).join("");
      if (!$("#quitDlg").open) $("#quitDlg").showModal();
      return;
    }
    showAlert(`沒關成功：${e.message}`);
    return;
  }
  for (const x of document.querySelectorAll("dialog[open]")) x.close();
  clearTimeout(pollTimer);
  clearTimeout(ytPoll);
  clearTimeout(burnPoll);
  clearTimeout(saveTimer);
  state.id = "";
  setView("closed");
  for (const id of ["#homeBtn", "#burnOpen", "#ytOpen", "#wikiOpen", "#settingsBtn", "#quitBtn", "#steps"]) $(id).hidden = true;
  $("#projName").textContent = "";
  $("#privBadge").hidden = true;
  video.removeAttribute("src");
  video.load();
}
$("#quitBtn").onclick = () => quit();
$("#quitForce").onclick = () => quit(true);
$("#quitCancel").onclick = () => $("#quitDlg").close();


// ---- 開始 ----
const hashId = location.hash.slice(1);
if (/^[0-9a-f]{16}$/.test(hashId)) openProject(hashId); else showHome();
