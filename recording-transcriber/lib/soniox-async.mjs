// Soniox 檔案轉錄：上傳 → 建立轉錄 → 等完成 → 取 tokens →
// 刪掉 Soniox 上的檔案與轉錄（取回後立刻刪除）。
// 網路斷一下不讓整段白做（#64）：輪詢、取回、刪除會退避重試；辨識完卻取不回來時，
// 轉錄留在 Soniox、id 記在 pending 檔，下次直接取回不重新上傳；刪不掉的記在 leftovers，下次補刪。
// 金鑰只在記憶體裡傳遞，不寫檔、不印出。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";

const BASE = "https://api.soniox.com";
// 載入時的原生 fetch：只有沒被換掉（正式使用）才用自己的上傳；測試換成假 fetch 時照舊走 fetch，不會連到真的 Soniox
const NATIVE_FETCH = globalThis.fetch;
export const SONIOX_ASYNC_MODEL = "stt-async-v5";
export const SONIOX_ASYNC_USD_PER_HOUR = 0.10;   // soniox.com/pricing（2026-10-20）

// 環境變數 → 金鑰檔（~/.config/meeting-scribe/soniox.key，600）→ macOS 鑰匙圈
export function resolveSonioxKey(env = process.env) {
  if (env.SONIOX_API_KEY) return env.SONIOX_API_KEY.trim();
  const file = env.CYCLONE_SONIOX_KEY_FILE || path.join(os.homedir(), ".config", "meeting-scribe", "soniox.key");
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key) return key;
  } catch { /* 沒有就試鑰匙圈 */ }
  if (process.platform === "darwin" && env.CYCLONE_SONIOX_NO_KEYCHAIN !== "1") {
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "soniox-api-key", "-w"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return "";
}

// 不碰鑰匙圈（ping 用，不能跳出授權視窗）
export function hasSonioxKey(env = process.env) {
  return Boolean(resolveSonioxKey({ ...env, CYCLONE_SONIOX_NO_KEYCHAIN: "1" }));
}

// 約一分鐘內重試 5 次；測試可用 CYCLONE_SONIOX_RETRY_DELAYS=0,0 縮短
const retryDelays = (env = process.env) => env.CYCLONE_SONIOX_RETRY_DELAYS
  ? env.CYCLONE_SONIOX_RETRY_DELAYS.split(",").map(Number)
  : [2000, 5000, 10_000, 20_000, 30_000];
const PENDING_GRACE_MS = 3 * 86_400_000;

// 使用者按停止（#67）：一律丟這個錯誤，呼叫端用 cancelled 判斷，不當成失敗
const stopped = () => Object.assign(new Error("cancelled"), { cancelled: true });

// 連線層的錯誤講人話（#121）：以前只有「fetch failed」，看不出是哪一步、為什麼
export function netReason(e) {
  const code = e?.cause?.code || e?.code || (e?.name === "TimeoutError" ? "TIMEOUT" : "");
  if (/HEADERS_TIMEOUT|BODY_TIMEOUT|TIMEOUT|ETIMEDOUT/.test(code)) return "太久沒有回應（網路太慢或中斷）";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "找不到 Soniox（網路或 DNS 沒通）";
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(code)) return "連線斷了";
  return code ? `連線失敗（${code}）` : `連線失敗（${String(e?.message || e).slice(0, 80)}）`;
}
const netError = (what, e) => Object.assign(new Error(`${what}：${netReason(e)}`), { cause: e, code: e?.cause?.code || e?.code });

// 上傳聲音（#121）：Node 內建 fetch 的 undici 規定 5 分鐘內要收到回應標頭，網路上傳慢（學校網路約 25 KB/s）
// 時大檔還沒傳完就被切斷。這裡用 node:https 邊讀檔邊送，只照我們自己的逾時（預設 30 分鐘）
export function uploadFile(base, key, file, { timeoutMs = 1_800_000, signal = null, filename = path.basename(file) } = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----soniox${randomBytes(12).toString("hex")}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = fs.statSync(file).size;
    const url = new URL("/v1/files", base);
    const lib = url.protocol === "http:" ? http : https;
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(v); };
    const req = lib.request(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": head.length + size + tail.length } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(reject, Object.assign(new Error(`Soniox POST /v1/files HTTP ${res.statusCode}`), { status: res.statusCode }));
        try { finish(resolve, text ? JSON.parse(text) : {}); } catch { finish(reject, new Error("Soniox 上傳回應看不懂")); }
      });
      res.on("error", (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => finish(reject, e));
    req.write(head);
    const rs = fs.createReadStream(file);
    rs.on("error", (e) => { req.destroy(e); });
    rs.on("end", () => req.end(tail));
    rs.pipe(req, { end: false });
  });
}

async function call(fetchImpl, key, method, p, body, headers = {}, timeoutMs = 120_000, stop = null) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let r;
  try {
    r = await fetchImpl(BASE + p, { method, headers: { Authorization: `Bearer ${key}`, ...headers }, body, signal: stop ? AbortSignal.any([timeout, stop]) : timeout });
  } catch (e) {
    if (stop?.aborted) throw e;
    throw netError(`Soniox ${method === "GET" ? "取回辨識結果" : method === "DELETE" ? "刪除雲端副本" : "建立辨識"}`, e);
  }
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Soniox ${method} ${p.replace(/[0-9a-f-]{16,}/g, "<id>")} HTTP ${r.status}`), { status: r.status });
  return text ? JSON.parse(text) : {};
}

// 連線錯誤、逾時、429、5xx 才重試；其他 4xx 是請求本身有問題，重試也一樣
const transient = (e) => !e.status || e.status === 429 || e.status >= 500;

// 只給 GET 與 DELETE 用：重送不會多建東西。上傳與建立轉錄不重試，免得雲端多一份。
// stop：使用者按停止時不再重試（刪雲端副本的 DELETE 不帶 stop，停止後照樣要刪）
async function callRetry(fetchImpl, key, method, p, { sleep, delays = retryDelays(), stop = null } = {}) {
  for (let i = 0; ; i++) {
    if (stop?.aborted) throw stopped();
    try {
      return await call(fetchImpl, key, method, p, undefined, {}, 120_000, stop);
    } catch (e) {
      if (stop?.aborted) throw stopped();
      if (!transient(e) || i >= delays.length) throw e;
      await sleep(delays[i]);
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

export function defaultLeftoversFile(env = process.env) {
  return env.CYCLONE_SONIOX_LEFTOVERS || path.join(os.homedir(), ".local", "state", "cyclone-recording-transcriber", "soniox-leftovers.json");
}

// 上次沒刪掉的雲端副本，這次先補刪；刪掉了（或已經不在）就從清單拿掉
async function sweepLeftovers(fetchImpl, key, file, sleep) {
  const list = readJson(file, []);
  if (!Array.isArray(list) || !list.length) return;
  const keep = [];
  for (const x of list) {
    if (x.not_before && Date.now() < x.not_before) { keep.push(x); continue; }   // 還在等人按重試的
    try {
      await callRetry(fetchImpl, key, "DELETE", `/v1/${x.kind === "file" ? "files" : "transcriptions"}/${x.id}`, { sleep, delays: [2000] });
    } catch (e) {
      if (e.status !== 404) keep.push(x);
    }
  }
  if (keep.length) writeJson(file, keep); else fs.rmSync(file, { force: true });
}

function addLeftovers(file, items) {
  if (!items.length) return;
  const list = readJson(file, []);
  writeJson(file, [...(Array.isArray(list) ? list : []), ...items]);
}

// 已經刪掉的就不必再等寬限期補刪
function dropLeftover(file, id) {
  const list = readJson(file, null);
  if (!Array.isArray(list) || !list.some((x) => x.id === id)) return;
  const keep = list.filter((x) => x.id !== id);
  if (keep.length) writeJson(file, keep); else fs.rmSync(file, { force: true });
}

// 刪雲端副本：回傳刪掉了沒；404 代表已經不在，也算刪掉
async function deleteCopy(fetchImpl, key, kind, id, sleep) {
  try {
    await callRetry(fetchImpl, key, "DELETE", `/v1/${kind === "file" ? "files" : "transcriptions"}/${id}`, { sleep });
    return true;
  } catch (e) {
    return e.status === 404;
  }
}

// 可以被停止打斷的等待；沒被打斷就把監聽拿掉，免得輪詢一小時累積上千個
function napper(sleep, stop) {
  if (!stop) return sleep;
  return (ms) => new Promise((resolve) => {
    if (stop.aborted) return resolve();
    const done = () => { stop.removeEventListener("abort", done); resolve(); };
    stop.addEventListener("abort", done);
    sleep(ms).then(done, done);
  });
}

// 等轉錄完成、取回 tokens；輪詢與取回都會重試
async function waitAndFetch(fetchImpl, key, tid, { t0, timeoutMs, pollMs, sleep, stop }) {
  for (;;) {
    const st = await callRetry(fetchImpl, key, "GET", `/v1/transcriptions/${tid}`, { sleep, stop });
    if (st.status === "completed") break;
    if (st.status === "error") throw Object.assign(new Error(`Soniox transcription failed: ${String(st.error_message || "").slice(0, 200)}`), { final: true });
    if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error("Soniox transcription timed out"), { final: true });
    await sleep(pollMs);
    if (stop?.aborted) throw stopped();
  }
  const tr = await callRetry(fetchImpl, key, "GET", `/v1/transcriptions/${tid}/transcript`, { sleep, stop });
  return tr.tokens || [];
}

const result = (tokens, t0, deleted, extra = {}) =>
  ({ tokens, audio_ms: tokens.length ? tokens[tokens.length - 1].end_ms : 0, seconds: (Date.now() - t0) / 1000, deleted, ...extra });

// 回傳 { tokens, audio_ms, seconds, deleted: {file, transcription}, resumed? }。
// pending = { file, key }：辨識中斷時記下轉錄 id，同一個 key 下次直接接回去，不重新上傳。
// signal：使用者按停止（#67）。停止後刪掉雲端的檔案與轉錄、不寫 pending，丟出 cancelled 錯誤。
export async function transcribeFile(file, { key, terms = [], languageHints = ["zh", "en"], fetchImpl = fetch, upload = fetchImpl === NATIVE_FETCH ? uploadFile : null, pollMs = 2000, timeoutMs = 3600_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pending = null, leftoversFile = defaultLeftoversFile(), signal = null } = {}) {
  if (!key) throw new Error("no Soniox API key");
  if (signal?.aborted) throw stopped();
  const t0 = Date.now();
  const stop = signal;
  const nap = napper(sleep, stop);
  await sweepLeftovers(fetchImpl, key, leftoversFile, sleep);

  const saved = pending?.file ? readJson(pending.file, null) : null;
  if (saved && saved.key === pending.key && saved.tid) {
    const deleted = { file: true, transcription: false };
    let tokens;
    try {
      tokens = await waitAndFetch(fetchImpl, key, saved.tid, { t0, timeoutMs, pollMs, sleep: nap, stop });
    } catch (e) {
      if (stop?.aborted) {
        // 接回到一半按停止：這份也不要了，刪掉、不再等人重試
        fs.rmSync(pending.file, { force: true });
        deleted.transcription = await deleteCopy(fetchImpl, key, "transcription", saved.tid, sleep);
        if (deleted.transcription) dropLeftover(leftoversFile, saved.tid);
        else addLeftovers(leftoversFile, [{ kind: "transcription", id: saved.tid }]);
        throw Object.assign(stopped(), { sonioxDeleted: deleted });
      }
      if (e.status !== 404 && !e.final) {
        throw Object.assign(new Error("還是連不上 Soniox，辨識結果還留在雲端；網路穩了再按一次重試，不用重新上傳。"), { sonioxDeleted: deleted, sonioxPending: true, cause: e });
      }
      fs.rmSync(pending.file, { force: true });   // 雲端已經沒有這份或辨識失敗：從頭來
      tokens = null;
    }
    if (tokens) {
      fs.rmSync(pending.file, { force: true });
      deleted.transcription = await deleteCopy(fetchImpl, key, "transcription", saved.tid, sleep);
      if (deleted.transcription) dropLeftover(leftoversFile, saved.tid);   // 寬限期那筆也不必留
      else addLeftovers(leftoversFile, [{ kind: "transcription", id: saved.tid }]);
      return result(tokens, t0, deleted, { resumed: true });
    }
  } else if (saved && pending?.file) {
    fs.rmSync(pending.file, { force: true });     // 別支影片或別段剪輯留下的，不接
  }

  let fileId;
  try {
    if (upload) fileId = (await upload(BASE, key, file, { timeoutMs: 1_800_000, signal: stop })).id;
    else {
      // 測試注入的 fetchImpl 照舊用 FormData
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
      fileId = (await call(fetchImpl, key, "POST", "/v1/files", form, {}, 1_800_000, stop)).id;
    }
  } catch (e) {
    if (stop?.aborted) throw Object.assign(stopped(), { sonioxDeleted: { file: true, transcription: true } });
    if (e.status) throw e;
    // 上傳沒完成：雲端沒有轉錄、不會計費
    throw Object.assign(netError("上傳聲音到 Soniox", e), { notCharged: true });
  }
  const deleted = { file: false, transcription: false };
  let tid = "";
  let keepTranscription = false;
  try {
    if (stop?.aborted) throw stopped();
    tid = (await call(fetchImpl, key, "POST", "/v1/transcriptions", JSON.stringify({
      model: SONIOX_ASYNC_MODEL, file_id: fileId, language_hints: languageHints,
      enable_speaker_diarization: true, context: { terms: terms.slice(0, 100) },
    }), { "Content-Type": "application/json" }, 120_000, stop)).id;
    try {
      return result(await waitAndFetch(fetchImpl, key, tid, { t0, timeoutMs, pollMs, sleep: nap, stop }), t0, deleted);
    } catch (e) {
      // 重試完還是斷線：轉錄留在雲端，記下 id，下次接回去。使用者按停止不算斷線
      if (!stop?.aborted && !e.final && transient(e) && pending?.file && writeJson(pending.file, { key: pending.key, tid, created: new Date().toISOString() })) {
        keepTranscription = true;
        // 專案資料夾若被清掉就沒人會接回去：三天後當殘留補刪
        addLeftovers(leftoversFile, [{ kind: "transcription", id: tid, not_before: Date.now() + PENDING_GRACE_MS }]);
        throw Object.assign(new Error("跟 Soniox 的連線斷了（已自動重試）。辨識結果先留在雲端，網路穩了按「重試」會直接取回，不用重新上傳。"), { sonioxPending: true, cause: e });
      }
      throw e;
    }
  } catch (error) {
    const e = stop?.aborted && !error.cancelled ? stopped() : error;
    e.sonioxDeleted = deleted;   // finally 跑完才會填好，呼叫端從這裡看雲端副本刪了沒
    throw e;
  } finally {
    const left = [];
    if (tid && !keepTranscription) {
      deleted.transcription = await deleteCopy(fetchImpl, key, "transcription", tid, sleep);
      if (!deleted.transcription) left.push({ kind: "transcription", id: tid });
    } else if (!tid) deleted.transcription = true;
    deleted.file = await deleteCopy(fetchImpl, key, "file", fileId, sleep);
    if (!deleted.file) left.push({ kind: "file", id: fileId });
    addLeftovers(leftoversFile, left);
  }
}
