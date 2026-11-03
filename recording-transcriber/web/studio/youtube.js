"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：YouTube 設定、上傳與交給 agent 寫 wiki。

// ---- 設定：YouTube 頻道（#40）----
// 每個人用自己的 Google Cloud OAuth 用戶端；頻道的授權存在這台 Mac 的鑰匙圈，預設值存在工作室的設定檔
let ytSettings = null, ytEditing = "", ytConnectTimer = 0;
const PRIVACY_LABEL = { private: _("私人"), unlisted: _("不公開"), public: _("公開") };
const SUBS_LABEL = { cc: _("CC 字幕"), burned: _("燒在畫面上") };
async function loadYt() { ytSettings = await api("/api/youtube"); return ytSettings; }
async function openSettings() {
  try { await loadYt(); } catch (e) { showAlert(e.message); return; }
  renderSettings();
  if (!$("#setDlg").open) $("#setDlg").showModal();
}
function channelDefaultsForm(c) {
  const d = c.defaults;
  const seg = (name, map, v) => `<div class="seg-ctl" role="group" data-k="${name}">${Object.entries(map).map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${k === v}">${l}</button>`).join("")}</div>`;
  const cats = ytSettings.categories.map(([k, l]) => `<option value="${k}"${k === d.categoryId ? " selected" : ""}>${esc(l)}</option>`).join("");
  return `<div class="ch-defaults" data-defaults="${esc(c.id)}">
    <p class="hint">${_("上傳時預先選好的設定，每次上傳前都還能改。")}</p>
    <div class="field"><span>${_("誰看得到")}</span>${seg("privacy", PRIVACY_LABEL, d.privacy)}</div>
    <div class="field"><span>${_("字幕")}</span>${seg("subtitles", { cc: _("CC 字幕（可開關）"), burned: _("燒在畫面上") }, d.subtitles)}</div>
    <label class="field"><span>${_("播放清單")}</span><select data-k="playlistId"><option value="">${_("不加入播放清單")}</option>${d.playlistId ? `<option value="${esc(d.playlistId)}" selected>${_("讀取中…")}</option>` : ""}</select></label>
    <div class="field-row">
      <label class="field"><span>${_("分類")}</span><select data-k="categoryId">${cats}</select></label>
      <label class="field"><span>${_("影片語言")}</span><input class="text-in" data-k="language" value="${esc(d.language)}" autocomplete="off"></label>
    </div>
    <label class="field"><span>${_("標籤（用逗號分開）")}</span><input class="text-in" data-k="tags" value="${esc(d.tags.join(", "))}" autocomplete="off"></label>
    <label class="check"><input type="checkbox" data-k="madeForKids"${d.madeForKids ? " checked" : ""}><span>${_("預設標成「為兒童打造」的影片")}</span></label>
    <label class="check"><input type="checkbox" data-k="notify"${d.notify ? " checked" : ""}><span>${_("公開時通知訂閱者")}</span></label>
    <div class="dlg-actions" style="margin-top:12px"><button class="btn sm" data-act="cancel">${_("取消")}</button><button class="btn sm solid" data-act="save">${_("儲存預設值")}</button></div>
  </div>`;
}
function renderSettings() {
  const y = ytSettings;
  $("#ytSetup").hidden = Boolean(y.client?.ready);
  $("#ytReady").hidden = !y.client?.ready;
  if (!y.client?.ready) return;
  $("#ytClientInfo").textContent = _("Google Cloud 專案：{name}（用戶端 {id}）", { name: y.client.project_id || _("（沒有名稱）"), id: y.client.client_id });
  $("#ytNoChannel").hidden = y.channels.length > 0;
  $("#ytConnect").textContent = y.channels.length ? _("再連結一個頻道") : _("連結 YouTube 頻道");
  $("#ytChannels").innerHTML = y.channels.map((c) => {
    const d = c.defaults;
    return `<li data-ch="${esc(c.id)}">
      <div class="ch-head">${c.thumb ? `<img src="${esc(c.thumb)}" alt="" referrerpolicy="no-referrer">` : '<span class="ch-ph"></span>'}
        <span class="ch-name">${esc(c.title)}</span>
        ${c.id === y.default_channel ? `<span class="badge">${_("預設")}</span>` : ""}
        ${c.connected ? "" : `<span class="badge warn">${_("授權失效，要重新連結")}</span>`}
        ${c.id === y.default_channel ? "" : `<button class="btn sm ghost" data-act="default">${_("設為預設")}</button>`}
        <button class="btn sm ghost" data-act="edit">${_("預設值…")}</button>
        <button class="btn sm ghost" data-act="remove">${_("移除")}</button>
      </div>
      <p class="hint" style="margin:4px 0 0 42px">${PRIVACY_LABEL[d.privacy]} · ${SUBS_LABEL[d.subtitles]} · ${esc(Object.fromEntries(y.categories)[d.categoryId] || "")}${d.madeForKids ? ` · ${_("兒童影片")}` : ""}</p>
      ${ytEditing === c.id ? channelDefaultsForm(c) : ""}
    </li>`;
  }).join("");
  if (ytEditing) loadDefaultPlaylists(ytEditing);
}
async function loadDefaultPlaylists(cid) {
  const sel = document.querySelector(`[data-defaults="${CSS.escape(cid)}"] select[data-k="playlistId"]`);
  if (!sel) return;
  const want = ytSettings.channels.find((c) => c.id === cid)?.defaults.playlistId || "";
  try {
    const { items } = await api(`/api/youtube/channels/${encodeURIComponent(cid)}/playlists`);
    sel.innerHTML = `<option value="">${_("不加入播放清單")}</option>` + items.map((x) => `<option value="${esc(x.id)}"${x.id === want ? " selected" : ""}>${esc(x.title)}</option>`).join("");
  } catch (e) {
    sel.innerHTML = `<option value="">${_("不加入播放清單")}</option>${want ? `<option value="${esc(want)}" selected>${_("（讀不到播放清單）")}</option>` : ""}`;
  }
}
$("#settingsBtn").onclick = openSettings;
$("#setClose").onclick = () => $("#setDlg").close();
$("#setDlg").addEventListener("close", () => { clearTimeout(ytConnectTimer); ytEditing = ""; $("#ytConnectNote").hidden = true; });
$("#ytGuide").onclick = () => post("/api/youtube/guide").catch((e) => showAlert(e.message));
$("#ytPick").onclick = $("#ytRepick").onclick = () => { $("#ytFile").value = ""; $("#ytFile").click(); };
$("#ytFile").onchange = async () => {
  const f = $("#ytFile").files[0];
  if (!f) return;
  try {
    ytSettings = await post("/api/youtube/client", { json: await f.text() });
    renderSettings();
    toast(_("OAuth 用戶端設定好了，接著按「連結 YouTube 頻道」。"), [], 5000);
  } catch (e) { showAlert(e.message); }
};
let removeArmed = "";
function armRemove(btn, key, label) {
  if (removeArmed === key) return true;
  removeArmed = key;
  btn.textContent = label;
  setTimeout(() => { if (removeArmed === key) { removeArmed = ""; renderSettings(); } }, 4000);
  return false;
}
$("#ytClientRemove").onclick = async (e) => {
  if (!armRemove(e.currentTarget, "client", _("再按一次：移除用戶端和所有頻道"))) return;
  removeArmed = "";
  try { ytSettings = await post("/api/youtube/client/remove"); renderSettings(); } catch (err) { showAlert(err.message); }
};
$("#ytConnect").onclick = async () => {
  try {
    const r = await post("/api/youtube/connect");
    $("#ytConnectLink").href = r.url;
    $("#ytConnectNote").hidden = false;
  } catch (e) { showAlert(e.message); return; }
  // 授權在另一個分頁完成：這裡每 2 秒看一次，頻道出現或授權恢復就更新（最多等 10 分鐘）
  const before = JSON.stringify(ytSettings.channels.map((c) => [c.id, c.connected]));
  const started = Date.now();
  clearTimeout(ytConnectTimer);
  const tick = async () => {
    if (!$("#setDlg").open || Date.now() - started > 600_000) return;
    try {
      await loadYt();
      if (JSON.stringify(ytSettings.channels.map((c) => [c.id, c.connected])) !== before) {
        $("#ytConnectNote").hidden = true;
        renderSettings();
        toast(_("頻道連結好了。"), [], 4000);
        return;
      }
    } catch { /* 下一輪再試 */ }
    ytConnectTimer = setTimeout(tick, 2000);
  };
  ytConnectTimer = setTimeout(tick, 2000);
};
$("#ytChannels").onclick = async (e) => {
  const li = e.target.closest("[data-ch]");
  if (!li) return;
  const cid = li.dataset.ch;
  const seg = e.target.closest(".seg-ctl button");
  if (seg) { for (const b of seg.parentElement.children) b.setAttribute("aria-pressed", String(b === seg)); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  try {
    if (act === "default") { ytSettings = await post(`/api/youtube/channels/${encodeURIComponent(cid)}/default`); renderSettings(); }
    if (act === "edit") { ytEditing = ytEditing === cid ? "" : cid; renderSettings(); }
    if (act === "cancel") { ytEditing = ""; renderSettings(); }
    if (act === "remove") {
      if (!armRemove(e.target.closest("button"), `ch:${cid}`, _("再按一次確定移除"))) return;
      removeArmed = "";
      ytSettings = await post(`/api/youtube/channels/${encodeURIComponent(cid)}/remove`);
      renderSettings();
    }
    if (act === "save") {
      const box = li.querySelector("[data-defaults]");
      const val = (k) => box.querySelector(`[data-k="${k}"]`);
      const pressed = (k) => val(k).querySelector('[aria-pressed="true"]')?.dataset.v;
      ytSettings = await post(`/api/youtube/channels/${encodeURIComponent(cid)}`, { defaults: {
        privacy: pressed("privacy"), subtitles: pressed("subtitles"), playlistId: val("playlistId").value, categoryId: val("categoryId").value,
        language: val("language").value.trim(), tags: val("tags").value, madeForKids: val("madeForKids").checked, notify: val("notify").checked,
      } });
      ytEditing = "";
      renderSettings();
      toast(_("預設值存好了。"), [], 3000);
    }
  } catch (err) { showAlert(err.message); }
};

// ---- 上傳 YouTube（#40）----
// 需要的影片沒有或過期，伺服器會先輸出（CC 字幕版用不燒字幕的剪接版或原片；燒在畫面上用燒字幕版），再上傳、掛字幕、加播放清單
let ytPoll = 0, ytPrivacy = "private", ytSubsMode = "cc";
const ytDlg = $("#ytDlg");
const cutsKeyOf = (cuts) => (cuts || []).map((c) => `${c.start}-${c.end}`).join(",");
function setSeg(sel, v) { for (const b of document.querySelectorAll(`${sel} button`)) b.setAttribute("aria-pressed", String(b.dataset.v === v)); }
function ytChannelObj() { return ytSettings?.channels.find((c) => c.id === $("#ytChannel").value); }
function applyChannelDefaults(c) {
  const d = c.defaults;
  ytPrivacy = d.privacy; ytSubsMode = d.subtitles;
  setSeg("#ytPrivacy", ytPrivacy); setSeg("#ytSubs", ytSubsMode);
  $("#ytAlsoCc").checked = true;
  $("#ytAlsoCcRow").hidden = ytSubsMode !== "burned";
  $("#ytWhen").hidden = true;
  // 頻道預設的標籤在前，AI 依內容建議的接在後面（#46）；重複的只留一個
  // 總長照 YouTube 的算法守 500 字（有空白的標籤多算 2，標籤之間各 1），超過就不再加建議
  const sug = state.p?.youtube_suggest?.tags || [];
  const tags = [...d.tags];
  const cost = (t) => [...t].length + (/\s/.test(t) ? 2 : 0);
  let used = tags.reduce((n, t) => n + cost(t), 0) + Math.max(0, tags.length - 1);
  for (const t of sug) {
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    if (used + cost(t) + (tags.length ? 1 : 0) > 500) break;
    used += cost(t) + (tags.length ? 1 : 0);
    tags.push(t);
  }
  $("#ytTags").value = tags.join(", ");
  $("#ytTagsHint").textContent = sug.length ? _("已經帶入 AI 依內容建議的標籤，可以改或刪。") : "";
  $("#ytCategory").innerHTML = ytSettings.categories.map(([k, l]) => `<option value="${k}"${k === d.categoryId ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("#ytLang").value = d.language;
  $("#ytKids").checked = d.madeForKids;
  $("#ytNotify").checked = d.notify;
  loadUploadPlaylists(c.id, d.playlistId);
  ytPlan();
}
async function loadUploadPlaylists(cid, want) {
  const sel = $("#ytPlaylist");
  sel.innerHTML = `<option value="">${_("不加入播放清單")}</option>${want ? `<option value="${esc(want)}" selected>${_("讀取中…")}</option>` : ""}`;
  try {
    const { items } = await api(`/api/youtube/channels/${encodeURIComponent(cid)}/playlists`);
    if ($("#ytChannel").value !== cid) return;
    sel.innerHTML = `<option value="">${_("不加入播放清單")}</option>` + items.map((x) => `<option value="${esc(x.id)}"${x.id === want ? " selected" : ""}>${esc(x.title)}</option>`).join("");
  } catch {
    if (want) sel.innerHTML = `<option value="">${_("不加入播放清單")}</option><option value="${esc(want)}" selected>${_("（讀不到播放清單名稱）")}</option>`;
  }
}
function ytCounts() {
  const t = [...$("#ytTitle").value.trim()].length, b = utf8Len($("#ytDesc").value);
  $("#ytTitleCount").textContent = _("{n} / 100 字", { n: t });
  $("#ytTitleCount").classList.toggle("over", t > 100 || !t);
  $("#ytDescCount").textContent = _("{n} / 5000 位元組（中文一個字算 3）", { n: b });
  $("#ytDescCount").classList.toggle("over", b > 5000);
}
// 說明這次會做什麼：要不要先輸出、字幕怎麼上
function ytPlan() {
  const p = state.p, outs = p.outputs || {}, cuts = state.cuts;
  let how;
  if (ytSubsMode === "burned") {
    how = outs.burn && outs.burn.rev === state.rev && (outs.burn.style || "outline") === state.style && (outs.burn.lang_mode || "") === (state.foreign ? state.langMode : "") ? _("用已經燒好字幕的影片上傳。") : _("會先把字幕燒進影片（要花幾分鐘），再上傳。");
    if ($("#ytAlsoCc").checked) how += _("最後也把字幕檔掛成 CC 字幕。");
  } else if (!cuts.length) how = _("直接上傳原始影片，再把字幕檔掛成 CC 字幕。");
  else how = outs.cut && outs.cut.cuts === cutsKeyOf(cuts) ? _("用已經輸出的剪接版上傳，再掛上 CC 字幕。") : _("會先輸出剪接好的影片（不燒字幕，要花幾分鐘），再上傳，最後掛上 CC 字幕。");
  const when = ytPrivacy === "schedule" ? _("上傳後先是私人，到了排定時間自動公開。") : ytPrivacy === "public" ? _("上傳完成就公開。") : "";
  $("#ytPlan").textContent = _("{how}{when} 上傳中可以繼續改字，但要再上傳一次才會更新到 YouTube。", { how, when });
}
async function openYoutube() {
  if (descBusyId === state.id) { showAlert(_("說明欄還在重新寫，寫好再上傳（大約一分鐘）。")); return; }
  await flushSave();
  try { [ytSettings, state.p] = await Promise.all([api("/api/youtube"), api(`/api/projects/${state.id}`)]); } catch (e) { showAlert(e.message); return; }
  const usable = ytSettings.client?.ready ? ytSettings.channels : [];
  $("#ytNone").hidden = usable.length > 0;
  $("#ytForm").hidden = !usable.length;
  $("#ytStart").hidden = !usable.length;
  $("#ytRun").hidden = true;
  $("#ytResult").hidden = true;
  $("#ytCancel").hidden = true;
  if (usable.length) {
    const last = state.p.youtube;
    $("#ytChannel").innerHTML = usable.map((c) => `<option value="${esc(c.id)}"${c.connected ? "" : " disabled"}>${esc(c.title)}${c.connected ? "" : _("（授權失效，到設定重新連結）")}</option>`).join("");
    const pick = [last?.channel, ytSettings.default_channel, ...usable.map((c) => c.id)].find((id) => usable.some((c) => c.id === id && c.connected));
    if (pick) $("#ytChannel").value = pick;
    $("#ytStart").disabled = !pick;
    // 名稱：上次上傳用的和 AI 建議的（#46）取比較新的那個；都沒有才用檔名
    const sug = state.p.youtube_suggest;
    const sugNewer = sug?.title && (!last?.title || Date.parse(sug.created || 0) > Date.parse(last.started || 0));
    $("#ytTitle").value = (sugNewer ? sug.title : last?.title) || state.p.name;
    $("#ytDesc").value = cutOps.remapDescription(state.desc, state.cuts);
    if (ytChannelObj()) applyChannelDefaults(ytChannelObj());
    ytCounts();
    const done = last?.video_id && last.status !== "uploading";
    // 從 YouTube 下載的別人的影片（#56）：提醒上傳前要取得作者同意
    const src = state.p?.source;
    $("#ytOthers").hidden = !src?.downloaded;
    if (src?.downloaded) $("#ytOthers").textContent = _("這支是從 YouTube 下載的別人的影片{by}。上傳到自己的頻道前，要先取得作者同意；不然可能侵權，影片也可能被 YouTube 下架。", { by: src.uploader ? _("（作者：{name}）", { name: src.uploader }) : "" });
    $("#ytAgain").hidden = !done;
    if (done) $("#ytAgain").innerHTML = _("這支在 {date} 上傳過到「{ch}」（{link}）。再上傳會變成 YouTube 上的另一支新影片。", { date: esc(fmtDate(Date.parse(last.finished || last.started))), ch: esc(last.channel_title), link: `<a href="${esc(last.url)}" target="_blank" rel="noopener">${_("看影片")}</a>` });
    // 只是要補 CC 字幕（#71）：不用重傳影片，放在最上面，免得按到下面的「上傳」
    $("#ytAgainCc").hidden = !(done && ytNeedsCc(last));
    $("#ytAgainCcBtn").disabled = false;
    $("#ytAgainCcBtn").textContent = _("只補上 CC 字幕");
  }
  if (!ytDlg.open) ytDlg.showModal();
  if (state.p.job?.kind === "upload" || state.p.youtube?.status === "uploading") refreshYt();
}
$("#ytOpen").onclick = openYoutube;

// 交給 coding agent 寫 wiki（#49）：先存檔，交接單才拿得到最新的字幕和說明欄；交過一次再交要先確認
async function handoffToWiki(force = false, id = state.id) {
  // id 在按下時就固定：確認提示留著時換了影片，也不會交到另一支
  if (!id || id !== state.id) return;
  if (descBusyId === id) { showAlert(_("說明欄還在重新寫，寫好再交（大約一分鐘）。")); return; }
  const b = $("#wikiOpen");
  b.disabled = true;
  try {
    await flushSave();
    const r = await post(`/api/projects/${id}/handoff`, { force });
    if (state.p && state.id === id) state.p.handoff = r.handoff;
    toast(_("交好了：{folder}。之後跟 coding agent 說「處理待寫 wiki」，它會整理到 wiki。", { folder: esc(r.folder) }), [], 12000);
  } catch (e) {
    if (!e.handoff) { showAlert(e.message); return; }
    const when = new Date(e.handoff.at).toLocaleString(UI_LANG === "en" ? "en-US" : "zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    toast(_("這支 {when} 已經交過一次（{name}）。要再交一份新的嗎？", { when: esc(when), name: esc(e.handoff.name) }), [{ label: _("再交一份"), solid: true, run: () => handoffToWiki(true, id) }, { label: _("不用") }], 0);
  } finally { b.disabled = false; }
}
$("#wikiOpen").onclick = () => handoffToWiki();
$("#ytToSettings").onclick = () => { ytDlg.close(); openSettings(); };
$("#ytChannel").onchange = () => { const c = ytChannelObj(); if (c) applyChannelDefaults(c); };
$("#ytTitle").oninput = ytCounts;
$("#ytDesc").oninput = ytCounts;
$("#ytPrivacy").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  ytPrivacy = b.dataset.v;
  setSeg("#ytPrivacy", ytPrivacy);
  $("#ytWhen").hidden = ytPrivacy !== "schedule";
  if (ytPrivacy === "schedule" && !$("#ytWhen").value) {
    const t = new Date(Date.now() + 86_400_000);
    t.setMinutes(0, 0, 0);
    $("#ytWhen").value = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  ytPlan();
};
$("#ytSubs").onclick = (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  ytSubsMode = b.dataset.v;
  setSeg("#ytSubs", ytSubsMode);
  $("#ytAlsoCcRow").hidden = ytSubsMode !== "burned";
  ytPlan();
};
$("#ytAlsoCc").onchange = () => ytPlan();
$("#ytStart").onclick = async () => {
  const c = ytChannelObj();
  if (!c) return;
  let publishAt = "";
  if (ytPrivacy === "schedule") {
    const t = new Date($("#ytWhen").value);
    if (!$("#ytWhen").value || Number.isNaN(t.getTime())) { showAlert(_("請選公開的時間")); return; }
    publishAt = t.toISOString();
  }
  $("#ytStart").disabled = true;
  await flushSave();
  try {
    await post(`/api/projects/${state.id}/youtube`, {
      channel: c.id, title: $("#ytTitle").value, description: $("#ytDesc").value, privacy: ytPrivacy === "schedule" ? "private" : ytPrivacy, publishAt,
      subtitles: ytSubsMode, alsoCc: ytSubsMode === "burned" && $("#ytAlsoCc").checked, playlistId: $("#ytPlaylist").value, tags: $("#ytTags").value, categoryId: $("#ytCategory").value, language: $("#ytLang").value.trim(),
      madeForKids: $("#ytKids").checked, notify: $("#ytNotify").checked,
    });
  } catch (e) { showAlert(e.message); $("#ytStart").disabled = false; return; }
  $("#ytStart").disabled = false;
  setTimeout(refreshYt, 300);
};
const YT_STEPS = [["export", _("輸出影片")], ["upload", _("上傳影片")], ["captions", _("掛上 CC 字幕")], ["playlist", _("加入播放清單")]];
async function refreshYt() {
  clearTimeout(ytPoll);
  if (!ytDlg.open) return;
  let p;
  try { p = await api(`/api/projects/${state.id}`); } catch (e) { showAlert(e.message); return; }
  state.p = { ...state.p, outputs: p.outputs, youtube: p.youtube, burn: p.burn };
  const running = p.job?.kind === "upload", y = p.youtube || {};
  $("#ytForm").hidden = true;
  $("#ytNone").hidden = true;
  // 上傳好了就不再顯示「上傳」：表單收起來了，按下去會用看不到的設定再傳一支（要再傳就重新打開這個視窗）
  $("#ytStart").hidden = running || y.status === "done";
  $("#ytCancel").hidden = !running;
  $("#ytRun").hidden = !running;
  $("#ytResult").hidden = running;
  if (running) {
    const order = YT_STEPS.map(([k]) => k), at = order.indexOf(p.job.step);
    const shown = YT_STEPS.filter(([k]) => (p.job.steps || order).includes(k));
    $("#ytSteps").innerHTML = shown.map(([k, l]) => `<li class="${order.indexOf(k) < at ? "done" : k === p.job.step ? "now" : ""}">${l}</li>`).join("");
    const x = p.job.progress || 0;
    $("#ytBar").value = x;
    $("#ytPct").textContent = p.job.step === "export" || p.job.step === "upload"
      ? _("{pct}%　可以關掉這個視窗繼續改字，上傳會在背景繼續。", { pct: Math.round(x * 100) })
      : _("快好了…");
    ytPoll = setTimeout(refreshYt, 1000);
    return;
  }
  const warn = (y.warnings || []).map((w) => `<p class="hint warn-text">${esc(I18N.msg(w))}</p>`).join("");
  const links = y.video_id ? `<div class="yt-links"><a class="btn solid" href="${esc(y.url)}" target="_blank" rel="noopener">${_("在 YouTube 看")}</a><a class="btn" href="${esc(y.studio_url)}" target="_blank" rel="noopener">${_("到 YouTube Studio 編輯")}</a></div>` : "";
  const vis = y.publish_at ? _("排定在 {date} 公開", { date: esc(fmtDate(Date.parse(y.publish_at))) }) : PRIVACY_LABEL[y.privacy] || "";
  const html = {
    done: `<p><b>${_("上傳好了。")}</b>${_("「{title}」已經在「{ch}」，目前是{vis}{cc}。YouTube 處理畫質還要幾分鐘。", { title: esc(y.title), ch: esc(y.channel_title), vis, cc: y.cc_added || (y.subtitles === "cc" && !(y.warnings || []).length) ? _("，CC 字幕也掛上了") : "" })}</p>`,
    failed: `<p class="warn-text"><b>${_("沒有上傳成功：")}</b>${esc(I18N.msg(y.error || ""))}</p>`,
    cancelled: `<p>${_("已停止。")}${y.video_id ? _("影片已經傳上去了，只是後面的步驟沒做完。") : ""}</p>`,
  }[y.status] || "";
  // 事後補 CC 字幕（#71）：燒在畫面上的、停在半路的、或當時字幕沒掛成功的
  const addCc = ytNeedsCc(y)
    ? `<div class="yt-addcc"><p class="hint">${y.subtitles === "burned" ? _("畫面上已經燒了字。另外掛上 CC 字幕，YouTube 才能搜尋影片裡說的話、自動翻成其他語言；通常要觀眾自己按 CC 才會出現。") : _("CC 字幕還沒掛上去。")}${_("會用現在的字幕（上傳後改過的字也算）。")}</p><button class="btn" id="ytAddCc">${_("補上 CC 字幕")}</button></div>`
    : "";
  $("#ytResult").innerHTML = html + warn + addCc + links;
  if ($("#ytAddCc")) $("#ytAddCc").onclick = addCcToYoutube;
  if (y.status === "failed" || y.status === "cancelled") { $("#ytForm").hidden = false; $("#ytStart").textContent = _("再試一次"); }
}
// 上傳過、還沒掛 CC 字幕：條件和伺服器的 needsCc 一樣
function ytNeedsCc(y = {}) {
  const ccFailed = (y.warnings || []).some((w) => w.startsWith("CC 字幕沒有掛上去"));   // 不翻：和伺服器存的警告文字比對
  return Boolean(y.video_id) && ["done", "cancelled"].includes(y.status) && !y.cc_added && (y.status === "cancelled" || y.subtitles === "burned" || ccFailed);
}
async function addCcToYoutube(e) {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = _("正在掛上 CC 字幕…");
  try {
    await flushSave();
    await post(`/api/projects/${state.id}/captions`);
    toast(_("CC 字幕補上了。YouTube 處理好之後，影片的字幕選單就看得到。"), [], 6000);
  } catch (err) { showAlert(err.message); }
  refreshYt();
}
$("#ytAgainCcBtn").onclick = addCcToYoutube;
$("#ytCancel").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } setTimeout(refreshYt, 500); };
$("#ytClose").onclick = () => ytDlg.close();
ytDlg.addEventListener("close", () => { clearTimeout(ytPoll); $("#ytStart").innerHTML = `<svg class="icon"><use href="#i-upload"/></svg>${_("上傳")}`; });
