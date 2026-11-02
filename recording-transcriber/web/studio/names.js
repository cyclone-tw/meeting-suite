"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：AI 更正名字（#60）：用一句話說哪些人名、地名寫錯，AI 找出各種寫法，勾選後一次改好。

// 這一輪的建議：[{ wrong, right, on, count, ctx }]；只屬於 namesFor 那支影片
let namesPairs = [], namesFor = "", namesBusyId = "";

function namesShow(open) {
  $("#namesBox").hidden = !open;
  $("#namesOpen").setAttribute("aria-expanded", String(open));
  if (open) $("#namesIn").focus();
}
$("#namesOpen").onclick = () => namesShow($("#namesBox").hidden);

// 換了影片：上一支的建議不留著（說明欄打的字留著，可以接著用）
function namesReset() {
  namesPairs = [];
  namesFor = "";
  $("#namesResult").hidden = true;
  $("#namesNote").textContent = "";
  showNamesBusy();
}

function showNamesBusy() {
  const on = Boolean(namesBusyId) && namesBusyId === state.id;
  $("#namesFind").disabled = Boolean(namesBusyId);
  $("#namesFind").textContent = on ? "AI 正在找…（約一分鐘）" : "請 AI 找出來";
  $("#namesStop").hidden = !on;
}

async function namesFind() {
  const instruction = $("#namesIn").value.trim();
  if (!instruction) { $("#namesNote").textContent = "先寫哪些名字或地名寫錯了，例如「B、C 都是 A」。"; $("#namesIn").focus(); return; }
  const id = state.id;
  await flushSave();   // AI 要看的是伺服器上的字幕：先把剛改的存進去
  namesBusyId = id;
  showNamesBusy();
  $("#namesResult").hidden = true;
  $("#namesNote").textContent = "";
  try {
    const r = await post(`/api/projects/${id}/names`, { instruction });
    if (state.id !== id) return;
    namesPreview(r.pairs || [], r.dropped || 0);
  } catch (e) {
    if (state.id === id) showAlert(e.message);
  } finally {
    namesBusyId = "";
    showNamesBusy();
  }
}
$("#namesFind").onclick = namesFind;
$("#namesStop").onclick = async () => { try { await post(`/api/projects/${state.id}/cancel`); } catch (e) { showAlert(e.message); } };

// 出現次數和上下文照「現在」的字幕算：等 AI 的時候可能又改過字，已經找不到的就不列
function namesPreview(pairs, dropped) {
  const counts = ops.applyNamePairs(state.cues, pairs).perPair;
  namesPairs = pairs.map((p, k) => ({ wrong: p.wrong, right: p.right, on: true, count: counts[k], ctx: ops.contextOf(state.cues, p.wrong) }))
    .filter((p) => p.count > 0);
  namesFor = state.id;
  const gone = pairs.length - namesPairs.length + dropped;
  if (!namesPairs.length) {
    $("#namesResult").hidden = true;
    $("#namesNote").textContent = `AI 沒找到要改的地方${gone ? `（有 ${gone} 組在字幕裡找不到或不合規，已略過）` : ""}。可以把說明寫得更清楚一點再試。`;
    return;
  }
  $("#namesNote").textContent = `找到 ${namesPairs.length} 組，勾選要改的${gone ? `（另有 ${gone} 組在字幕裡找不到或不合規，已略過）` : ""}。`;
  $("#namesList").innerHTML = namesPairs.map((p, k) => `<li><input type="checkbox" data-k="${k}" checked aria-label="改這一組"><div class="head"><span class="wrong">${esc(p.wrong)}</span><span class="arrow">→</span><b>${esc(p.right)}</b><span class="muted">${p.count} 處</span></div>${p.ctx ? `<span class="ex">${p.ctx.before ? "…" : ""}${esc(p.ctx.before)}<mark>${esc(p.ctx.hit)}</mark>${esc(p.ctx.after)}${p.ctx.after ? "…" : ""}</span>` : ""}</li>`).join("");
  $("#namesResult").hidden = false;
  namesApplyLabel();
}

function namesApplyLabel() {
  const n = namesPairs.filter((p) => p.on).reduce((s, p) => s + p.count, 0);
  $("#namesApply").disabled = !n;
  $("#namesApply").textContent = n ? `套用勾選的（${n} 處）` : "套用勾選的";
}
$("#namesList").onchange = (e) => {
  const box = e.target.closest?.("input[data-k]");
  const p = box && namesPairs[Number(box.dataset.k)];
  if (!p) return;
  p.on = box.checked;
  box.closest?.("li")?.classList.toggle("off", !p.on);
  namesApplyLabel();
};

function namesClose() {
  namesPairs = [];
  $("#namesResult").hidden = true;
  $("#namesNote").textContent = "";
  namesShow(false);
}
$("#namesCancel").onclick = namesClose;

// 套用：一次改完、標成「AI 改過」，整批可以一次復原；勾了「加入錯字表」就一起加進去（只加有改到的）
async function namesApply() {
  if (namesFor !== state.id) { namesReset(); return; }
  const chosen = namesPairs.filter((p) => p.on).map(({ wrong, right }) => ({ wrong, right }));
  if (!chosen.length) return;
  pushUndo();
  const mark = state.undo[state.undo.length - 1];
  const r = ops.applyNamePairs(state.cues, chosen);
  if (!r.count) {
    state.undo.pop();
    $("#undoBtn").disabled = !state.undo.length;
    namesClose();
    showAlert(r.skipped ? "改完的句子會超過 200 字，沒有改。" : "字幕裡已經找不到這些錯字了，可能剛剛改過。");
    return;
  }
  state.cues = r.cues;
  changed();
  renderList();
  showCue();
  drawOverlay();
  const toCorr = $("#namesCorr").checked ? chosen.filter((_, k) => r.perPair[k] > 0) : [];
  namesClose();
  // 復原只認這一批：中間又改了別的，就不會誤把別的修改退掉
  const back = [{ label: "復原", run: () => { if (state.undo[state.undo.length - 1] === mark) undo(); else showAlert("之後又改過字幕，請用上方的「復原」一步一步退。"); } }];
  const done = `已改 ${r.count} 處${r.skipped ? `（${r.skipped} 句改完會超過 200 字，沒有改）` : ""}，改過的句子在「AI 改過」裡。`;
  toast(`${done}${toCorr.length ? "正在加入錯字表…" : ""}`, back, 15000);
  if (!toCorr.length) return;
  try {
    const c = await post("/api/corrections", { pairs: toCorr.map((p) => [p.wrong, p.right]) });
    toast(`${done}${c.added ? `已加入錯字表 ${c.added} 組（共 ${c.hints + c.fixed} 組，存在 mini）。` : "錯字表裡都已經有了。"}`, back, 15000);
    loadCorr(true);
  } catch (e) { showAlert(`字幕改好了，但錯字表沒加成功：${e.message}`); }
}
$("#namesApply").onclick = namesApply;
