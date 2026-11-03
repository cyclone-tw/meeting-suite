"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：Discord 分軌標講者（#129）：開始處理前選 zip、填名字、補回沒錄到的聲音；編輯頁的「講者」面板；
// 設定裡的講者名冊（#132）。

// 開始處理前選的分軌 { zip, file, start, tracks: [{ user, name }] }；null 是不用
let trk = null;
// 編輯頁「講者」面板用的分軌
let spkCraig = null, spkBusy = false;

const craigWhen = (ms) => (ms ? new Date(ms).toLocaleString(UI_LANG === "en" ? "en-US" : "zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const craigSummary = (c) => _("{file}（{when} 開始錄、{n} 個人）", { file: c.file, when: craigWhen(c.start), n: c.tracks.length });

// 每個帳號一列，填字幕上要顯示的名字；記過的名字帶入。
// 認得的人（名冊裡有名字）收成一行，按「修改名字」才展開；新帳號照樣列出來填（#132）
function craigRows(tbody, craig, known) {
  const table = tbody.closest("table");
  tbody.innerHTML = craig.tracks.map((t, i) => `<tr${t.name ? " data-known" : ""}><td>${esc(t.user)}</td><td><input class="text-in" data-i="${i}" maxlength="12" value="${esc(t.name || "")}" placeholder="${esc(t.user)}" aria-label="${_("{user} 在字幕上的名字", { user: esc(t.user) })}"></td></tr>`).join("");
  const names = craig.tracks.filter((t) => t.name).map((t) => t.name);
  const fresh = craig.tracks.length - names.length;
  const expand = () => {
    for (const tr of tbody.querySelectorAll("tr[data-known]")) tr.hidden = false;
    table.hidden = false;
    known.hidden = true;
  };
  if (!names.length) { known.hidden = true; table.hidden = false; return; }
  // 名字一律用同一種色塊；「修改名字」用另一個醒目的顏色，才不會被當成普通文字
  known.innerHTML = `<span>${_("認得 {n} 位：", { n: names.length })}</span>${names.map((n) => `<span class="spk-chip">${esc(n)}</span>`).join("")}${fresh ? `<span>${_("新來的 {n} 位請在下面填名字", { n: fresh })}</span>` : ""}<button type="button" class="btn sm spk-edit">${_("修改名字")}</button>`;
  known.querySelector("button").onclick = expand;
  known.hidden = false;
  for (const tr of tbody.querySelectorAll("tr[data-known]")) tr.hidden = true;
  table.hidden = !fresh;
}
function craigNames(tbody, craig) {
  const out = {};
  for (const inp of tbody.querySelectorAll("input[data-i]")) {
    const v = inp.value.trim();
    if (v) out[craig.tracks[Number(inp.dataset.i)].user] = v;
  }
  return out;
}
async function pickCraig() {
  const r = await post("/api/pick-zip");
  return r.cancelled ? null : r.craig;
}

// ── 開始處理前（設定畫面）──
function trkShow(craig) {
  trk = craig || null;
  $("#trkFound").textContent = trk ? _("找到這場的 Discord 分軌：{summary}", { summary: craigSummary(trk) }) : _("沒有找到這場的 Discord 分軌（Craig 下載的 zip）。用 Discord 錄音的話可以自己選。");
  $("#trkBody").hidden = !trk;
  $("#trkClear").hidden = !trk;
  if (trk) craigRows($("#trkRows"), trk, $("#trkKnown"));
}
// 開始處理時一起送出；沒選分軌就不帶
const trkPayload = () => (trk ? { zip: trk.zip, names: craigNames($("#trkRows"), trk), fill: $("#trkFill").checked } : undefined);
$("#trkPick").onclick = async () => {
  try { const c = await pickCraig(); if (c) trkShow(c); } catch (e) { showAlert(e.message); }
};
$("#trkClear").onclick = () => trkShow(null);

// ── 編輯頁「講者」面板 ──
function spkShow(open) {
  $("#spkBox").hidden = !open;
  $("#spkOpen").setAttribute("aria-expanded", String(open));
  if (open) spkLoad();
}
$("#spkOpen").onclick = () => spkShow($("#spkBox").hidden);

// 換了影片：上一支的分軌不留著。處理時分軌對不起來（拿錯 zip）就打開面板說明
function spkReset(p) {
  spkCraig = null;
  $("#spkNote").textContent = "";
  const err = p?.tracks?.error && !p?.speakers ? _("處理時沒有標講者：{err}", { err: I18N.msg(p.tracks.error) }) : "";
  spkShow(Boolean(err));
  if (err) $("#spkNote").textContent = err;
}

async function spkLoad() {
  const id = state.id;
  $("#spkFound").textContent = _("找這場的分軌…");
  $("#spkApply").disabled = true;
  try {
    const r = await api(`/api/projects/${id}/speakers`);
    if (state.id === id) spkSet(r.craig);
  } catch (e) { if (state.id === id) $("#spkFound").textContent = e.message; }
}

function spkSet(c) {
  spkCraig = c || null;
  const done = Boolean(state.p?.speakers);
  $("#spkFound").textContent = spkCraig ? (done ? _("分軌：{summary}。改了名字就按「重新標講者」", { summary: craigSummary(spkCraig) }) : _("分軌：{summary}", { summary: craigSummary(spkCraig) })) : _("沒有找到這場的 Discord 分軌，請按「選 zip…」。");
  $("#spkTable").hidden = !spkCraig;
  $("#spkKnown").hidden = true;
  if (spkCraig) craigRows($("#spkRows"), spkCraig, $("#spkKnown"));
  $("#spkApply").textContent = done ? _("重新標講者") : _("標上講者");
  $("#spkApply").disabled = !spkCraig || spkBusy;
}
$("#spkPick").onclick = async () => {
  try { const c = await pickCraig(); if (c) spkSet(c); } catch (e) { $("#spkNote").textContent = e.message; }
};

$("#spkApply").onclick = async () => {
  if (!spkCraig || spkBusy) return;
  const id = state.id, craig = spkCraig, names = craigNames($("#spkRows"), craig);
  await flushSave();   // 伺服器標的是存好的字幕：先把剛改的存進去
  spkBusy = true;
  $("#spkApply").disabled = true;
  $("#spkNote").textContent = _("對齊分軌、判斷每句是誰講的…（大約十幾秒）");
  try {
    const r = await post(`/api/projects/${id}/speakers`, { zip: craig.zip, names, rev: state.p.rev });
    if (state.id !== id) return;
    const counts = Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => _("{name} {n} 句", { name: k, n })).join(_("、"));
    await openProject(id);   // 重新載入字幕（rev 也換新）
    if (state.id !== id) return;
    spkShow(true);
    const shown = counts || _("沒有判斷出講者");
    $("#spkNote").textContent = r.missing.length
      ? _("標好了：{counts}。注意：影片裡沒錄到 {names} 的聲音，他們講的話不在字幕裡；按下面的「重新處理這支影片…」會先把聲音補回去再重新辨識（要再付一次辨識費）", { counts: shown, names: r.missing.join(_("、")) })
      : _("標好了：{counts}", { counts: shown });
  } catch (e) {
    if (state.id === id) $("#spkNote").textContent = e.message;
  } finally {
    spkBusy = false;
    if (state.id === id) $("#spkApply").disabled = !spkCraig;
  }
};

// ── 設定裡的講者名冊（#132）──
// 改名：離開輸入框就存；刪除：按兩下（第一下變成「確定刪除？」）
function rosterRender(people) {
  $("#rosterTable").hidden = !people.length;
  $("#rosterEmpty").hidden = people.length > 0;
  $("#rosterRows").innerHTML = people.map((x) => `<tr data-user="${esc(x.user)}"><td>${esc(x.user)}</td>
    <td><input class="text-in" maxlength="12" value="${esc(x.name)}" placeholder="${x.name ? "" : _("還沒取名")}" aria-label="${_("{user} 在字幕上的名字", { user: esc(x.user) })}"></td>
    <td>${x.seen ? esc(x.seen.slice(5).replace("-", "/")) : "—"}</td>
    <td><button type="button" class="btn sm ghost" data-act="remove">${_("刪除")}</button></td></tr>`).join("");
  for (const tr of $("#rosterRows").querySelectorAll("tr")) {
    const user = tr.dataset.user, inp = tr.querySelector("input");
    let was = inp.value;
    // 改名不重畫整張表：連著改好幾個人時，游標才不會跳掉
    inp.onchange = async () => {
      try {
        const name = (await post("/api/speakers", { user, name: inp.value })).people.find((x) => x.user === user)?.name || "";
        inp.value = was = name;
        $("#rosterNote").textContent = _("{user} 改成「{name}」了。下次標講者就會用新名字。", { user, name });
      } catch (e) { inp.value = was; $("#rosterNote").textContent = e.message; }
    };
    const del = tr.querySelector('[data-act="remove"]');
    del.onclick = () => {
      if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = _("確定刪除？"); return; }
      rosterCall("/api/speakers/remove", { user }, _("已經把 {user} 從名冊刪掉。", { user }));
    };
  }
}
async function rosterCall(path, body, done) {
  try {
    rosterRender((await post(path, body)).people);
    $("#rosterNote").textContent = done;
    return true;
  } catch (e) {
    $("#rosterNote").textContent = e.message;
    return false;
  }
}
async function rosterLoad() {
  $("#rosterNote").textContent = "";
  try { rosterRender((await api("/api/speakers")).people); } catch (e) { $("#rosterNote").textContent = e.message; }
}
$("#settingsBtn").addEventListener("click", rosterLoad);
$("#rosterAdd").onclick = async () => {
  const user = $("#rosterUser").value.trim(), name = $("#rosterName").value;
  if (await rosterCall("/api/speakers", { user, name }, _("已經把 {user} 加進名冊。", { user }))) { $("#rosterUser").value = ""; $("#rosterName").value = ""; }
};
for (const id of ["#rosterUser", "#rosterName"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("#rosterAdd").click(); });
