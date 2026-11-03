"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：共用：API、提示、畫面切換、格式化。

// 介面中英切換（#152）：靜態畫面照字典換字（i18n.js 決定了語言），換好才顯示
I18N.translate(document.documentElement);
document.documentElement.classList.remove("i18n-wait");

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
// 伺服器設定好的選用功能（handoff、icloud），沒設定的按鈕不顯示
const FEATURES = new Set((document.querySelector('meta[name="studio-features"]')?.content || "").split(/\s+/).filter(Boolean));
const SIZE_PX = { small: 16, medium: 20, large: 24 };
const STEP_ORDER = ["preview", "tracks", "fill", "extract", "asr", "proofread", "describe", "speakers"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "X-Studio-Token": TOKEN, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  const j = await r.json().catch(() => ({}));
  // 主機的錯誤訊息是中文：照字典換成介面的語言（I18N.msg 認得帶 {名稱} 的訊息，查不到照原樣）
  if (!r.ok) throw Object.assign(new Error(j.error ? I18N.msg(j.error) : `HTTP ${r.status}`), { status: r.status, busy: j.busy, handoff: j.handoff });
  return j;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

// ---- 共用 ----
let alertTimer = 0;
function showAlert(msg) {
  $("#alertText").textContent = msg;
  $("#alert").hidden = false;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { $("#alert").hidden = true; }, 12000);
}
$("#alertClose").onclick = () => { $("#alert").hidden = true; };

let toastTimer = 0;
function toast(html, actions = [], ms = 9000) {
  const t = $("#toast");
  t.innerHTML = `<span>${html}</span>`;
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = `btn sm${a.solid ? " solid" : ""}`;
    b.textContent = a.label;
    b.onclick = async () => { t.hidden = true; await a.run?.(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setStep(n) {
  for (const li of document.querySelectorAll("#steps li")) {
    const s = Number(li.dataset.s);
    li.classList.toggle("now", s === n);
    li.classList.toggle("done", s < n);
  }
}

let homePosters = null;   // 首頁縮圖的串流，離開首頁就中止
let dlRun = 0;            // 等 iCloud 下載的輪次；換一輪或離開首頁，舊的等待就停（#20、#22）
function setView(v) {
  for (const id of ["home", "trim", "processing", "editor", "closed"]) $(`#${id}`).hidden = id !== v;
  $("#homeBtn").hidden = v === "home";
  $("#burnOpen").hidden = v !== "editor";
  $("#ytOpen").hidden = v !== "editor";
  $("#wikiOpen").hidden = v !== "editor" || !FEATURES.has("handoff");
  if (v !== "editor") { $("#saveNote").textContent = ""; video.pause(); if (typeof leaveEditorTimeline === "function") leaveEditorTimeline(); }
  if (v !== "trim") pvideo.pause();
  if (v !== "home") {
    homePosters?.abort();
    dlRun += 1;   // 改開了別的東西：不要等下載完又把畫面拉回預覽
    if ($("#toast").textContent.includes(_("正在下載到這台電腦"))) $("#toast").hidden = true;
  }
  if (v === "home") { $("#projName").textContent = ""; $("#privBadge").hidden = true; }
}

const fmtClock = (ms) => {
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtDate = (ms) => new Date(ms).toLocaleString(UI_LANG === "en" ? "en-US" : "zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
