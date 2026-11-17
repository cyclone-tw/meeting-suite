"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：學習筆記（#172）：影片下方的時間戳筆記（Markdown），存成專案資料夾的 notes.md（lib/study-notes.mjs）。

const notes = { items: [], loaded: false, editing: null, newAt: 0, draft: "", busy: false, delArmed: -1, delAt: 0 };
const NOTES_OPEN_KEY = "studio.notesOpen";

// 編輯頁打開時（showEditor 呼叫）：換成這支影片的筆記
function notesReset() {
  Object.assign(notes, { items: [], loaded: false, editing: null, newAt: 0, draft: "", busy: false, delArmed: -1 });
  let open = true;
  try { open = localStorage.getItem(NOTES_OPEN_KEY) !== "0"; } catch (e) { /* 讀不到照預設 */ }
  setNotesOpen(open, false);
  renderNotes();
  loadNotes();
}
// 讀成功之前不准新增：存檔是整份覆寫，用空清單存會把檔裡原本的筆記蓋掉（#175）
async function loadNotes() {
  const id = state.id;
  let r;
  try { r = await api(`/api/projects/${id}/notes`); } catch (e) {
    if (state.id === id) showAlert(_("讀不到這支影片的筆記：{msg}", { msg: e.message }));
    return;
  }
  if (state.id !== id) return;
  notes.items = r.notes || [];
  notes.loaded = true;
  renderNotes();
}
// 整份存回去；伺服器整理過（排序、去空白）的結果再畫一次
async function saveNotes(items) {
  const id = state.id;
  notes.busy = true;
  try {
    const r = await api(`/api/projects/${id}/notes`, { method: "PUT", body: JSON.stringify({ notes: items }) });
    if (state.id !== id) return false;
    notes.items = r.notes || [];
    notes.editing = null;
    return true;
  } catch (e) {
    showAlert(e.message);
    return false;
  } finally {
    notes.busy = false;
    if (state.id === id) renderNotes();
  }
}

function setNotesOpen(open, remember = true) {
  $("#notesBody").hidden = !open;
  $("#notesToggle").setAttribute("aria-expanded", String(open));
  if (remember) { try { localStorage.setItem(NOTES_OPEN_KEY, open ? "1" : "0"); } catch (e) { /* 不記 */ } }
}

function renderNotes() {
  $("#notesCount").textContent = String(notes.items.length);
  $("#noteAdd").disabled = !notes.loaded;
  $("#notesEmpty").hidden = notes.items.length > 0 || notes.editing !== null;
  const list = $("#notesList");
  list.textContent = "";
  if (notes.editing === "new") list.append(noteEditor({ t_ms: notes.newAt, text: notes.draft || "" }, "new"));
  notes.items.forEach((n, i) => list.append(notes.editing === i ? noteEditor(n, i) : noteCard(n, i)));
  etl.setNotes(notes.items.map((n) => n.t_ms));
}

function noteTimeButton(ms) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "note-time";
  b.dataset.seek = String(ms);
  b.textContent = notesOps.noteTime(ms);
  b.title = _("跳到這則筆記的時間");
  return b;
}
function noteCard(n, i) {
  const li = document.createElement("li");
  li.className = "note";
  const head = document.createElement("div");
  head.className = "note-head";
  head.append(noteTimeButton(n.t_ms));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn sm ghost";
  edit.dataset.edit = String(i);
  edit.textContent = _("編輯");
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn sm ghost";
  del.dataset.del = String(i);
  del.textContent = notes.delArmed === i ? _("再按一次刪除") : _("刪除");
  head.append(edit, del);
  const body = document.createElement("div");
  body.className = "note-body";
  if (window.MdView) window.MdView.render(body, n.text, { top: 4 });
  else { body.classList.add("note-plain"); body.textContent = n.text; }   // 會議轉錄 App 的共用元件不在：照原文
  linkTimes(body);   // 筆記裡的 [HH:MM:SS] 也能點（ask.js；從 Ask AI 存來的筆記常有）
  li.append(head, body);
  return li;
}
function noteEditor(n, key) {
  const li = document.createElement("li");
  li.className = "note editing";
  const head = document.createElement("div");
  head.className = "note-head";
  head.append(noteTimeButton(n.t_ms));
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = _("支援 Markdown；⌘Enter 儲存，Esc 取消");
  head.append(hint);
  const ta = document.createElement("textarea");
  ta.className = "note-input";
  ta.rows = 4;
  ta.maxLength = 5000;
  ta.value = n.text;
  ta.dataset.key = String(key);
  ta.setAttribute("aria-label", _("筆記內容"));
  const row = document.createElement("div");
  row.className = "note-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn sm solid";
  save.dataset.save = String(key);
  save.textContent = _("儲存");
  save.disabled = notes.busy;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn sm";
  cancel.dataset.cancel = "1";
  cancel.textContent = _("取消");
  row.append(save, cancel);
  li.append(head, ta, row);
  setTimeout(() => ta.focus(), 0);
  return li;
}

// 新增：先暫停，時間取目前位置
function addNoteAt(ms, text = "") {
  if (notes.busy) return;   // 正在存：等存完，免得剛打開的編輯框被關掉
  if (!notes.loaded) { showAlert(_("筆記還沒讀到，先不能新增；請重新整理再試。")); return; }
  video.pause();
  notes.newAt = Math.max(0, Math.round(ms));
  notes.draft = text;
  notes.editing = "new";
  setNotesOpen(true);
  renderNotes();
}
$("#noteAdd").addEventListener("click", () => addNoteAt(video.currentTime * 1000));
$("#notesToggle").addEventListener("click", () => setNotesOpen($("#notesBody").hidden));

async function commitNote(key) {
  const ta = $("#notesList").querySelector(".note-input");
  const text = ta ? ta.value.trim() : "";
  if (key === "new") {
    if (!text) { notes.editing = null; renderNotes(); return; }
    if (await saveNotes([...notes.items, { t_ms: notes.newAt, text }])) notes.draft = "";
    return;
  }
  const i = Number(key);
  // 改成空白就是刪掉這則
  await saveNotes(text ? notes.items.map((n, k) => (k === i ? { ...n, text } : n)) : notes.items.filter((n, k) => k !== i));
}
$("#notesList").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || notes.busy) return;
  if (t.dataset.seek !== undefined) { seekMs(Number(t.dataset.seek)); return; }
  if (t.dataset.edit !== undefined) { notes.editing = Number(t.dataset.edit); notes.delArmed = -1; renderNotes(); return; }
  if (t.dataset.cancel !== undefined) { notes.editing = null; notes.draft = ""; renderNotes(); return; }
  if (t.dataset.save !== undefined) { await commitNote(t.dataset.save); return; }
  if (t.dataset.del !== undefined) {
    const i = Number(t.dataset.del);
    // 刪除要按兩次（4 秒內），不跳確認視窗
    if (notes.delArmed !== i || Date.now() - notes.delAt > 4000) { notes.delArmed = i; notes.delAt = Date.now(); renderNotes(); return; }
    notes.delArmed = -1;
    await saveNotes(notes.items.filter((n, k) => k !== i));
  }
});
$("#notesList").addEventListener("keydown", (e) => {
  if (!e.target.classList?.contains("note-input") || e.isComposing || e.keyCode === 229 || notes.busy) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitNote(e.target.dataset.key); }
  else if (e.key === "Escape") { e.preventDefault(); notes.editing = null; notes.draft = ""; renderNotes(); }
});
