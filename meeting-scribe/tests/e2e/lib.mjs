// e2e 共用：開測試服務、開無頭 Chrome、用 CDP 在頁面裡執行程式。只用 Node 內建（Node 22 以上有 WebSocket）。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PY = process.env.PYTHON || "python3";

// 16 kHz mono s16 wav：on 毫秒聲音、off 毫秒安靜，重複到 secs 秒；amp=0 就是全靜音
export function makeWav(file, { secs = 10, on = 400, off = 300, amp = 6000 } = {}) {
  const sr = 16000, n = sr * secs, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / sr) * 1000 % (on + off);
    const v = amp && t < on ? Math.round(amp * Math.sin(2 * Math.PI * 220 * i / sr) * (0.6 + 0.4 * Math.sin(i / 900))) : 0;
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

// Chrome 被關掉後還會寫一下 profile：刪資料夾時重試幾次，不然偶爾 ENOTEMPTY 讓情境假失敗
export function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ms-e2e-${tag}-`)); }

export async function startServer(port, work) {
  // 剛砍掉的服務在同一個 port 重開（模擬重啟）時，偶爾還綁不上（Address already in use）：等一下再試，最多 5 次
  for (let attempt = 0; ; attempt++) {
    const proc = spawn(PY, ["-I", path.join(ROOT, "tests/e2e/serve.py"), String(port), work], { stdio: ["ignore", "ignore", "pipe"] });
    proc.log = "";
    proc.stderr.on("data", (d) => { proc.log += d; });
    for (let i = 0; i < 50 && proc.exitCode === null; i++) {
      // 一秒逾時：port 被別的程式佔著（收了連線卻不回）時才不會一直等
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok && proc.exitCode === null) return proc; } catch (e) { /* 還沒起來 */ }
      await sleep(200);
    }
    proc.kill();
    await waitExit(proc);
    if (attempt >= 4 || !/Address already in use|Errno 48/.test(proc.log)) throw new Error("測試服務沒有起來：" + proc.log.slice(-500));
    await sleep(1000);
  }
}

// 等子程序結束：已經結束就不等（exit 事件不會再來），最多等 5 秒
function waitExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((r) => { const t = setTimeout(r, 5000); proc.once("exit", () => { clearTimeout(t); r(); }); });
}

export async function stopServer(proc) {
  if (!proc) return;
  proc.kill("SIGKILL");
  await waitExit(proc);
}

// 網頁放 Cloudflare Pages 的情境（#106）：用 deploy/build-pages.py 打包，再用 Python 內建的靜態伺服器在另一個 port 送出
export function buildPages(api, out) {
  execFileSync(PY, ["-I", path.join(ROOT, "deploy/build-pages.py"), "--api", api, "--out", out], { stdio: "ignore" });
}

export async function startStatic(port, dir) {
  const proc = spawn(PY, ["-I", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir], { stdio: "ignore" });
  for (let i = 0; i < 50 && proc.exitCode === null; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/build.txt`, { signal: AbortSignal.timeout(1000) })).ok) return proc; } catch (e) { /* 還沒起來 */ }
    await sleep(200);
  }
  proc.kill("SIGKILL");
  await waitExit(proc);
  throw new Error("靜態伺服器沒有起來");
}

// 無頭 Chrome；wav 給假麥克風用（不給就沒有麥克風）
// init：每次載入頁面前先在頁面裡執行的程式（換掉外部服務用，#105）；before(page)：第一次打開網址前先做（例如開 CDP 功能）
// args：額外的 Chrome 參數（例如把某個 port 當成公開網路，#106）
// lang：瀏覽器語言（#195 介面跟著它走）；預設中文，其他情境的中文斷言才對得上
export async function openPage(url, { wav, init, before, args: extra = [], lang = "zh-TW", port = 9400 + Math.floor(Math.random() * 400) } = {}) {
  const dir = tmpdir("chrome");
  const args = ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess", `--lang=${lang}`, `--accept-lang=${lang}`];
  if (wav) args.push(`--use-file-for-fake-audio-capture=${wav}`);
  args.push(...extra);
  const chrome = spawn(CHROME, [...args, "about:blank"], { stdio: "ignore" });
  try {
    return await attach(chrome, dir, port, url, { init, before });
  } catch (e) {
    chrome.kill("SIGKILL");   // 沒接上也要關掉、刪掉 profile
    await waitExit(chrome);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw e;
  }
}

async function attach(chrome, dir, port, url, { init, before } = {}) {
  let targets = [];
  for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) { /* 還沒起來 */ }
    if (!targets.some((t) => t.type === "page")) await sleep(200);
  }
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("無頭 Chrome 沒有開出頁面");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  // CDP 事件（沒有 id 的訊息）交給 on() 登記的處理函式
  const listeners = new Map();
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of listeners.get(m.method) || []) fn(m.params);
  };
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); j(new Error(`瀏覽器沒有回應：${method}`)); }, 60000);
    pending.set(i, (m) => { clearTimeout(t); r(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  // 在頁面裡執行，回傳值；頁面丟例外就讓測試失敗
  const ev = async (expr) => {
    const r = (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result;
    if (r?.exceptionDetails) throw new Error("頁面例外：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + "\n  於 " + expr.slice(0, 120));
    return r?.result?.value;
  };
  const until = async (expr, ms = 20000, step = 250) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(step); }
    throw new Error(`等不到：${expr}（${ms / 1000} 秒）`);
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  if (init) { await send("Page.enable"); await send("Page.addScriptToEvaluateOnNewDocument", { source: init }); }
  if (before) await before({ send, on });
  const go = async (u = url) => { await send("Page.navigate", { url: u }); await sleep(300); await until(`document.readyState === "complete" && !!document.getElementById("btn")`); await sleep(500); };
  await go();
  const close = async () => { try { ws.close(); } catch (e) { /* 已關 */ } chrome.kill("SIGKILL"); await waitExit(chrome); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  return { ev, until, send, on, go, close };
}

export function assert(cond, msg) { if (!cond) throw new Error(msg); }
