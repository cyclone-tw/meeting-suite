// meeting-scribe 端到端測試：真的 server.py＋真的頁面（無頭 Chrome），Claude 與本機 ASR 用 tests/ 裡的假程式。
// 用法：node tests/e2e/run.mjs [情境名稱…]   （不給就全部跑；部署前跑一次）
// 需要 macOS 上的 Google Chrome 與 Node 22+；不需要網路、不會碰 Soniox、Claude 或真的 Drive。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, buildPages, freePort, makeWav, openPage, PY, ROOT, sleep, startServer, startStatic, stopServer, tmpdir } from "./lib.mjs";

const fixtures = tmpdir("wav");
const SPEECH = makeWav(path.join(fixtures, "speech.wav"), { secs: 10 });
const SILENT = makeWav(path.join(fixtures, "silent.wav"), { secs: 10, amp: 0 });

// 每個情境自己開服務與瀏覽器；ctx = { port, work, server, page, url }
// 正在跑的服務與瀏覽器：失敗或 Ctrl-C 時也要收乾淨，不留孤兒程序與暫存資料夾
const live = new Set();
async function cleanupAll() { for (const c of [...live]) { await c(); live.delete(c); } }
process.on("SIGINT", async () => { await cleanupAll(); fs.rmSync(fixtures, { recursive: true, force: true }); process.exit(130); });

// pre(work)：開服務前先準備 WORKDIR；init／before 傳給 openPage；host 換成 localhost 才能用 passkey（WebAuthn 不接受 IP）
async function withEnv(fn, { wav = SPEECH, pre, init, before, host = "127.0.0.1", lang } = {}) {
  const port = await freePort(), work = tmpdir("work");
  const ctx = { port, work, url: `http://${host}:${port}/` };
  const cleanup = async () => {
    if (ctx.page) await ctx.page.close();
    await stopServer(ctx.server);
    fs.rmSync(work, { recursive: true, force: true });
  };
  live.add(cleanup);
  try {
    if (pre) pre(work);
    ctx.server = await startServer(port, work);
    // init 可以是函式：要等服務起來才知道的東西（例如假 Google 的網址，#107）
    ctx.page = await openPage(ctx.url, { wav, init: typeof init === "function" ? init(ctx) : init, before, lang });
    await fn(ctx);
  } finally {
    live.delete(cleanup);
    await cleanup();
  }
}

const setup = (p, { ai = false, polish = false } = {}) =>
  p.ev(`document.getElementById("ai").checked = ${ai};
        if (document.getElementById("polish")) document.getElementById("polish").checked = ${polish};
        engine.value = "whisper"; engine.onchange(); true`);
const record = async (p, ms) => { await p.ev(`document.getElementById("btn").click()`); await p.until("recording"); await sleep(ms); };
// 停止錄音；有議程還沒談完會先跳出提醒（#97），這裡一律選「仍要結束」
const stopRec = async (p) => {
  await p.ev(`document.getElementById("btn").click(); if (!agRemind.hidden) agRemindEnd.click(); true`);
  await p.until("localEvt === null && !recording", 30000);
};
const words = (p) => p.ev(`finals.filter((t) => t.text !== "<end>").length`);

// ---- client 模式（#105）：金鑰在瀏覽器；Soniox、Azure 換成頁面裡的假服務，不連外 ----
const KEY_S = "snx-e2e-MASTER-SONIOX-1234", KEY_A = "az-e2e-MASTER-AZURE-5678", PASS = "correct horse 1";
const FAKE_ASR = `(() => {
  const log = window.__asr = { soniox: [], azure: [], ws: [], sdk: [] };
  const MASTER = { soniox: ${JSON.stringify(KEY_S)}, azure: ${JSON.stringify(KEY_A)} };
  // 假的 Soniox 非即時 API（#114 匯入檔案）：__sxPolls 次查詢後完成；__sxFail = { "POST /transcriptions": 402 } 讓某一步失敗
  const SX = "https://api.soniox.com/v1";
  const sx = window.__sx = { files: {}, jobs: {}, calls: [], n: 0 };
  const SX_TOKENS = [
    { text: "今天", start_ms: 0, end_ms: 400, speaker: "1" }, { text: "討論 IEP。", start_ms: 400, end_ms: 1200, speaker: "1" },
    { text: "好的", start_ms: 3000, end_ms: 3400, speaker: "2" }, { text: "，下週再談。", start_ms: 3400, end_ms: 4200, speaker: "2" },
    { text: "第二批", start_ms: 31000, end_ms: 31500, speaker: "1", confidence: 0.9 },
  ];
  const sxReply = (status, obj) => new Response(obj == null ? null : JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  function sxRoute(method, p, auth, body) {
    sx.calls.push({ method, path: p, auth, body });
    if (auth !== "Bearer " + MASTER.soniox) return [401, { error_message: "bad key" }];
    const fail = (window.__sxFail || {})[method + " " + p.replace(/\\/[^/]+-\\d+/g, "/:id")];
    if (fail) return [fail, { error_message: "e2e" }];
    if (method === "POST" && p === "/files") { const id = "file-" + ++sx.n; sx.files[id] = body.size; return [201, { id }]; }
    if (method === "POST" && p === "/transcriptions") {
      if (!(body.file_id in sx.files)) return [400, {}];
      const id = "tr-" + ++sx.n; sx.jobs[id] = { req: body, polls: 0 }; return [201, { id, status: "queued" }];
    }
    let m = /^\\/transcriptions\\/([\\w-]+)(\\/transcript)?$/.exec(p);
    if (m && sx.jobs[m[1]]) {
      const job = sx.jobs[m[1]];
      if (method === "DELETE") { delete sx.jobs[m[1]]; return [204, null]; }
      if (m[2]) return [200, { id: m[1], tokens: SX_TOKENS }];
      job.polls++;
      if (job.polls <= (window.__sxPolls ?? 2)) return [200, { id: m[1], status: job.polls === 1 ? "queued" : "transcribing" }];
      return [200, { id: m[1], status: window.__sxFinal || "completed", error_message: window.__sxFinal ? "bad audio" : null }];
    }
    m = /^\\/files\\/([\\w-]+)$/.exec(p);
    if (m && method === "DELETE" && m[1] in sx.files) { delete sx.files[m[1]]; return [204, null]; }
    return [404, {}];
  }
  // 上傳檔案走 XHR（頁面要看上傳進度）：Soniox 的網址攔下來，其他照常
  const RealXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends RealXHR {
    open(method, url, ...rest) { this.__sx = String(url).startsWith(SX + "/"); this.__m = method; this.__u = String(url); this.__h = {}; if (!this.__sx) return super.open(method, url, ...rest); }
    setRequestHeader(k, v) { if (!this.__sx) return super.setRequestHeader(k, v); this.__h[k] = v; }
    get status() { return this.__sx ? this.__status : super.status; }
    get response() { return this.__sx ? this.__resp : super.response; }
    get responseType() { return this.__sx ? "json" : super.responseType; }
    set responseType(v) { if (!this.__sx) super.responseType = v; }
    abort() { if (!this.__sx) return super.abort(); this.__aborted = true; clearTimeout(this.__t); if (this.onabort) this.onabort(); }
    send(body) {
      if (!this.__sx) return super.send(body);
      const file = body.get("file");
      let n = 0;
      const step = () => {
        if (this.__aborted) return;
        n++;
        if (this.upload.onprogress) this.upload.onprogress({ loaded: Math.round(file.size * Math.min(n, 3) / 3), total: file.size });
        if (n < 3) { this.__t = setTimeout(step, window.__sxUploadMs ?? 100); return; }
        const [status, obj] = sxRoute(this.__m, this.__u.slice(SX.length), this.__h.Authorization, { size: file.size, name: file.name, type: file.type });
        this.__status = status; this.__resp = obj;
        if (this.onload) this.onload();
      };
      this.__t = setTimeout(step, 0);
    }
  };
  const real = window.fetch.bind(window);
  window.fetch = async (url, opt = {}) => {
    const u = String(url), h = opt.headers || {};
    if (u.startsWith(SX + "/") && !u.startsWith(SX + "/auth/")) {
      if (opt.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const [status, obj] = sxRoute(opt.method || "GET", u.slice(SX.length), h.Authorization, opt.body ? JSON.parse(opt.body) : null);
      return sxReply(status, obj);
    }
    if (u === "https://api.soniox.com/v1/auth/temporary-api-key") {
      log.soniox.push({ auth: h.Authorization, body: JSON.parse(opt.body) });
      if (h.Authorization !== "Bearer " + MASTER.soniox) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ api_key: "tmp-soniox-" + log.soniox.length, expires_at: "x" }), { status: 201 });
    }
    const m = /^https:\\/\\/([a-z0-9]+)\\.api\\.cognitive\\.microsoft\\.com\\/sts\\/v1\\.0\\/issueToken$/.exec(u);
    if (m) {
      log.azure.push({ region: m[1], key: h["Ocp-Apim-Subscription-Key"] });
      if (window.__azureDelay) await new Promise((r) => setTimeout(r, window.__azureDelay));
      if (h["Ocp-Apim-Subscription-Key"] !== MASTER.azure || m[1] !== "eastasia") return new Response("", { status: 401 });
      return new Response("tok-azure-" + log.azure.length, { status: 200 });
    }
    // 網頁放 Pages 時（#106）主機 API 在另一個來源，也放行
    const apiBase = document.querySelector('meta[name="scribe-api"]')?.content || "";
    if (/^https?:/.test(u) && !u.startsWith(location.origin) && !(apiBase && u.startsWith(apiBase + "/"))
        && !(window.__fakeGoogle && u.startsWith(window.__fakeGoogle + "/"))) throw new TypeError("e2e 不准連外：" + u);
    return real(url, opt);
  };
  window.WebSocket = function (url, protocols) {
    if (url !== "wss://stt-rt.soniox.com/transcribe-websocket") throw new Error("e2e 不准連外：" + url);
    const w = { url, protocols, readyState: 0, frames: 0, config: null, binaryType: "blob",
      emit(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); },
      send(d) {
        if (this.readyState !== 1) return;
        if (typeof d === "string") {
          if (d === "") { setTimeout(() => this.emit({ tokens: [{ text: "尾", is_final: true, start_ms: this.frames * 100 }], finished: true }), 30); return; }
          this.config = JSON.parse(d);
          return;
        }
        this.frames++;
        if (window.__sonioxDropAt && this.frames >= window.__sonioxDropAt) {
          window.__sonioxDropAt = 0; this.readyState = 3; window.__droppedAt = Date.now() - startedAt;
          setTimeout(() => this.onclose && this.onclose({}), 0);
          return;
        }
        if (this.frames % 10 === 0) this.emit({ tokens: [{ text: "甲" + this.frames, is_final: true, start_ms: this.frames * 100, speaker: "1" }, { text: "暫", is_final: false, start_ms: this.frames * 100 }] });
      },
      close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose && this.onclose({}), 0); },
    };
    log.ws.push(w);
    setTimeout(() => { w.readyState = 1; if (w.onopen) w.onopen(); }, 20);
    return w;
  };
  // 假的 Azure Speech SDK：只做頁面用到的部分；每收 10 包音訊（約 1 秒）回一句
  class Rec {
    constructor(cfg, audio) { this.cfg = cfg; this.push = audio.push; this.at = 0; log.sdk.push(this); }
    _go(ok) {
      this.timer = setInterval(() => {
        const n = this.push.writes;
        if (n >= this.at + 10) {
          this.at = n;
          const r = { text: "乙" + n, offset: n * 1e6, reason: 3, speakerId: "Guest-1" };
          if (this.recognizing) this.recognizing(this, { result: { ...r, text: "乙…" } });
          if (this.recognized) this.recognized(this, { result: r });
        }
        if (this.push.closed && !this.endSent) {
          this.endSent = true;
          if (this.recognized) this.recognized(this, { result: { text: "乙尾", offset: n * 1e6, reason: 3 } });
          setTimeout(() => this.sessionStopped && this.sessionStopped(this, {}), 20);
        }
      }, 50);
      setTimeout(ok, 20);
    }
    startContinuousRecognitionAsync(ok) { this._go(ok); }
    stopContinuousRecognitionAsync(ok) { clearInterval(this.timer); this.stopped = true; setTimeout(ok, 10); }
    close() { clearInterval(this.timer); this.closed = true; }
  }
  window.SpeechSDK = {
    AudioStreamFormat: { getWaveFormatPCM: (r, b, c) => ({ r, b, c }) },
    AudioInputStream: { createPushStream: (fmt) => ({ fmt, writes: 0, closed: false, write() { this.writes++; }, close() { this.closed = true; } }) },
    AudioConfig: { fromStreamInput: (push) => ({ push }) },
    SpeechConfig: { fromAuthorizationToken: (token, region) => ({ token, region }) },
    SpeechRecognizer: Rec,
    ConversationTranscriber: Rec,
    PhraseListGrammar: { fromRecognizer: () => ({ addPhrase() {} }) },
    ResultReason: { RecognizedSpeech: 3 },
    CancellationReason: { Error: 1 },
  };
})();`;
// client 模式的環境：攔下所有送往伺服器的請求，最後檢查有沒有夾帶金鑰
function clientEnv(fn, { before, ...opts } = {}) {
  const reqs = [];
  return withEnv((ctx) => fn({ ...ctx, reqs }), {
    pre: (w) => fs.writeFileSync(path.join(w, "client-mode"), ""),
    init: FAKE_ASR,
    before: async (cdp) => {
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (q) => reqs.push(q.request));
      cdp.on("Network.webSocketCreated", (q) => reqs.push({ method: "WS", url: q.url }));
      if (before) await before(cdp);
    },
    ...opts,
  });
}
async function vaultFill(p) {
  await p.until(`keyMode === "client" && !$("vaultBox").hidden && !$("vaultSetup").hidden`, 10000);
  await p.ev(`$("vaultPass1").value = $("vaultPass2").value = ${JSON.stringify(PASS)}; $("vaultCreate").click(); true`);
  await p.until(`!$("vaultOpenBox").hidden`, 20000);
  await p.ev(`vaultEditStart("soniox"); $("vaultKey").value = ${JSON.stringify(KEY_S)}; $("vaultSave").click(); true`);
  await p.until(`!!vault.secrets.soniox`, 5000);
  await p.ev(`vaultEditStart("azure"); $("vaultKey").value = ${JSON.stringify(KEY_A)}; $("vaultRegion").value = "EastAsia"; $("vaultSave").click(); true`);
  await p.until(`!!vault.secrets.azure`, 5000);
}
async function noLeak(p, reqs) {
  const kept = await p.ev(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])`);
  const rec = await p.ev(`(async () => JSON.stringify(await idb("readonly", (st) => st.get("v1")), (k, v) => v instanceof Uint8Array ? String.fromCharCode(...v) : v))()`);
  assert(reqs.length > 5, `應該攔到送往伺服器的請求：${reqs.length}`);
  for (const k of [KEY_S, KEY_A]) {
    for (const part of [k, k.slice(4, 20), k.slice(-12)]) {
      assert(!kept.includes(part), "localStorage／sessionStorage 不能有金鑰明文");
      assert(!rec.includes(part), "IndexedDB 只能存加密後的金鑰");
      for (const q of reqs) {
        const all = q.url + JSON.stringify(q.headers || {}) + (q.postData || "");
        assert(!all.includes(part), `送往伺服器的請求夾帶了金鑰：${q.method} ${q.url}`);
      }
    }
  }
  assert(!reqs.some((q) => q.url.endsWith("/token")), "client 模式不該向伺服器要臨時金鑰");
}
const stopNow = (p) => p.ev(`$("btn").click(); if (!agRemind.hidden) agRemindEnd.click(); true`);
// 在頁面裡做一個 secs 秒的 wav，拖進畫面（匯入檔案，#90）
const dropWav = (p, name, secs = 3) => p.ev(`(() => {
  const sr = 16000, n = sr * ${secs}, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(6000 * Math.sin(2 * Math.PI * 330 * i / sr)), true);
  const dt = new DataTransfer();
  dt.items.add(new File([buf], ${JSON.stringify(name)}, { type: "audio/wav" }));
  for (const type of ["dragenter", "dragover", "drop"]) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true; })()`);

// ---- 網頁放 Cloudflare Pages、API 留在主機（#106）----
// 打包好的靜態網頁在一個 port、真的 server.py 在另一個 port（不同來源）。Chrome 把網頁那個 port 當公開網路、
// API 那個 port 當區域網路（跟 Pages → tailnet 的 100.x 位址一樣），並先允許「區域網路存取」權限。
// allow=false：主機的 cors_origins 不列這個網頁來源
// cdp(cdp, ctx)：開頁前多做的 CDP 設定（例如攔下送往主機的請求，模擬手機沒開 Tailscale，#178）
async function pagesEnv(fn, { allow = true, google = false, cdp: extraCdp } = {}) {
  const apiPort = await freePort(), pagePort = await freePort(), work = tmpdir("work");
  const apiOrigin = `http://127.0.0.1:${apiPort}`, pageOrigin = `http://127.0.0.1:${pagePort}`;
  const reqs = [];
  const ctx = { port: apiPort, work, apiOrigin, pageOrigin, reqs, url: pageOrigin + "/" };
  const cleanup = async () => {
    if (ctx.page) await ctx.page.close();
    await stopServer(ctx.server);
    await stopServer(ctx.static);
    fs.rmSync(work, { recursive: true, force: true });
  };
  live.add(cleanup);
  try {
    fs.writeFileSync(path.join(work, "client-mode"), "");
    fs.writeFileSync(path.join(work, "cors-origins"), JSON.stringify(allow ? [pageOrigin] : ["https://other.example"]));
    // Drive 瀏覽器直傳（#107）：Google 授權跳回 Pages 上的 /oauth/
    if (google) fs.writeFileSync(path.join(work, "drive-browser"), JSON.stringify([pageOrigin + "/oauth/"]));
    ctx.server = await startServer(apiPort, work);
    if (google) ctx.google = fs.readFileSync(path.join(work, "google-url"), "utf8");
    buildPages(apiOrigin, path.join(work, "site"));
    ctx.static = await startStatic(pagePort, path.join(work, "site"));
    ctx.page = await openPage(ctx.url, {
      wav: SPEECH,
      init: FAKE_ASR + (google ? googleInit(ctx.google) : ""),
      // 假 Google 跟真的一樣當公開網路
      args: [`--ip-address-space-overrides=127.0.0.1:${pagePort}=public,127.0.0.1:${apiPort}=local${google ? `,${new URL(ctx.google).host}=public` : ""}`],
      before: async (cdp) => {
        // 實機上 Chrome 會跳「要存取區域網路上的裝置」提示，使用者按允許（docs/deploy-pages.md）
        const g = await cdp.send("Browser.grantPermissions", { permissions: ["localNetwork"] });
        if (g.error) throw new Error("沒辦法允許區域網路存取：" + g.error.message);
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSent", (q) => reqs.push(q.request));
        if (google) await googleCdp(cdp);
        if (extraCdp) await extraCdp(cdp, ctx);
      },
    });
    await fn(ctx);
  } finally {
    live.delete(cleanup);
    await cleanup();
  }
}

// ---- Google Drive 瀏覽器直傳（#107）：假的 Google OAuth／Drive（tests/fake_google.py）跟著測試服務一起開 ----
// 頁面裡的 Google 網址是寫死的：這裡把 fetch 與 window.open 的 Google 網址換成假服務；假服務在另一個 port，
// 頁面的 CSP 不放行它，所以 e2e 關掉 CSP 檢查（CSP 的內容由 tests/test_drive_browser.py 檢查）
const googleInit = (url) => `(() => {
  window.__fakeGoogle = ${JSON.stringify(url)};
  const map = (u) => String(u).replace(/^https:\\/\\/(www\\.googleapis\\.com|accounts\\.google\\.com)(?=\\/)/, window.__fakeGoogle);
  const f = window.fetch.bind(window);
  window.fetch = (u, opt) => f(typeof u === "string" ? map(u) : u, opt);
  const o = window.open.bind(window);
  window.open = (u, ...rest) => o(map(u), ...rest);
})();`;
async function googleCdp(cdp) {
  const r = await cdp.send("Page.setBypassCSP", { enabled: true });
  if (r.error) throw new Error("沒辦法關掉 CSP：" + r.error.message);
}
const gctl = (g, name, arg) => fetch(`${g}/__ctl/${name}`, { method: "POST", body: JSON.stringify(arg ?? null) });
const gstate = async (g) => (await fetch(`${g}/__ctl/state`)).json();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const pageSha = (expr) => `(async () => { const b = await (${expr}).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join(""); })()`;
// 同源模式（直接開主機網頁）＋ drive_mode = browser
function driveEnv(fn, opts = {}) {
  const reqs = [];
  return withEnv((ctx) => fn({ ...ctx, reqs, google: fs.readFileSync(path.join(ctx.work, "google-url"), "utf8") }), {
    pre: (w) => fs.writeFileSync(path.join(w, "drive-browser"), "[]"),
    init: (ctx) => googleInit(fs.readFileSync(path.join(ctx.work, "google-url"), "utf8")),
    before: async (cdp) => {
      await googleCdp(cdp);
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (q) => reqs.push(q.request));
    },
    ...opts,
  });
}
// Drive 上某個資料夾底下的東西
const kids = (st, id) => st.files.filter((f) => f.parents.includes(id) && !f.trashed);
const FOLDER = "application/vnd.google-apps.folder";

const SCENARIOS = {
  // 本機辨識一路到結束；Whisper 碎片要接成句子，不是一個碎片一行（#57）
  async "local-engine"() {
    await withEnv(async ({ page: p }) => {
      await setup(p);
      await record(p, 12000);
      await stopRec(p);
      const n = await words(p), lines = await p.ev(`transcriptText().split("\\n").filter(Boolean).length`);
      assert(n >= 2, `應有至少 2 段辨識結果，實際 ${n}`);
      // 假 ASR 每 5～10 秒吐兩段都沒有句尾標點：合併正常時行數一定比碎片少，一個碎片一行就會失敗
      assert(lines >= 1 && lines < n, `碎片應接成句子：${lines} 行／${n} 段`);
    });
  },

  // AI 整理 → 會後總結 → 教師版會議紀錄（排序、改狀態焦點）→ 本場用量 → 存 Drive 三個檔（#3、#39、#72）
  async "minutes-and-save"() {
    await withEnv(async ({ page: p, work }) => {
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.until(`[...minTpl.options].some((o) => o.value === "test-teacher")`, 5000);
      await p.ev(`minTpl.value = "test-teacher"; minGo.click(); true`);
      await p.until("!!minutes", 20000);
      const rows = await p.ev(`[...document.querySelectorAll(".minTable tbody tr")].map((tr) => tr.cells[0].textContent)`);
      assert(rows[0] === "早一點的事" && rows[rows.length - 1] === "壞日期", `待辦應依期限排序：${rows}`);
      const focus = await p.ev(`(() => { const s = document.querySelectorAll(".minTable select")[2]; s.focus(); s.value = "已完成"; s.dispatchEvent(new Event("change"));
        const all = [...document.querySelectorAll(".minTable select")]; return all.indexOf(document.activeElement); })()`);
      assert(focus === 2, `改狀態後焦點應留在第 3 列，實際 ${focus}`);
      assert(/已完成/.test(await p.ev(`minutesMarkdown()`)), "複製的 Markdown 要反映改過的狀態");
      const usage = await p.ev(`document.getElementById("usageNote").hidden ? "" : document.getElementById("usageNote").textContent`);
      assert(/Claude/.test(usage), `會後要顯示本場用量（含 Claude）：「${usage}」`);
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "minutes"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const files = fs.readdirSync(path.join(work, "drive", "e2e", dir)).sort();
      for (const f of ["minutes.md", "summary.md", "transcript.txt"]) assert(files.includes(f), `Drive 應有 ${f}：${files}`);
    });
  },

  // 會議紀錄送到 Redmine：一筆主任務＋待辦子任務，名字遮中間；再送只更新、不重複；重新產生紀錄仍是同一筆（#82）
  async "redmine"() {
    await withEnv(async ({ page: p, work }) => {
      const base = fs.readFileSync(path.join(work, "redmine-url"), "utf8");
      const key = fs.readFileSync(path.join(work, "redmine-key"), "utf8");
      const rm = async (q) => (await fetch(base + q, { headers: { "X-Redmine-API-Key": key } })).json();
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.ev(`minGo.click(); true`);
      await p.until("!!minutes && !document.getElementById('rmCtl').hidden", 20000);
      await p.ev(`rmName.value = "王小明"; rmName.dispatchEvent(new Event("input")); true`);
      assert(/王○明/.test(await p.ev(`rmNote.textContent`)), "送出前要預覽遮過的名字");
      assert(await p.ev(`rmGo.click(); minGo.disabled`), "送 Redmine 時不能重新產生會議紀錄，不然會記不到任務編號");
      await p.until("!!(minutes.redmine && minutes.redmine.id) && !rmBusy", 15000);
      const id = await p.ev("minutes.redmine.id");
      const parent = (await rm(`/issues/${id}.json`)).issue;
      assert(/^【王○明】/.test(parent.subject) && !/小明/.test(parent.subject.replace("○明", "")), `主任務主旨要遮名字：${parent.subject}`);
      const kids = (await rm(`/issues.json?parent_id=${id}`)).issues;
      assert(kids.length === 4 && kids.every((k) => k.subject.startsWith("【王○明】")), `應有 4 筆待辦子任務：${kids.map((k) => k.subject)}`);
      assert(/#\d+/.test(await p.ev("rmNote.textContent")) && (await p.ev("rmGo.textContent")) === "更新 Redmine", "送出後要顯示任務編號，按鈕改成更新");
      await p.ev(`minGo.click(); true`);
      await p.until("!minBusy", 20000);
      assert((await p.ev("minutes.redmine && minutes.redmine.id")) === id, "重新產生會議紀錄後仍記得同一筆 Redmine 任務");
      await p.ev(`rmGo.click(); true`);
      await p.until("!rmBusy && /已更新/.test(rmNote.textContent)", 15000);
      const again = (await rm(`/issues.json?parent_id=${id}`)).issues;
      assert(again.length === 4, `再送不能重複建待辦：${again.length}`);
    });
  },

  // 收音來源四選一：系統聲音要引導選整個螢幕、不顯示麥克風；選擇會記住；頁面標題與 icon 是新名字（#86）；功能區塊有各自的顏色（#93）
  async "source-and-brand"() {
    await withEnv(async ({ page: p }) => {
      assert(/^Cyclone Scribe/.test(await p.ev("document.title")), "分頁標題要是 Cyclone Scribe");
      assert(await p.ev(`!!document.querySelector('link[rel="icon"][href="/icon.svg"]')`), "要有 SVG icon");
      await p.until(`document.querySelector("header > #brandIcon")?.naturalWidth > 0`, 5000);
      assert(await p.ev("brandIcon.getBoundingClientRect().width") >= 32, "頁首標題旁要有麥克風 icon");
      const opts = await p.ev(`[...document.querySelectorAll("#sourceSeg button")].map((b) => b.dataset.v).join()`);
      assert(opts === "mic,tab,sys,mix", `收音來源應有四個選項：${opts}`);
      await p.ev(`document.querySelector('#sourceSeg [data-v="sys"]').click(); true`);
      assert(/整個螢幕/.test(await p.ev("sourceNote.textContent")) && await p.ev("micBox.hidden"), "系統聲音要提示選整個螢幕，且不顯示麥克風");
      await p.ev(`document.querySelector('#sourceSeg [data-v="mix"]').click(); true`);
      assert(!(await p.ev("micBox.hidden")), "麥克風＋電腦要顯示麥克風選單");
      await p.ev(`document.querySelector('#sourceSeg [data-v="sys"]').click(); true`);
      await p.go();
      assert((await p.ev(`source.value`)) === "sys", "重新整理後要記得選了系統聲音");
      const wide = await p.ev("getComputedStyle(document.querySelector('main')).maxWidth");
      assert(wide === "none", `主內容要滿版，不能固定寬度：${wide}`);
      // 功能區塊各有淡色（#93）：現場錄音、匯入、轉錄設定三塊的底色互不相同，也不同於設定卡；匯入按鈕是實心
      const bgs = await p.ev(`["setup", "liveBlk", "importBox", "optBlk"].map((id) => getComputedStyle(document.getElementById(id)).backgroundColor)`);
      assert(new Set(bgs).size === 4, `設定卡與三個功能區塊的底色要互不相同：${bgs}`);
      // 和一般按鈕（白面）比：只拿掉實心底色也要抓得到
      const imp = await p.ev(`(() => { const b = getComputedStyle(importBtn), r = importBtn.getBoundingClientRect(); return [b.backgroundColor, b.color, r.height, getComputedStyle(micTest).backgroundColor]; })()`);
      assert(imp[0] !== imp[3] && imp[0] !== imp[1] && imp[0] !== bgs[2] && imp[2] >= 44, `匯入按鈕要是 44px 以上的實心按鈕：${imp}`);
    });
  },

  // 連續 8 秒數位靜音要提醒，按停止就收掉（#50、#52）
  async "silence-alert"() {
    await withEnv(async ({ page: p }) => {
      await setup(p);
      await record(p, 4000);
      assert(await p.ev(`document.getElementById("alert").hidden`), "4 秒時還不該提醒");
      await p.until(`alertKind === "silent"`, 10000);
      await stopRec(p);
      assert(await p.ev(`document.getElementById("alert").hidden`), "停止後靜音提醒要收掉");
    }, { wav: SILENT });
  },

  // 錄音中服務重啟：錄音不停、時間接上、AI 接回、結束用整場重新總結（#74）
  async "restart-resume"() {
    await withEnv(async (ctx) => {
      const p = ctx.page;
      await setup(p, { ai: true });
      await record(p, 10000);
      // 重啟前先讓舊 session 處理過一段，才有東西會在重啟時丟掉、需要整場重新總結
      await p.ev("maybeSendChunk(true); true");
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 15000);
      const before = await p.ev(`Math.max(0, ...finals.map((t) => t.start || 0))`);
      await stopServer(ctx.server);
      await sleep(4000);
      assert(await p.ev("recording"), "服務停掉時錄音不該停");
      assert(await p.ev(`alertKind === "resume"`), "要提示正在自動接回");
      ctx.server = await startServer(ctx.port, ctx.work);
      await p.until(`Math.max(0, ...finals.map((t) => t.start || 0)) > ${before} + 5000`, 30000);
      // 重啟要等下一段送出（或按停止送最後一段）時才看得出來，所以只驗結果：總結涵蓋整場
      await stopRec(p);
      await p.until("!!summary || !!sumError", 30000);
      assert(/^重產：/.test(await p.ev("summary && summary.intro")), "結束時要用整場逐字稿重新產生總結");
    });
  },

  // 上一場留下的事件連線收到 done 要自己關，不能每幾秒重連（#64）
  async "stale-event-source"() {
    await withEnv(async ({ page: p, server }) => {
      await p.ev(`(async () => { const mid = "a".repeat(32); await postJson("/api/local/end", { meeting: mid });
        window._old = new EventSource("/api/local/events?meeting=" + mid); _old.onmessage = onLocalEvent; return true; })()`);
      await p.until("_old.readyState === 2", 8000);
      const before = (server.log.match(/GET \/api\/local\/events/g) || []).length;
      assert(before >= 1, "紀錄裡應看得到這條連線（看不到就無法判斷有沒有重連）");
      await sleep(4000);
      const after = (server.log.match(/GET \/api\/local\/events/g) || []).length;
      assert(after === before, `關掉後不該再重連（${before} → ${after}）`);
    });
  },

  // 暫存：錄完重新整理 → 最近的會議開啟 → 接續錄（時間接在後面）→ 存 Drive 後暫存刪除（#42）
  async "drafts-continue"() {
    await withEnv(async ({ page: p, port }) => {
      await setup(p);
      await record(p, 10000);
      await stopRec(p);
      const first = await p.ev(`Math.max(0, ...finals.map((t) => t.start || 0))`);
      await sleep(1500);   // 等最後一次暫存送完
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`finals.length > 0 && !!draftId`, 10000);
      // 暫存說明顯示設定的主機名稱（#170），不寫死
      await p.until(`!draftHelp.hidden && draftHelp.textContent.includes("已暫存在測試主機")`, 5000);
      assert(await p.ev(`recentHelp.textContent.includes("測試主機")`), "暫存說明要用設定的主機名稱");
      const restored = await words(p);
      assert(restored >= 2, `開啟後要還原逐字稿，實際 ${restored} 段`);
      await setup(p);
      await p.ev(`document.getElementById("contBtn").click()`);
      await p.until("recording");
      await sleep(9000);
      await stopRec(p);
      const last = await p.ev(`Math.max(0, ...finals.map((t) => t.start || 0))`);
      assert(last > first + 5000, `接續段的時間要接在前一段後面（${first} → ${last}）`);
      const id = await p.ev("draftId");
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "draft"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      await sleep(1000);
      const drafts = (await (await fetch(`http://127.0.0.1:${port}/api/drafts`)).json()).drafts;
      assert(!drafts.some((d) => d.id === id), "存到 Drive 後暫存要刪掉");
    });
  },

  // 逐字稿優化＋話題分卡：「接著…」的段落併進上一張卡；存檔時好讀版在原稿前面（#57）
  async "polish-topic-cards"() {
    await withEnv(async ({ page: p }) => {
      await setup(p, { ai: true, polish: true });
      await record(p, 1500);
      const say = async (text, at) => {
        await p.ev(`finals.push({ text: ${JSON.stringify(text)}, start: ${at}, brk: true }); updateSegs(); maybeSendChunk(true); true`);
        await p.until(`[...chunks.values()].filter((c) => c.corrected).length >= chunks.size && chunks.size > 0`, 15000);
      };
      await say("今天先談閱讀進度，書上學生進步很多。", 1000);
      await say("接著說明數學的部分，嗯就是還要加強。", 20000);
      await say("另外下次開會改到週五。", 40000);
      const cards = await p.ev(`[...document.querySelectorAll("#paras .card")].filter((c) => !c.hidden).length`), n = await p.ev("chunks.size");
      assert(n === 3 && cards === 2, `3 段應併成 2 張話題卡，實際 ${n} 段 ${cards} 張`);
      await stopRec(p);
      const file = await p.ev("transcriptFile()");
      const a = file.indexOf("【優化逐字稿】"), b = file.indexOf("【原始逐字稿】");
      assert(a >= 0 && b > a, "存檔內容要先放好讀版、再放原稿");
    }, { wav: SILENT });
  },

  // 同時整理上限（#108）：兩個名額被別場佔滿時，這場的段落先排隊、頁面顯示「排隊中」；別場結束後自動開始整理
  async "ai-queue"() {
    await withEnv(async ({ page: p }) => {
      const others = ["a".repeat(32), "b".repeat(32)];
      const post = (path, body) => `fetch(${JSON.stringify(path)}, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" }, body: JSON.stringify(${body}) })`;
      await p.ev(`(async () => { for (const m of ${JSON.stringify(others)}) await ${post("/api/agent/para", `{ meeting: m, idx: 1, start: 0, end: 10, text: "佔位" }`)}; return true; })()`);
      await setup(p, { ai: true });
      await record(p, 1500);
      await p.ev(`finals.push({ text: "今天先談閱讀進度，書上學生進步很多。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`document.getElementById("aiNote").textContent.startsWith("排隊中")`, 15000);
      assert(await p.ev(`![...chunks.values()].some((c) => c.corrected)`), "排隊中不該有整理結果");
      await p.ev(`(async () => { for (const m of ${JSON.stringify(others)}) await ${post("/api/agent/end", `{ meeting: m }`)}; return true; })()`);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 30000);
      assert(await p.ev(`!document.getElementById("aiNote").textContent.startsWith("排隊中")`), "輪到之後拿掉排隊提示");
      await stopRec(p);
    }, { wav: SILENT });
  },

  // 心智圖：產生 → SVG 有中心與議題 → Mermaid 文字 → 轉 PNG 的圖片解得開 → 存 Drive 多 mindmap.svg／.md（#3）
  async mindmap() {
    await withEnv(async ({ page: p, work }) => {
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.ev(`document.getElementById("mapGo").click(); true`);
      await p.until("!!mindmap", 20000);
      const texts = await p.ev(`[...document.querySelectorAll("#mapView .mm-body svg text")].map((t) => t.textContent)`);
      for (const t of ["IEP 會議", "閱讀進度", "評量調整", "待辦"]) assert(texts.includes(t), `心智圖少了「${t}」：${texts}`);
      const mermaid = await p.ev("MindMap.toMermaid(mindmap)");
      assert(/^mindmap\n  root\(\(IEP 會議\)\)\n    閱讀進度/.test(mermaid), `Mermaid 格式不對：${mermaid.slice(0, 60)}`);
      const png = await p.ev(`(async () => { const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(MindMap.toSvg(mindmap)); await img.decode(); return img.width > 200; })()`);
      assert(png, "SVG 要能轉成圖片（下載 PNG 用）");
      if (process.env.SHOT) { const r = await p.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(process.env.SHOT, Buffer.from(r.result.data, "base64")); }
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "map"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const files = fs.readdirSync(path.join(work, "drive", "e2e", dir));
      for (const f of ["mindmap.svg", "mindmap.md"]) assert(files.includes(f), `Drive 應有 ${f}：${files}`);
    });
  },

  // 捨棄這場（#133）：刪不掉就留著；刪成功才清頁面，主機暫存不見、回到開始畫面、沒有「回到上一場」
  async "discard-meeting"() {
    await withEnv(async ({ page: p, port }) => {
      await setup(p, { ai: true });
      await record(p, 1500);
      await p.ev(`finals.push({ text: "今天書上的學生由班長報告。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 15000);
      await stopRec(p);
      const draft = await p.ev("draftId");
      await p.until(`fetch("/api/drafts").then((r) => r.json()).then((j) => j.drafts.some((d) => d.id === ${JSON.stringify(draft)}))`, 10000);
      assert(await p.ev("!discardBtn.hidden"), "會後還沒存要看得到「捨棄這場」");
      assert(await p.ev("savedOk = true, updateDock(), discardBtn.hidden"), "存好之後不用再捨棄");
      await p.ev("savedOk = false; updateDock(); true");
      // 按一次只是確認，4 秒沒再按就恢復
      await p.ev("discardBtn.click(); true");
      assert(await p.ev(`discardBtn.dataset.armed === "1" && phase === "done"`), "按一次只變成確認");
      await p.until("!discardBtn.dataset.armed", 6000);
      // 主機刪不掉：這場留著
      await p.ev(`window._f = window.fetch; window.fetch = (u, o) => String(u).includes("/api/drafts/delete") ? Promise.resolve(new Response('{"error":"壞掉"}', { status: 500 })) : _f(u, o);
        discardBtn.click(); discardBtn.click(); true`);
      await p.until(`/沒有捨棄成功/.test(document.getElementById("status").textContent)`, 5000);
      assert(await p.ev(`phase === "done" && finals.length > 0 && draftId === ${JSON.stringify(draft)}`), "刪不掉時這場要留著");
      await p.ev("window.fetch = _f; true");
      await p.ev("discardBtn.click(); discardBtn.click(); true");
      await p.until(`phase === "setup" && /已捨棄/.test(document.getElementById("status").textContent)`, 10000);
      assert(await p.ev(`finals.length === 0 && segs.length === 0 && chunks.size === 0 && audioChunks.length === 0 && draftId === null && !summary`), "頁面上不能留上一場的內容");
      assert(await p.ev("resumeNote.hidden"), "捨棄後不該出現「回到上一場」");
      const drafts = (await (await fetch(`http://127.0.0.1:${port}/api/drafts`)).json()).drafts;
      assert(!drafts.some((d) => d.id === draft), "主機暫存要刪掉");
      await p.until(`document.querySelectorAll("#recentList li").length === 0`, 5000);
    });
  },

  // 更正名字（#130）：會議中請 AI 找 → 取消一組 → 套用；逐字稿、段落、之後才產生的總結與心智圖都換掉，取消的那組不換；
  // 加進常錯字對照；重新整理開回這場仍是新寫法；存到 Drive 的檔案裡沒有錯的寫法
  async "name-fix"() {
    await withEnv(async ({ page: p, work, port }) => {
      await setup(p, { ai: true });
      await record(p, 1500);
      await p.ev(`finals.push({ text: "今天書上的學生由班長報告。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 15000);
      await p.ev(`nfOpen.click(); nfReq.value = "書上都是學障"; nfFind.click(); true`);
      await p.until("nfPairs.length > 0 && !nfBusy", 15000);
      const found = await p.ev("nfPairs.map((x) => x.wrong + '→' + x.right)");
      assert(JSON.stringify(found) === JSON.stringify(["書上→學障", "報告→報吿"]), `AI 找到的組合不對：${found}`);
      assert(await p.ev(`document.querySelectorAll("#nfList li").length`) === 2, "每一組一列");
      assert(/1 處/.test(await p.ev(`document.querySelector("#nfList li").textContent`)), "要顯示出現次數");
      await p.ev(`document.querySelectorAll("#nfList input[type=checkbox]")[1].click(); nfApply.click(); true`);
      await p.until("nameFixes.length === 1", 5000);
      const seg = await p.ev("transcriptText()");
      assert(seg.includes("今天學障的學生由班長報告") && !seg.includes("書上"), `逐字稿沒換或換錯：${seg}`);
      await p.until(`fetch("/api/corrections").then((r) => r.json()).then((j) => j.hints.some(([w, r]) => w === "書上" && r === "學障"))`, 5000);
      // 交給伺服器失敗：清掉 fixesEpoch，下一段送出時重送（review nit）
      await p.until("fixesEpoch !== '' && fixesEpoch === aiParaEpoch", 5000);
      await p.ev(`(async () => { const f = window.fetch; window.fetch = (u, o) => String(u).includes("/api/agent/fixes") ? Promise.reject(new Error("x")) : f(u, o);
        try { await pushNameFixes(); } finally { window.fetch = f; } return true; })()`);
      assert(await p.ev("fixesEpoch") === "", "送不到要清掉 fixesEpoch");
      await p.ev(`finals.push({ text: "接著說明數學的部分。", start: 20000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until("fixesEpoch === aiParaEpoch && fixesEpoch !== ''", 15000);
      // 之後才產生的內容：伺服器的整理程序收到更正，會後總結照新寫法；心智圖（另開程序）也換掉
      await stopRec(p);
      await p.until("!!summary", 30000);
      assert(!JSON.stringify(await p.ev("summary")).includes("書上"), "會後總結要照新寫法");
      await p.ev(`mapGo.click(); true`);
      await p.until("!!mindmap", 20000);
      assert(!JSON.stringify(await p.ev("mindmap")).includes("書上"), "心智圖要照新寫法");
      // 重新整理開回這場：仍是新寫法
      const draft = await p.ev("draftId");
      for (let t = Date.now(); ; await sleep(250)) {
        const j = await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${draft}`)).json();
        if (JSON.stringify(j.ai?.name_fixes) === JSON.stringify([["書上", "學障"]]) && j.ai?.mindmap) break;
        if (Date.now() - t > 15000) throw new Error("等不到暫存寫入更正");
      }
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until("nameFixes.length === 1 && segs.length > 0", 10000);
      assert(!(await p.ev("transcriptFile()")).includes("書上"), "重新打開後逐字稿仍是新寫法");
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "names"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = path.join(work, "drive", "e2e", fs.readdirSync(path.join(work, "drive", "e2e"))[0]);
      const files = fs.readdirSync(dir);
      assert(files.length > 2, `Drive 檔案太少：${files}`);
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        assert(!text.includes("書上"), `${f} 還有錯的寫法`);
      }
      assert(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith("transcript") || f.includes("逐字稿"))), "utf8").includes("報告"), "取消的那組不換");
      // 換下一場：上一場還沒套用的組合與更正都不帶過來
      await p.ev(`nfPairs = [{ wrong: "書上", right: "學障", on: true }]; resetAi(); true`);
      assert(await p.ev("nfPairs.length === 0 && nameFixes.length === 0 && !nfBusy"), "新的一場不能帶著上一場的更正");
    }, { wav: SILENT });
  },

  async "ui-lang"() {
    // 介面中英切換（#195）：英文瀏覽器沒選過就用英文；靜態畫面全換掉；錄音中不能切；切回中文會記住
    await withEnv(async ({ page: p }) => {
      assert(await p.ev(`UI_LANG === "en" && document.documentElement.lang === "en"`), "英文瀏覽器沒選過語言就用英文");
      assert(await p.ev(`!document.documentElement.classList.contains("i18n-wait") && getComputedStyle(document.body).visibility === "visible"`), "換好字要把畫面顯示出來");
      const missing = await p.ev(`[...I18N.missing]`);
      assert(missing.length === 0, "字典缺：" + missing.join("｜"));
      // 例外：切換鈕本來就寫「中文」；擴充包的議程名稱是使用者的內容。辨識引擎名稱由主機照 lang=en 給英文（#197）
      const left = (await p.ev(`document.body.innerText.match(/[\\u3400-\\u9fff][^\\n]{0,30}/g) || []`))
        .filter((s) => !["中文", "測試擬訂議程", "沒有學生資料的議程"].includes(s));
      assert(left.length === 0, "英文畫面還有中文：" + left.slice(0, 8).join("｜"));
      // 例外：標了 translate="no" 的（切換鈕的說明本來就用中文、資料夾名稱）。心智圖與延伸元件另外在 ui-lang-shared 看
      const attrs = await p.ev(`[...document.querySelectorAll("[title],[placeholder],[aria-label],[alt]")].filter((e) => !e.closest("[translate=no]")).flatMap((e) =>
        ["title", "placeholder", "aria-label", "alt"].map((a) => e.getAttribute(a) || "")).filter((v) => /[\\u3400-\\u9fff]/.test(v))`);
      assert(attrs.length === 0, "英文畫面的提示文字還有中文：" + attrs.slice(0, 8).join("｜"));
      assert(await p.ev(`langBtn.textContent === "中文" && btn.textContent.includes("Start recording")`), "按鈕顯示要切過去的語言");
      // 會議紀錄的模板名稱照翻好的模板清單顯示，存的資料不換（#197）
      await p.until(`$("minTpl").options.length > 0 && !/[\\u3400-\\u9fff]/.test($("minTpl").options[0].textContent)`, 5000);
      const note = await p.ev(`(() => { minutes = { template: "general", title: "一般會議", date: "2026-11-03", actions: [], decisions: [], questions: [], sections: [] };
        try { renderMinutes(); return $("minNote").textContent; } finally { minutes = null; } })()`);
      assert(note.startsWith(await p.ev(`$("minTpl").options[0].textContent`)) && !/[\u3400-\u9fff]/.test(note), "會議紀錄說明行的模板名稱要照清單：" + note);
      assert(await p.ev(`minTplName({ template: "x", title: "擴充包的" }) === "擴充包的"`), "清單裡沒有的模板用存的名稱");
      // 主機回的錯誤也是英文（#197）：api() 帶 lang=en
      const err = await p.ev(`fetch(api("/api/drafts/get?draft=..%2Fx")).then((r) => r.json()).then((j) => j.error)`);
      assert(err && !/[\u3400-\u9fff]/.test(err), "英文模式下主機的錯誤訊息要是英文：" + err);
      await setup(p);
      await record(p, 1500);
      await p.ev(`window.__stay = 1; langBtn.click(); true`);
      await sleep(800);
      assert(await p.ev(`window.__stay === 1 && !$("alert").hidden && /recording/i.test($("alertText").textContent)`), "錄音中按切換只提醒、不重新載入");
      await stopRec(p);
      await sleep(500);
      assert(await p.ev(`$("status").textContent === _("已結束，可以下載逐字稿")`), "英文模式錄完，狀態不能被「連線已關閉」蓋掉：" + await p.ev(`$("status").textContent`));
      await p.ev(`sumBusy = true; langBtn.click(); true`);
      await sleep(800);
      assert(await p.ev(`window.__stay === 1`), "AI 正在產生總結時也不能切");
      await p.ev(`sumBusy = false; modBusy = { key: "x", label: "x" }; langBtn.click(); true`);
      await sleep(800);
      assert(await p.ev(`window.__stay === 1`), "延伸模組產生中也不能切（結果不會自己寫進暫存）");
      await p.ev(`modBusy = null; true`);
      await p.ev(`langBtn.click(); true`);
      await p.until(`window.__stay === undefined && typeof UI_LANG !== "undefined" && !!document.getElementById("btn")`, 15000);
      assert(await p.ev(`UI_LANG === "zh" && document.documentElement.lang === "zh-Hant" && localStorage.getItem("ms.lang") === "zh"`), "切回中文要記住");
      assert(await p.ev(`btn.textContent.includes("開始錄音") && langBtn.textContent === "EN"`), "切回中文後畫面是中文");
    }, { lang: "en-US" });
  },

  // 共用元件跟著介面語言（#201）：英文模式下延伸頁籤與心智圖的按鈕、說明、提示都是英文；
  // 會議內容（心智圖節點、AI 產出）與擴充包的模組名稱不翻
  async "ui-lang-shared"() {
    await withEnv(async ({ page: p }) => {
      const cjk = (sel) => p.ev(`(() => { const r = /[\\u3400-\\u9fff]/; const out = [];
        for (const e of document.querySelectorAll(${JSON.stringify(sel)})) {
          if (r.test(e.innerText || "")) out.push((e.innerText || "").slice(0, 40));
          for (const a of ["title", "aria-label", "placeholder"]) if (r.test(e.getAttribute(a) || "")) out.push(a + "=" + e.getAttribute(a)); }
        return out; })()`);
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.ev(`setSide(true); document.getElementById("tab-ext").click(); true`);
      await p.until(`document.querySelectorAll("#extView .ext-tab").length >= 2`, 10000);
      const tabs = await p.ev(`[...document.querySelectorAll("#extView .ext-tab")].map((b) => b.textContent)`);
      assert(tabs.includes("Build on") && tabs.includes("Perspective feedback"), "內建模組的子頁籤是英文：" + tabs.join("｜"));
      await p.ev(`document.querySelector('#extView .ext-tab[data-mod="perspective"]').click(); true`);
      const ext = (await cjk("#extView .ext-note, #extView .ext-opt, #extView .ext-actions, #extView .ext-actions *, #extView .ext-tabs"))
        .filter((s) => !s.includes("測試模組"));
      assert(ext.length === 0, "延伸頁籤還有中文：" + ext.join("｜"));
      await p.ev(`document.getElementById("tab-map").click(); mapGo.click(); true`);
      await p.until("!!mindmap", 20000);
      const map = await cjk("#mapView .mm-tools, #mapView .mm-tools *, #mapView .mm-bar, #mapView .mm-bar *, #mapView .mm-hint");
      assert(map.length === 0, "心智圖工具列與提示還有中文：" + map.join("｜"));
      // 節點文字是會議內容（中文照舊），節點與畫布的說明是英文
      assert(await p.ev(`/^Mind map canvas/.test(document.querySelector("#mapView .mm-body").getAttribute("aria-label"))
        && [...document.querySelectorAll("#mapView .mm-node")].every((g) => /click to (collapse|expand)\\)$/.test(g.getAttribute("aria-label")))`), "心智圖畫布與節點的說明要是英文");
      await p.ev(`mapUI.part("edit-btn").click(); true`);
      const edit = await p.ev(`[...document.querySelectorAll("#mapView .mm-edit button, #mapView .mm-edit input")]
        .flatMap((e) => [e.textContent, e.title, e.getAttribute("aria-label") || "", e.placeholder || ""]).map((v) => v.replace(/"[^"]*"/g, "")).filter((v) => /[\\u3400-\\u9fff]/.test(v))`);   // 引號裡是節點文字（會議內容）
      assert(edit.length === 0, "心智圖編輯器還有中文：" + edit.slice(0, 6).join("｜"));
      const missing = await p.ev(`[...I18N.missing]`);
      assert(missing.length === 0, "字典缺：" + missing.join("｜"));
    }, { lang: "en-US" });
  },

  // AI 產出語言（#202）：設定預設跟介面；開始時決定這場的語言，段落與會後產出都帶上；會議中改設定不影響這場；
  // 跟著暫存，重新打開沿用當時的語言
  async "ai-lang"() {
    await withEnv(async ({ page: p, port }) => {
      await setup(p, { ai: true });
      assert(await p.ev(`$("aiLang").value === "ui" && aiLangNow() === "zh"`), "預設跟介面（中文）");
      await p.ev(`$("aiLang").value = "en"; $("aiLang").onchange(); true`);
      assert(await p.ev(`localStorage.getItem("ms.aiLang") === "en"`), "設定要記住");
      await p.ev(`window._sent = []; window._f0 = window.fetch;
        window.fetch = (u, o) => { if (["/api/agent/para", "/api/agent/summary", "/api/agent/module"].some((x) => String(u).includes(x))) _sent.push(JSON.parse(o.body)); return _f0(u, o); }; true`);
      await record(p, 1500);
      await p.ev(`$("aiLang").value = "zh"; $("aiLang").onchange(); true`);   // 會議中改設定：這場不變
      await p.ev(`finals.push({ text: "大家好，今天輪流分享。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`_sent.length > 0`, 10000);
      assert(await p.ev(`_sent[0].ai_lang === "en" && meetingAiLang === "en"`), "段落帶這場開始時決定的語言");
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.ev(`setSide(true); document.getElementById("tab-map").click(); mapGo.click(); true`);
      await p.until(`_sent.some((b) => b.kind === "mindmap")`, 10000);
      assert(await p.ev(`_sent.filter((b) => b.kind === "mindmap" || b.paras && !b.kind).every((b) => b.ai_lang === "en")`), "會後產出也帶同一種語言");
      const draft = await p.ev("draftId");
      const meta = (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${draft}`)).json()).meta;
      assert(meta.ai_lang === "en", "暫存記住這場的語言：" + JSON.stringify(meta));
      // 存 Drive 的延伸檔用結果存的標題（產生時照這場的語言給），不用畫面上跟介面語言走的名稱（#204）
      await p.until(`!!modCatalogs.en && !!modCatalogs.zh`, 5000);
      assert(await p.ev(`(() => { const keep = modules; modules = [{ module: "perspective", key: "p", title: "視角回饋：家長", options: { who: "parent" }, markdown: "x" }];
        try { return moduleFiles()[0].label === "Perspective feedback (Parent)" && modLabel(modules[0]) === "視角回饋（家長）"; } finally { modules = keep; } })()`),
        "英文會議的延伸檔名用英文，畫面照中文介面：" + await p.ev(`(() => { const keep = modules; modules = [{ module: "perspective", options: { who: "parent" }, title: "t" }]; try { return moduleFiles()[0].label; } finally { modules = keep; } })()`));
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until("segs.length > 0", 10000);
      assert(await p.ev(`meetingAiLang === "en" && aiLangNow() === "zh"`), "重新打開沿用這場的語言，不看現在的設定");
    });
  },

  // 會議說明（#185）：設定面板寫的說明在開始時帶上、每段都附上；會議中用「會議說明」改，暫存記住、重新整理開回這場還在；
  // 「AI 修正」與「會議說明」是標籤樣式；兩個視窗共用遮罩，點遮罩關得掉；開新的一場不帶上一場的說明
  async "meeting-context"() {
    await withEnv(async ({ page: p, port }) => {
      await setup(p, { ai: true });
      const ctx = "主持人小美開場，四位老師輪流分享。";
      assert(await p.ev(`ctxSetup.offsetParent !== null && ctxSetup.closest("#setup") !== null && !ctxSetup.closest("#prefs")`), "會議說明在「新的會議」卡片上，不用打開設定就看得到");
      await p.ev(`ctxSetup.value = ${JSON.stringify(ctx)};
        window._paras = []; window._f0 = window.fetch;
        window.fetch = (u, o) => { if (String(u).includes("/api/agent/para")) _paras.push(JSON.parse(o.body)); return _f0(u, o); }; true`);
      await record(p, 1500);
      assert(await p.ev(`meetingContext === ${JSON.stringify(ctx)}`), "開始時要讀設定面板的說明");
      await p.ev(`finals.push({ text: "大家好，今天輪流分享。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until("_paras.length > 0", 10000);
      assert(await p.ev(`_paras[0].context === ${JSON.stringify(ctx)}`), "段落要附上會議說明");
      assert(await p.ev(`!ctxOpen.hidden && ctxOpen.classList.contains("tag-btn") && ctxOpen.classList.contains("has") && nfOpen.classList.contains("tag-btn")`), "會議說明與 AI 修正是標籤樣式，有說明時標出來");
      assert(await p.ev(`nfOpen.textContent.trim() === "AI 修正" && nfHead.textContent === "AI 修正"`), "更正名字改名 AI 修正");
      // 會議中改說明：存進暫存，下一段就帶新的
      await p.ev(`ctxOpen.click(); ctxText.value = "改成三位老師分享，主持人是小美"; ctxSave.click(); true`);
      await p.until(`/存好了/.test(ctxNote.textContent)`, 5000);
      const draft = await p.ev("draftId");
      const meta = async () => (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${draft}`)).json()).meta;
      assert((await meta()).context === "改成三位老師分享，主持人是小美", "暫存要記住新的說明");
      await p.ev(`nfScrim.click(); true`);
      assert(await p.ev("ctxDlg.hidden && nfScrim.hidden && nameFix.hidden"), "點遮罩要關掉說明視窗");
      await p.ev(`finals.push({ text: "第一位老師分享。", start: 9000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until("_paras.length > 1", 10000);
      assert(await p.ev(`_paras.at(-1).context === "改成三位老師分享，主持人是小美"`), "下一段帶新的說明");
      // AI 修正：講者對應只用在這場，不加進常錯字對照；一般的錯字照樣記住
      await p.ev(`nfOpen.click(); nfPairs = [{ wrong: "講者一", right: "小美", on: true }, { wrong: "大理", right: "大里", on: true }]; nfRender();
        nfRemember.checked = true; nfApply.click(); true`);
      await p.until(`/常錯字對照/.test(nfNote.textContent)`, 5000);
      const corr = await (await fetch(`http://127.0.0.1:${port}/api/corrections`)).json();
      assert(corr.hints.some(([w]) => w === "大理"), "一般錯字要記住");
      assert(!corr.hints.some(([w]) => w.startsWith("講者")), "講者對應不能變成每場都生效的錯字");
      assert(/講者/.test(await p.ev("nfNote.textContent")), "要說明講者對應只用在這場");
      await p.ev(`nfClose.click(); true`);
      assert(await p.ev(`ctxSetup.value === ${JSON.stringify(ctx)}`), "開始失敗要重按時，設定面板的說明還在");
      await stopRec(p);
      await p.ev(`setPhase("setup"); true`);
      assert(await p.ev(`ctxSetup.value === ""`), "回到設定畫面開新的一場：不沿用上一場的說明");
      // 重新整理開回這場：說明還在
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until("segs.length > 0", 10000);
      assert(await p.ev(`meetingContext === "改成三位老師分享，主持人是小美"`), "重新打開後說明還在");
      assert(await p.ev(`ctxSetup.value === ""`), "設定面板不帶上一場的說明（開新的一場時才讀）");
    }, { wav: SILENT });
  },

  // 延伸模組（#136）：清單從主機來；選視角產生、同樣選項顯示「重新產生」、換選項再產生一份、移除要按兩次；
  // 會後才有「延伸」頁籤，一個模組一個子頁籤（發芽是樹苗＋短名），子頁籤只列目前這個選擇的那一份（#153）；
  // 畫面是共用元件 ExtPanel（#157）：選項是按鈕、已產生的標出來、結果用 Markdown 排版；
  // 更正名字也換模組結果；跟著暫存，重新整理開回這場還在；存到 Drive 每份延伸一個檔（總結還沒有也存）
  async "modules"() {
    await withEnv(async ({ page: p, work, port }) => {
      const X = (sel) => `document.querySelector('#extView ${sel}')`, XS = (sel) => `[...document.querySelectorAll('#extView ${sel}')]`;
      const pickWho = (v) => p.ev(`${X(`.ext-choice[data-choice="${v}"]`)}.click(); true`);
      await setup(p, { ai: true });
      await record(p, 1500);
      await p.ev(`finals.push({ text: "今天書上的學生由班長報告。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 15000);
      assert(await p.ev(`document.getElementById("tab-ext").hidden && document.getElementById("tab-map").hidden`), "錄音中沒有心智圖、延伸頁籤");
      await stopRec(p);
      await p.until("!!summary", 30000);
      await p.until(`!document.getElementById("tab-ext").hidden && !document.getElementById("tab-map").hidden && ${XS(".ext-tab")}.length >= 2`, 10000);
      // 完整總結用共用的 Markdown 排版（#157）：看得到標題與清單，看不到 ## 與 -
      await p.ev(`setSide(true); selectTab("summary"); sumView = "full"; renderSummary(); true`);
      const full = await p.ev(`({ text: sumBody.textContent, h: sumBody.querySelectorAll(".md-h").length, li: sumBody.querySelectorAll("li").length })`);
      assert(full.h === 3 && full.li === 1 && !/#|^-/.test(full.text) && full.text.includes("核心結論"), `完整總結要排版：${JSON.stringify(full)}`);
      await p.ev(`setSide(true); document.getElementById("tab-ext").click(); true`);
      assert(await p.ev(`!document.getElementById("panel-ext").hidden && document.getElementById("panel-summary").hidden && modBox.offsetHeight > 0`), "延伸是獨立頁籤");
      // 頁籤比側欄寬（議程也在、側欄拉到最窄）會橫向捲動：選中的要捲進畫面，不被收起按鈕蓋住
      const inView = () => p.ev(`(() => { const t = document.getElementById("tab-ext").getBoundingClientRect(), c = sideClose.getBoundingClientRect();
        return t.width > 0 && t.right <= c.left + 1 && t.left >= sideTabs.getBoundingClientRect().left; })()`);
      await p.ev(`document.getElementById("tab-agenda").hidden = false; setSideWidth(280); sideTabs.scrollLeft = 0; selectTab("live"); selectTab("ext"); true`);
      assert(await p.ev("sideTabs.scrollWidth > sideTabs.clientWidth") && await inView(), "窄側欄選中的頁籤要捲進畫面");
      await p.ev(`document.getElementById("tab-agenda").hidden = true; setSideWidth(Number(store.get("ms.sideW", 0))); true`);
      const ids = await p.ev(`${XS(".ext-tab")}.map((b) => b.dataset.mod)`);
      const sprout = await p.ev(`(() => { const b = ${X('.ext-tab[data-mod="sprout"]')}; return { text: b.textContent, svg: !!b.querySelector("svg.ext-icon"), label: b.getAttribute("aria-label") }; })()`);
      assert(sprout.text === "發芽" && sprout.svg && sprout.label === "讓這場會議發芽", `發芽子頁籤要是樹苗＋短名：${JSON.stringify(sprout)}`);
      // 小圖示（#168）：每個子頁籤、視角按鈕、會後區塊標題都有圖示（共用元件 MeetingIcons）
      const icons = await p.ev(`({ tabs: ${XS(".ext-tab")}.map((b) => b.querySelector("svg")?.dataset.icon || ""),
        heads: ["minHead", "formHead", "mapHead", "modHead", "saveHead"].map((id) => document.getElementById(id).closest(".blk-h").querySelector("svg.icon")?.dataset.icon || ""),
        hidden: [...document.querySelectorAll(".blk-h svg.icon[data-icon]")].every((s) => s.getAttribute("aria-hidden") === "true") })`);
      assert(icons.tabs.join() === "sapling,eye,spark" && icons.heads.join() === "minutes,form,mindmap,ext,drive" && icons.hidden, `圖示不對：${JSON.stringify(icons)}`);
      assert(ids[0] === "sprout" && ids[1] === "perspective" && !ids.includes("summary") && !ids.includes("mindmap"),
        `清單照主機給的（不含會後總結與心智圖）：${ids}`);
      // 心智圖模組（#150）：主機轉出的 Mermaid、Markdown、.opml 要和頁面自己轉的一字不差（控制字元、括號、跳脫字元都試）
      const mm = await p.ev(`postJson("/api/agent/module", { meeting: "${"d".repeat(32)}", module: "mindmap", paras: [{ start: 0, text: "今天談閱讀" }] }).then((r) => r.json())`);
      assert(mm.module === "mindmap" && mm.mindmap?.branches?.length, `心智圖模組回應不對：${JSON.stringify(mm).slice(0, 200)}`);
      const same = async (m) => p.ev(`(() => { const keep = mindmap; mindmap = ${JSON.stringify(m.mindmap)};
        const got = { mermaid: MindMap.toMermaid(mindmap), markdown: MindMap.toMarkdown(mindmap), opml: MindMap.toOpml(mindmap) }; mindmap = keep; return got; })()`);
      const page = await same(mm);
      for (const k of ["mermaid", "markdown", "opml"]) assert(page[k] === mm[k], `${k} 和頁面不一樣：\n${mm[k]}\n---\n${page[k]}`);
      const odd = { center: "A(B)[C]{D}", branches: [{ label: "x & <y> \"z\"\u0007", children: [{ label: "  多  空白  ", children: [{ label: "`反引號`" }] }] },
        { label: "", children: [{ label: "沒標題的議題" }] }, { label: "   " }] };
      const py = JSON.parse(execFileSync(PY, ["-I", "-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import server
m = json.load(sys.stdin); print(json.dumps({"mermaid": server.mindmap_mermaid(m), "markdown": server.mindmap_markdown(m), "opml": server.mindmap_opml(m)}))`],
        { input: JSON.stringify(odd), encoding: "utf8" }));
      const pageOdd = await same({ mindmap: odd });
      for (const k of ["mermaid", "markdown", "opml"]) assert(pageOdd[k] === py[k], `特殊字元的 ${k} 和頁面不一樣：\n${py[k]}\n---\n${pageOdd[k]}`);
      await p.ev(`${X('.ext-tab[data-mod="perspective"]')}.click(); true`);
      assert(await p.ev(`${XS(".ext-choice")}.map((b) => b.dataset.choice).join(",")`) === "boss,sped,parent", "視角是一排按鈕");
      await pickWho("parent");
      await p.ev(`${X(".ext-run")}.click(); true`);
      assert(await p.ev(`${X(".ext-run")}.disabled && /正在產生/.test(${X(".ext-note")}.textContent)`), "產生中按鈕要停用");
      await p.until("modules.length === 1 && !modBusy", 20000);
      const first = await p.ev(`${X(".ext-note")}.textContent + "｜" + ${X(".ext-body")}.textContent`);
      assert(first.includes("視角回饋（家長）") && first.includes("學生家長") && first.includes("下週再談"), `結果不對：${first}`);
      assert(await p.ev(`!${X(".ext-body")}.textContent.includes("##") && !!${X(".ext-body .md-h")}`), "結果用 Markdown 排版，不顯示語法");
      assert(await p.ev(`${X(".ext-run")}.textContent`) === "重新產生", "同樣選項再按是重新產生");
      await pickWho("boss");
      assert(await p.ev(`${X(".ext-run")}.textContent`) === "產生", "換了選項就是新的一份");
      assert(await p.ev(`${X(".ext-body")}.hidden`), "子頁籤只顯示目前這個選擇的結果");
      assert(await p.ev(`/已產生/.test(${X('.ext-choice[data-choice="parent"]')}.textContent) && !/已產生/.test(${X('.ext-choice[data-choice="boss"]')}.textContent)`), "按鈕標出已產生的選擇");
      await p.ev(`${X(".ext-run")}.click(); true`);
      await p.until("modules.length === 2 && !modBusy", 20000);
      assert(await p.ev(`/主管/.test(${X(".ext-body")}.textContent) && !/學生家長/.test(${X(".ext-body")}.textContent)`), "換到主管只看到主管那一份");
      await p.ev(`${X('.ext-tab[data-mod="sprout"]')}.click(); true`);
      assert(await p.ev(`${X(".ext-body")}.hidden && ${XS(".ext-choice")}.length === 0 && ${X(".ext-run")}.textContent === "產生"`), "發芽子頁籤沒有選項，也看不到視角回饋的結果");
      await p.ev(`${X('.ext-tab[data-mod="perspective"]')}.click(); true`);
      await p.ev(`${X(".ext-remove")}.click(); true`);
      assert(await p.ev("modules.length === 2"), "移除按一次只是確認");
      await p.ev(`${X(".ext-remove")}.click(); true`);
      assert(await p.ev("modules.length === 1 && modules[0].title === '視角回饋：家長'"), "第二次才移除");
      await pickWho("parent");
      assert(await p.ev(`!${X(".ext-body")}.hidden`), "換回家長看得到那一份");
      // 更正名字也換掉模組結果
      await p.ev(`nfRemember.checked = false; nfPairs = [{ wrong: "書上", right: "學障", on: true }]; nfApplyPairs(); true`);
      await p.until("nameFixes.length === 1", 5000);
      assert(!(await p.ev("modules[0].markdown")).includes("書上") && !(await p.ev(`${X(".ext-body")}.textContent`)).includes("書上"), "模組結果要照更正");
      // 更正只換文字，模組 id 與選項不動（錯字剛好是選項 id 也一樣）
      await p.ev(`nfPairs = [{ wrong: "parent", right: "家長們", on: true }]; nfApplyPairs(); true`);
      await p.until("nameFixes.length === 2", 5000);
      assert(await p.ev(`modules[0].options.who === "parent" && modules[0].key === "perspective:who=parent"`), "模組 id 與選項不能被更正改掉");
      const draft = await p.ev("draftId");
      for (let t = Date.now(); ; await sleep(250)) {
        const j = await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${draft}`)).json();
        if (j.ai?.modules?.length === 1 && !JSON.stringify(j.ai.modules).includes("書上")) break;
        if (Date.now() - t > 15000) throw new Error("等不到暫存寫入延伸模組");
      }
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`modules.length === 1 && !document.getElementById("tab-ext").hidden`, 10000);
      // 重新整理後停在上次產生的那個模組與選擇（最後產生的是主管，那份已移除）；換到家長看得到留下來的那份
      await p.until(`${X('.ext-tab[data-mod="perspective"]')}?.getAttribute("aria-selected") === "true" && ${X('.ext-choice[data-choice="boss"]')}?.getAttribute("aria-pressed") === "true"`, 10000);
      await pickWho("parent");
      assert(await p.ev(`!${X(".ext-body")}.hidden`), "重新整理後結果還在");
      // 每份延伸一個檔（#157）；總結還沒有也照樣存
      await p.ev(`summary = null; saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "mods"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      assert(/延伸 1 份/.test(await p.ev(`saveStatus.textContent`)), "存檔訊息要說存了延伸");
      const dir = path.join(work, "drive", "e2e", fs.readdirSync(path.join(work, "drive", "e2e"))[0]);
      const names = fs.readdirSync(dir);
      assert(!names.some((f) => f.startsWith("summary")), `總結還沒有就不存總結檔：${names}`);
      const md = fs.readFileSync(path.join(dir, "視角回饋（家長）.md"), "utf8");
      assert(md.startsWith("# 視角回饋（家長）\n\n") && md.includes("## 模組結果") && !md.includes("書上"), `延伸檔不對：${md.slice(0, 300)}`);
    }, { wav: SILENT });
  },

  // 心智圖編輯：改中心、加子項、Enter 加同層、刪除＋復原；圖、Mermaid、.opml 跟著變；改過要按兩次才重新產生；
  // 存 Drive 多 mindmap.opml；重新整理開回這場，修改還在（#3）
  async "mindmap-edit"() {
    await withEnv(async ({ page: p, work, port }) => {
      // 等伺服器上的暫存真的有某個內容（取代固定等待 saveAiSoon 的 2 秒）
      const draftHas = async (want) => {
        for (let t = Date.now(); Date.now() - t < 15000; await sleep(250)) {
          const r = await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${await p.ev("draftId")}`).catch(() => null);
          const j = r && r.ok ? await r.json() : null;
          if (j && want(j.ai?.mindmap)) return;
        }
        throw new Error("等不到暫存寫入心智圖");
      };
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      // 心智圖在自己的頁籤（#153）：要在那裡才按得到、編輯框才拿得到焦點
      await p.ev(`setSide(true); document.getElementById("tab-map").click(); mapGo.click(); true`);
      await p.until("!!mindmap", 20000);
      const svgTexts = () => p.ev(`[...document.querySelectorAll("#mapView .mm-body svg text")].map((t) => t.textContent)`);
      const type = (sel, v) => p.ev(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); return true; })()`);
      const row = (n) => `document.querySelectorAll("#mapView .mm-edit .mm-row")[${n}]`;
      const rows = () => p.ev(`document.querySelectorAll("#mapView .mm-edit .mm-row").length`);
      const nodes = await p.ev(`(() => { let n = 1; const w = (x) => { n++; (x.children || []).forEach(w); }; mindmap.branches.forEach(w); return n; })()`);
      await p.ev(`mapUI.part("edit-btn").click(); true`);
      assert(!(await p.ev(`mapUI.part("edit").hidden`)) && await rows() === nodes, `編輯器要一格一列：${await rows()} vs ${nodes}`);
      assert(await p.ev(`document.activeElement === ${row(0)}.querySelector("input")`), "打開編輯要把焦點放在中心主題");
      await type(`${row(0)}.querySelector("input")`, "暫時的主題");
      await p.until(`[...document.querySelectorAll("#mapView .mm-body svg text")].some((t) => t.textContent === "暫時的主題")`, 3000);
      // 第一個議題加子項：新格子拿到焦點，打字後出現在 Mermaid
      const first = await p.ev("mindmap.branches[0].label");
      await p.ev(`${row(1)}.querySelectorAll("button")[0].click(); true`);
      assert(await rows() === nodes + 1, "加子項要多一列");
      await type("document.activeElement", "新加的重點");
      assert((await p.ev("MindMap.toMermaid(mindmap)")).includes("新加的重點"), "Mermaid 要有新加的重點");
      // Enter 加一格同層的空白：空白格不進圖也不進匯出
      await p.ev(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
      assert(await rows() === nodes + 2, "Enter 要在下面加一列");
      const mermaid = await p.ev("MindMap.toMermaid(mindmap)");
      assert(!/^\s*$/m.test(mermaid), `空白格不能進 Mermaid：${mermaid}`);
      // 貼上的控制字元不進匯出（XML 不收，會讓存 Drive 整個失敗）
      await type("document.activeElement", "控制\u0001字元");
      assert((await p.ev("MindMap.toOpml(mindmap)")).includes('text="控制字元"'), "控制字元要拿掉");
      // 加一個子項再刪掉（刪掉這一層唯一的一格）：焦點回到上一層那一格，不掉到頁面外
      const btn = (n) => `document.activeElement.closest(".mm-row").querySelectorAll("button")[${n}].click()`;
      await p.ev(`${btn(0)}; true`);
      await p.ev(`${btn(3)}; true`);
      assert(await p.ev(`document.activeElement.matches(".mm-edit input") && document.activeElement.value.startsWith("控制")`), "刪掉唯一的子項後焦點要回到上一層");
      // Enter 前打的字（還沒觸發 change）也要自己一步：第一次復原只拿掉新的一格，第二次才回到打字前
      await p.ev(`(() => { const i = document.activeElement; i.value = "改到一半"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
      const r0 = await rows();
      await p.ev(`mapUI.part("undo").click(); true`);
      assert(await rows() === r0 - 1 && JSON.stringify(await p.ev("mindmap")).includes("改到一半"), "第一次復原只拿掉新的一格");
      await p.ev(`mapUI.part("undo").click(); true`);
      assert(!JSON.stringify(await p.ev("mindmap")).includes("改到一半") && await rows() === r0 - 1 && JSON.stringify(await p.ev("mindmap")).includes("控制"),
        "第二次復原回到打字前（不是更早的一步）");
      // 刪第一個議題（連子項），復原後回來
      await p.ev(`${row(1)}.querySelectorAll("button")[3].click(); true`);
      assert(!(await svgTexts()).includes(first), `刪掉的「${first}」不能還在圖上`);
      await p.ev(`mapUI.part("undo").focus(); mapUI.part("undo").click(); true`);
      assert((await svgTexts()).includes(first) && (await svgTexts()).includes("新加的重點"), "復原要把議題和子項拿回來");
      assert(await p.ev(`document.activeElement?.closest(".mm-edit") !== null`), "復原後焦點要留在編輯器");
      // 復原之後只改字（不改結構）：這次修改也要暫存，重新整理後還在
      await draftHas((m) => JSON.stringify(m || {}).includes("新加的重點"));   // 復原觸發的暫存先送完，接下來的改字要靠自己觸發暫存
      await type(`${row(0)}.querySelector("input")`, "新的主題 & <測試>");
      await p.until(`[...document.querySelectorAll("#mapView .mm-body svg text")].some((t) => t.textContent === "新的主題 & <測試>")`, 3000);
      // .opml：中心是唯一最上層、特殊字元正確轉義、跟圖同一份內容
      const opml = await p.ev(`(() => { const d = new DOMParser().parseFromString(MindMap.toOpml(mindmap), "text/xml"); if (d.querySelector("parsererror")) return null;
        const top = d.querySelectorAll("body > outline"); return { top: top.length, center: top[0].getAttribute("text"), title: d.querySelector("head > title").textContent,
        all: [...d.querySelectorAll("outline")].map((o) => o.getAttribute("text")) }; })()`);
      assert(opml && opml.top === 1 && opml.center === "新的主題 & <測試>" && opml.title === opml.center, `.opml 結構不對：${JSON.stringify(opml)}`);
      assert(opml.all.includes(first) && opml.all.includes("新加的重點") && !opml.all.includes(""), `.opml 內容不對：${opml.all}`);
      // 改過之後按一次「重新產生」只會提醒，不會蓋掉
      await p.ev(`mapGo.click(); true`);
      assert(/再按一次/.test(await p.ev("mapGo.textContent")) && !(await p.ev("mapBusy")), "第一次按要先提醒");
      assert(await p.ev("mindmap.center") === "新的主題 & <測試>", "第一次按不能蓋掉修改");
      // 重新整理開回這場：修改還在（存 Drive 會刪暫存，所以先測這個）
      await draftHas((m) => m?.center === "新的主題 & <測試>");
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`mindmap?.center === "新的主題 & <測試>" && mindmap.edited === true`, 10000);
      assert(JSON.stringify(await p.ev("mindmap")).includes("新加的重點"), "重新整理後子項要還在");
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "mapedit"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const saved = fs.readFileSync(path.join(work, "drive", "e2e", dir, "mindmap.opml"), "utf8");
      assert(saved.includes('<outline text="新的主題 &amp; &lt;測試&gt;">') && saved.includes("新加的重點"), `Drive 的 mindmap.opml 不對：${saved.slice(0, 200)}`);
      assert(fs.readFileSync(path.join(work, "drive", "e2e", dir, "mindmap.md"), "utf8").includes("新加的重點"), "Drive 的 mindmap.md 要是改過的版本");
    });
  },

  // 心智圖畫布（#127）：縮放鈕／鍵盤／Ctrl＋滾輪改 transform、拖曳平移、收合節點、全部收合／展開、大畫面＋Esc、
  // 預設暗色＋切換亮色並記住、存檔用的 SVG 不受影響；手機寬度下大畫面蓋滿、雙指縮放、頁面不橫向捲動
  // 心智圖共用元件（#155，字幕工作室也用）：不靠 App 的全域變數就能掛；有版本；onChange 只在一次編輯完成時呼叫（打字不算、失焦或加一格才算）；
  // theme auto 跟著 <html data-theme> 變；標籤進 DOM 與 SVG 都跳脫；下載檔名用 fileName；存檔的 SVG 不靠外部 CSS；set／destroy
  async "mindmap-component"() {
    await withEnv(async ({ page: p }) => {
      const r = await p.ev(`(async () => {
        const out = { version: MindMap.version }, changes = [], tick = () => new Promise((res) => setTimeout(res, 50));
        const keepTheme = document.documentElement.dataset.theme;
        const box = document.createElement("div");
        document.body.append(box);
        const map = { center: "<img src=x onerror=alert(1)>", branches: [{ label: "議題<b>一</b>", children: [{ label: "重點" }] }, { label: "議題二" }] };
        const h = MindMap.mount(box, { map, theme: "auto", fileName: "測試/檔名", onChange: (m) => changes.push(m) });
        out.escaped = !box.querySelector("img, b") && [...box.querySelectorAll(".mm-body svg text")].some((t) => t.textContent === map.center);
        h.part("edit-btn").click();
        const input = box.querySelector(".mm-edit input");
        input.value = "新主題"; input.dispatchEvent(new Event("input"));
        out.afterInput = changes.length;
        input.dispatchEvent(new Event("change"));
        out.afterChange = changes.length; out.changed = changes[0]?.center; out.edited = changes[0]?.edited === true;
        box.querySelectorAll(".mm-edit .mm-row")[1].querySelectorAll("button")[0].click();
        out.afterAdd = changes.length; out.added = changes[1]?.branches[0].children.length;
        // Enter：剛打的字和加一格合成一次通知
        const last = [...box.querySelectorAll(".mm-edit input")].at(-1);
        last.value = "最後一格"; last.dispatchEvent(new Event("input"));
        last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        out.afterEnter = changes.length - out.afterAdd; out.enterKept = JSON.stringify(changes.at(-1)).includes("最後一格");
        changes[1].center = "改複本不影響元件"; out.get = h.get().center;
        document.documentElement.dataset.theme = "light"; await tick(); out.light = h.state().theme + "," + h.part("root").dataset.mmTheme;
        document.documentElement.dataset.theme = "dark"; await tick(); out.dark = h.state().theme + "," + h.part("root").dataset.mmTheme;
        h.setTheme("light"); out.fixed = h.state().theme;
        if (keepTheme) document.documentElement.dataset.theme = keepTheme; else delete document.documentElement.dataset.theme;
        let name = null; const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { name = this.download; };
        h.part("opml").click();
        HTMLAnchorElement.prototype.click = click;
        out.file = name;
        const svg = MindMap.toSvg(map);
        out.svg = { cls: /class=/.test(svg), style: /<style|style=/.test(svg), bg: svg.includes('fill="#fbfaf6"'), esc: svg.includes("&lt;img") };
        h.set(null); out.empty = h.part("viewer").hidden && h.part("tools").hidden;
        h.destroy(); out.gone = !box.querySelector(".mm");
        box.remove();
        return out;
      })()`);
      assert(/^\d+\.\d+\.\d+$/.test(r.version), `要有版本：${r.version}`);
      assert(r.escaped, "標籤要當文字，不能變成 HTML");
      assert(r.afterInput === 0 && r.afterChange === 1 && r.changed === "新主題" && r.edited, `改字要等失焦才通知一次：${JSON.stringify(r)}`);
      assert(r.afterAdd === 2 && r.added === 2, `加一格算一次編輯：${JSON.stringify(r)}`);
      assert(r.afterEnter === 1 && r.enterKept, `Enter 只通知一次、字有帶到：${JSON.stringify(r)}`);
      assert(r.get === "新主題", "onChange 給的是複本");
      assert(r.light === "light,light" && r.dark === "dark,dark" && r.fixed === "light", `theme auto 要跟著 <html data-theme>：${JSON.stringify(r)}`);
      assert(r.file === "測試_檔名.opml", `下載檔名用 fileName：${r.file}`);
      assert(!r.svg.cls && !r.svg.style && r.svg.bg && r.svg.esc, `存檔的 SVG 不靠外部 CSS、要跳脫：${JSON.stringify(r.svg)}`);
      assert(r.empty && r.gone, "set(null) 收起來、destroy 拿掉");
      assert(await p.ev(`!document.body.classList.contains("mm-full-open") && !!mapUI.part("root").isConnected`), "App 自己的心智圖不受影響");
    });
  },

  async "mindmap-canvas"() {
    await withEnv(async ({ page: p }) => {
      const MAP = { center: "IEP 會議", branches: [
        { label: "閱讀進度", children: [{ label: "識字量提升", children: [{ label: "每週 20 字" }] }, { label: "朗讀流暢" }] },
        { label: "評量調整", children: [{ label: "延長時間" }, { label: "報讀" }] },
        { label: "待辦", children: [{ label: "聯絡家長" }] },
        { label: "下次會議", children: [] },
      ] };
      const cam = () => p.ev(`({ ...mapUI.state(), t: mapUI.part("stage").style.transform })`);
      const texts = () => p.ev(`[...document.querySelectorAll("#mapView .mm-body svg text")].map((t) => t.textContent)`);
      const key = async (k, code, opts = {}) => {
        await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k.length === 1 ? k : undefined, windowsVirtualKeyCode: opts.vk || 0, ...opts.extra });
        await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: opts.vk || 0 });
      };
      const center = () => p.ev(`(() => { const r = mapUI.part("body").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      // 預設暗色：整個 app 和心智圖都是暗色
      assert(await p.ev(`document.documentElement.dataset.theme`) === "dark", "預設要是暗色");
      assert(await p.ev(`getComputedStyle(document.body).backgroundColor`) === "rgb(19, 19, 18)", "暗色時頁面底色要是暗的");
      await p.ev(`mindmap = ${JSON.stringify(MAP)}; setSide(true); renderMindmap(); selectTab("map"); true`);
      await p.until(`!mapUI.part("viewer").hidden && mapUI.state().s > 0 && mapUI.part("stage").style.transform.includes("scale")`, 5000);
      assert(await p.ev(`getComputedStyle(mapUI.part("body")).touchAction`) === "none", "畫布要 touch-action: none");
      assert(await p.ev(`getComputedStyle(mapUI.part("viewer")).backgroundColor`) === "rgb(21, 23, 28)", "心智圖預設暗色底");
      // 暗色版的字要清楚：中心是亮底深字、議題的字色跟底色對比夠
      const ink = await p.ev(`[...mapUI.part("stage").querySelectorAll(".mm-node")].map((g) => [g.querySelector("rect").getAttribute("fill"), g.querySelector("text").getAttribute("fill")])`);
      assert(ink.length >= 3 && ink.every(([bg, fg]) => bg && fg && bg !== fg), `節點字色不對：${JSON.stringify(ink)}`);
      // 縮放按鈕
      const c0 = await cam();
      await p.ev(`mapUI.part("zoom-in").click(); true`);
      const c1 = await cam();
      assert(c1.s > c0.s * 1.2 && c1.t !== c0.t, `放大要改 transform：${c0.t} → ${c1.t}`);
      await p.ev(`mapUI.part("zoom-out").click(); mapUI.part("zoom-out").click(); true`);
      assert((await cam()).s < c1.s, "縮小要變小");
      // 鍵盤：0 符合畫面、+ 放大、- 縮小（焦點在畫布上）
      await p.ev(`mapUI.part("body").focus(); true`);
      await key("0", "Digit0", { vk: 48 });
      assert(Math.abs((await cam()).s - c0.s) < 1e-6, "0 要回到符合畫面");
      await key("+", "Equal", { vk: 187 });
      assert((await cam()).s > c0.s * 1.2, "＋ 要放大");
      await key("-", "Minus", { vk: 189 });
      assert(Math.abs((await cam()).s - c0.s) < 1e-6, "− 要縮小回去");
      // Ctrl＋滾輪縮放；側欄裡一般滾輪不攔（讓側欄照常捲）
      const wc = await center();
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: wc.x, y: wc.y, deltaX: 0, deltaY: -200, modifiers: 2 });
      await sleep(100);
      const c2 = await cam();
      assert(c2.s > c0.s * 1.5, `Ctrl＋滾輪要放大：${c0.s} → ${c2.s}`);
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: wc.x, y: wc.y, deltaX: 0, deltaY: 120 });
      await sleep(100);
      assert((await cam()).s === c2.s, "側欄裡一般滾輪不縮放");
      // 拖曳平移（真的滑鼠事件，從一個可收合的議題上開始拖），拖完不能誤觸收合
      await p.ev(`mapUI.part("fit").click(); true`);
      const before = await cam(), all = (await texts()).length;
      const pt = await p.ev(`(() => { const r = mapUI.part("stage").querySelector('.mm-node[data-key="1"] .mm-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x + i * 12, y: pt.y + i * 6, button: "left", buttons: 1 });
      await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x + 60, y: pt.y + 30, button: "left", buttons: 0, clickCount: 1 });
      const after = await cam();
      assert(Math.abs(after.x - before.x - 60) < 1 && Math.abs(after.y - before.y - 30) < 1, `拖曳要平移 60,30：${before.x},${before.y} → ${after.x},${after.y}`);
      assert((await texts()).length === all && !(await p.ev(`mapUI.state().collapsed`)), "拖曳不能收合節點");
      // 點議題收合：子項不見、圓鈕顯示收了幾項；再點一次展開
      const g0 = `mapUI.part("stage").querySelector('.mm-node[data-key="0"]')`;
      assert(await p.ev(`${g0}.getAttribute("aria-expanded")`) === "true", "議題一開始是展開的");
      await p.ev(`${g0}.dispatchEvent(new MouseEvent("click", { bubbles: true })); true`);
      let t = await texts();
      assert(!t.includes("識字量提升") && !t.includes("每週 20 字") && !t.includes("朗讀流暢") && t.includes("閱讀進度") && t.includes("延長時間"), `收合後子項要藏起來：${t}`);
      assert(await p.ev(`${g0}.getAttribute("aria-expanded")`) === "false" && t.includes("3"), `收合的節點要標 aria-expanded=false、圓鈕顯示 3：${t}`);
      assert(await p.ev(`document.activeElement === ${g0}`), "收合後焦點留在那個節點");
      await key("Enter", "Enter", { vk: 13 });
      assert((await texts()).includes("識字量提升"), "節點上按 Enter 要展開");
      // 第二層也能收：「識字量提升」底下的細節
      await p.ev(`mapUI.part("stage").querySelector('.mm-node[data-key="0.0"]').dispatchEvent(new MouseEvent("click", { bubbles: true })); true`);
      t = await texts();
      assert(t.includes("識字量提升") && !t.includes("每週 20 字"), "第二層收合");
      // 全部收合／全部展開；沒有子項的議題沒有收合鈕
      await p.ev(`mapUI.part("collapse-all").click(); true`);
      t = await texts();
      for (const x of ["識字量提升", "延長時間", "聯絡家長"]) assert(!t.includes(x), `全部收合後「${x}」要藏起來`);
      assert(t.includes("下次會議") && !(await p.ev(`!!mapUI.part("stage").querySelector('.mm-node[data-key="3"]')`)), "沒有子項的議題照樣顯示、沒有收合鈕");
      await p.ev(`mapUI.part("expand-all").click(); true`);
      t = await texts();
      for (const x of ["識字量提升", "每週 20 字", "延長時間", "聯絡家長"]) assert(t.includes(x), `全部展開後要有「${x}」`);
      // 存檔／下載用的 SVG 不受畫面狀態影響：固定淺色、沒有互動屬性、收合的也照樣全部畫出來
      await p.ev(`mapUI.part("collapse-all").click(); true`);
      const exp = await p.ev("MindMap.toSvg(mindmap)");
      assert(exp.includes('fill="#fbfaf6"') && !/tabindex|mnode|mtog|mbox/.test(exp) && exp.includes("每週 20 字") && exp.includes("聯絡家長"), "存檔的 SVG 要是完整的列印版");
      await p.ev(`mapUI.part("expand-all").click(); true`);
      // 大畫面：蓋滿視窗、在 body 底下；Esc 關掉回到側欄，側欄不跟著關
      await p.ev(`mapUI.part("full").click(); true`);
      const vp = await p.ev(`(() => { const r = mapUI.part("viewer").getBoundingClientRect(); return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight, parent: mapUI.part("viewer").parentNode === document.body, full: mapUI.part("viewer").classList.contains("mm-full"), modal: mapUI.part("viewer").getAttribute("aria-modal") }; })()`);
      assert(vp.parent && vp.full && vp.modal === "true" && vp.w === vp.iw && vp.h === vp.ih, `大畫面要蓋滿視窗：${JSON.stringify(vp)}`);
      assert(await p.ev(`document.activeElement === mapUI.part("body") && mapUI.part("full").getAttribute("aria-label") === "關閉大畫面"`), "大畫面打開後焦點在畫布、按鈕變成關閉");
      assert(await p.ev(`document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".mm-viewer") !== null`), "大畫面要在最上層");
      // 大畫面時一般滾輪也縮放
      const fs0 = (await cam()).s;
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 450, deltaX: 0, deltaY: -150 });
      await sleep(100);
      assert((await cam()).s > fs0, "大畫面時滾輪要能縮放");
      await key("Escape", "Escape", { vk: 27 });
      assert(await p.ev(`!mapUI.part("viewer").classList.contains("mm-full") && mapUI.part("viewer").parentNode === mapUI.part("root") && mapUI.part("viewer").nextElementSibling === mapUI.part("edit") && !side.hidden`), "Esc 要關大畫面、放回原位，側欄還開著");
      assert(await p.ev(`document.activeElement === mapUI.part("full")`), "關掉後焦點回到「大畫面」鈕");
      // 主題切換：心智圖的按鈕切成亮色，整個 app 一起換；記在 localStorage，重新整理後還是亮色
      await p.ev(`mapUI.part("theme").click(); true`);
      assert(await p.ev(`document.documentElement.dataset.theme === "light" && localStorage.getItem("ms.theme") === "light"`), "切亮色要記住");
      assert(await p.ev(`getComputedStyle(mapUI.part("viewer")).backgroundColor`) === "rgb(250, 248, 244)", "心智圖要換亮色底");
      assert(await p.ev(`getComputedStyle(document.body).backgroundColor`) === "rgb(246, 246, 243)", "整個 app 要換亮色");
      assert(await p.ev(`mapUI.part("theme").textContent === "暗色" && themeBtn.getAttribute("aria-label") === "改成暗色"`), "按鈕要改成「改成暗色」");
      await p.go();
      assert(await p.ev(`document.documentElement.dataset.theme`) === "light", "重新整理後要記得亮色");
      await p.ev(`themeBtn.click(); true`);
      assert(await p.ev(`document.documentElement.dataset.theme === "dark" && localStorage.getItem("ms.theme") === "dark"`), "標題列的按鈕切回暗色");
      // 手機寬度（390px）：側欄是全螢幕面板，大畫面蓋滿、工具列不超出畫面、頁面不橫向捲動、雙指縮放、單指拖曳
      await p.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await p.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await sleep(500);   // 寬窄切換會觸發 wide 的 change（重設側欄），等它跑完再打開側欄
      await p.ev(`mindmap = ${JSON.stringify(MAP)}; setSide(true); renderMindmap(); selectTab("map"); true`);
      await p.until(`!mapUI.part("viewer").hidden && mapUI.part("body").clientWidth > 0 && mapUI.part("body").clientWidth <= 390`, 5000);
      assert(await p.ev(`document.documentElement.scrollWidth <= innerWidth`), "手機寬度下頁面不能橫向捲動");
      await p.ev(`mapUI.part("full").click(); true`);
      const m = await p.ev(`(() => { const r = mapUI.part("viewer").getBoundingClientRect(); return { w: r.width, iw: innerWidth, bad: [...mapUI.part("bar").querySelectorAll("button")].filter((b) => { const q = b.getBoundingClientRect(); return q.right > innerWidth + 0.5 || q.left < -0.5 || q.height < 36; }).map((b) => b.id) }; })()`);
      assert(m.w === m.iw && !m.bad.length, `手機大畫面要蓋滿、按鈕不超出畫面：${JSON.stringify(m)}`);
      const mc = await center(), s0 = (await cam()).s;
      const touch = (type, pts) => p.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
      await touch("touchStart", [[mc.x - 40, mc.y], [mc.x + 40, mc.y]]);
      for (let i = 1; i <= 5; i++) await touch("touchMove", [[mc.x - 40 - i * 12, mc.y], [mc.x + 40 + i * 12, mc.y]]);
      await touch("touchEnd", []);
      const s1 = (await cam()).s;
      assert(s1 > s0 * 1.5, `雙指張開要放大：${s0} → ${s1}`);
      const b1 = await cam();
      await touch("touchStart", [[mc.x, mc.y]]);
      for (let i = 1; i <= 4; i++) await touch("touchMove", [[mc.x - i * 10, mc.y + i * 5]]);
      await touch("touchEnd", []);
      const b2 = await cam();
      assert(Math.abs(b2.x - b1.x + 40) < 1 && Math.abs(b2.y - b1.y - 20) < 1 && b2.s === b1.s, `單指要拖曳平移：${JSON.stringify([b1, b2])}`);
      await p.ev(`mapUI.part("zoom-out").click(); true`);
      assert((await cam()).s < b2.s, "手機上的縮小鈕要能用");
      await p.ev(`mapUI.part("full").click(); true`);
      assert(await p.ev(`!mapUI.part("viewer").classList.contains("mm-full") && !side.hidden`), "手機上按「關閉」回到側欄：" + await p.ev(`JSON.stringify([mapUI.part("viewer").className, side.hidden, mapUI.part("viewer").parentNode.id])`));
    });
  },

  // 表單紀錄（#3、#97，用假擴充包）：選會議別 → AI 填表 → 在頁面改 → 下載的 Word 照改過的內容；必填提醒；
  // 改過後重新填寫要按兩次；重新整理後還在；換會議別沿用相同欄位；存 Drive 有 docx
  async "form-docx"() {
    await withEnv(async ({ page: p, work, port }) => {
      // docx 裡每一段的字（標籤和內容在不同的 run，要整段接起來看）
      const docxText = (file) => execFileSync("python3", ["-I", "-c", `import re, sys, zipfile
x = zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode()
print("\\n".join("".join(re.findall(r"<w:t(?: [^>]*)?>([^<]*)</w:t>", p)) for p in re.findall(r"<w:p[ >].*?</w:p>", x, re.S)))`, file], { encoding: "utf8" });
      const draftHas = async (want) => {
        for (let t = Date.now(); Date.now() - t < 15000; await sleep(250)) {
          const r = await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${await p.ev("draftId")}`).catch(() => null);
          const j = r && r.ok ? await r.json() : null;
          if (j && want(j.ai?.form)) return;
        }
        throw new Error("等不到暫存寫入表單");
      };
      const type = (sel, v) => p.ev(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); return true; })()`);
      const chk = (label) => `[...document.querySelectorAll("#formFields .ichk")].find((l) => l.textContent === ${JSON.stringify(label)}).querySelector("input")`;
      await setup(p, { ai: true });
      await record(p, 12000);
      await stopRec(p);
      await p.until("!!summary", 30000);
      assert(!(await p.ev("formBox.hidden")), "會後要看得到表單區塊");
      assert(await p.ev("formHead.textContent") === "測試會議紀錄（簽名版）", "區塊標題用擴充包的名稱");
      const opts = await p.ev(`[...formTpl.options].map((o) => o.value).join()`);
      assert(opts === "test-plan,test-exit", `要有擴充包的兩種會議：${opts}`);
      await p.ev(`formTpl.value = "test-plan"; formTpl.onchange(); formGo.click(); true`);
      await p.until("!!form && !formBusy", 20000);
      const roc = String(new Date().getFullYear() - 1911);
      const head = await p.ev(`Object.fromEntries([...document.querySelectorAll("#formFields .ihead input")].map((i) => [i.getAttribute("aria-label"), i.value]))`);
      assert(head["學生姓名"] === "王小明" && head["會議日期：年（民國）"] === roc, `表頭：AI 的姓名與民國年要填好：${JSON.stringify(head)}`);
      const student = await p.ev(`document.querySelector('#formFields textarea[aria-label^="學生本人說明"]').value`);
      assert(/^測試擬訂會議：個案表示喜歡閱讀/.test(student), `學生說明要是 AI 的內容：${student}`);
      assert(await p.ev(`${chk("語文-國")}.checked`), "AI 勾的項目要勾起來");
      assert(await p.ev(`document.querySelector("#formFields details[open] summary")?.textContent.includes("學習內容")`), "有勾的類別要展開");
      // 提醒：擴充包宣告的條件（導師的觀察沒寫、行為功能介入沒勾）→ 提醒；補上導師的觀察，那一條就消失；年級 6 要寫轉銜
      const warns = () => p.ev(`formWarn.hidden ? [] : [...formWarn.querySelectorAll("li")].map((li) => li.textContent)`);
      let w = await warns();
      assert(w.some((t) => t.includes("導師的觀察")) && w.some((t) => t.includes("行為功能介入")) && !w.some((t) => t.includes("轉銜")), `要提醒缺的項目：${w}`);
      await type(`document.querySelector('#formFields textarea[aria-label^="導師的觀察"]')`, "上課專心");
      await type(`document.querySelector('#formFields input[aria-label="年級"]')`, "六");
      w = await warns();
      assert(!w.some((t) => t.includes("導師的觀察")) && w.some((t) => t === "轉銜：6 年級要寫轉銜服務"), `補上的不再提醒、年級觸發轉銜：${w}`);
      // 改：勾家庭支持服務；沒勾的項目不展開細節；在選項的「其他」打字會自動勾那個選項；學校記住
      await p.ev(`${chk("家庭支持服務")}.click(); true`);
      const blank = `document.querySelector('#formFields input[aria-label="特殊需求：課程"]')`;
      assert(await p.ev(`${blank}.closest(".isub").hidden`), "沒勾的項目不展開細節");
      await p.ev(`${chk("特殊需求")}.click(); true`);
      assert(!(await p.ev(`${blank}.closest(".isub").hidden`)), "勾了要展開細節");
      await type(blank, "社會技巧");
      await type(`document.querySelector('#formFields input[aria-label="評量時間調整：其他的內容"]')`, "分兩節考");
      assert(await p.ev(`document.querySelector('#formFields input[aria-label="評量時間調整：其他"]').checked && form.values.items.exam_time.options["其他"] === "分兩節考"`), "選項的空格有字，要自動勾那個選項");
      await type(`document.querySelector('#formFields input[aria-label="學校"]')`, "國姓");
      assert(await p.ev(`localStorage.getItem("ms.form.test-pack.school")`) === "國姓", "表頭 remember 的欄位要記在這台裝置");
      // 下載：攔下 Word 檔，內容要照改過的
      await p.ev(`window._dl = null; downloadBlob = (b, n) => { b.arrayBuffer().then((a) => { let s = ""; for (const c of new Uint8Array(a)) s += String.fromCharCode(c); window._dl = { n, d: btoa(s) }; }); }; formDl.click(); true`);
      await p.until("!!window._dl", 10000);
      const dl = await p.ev("window._dl");
      assert(/^測試擬訂會議紀錄-王小明-\d{4}-\d\d-\d\d\.docx$/.test(dl.n), `檔名用擴充包的 file_name：${dl.n}`);
      const file = path.join(work, "dl.docx");
      fs.writeFileSync(file, Buffer.from(dl.d, "base64"));
      const text = docxText(file);
      for (const want of ["測試縣 國姓 學校", "學生姓名： 王小明 ", "語文-國：外加 3 節", "家庭支持服務", "特殊需求：社會技巧",
        "評量時間調整：延長考試時間20分鐘、其他：分兩節考", "個案表示喜歡閱讀", "導師的觀察：\n上課專心", "其他：\n無。"]) {
        assert(text.includes(want), `下載的 Word 要有「${want}」`);
      }
      assert(!/[□○■●]/.test(text), "敘述版不印勾選框");
      assert(!text.includes("測試結束會議"), "只有選的那一種會議");
      // 改過之後按一次「AI 重新填寫」只會提醒
      await p.ev(`formGo.click(); true`);
      assert(/再按一次/.test(await p.ev("formGo.textContent")) && !(await p.ev("formBusy")), "第一次按要先提醒");
      // 重新整理開回這場：修改還在
      await draftHas((x) => x?.values?.items?.family?.on === true && x.values.header.school === "國姓");
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`form?.values?.items?.family?.on === true && !formBox.hidden && !!document.querySelector("#formFields .ichk")`, 10000);
      assert(await p.ev(`${chk("家庭支持服務")}.checked`), "重新整理後勾選要還在");
      // 換會議別：相同欄位沿用
      await p.ev(`formTpl.value = "test-exit"; formTpl.onchange(); true`);
      assert(await p.ev(`form.template === "test-exit" && ${chk("能力現況")}.checked && /換了會議別/.test(formNote.textContent)`), "換會議別要沿用相同欄位並提醒");
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "form"; saveAudio.checked = false; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const saved = docxText(path.join(work, "drive", "e2e", dir, "test-minutes.docx"));
      assert(saved.includes("測試結束會議") && saved.includes("能力現況：閱讀理解進步"), "Drive 的 docx 要是換過會議別、沿用欄位的版本");
      // 暫存裡的表單在這台的擴充包找不到（沒裝擴充包、表單改名）：照樣能存 Drive，只是不附表單
      await p.ev(`form.template = "gone"; savedOk = false; saveTitle.value = "form-gone"; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent) && document.getElementById("saveStatus").textContent.includes("form-gone")`, 20000);
      const gone = fs.readdirSync(path.join(work, "drive", "e2e")).find((x) => x.includes("form-gone"));
      assert(gone && !fs.readdirSync(path.join(work, "drive", "e2e", gone)).includes("test-minutes.docx"), "找不到的表單不附");
      assert(/表單紀錄沒附/.test(await p.ev(`saveStatus.textContent`)), "沒附表單要說一聲");
    });
  },

  // 會議議程（#97，用假擴充包與假學生資料）：開會前選類型＋學生 → AI 個別化 → 改字、新增 → 重新整理還在 →
  // 開始錄音自動看議程、手動勾選 → 會後開回這場還在；自己打議程也能用
  async "agenda"() {
    await withEnv(async ({ page: p, port }) => {
      const type = (sel, v) => p.ev(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); i.dispatchEvent(new Event("change")); return true; })()`);
      await setup(p, { ai: true });
      await p.until(`[...agType.options].some((o) => o.value === "test-agenda") && agStudent.options.length > 1`, 5000);
      await p.ev(`agType.value = "test-agenda"; agType.onchange(); agStudent.value = "s-001"; agStudent.onchange(); true`);
      assert(!(await p.ev("agStudent.hidden")) && !(await p.ev("agGo.hidden")), "擴充包的議程要能選學生、產生");
      assert((await p.ev(`agStudent.selectedOptions[0].textContent`)) === "王〇安（s-001）", "選單顯示學生名字，不是代碼");
      await p.ev(`agGo.click(); true`);
      await p.until("!agendaBusy && agenda?.items?.length > 0", 20000);
      const titles = await p.ev(`[...agList.querySelectorAll("li input:not(.ag-detail)")].map((i) => i.value)`);
      assert(titles.join() === "學生本人說明,家長的觀察與期望,行為功能介入,轉銜服務,情緒行為支持,鑑輔到期", `議程項目不對：${titles}`);
      assert(await p.ev(`agList.querySelectorAll("li input.ag-detail")[0].value`) === "請小安用圖卡說說最喜歡的課", "AI 的個別化提問");
      assert(await p.ev(`agGrade.value`) === "" && /6 年級（從學生資料）/.test(await p.ev(`agNote.textContent`)), "AI 讀到的年級寫在說明裡，不回填年級欄");
      assert(/｜王〇安（s-001）｜/.test(await p.ev(`agNote.textContent`)), "議程說明寫學生名字");
      // 換學生、沒動年級欄，直接重新產生：用新學生的年級（三年級不必談轉銜），不沿用上一位的
      await p.ev(`agStudent.value = "s-002"; agStudent.onchange(); agGo.click(); true`);
      assert(await p.ev(`agType.disabled && agStudent.disabled`), "整理中不能換類型或學生");
      await p.until(`!agendaBusy && agenda?.student === "s-002"`, 20000);
      assert(!(await p.ev(`agType.disabled`)), "整理完恢復");
      assert(await p.ev(`agenda.facts.grade === 3 && !agenda.items.some((it) => it.id === "transition")`), "換學生要用新學生的年級");
      await p.ev(`agStudent.value = "s-001"; agStudent.onchange(); agGo.click(); true`);
      await p.until(`!agendaBusy && agenda?.student === "s-001"`, 20000);
      assert(/AI 依學生資料加的/.test(await p.ev(`agList.querySelectorAll("li")[5].textContent`)), "AI 加的項目要標示");
      // 改字、取消必談、新增一項
      await type(`agList.querySelectorAll("li input:not(.ag-detail)")[1]`, "家長期望");
      await p.ev(`agList.querySelectorAll("li button[aria-pressed]")[1].click(); agAdd.click(); true`);
      await type(`[...agList.querySelectorAll("li input:not(.ag-detail)")].at(-1)`, "下次開會時間");
      // 改過之後按「重新產生」只會提醒，不會蓋掉
      await p.ev(`agGo.click(); true`);
      assert(/再按一次/.test(await p.ev(`agGo.textContent`)) && (await p.ev(`agenda.items.length`)) === 7, "改過的議程重新產生要按兩次");
      // 重新整理：準備到一半的議程還在
      await p.go();
      await p.until(`agenda?.items?.length === 7 && agType.value === "test-agenda"`, 5000);
      assert(await p.ev(`agenda.items[1].title === "家長期望" && agenda.items[1].required === false && agenda.items[6].title === "下次開會時間"`), "重新整理後修改還在");
      // 開始錄音：側欄切到議程；手動勾一項，進度更新
      await setup(p, { ai: true });
      await p.ev(`document.getElementById("btn").click()`); await p.until("recording");
      await p.until(`!document.getElementById("tab-agenda").hidden && document.getElementById("tab-agenda").getAttribute("aria-selected") === "true"`, 5000);
      assert((await p.ev(`agCheck.querySelectorAll("li").length`)) === 7, "錄音中看得到議程");
      const before = await p.ev(`agProgress.textContent`);
      assert(before === "已談 0／7 項，必談還差 3 項", `進度：${before}`);
      await p.ev(`agCheck.querySelectorAll("li input")[0].click(); true`);
      assert(await p.ev(`agProgress.textContent`) === "已談 1／7 項，必談還差 2 項", "勾了之後進度要更新");
      assert(await p.ev(`agenda.items[0].done === true && agenda.items[0].by === "manual"`), "記下是手動勾的");
      await sleep(4000);
      await stopRec(p);
      // 會後開回這場：議程與勾選都還在
      for (let t = Date.now(); Date.now() - t < 15000; await sleep(250)) {
        const r = await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${await p.ev("draftId")}`).catch(() => null);
        const j = r && r.ok ? await r.json() : null;
        if (j?.ai?.agenda?.items?.[0]?.done) break;
      }
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      assert(!(await p.ev(`agenda`)), "回到設定畫面（新的一場）不帶上一場的議程");
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`agenda?.items?.[0]?.done === true && !document.getElementById("tab-agenda").hidden`, 10000);
      // 下一場：議程清掉；自己打議程
      await p.ev(`dockNext.click(); true`);
      await p.until(`phase === "setup"`, 5000);
      assert(!(await p.ev(`agenda`)) && (await p.ev(`agList.children.length`)) === 0, "下一場議程清掉");
      await p.ev(`agType.value = "manual"; agType.onchange(); agAdd.click(); true`);
      await type(`agList.querySelector("li input")`, "預算");
      assert(await p.ev(`agenda.type === "manual" && agenda.items[0].title === "預算"`), "自己打的議程");
      await p.ev(`for (let i = 0; i < 45; i++) agAdd.click(); true`);
      assert(await p.ev(`agenda.items.length`) === 40 && /最多就這麼多/.test(await p.ev(`agNote.textContent`)), "自己打的議程到上限要說");
      await p.ev(`agType.value = "test-agenda"; agType.onchange(); true`);
      assert(!(await p.ev(`agenda`)) && (await p.ev(`agList.children.length`)) === 0, "換類型：前一種的議程不留");
      // 草稿的議程類型已經不在擴充包裡：重新整理後丟掉，不留在背後
      await p.ev(`localStorage.setItem("ms.agendaDraft", JSON.stringify({ type: "gone", title: "舊的", items: [{ id: "a", title: "舊項目" }] })); true`);
      await p.go();
      await p.until(`[...agType.options].some((o) => o.value === "test-agenda")`, 5000);
      assert(!(await p.ev(`agenda`)) && !(await p.ev(`localStorage.getItem("ms.agendaDraft")`)), "類型不存在的草稿要丟掉");
    });
  },

  // 會議中的議程（#97 P2、P3）：AI 每兩段判斷談過的項目並自動打勾；老師取消後 AI 不再勾；「快結束了」列出沒談的；
  // 按停止時還有必談沒談要先提醒，「回去談」繼續錄、「仍要結束」才停
  async "agenda-live"() {
    await withEnv(async ({ page: p }) => {
      const type = (sel, v) => p.ev(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); return true; })()`);
      await setup(p, { ai: true });
      await p.ev(`agType.value = "manual"; agType.onchange(); agAdd.click(); agAdd.click(); agAdd.click(); true`);
      for (const [i, t] of ["學生說明", "家長期望", "下次開會"].entries()) await type(`agList.querySelectorAll("li input:not(.ag-detail)")[${i}]`, t);
      await p.ev(`agList.querySelectorAll("li button[aria-pressed]")[0].click(); agList.querySelectorAll("li button[aria-pressed]")[1].click(); true`);
      await p.ev(`document.getElementById("btn").click()`); await p.until("recording");
      // 假 AI 把第一個還沒談的項目算談到
      await p.until(`agenda.items[0].done && agenda.items[0].by === "ai"`, 60000);
      assert(/^AI：談到m-/.test(await p.ev(`agCheck.querySelector("li .ai").textContent`)), "顯示 AI 判斷談到什麼");
      // 取消 AI 勾的：之後 AI 不會再勾回去（第二項會被勾，第一項不會）
      await p.ev(`agCheck.querySelectorAll("li input")[0].click(); true`);
      assert(await p.ev(`agenda.items[0].by === "manual-off" && !agenda.items[0].done`), "取消 AI 勾的要記下來");
      await p.until(`agenda.items[1].done`, 60000);
      assert(await p.ev(`!agenda.items[0].done`), "老師取消的，AI 不再勾回去");
      // 就算 AI 又回報同一項（例如服務重啟前排隊的判斷），頁面也不勾回去
      await p.ev(`applyAgendaEvent({ covered: [{ id: agenda.items[0].id, para: 1, note: "又來" }] }); true`);
      assert(await p.ev(`!agenda.items[0].done && agenda.items[0].by === "manual-off"`), "頁面端也擋 AI 勾回去");
      // 快結束了：列出所有沒談的
      await p.ev(`agSoon.click(); true`);
      const soon = await p.ev(`[...agRemindList.querySelectorAll("li")].map((li) => li.textContent)`);
      assert(!(await p.ev("agRemind.hidden")) && soon.join() === "學生說明必談,下次開會" && (await p.ev("agRemindEnd.hidden")), `快結束了：${soon}`);
      await p.ev(`agRemindBack.click(); true`);
      // 按停止：第一項是必談、還沒談 → 先提醒，不停
      await p.ev(`document.getElementById("btn").click(); true`);
      assert(!(await p.ev("agRemind.hidden")) && (await p.ev("recording")), "還有必談沒談：先提醒、不停");
      assert(await p.ev(`agRemindHead.textContent`) === "還有 1 項必談沒談", "只列必談");
      await p.ev(`agRemindBack.click(); true`);
      assert(await p.ev(`recording && agRemind.hidden && document.getElementById("tab-agenda").getAttribute("aria-selected") === "true"`), "回去談：繼續錄、打開議程");
      await p.ev(`document.getElementById("btn").click(); true`);
      await p.ev(`agRemindEnd.click(); true`);
      await p.until("localEvt === null && !recording", 30000);
      assert(await p.ev("agRemind.hidden"), "結束後提醒收起來");
    });
  },

  // 匯入錄好的檔案（#90）：選檔 → 上傳、轉檔、本機辨識的進度 → 跟錄完一樣進會後畫面；會議名稱接檔名；存 Drive 帶轉好的 m4a
  async "import-whisper"() {
    await withEnv(async ({ page: p, work }) => {
      await setup(p, { ai: true });
      const file = makeWav(path.join(tmpdir("imp"), "週三個案會議.wav"), { secs: 14 });
      // 假的辨識很快，幾秒就做完：在頁面上記下每個事件與當時的按鈕字，事後檢查
      await p.ev(`window.__seen = []; { const orig = onLocalEvent; onLocalEvent = (e) => { try { const ev = JSON.parse(e.data); __seen.push([ev.type === "import" ? ev.stage : ev.type, btnLabel.textContent]); } catch (err) {} return orig(e); }; } true`);
      const doc = await p.send("DOM.getDocument", {});
      const { nodeId } = await p.send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#importFile" }).then((r) => r.result);
      await p.send("DOM.setFileInputFiles", { nodeId, files: [file] });
      await p.until(`phase === "done"`, 30000);
      const seen = await p.ev("__seen");
      const stages = seen.map(([k]) => k);
      assert(stages.includes("convert") && stages.includes("asr") && stages.at(-1) === "done", `要看到轉檔、本機辨識的進度：${stages}`);
      assert(seen.find(([k]) => k === "asr")[1] === "取消匯入", "匯入中底部按鈕是「取消匯入」");
      assert(await p.ev(`finals.filter((t) => t.text !== "<end>").length`) >= 2, "要有轉出來的逐字稿");
      assert(/週三個案會議$/.test(await p.ev("meetingTitle")), `會議名稱要接檔名：${await p.ev("meetingTitle")}`);
      assert(await p.ev(`totalMs`) >= 13000, "會議長度是檔案長度，不是轉錄花的時間");
      await p.until("!!summary", 30000);
      // 匯入跑完不是按停止：會議紀錄、心智圖、延伸也要出現，不能被當成還在錄音藏起來（#172）
      assert(await p.ev(`!minBox.hidden && !mapBox.hidden && !modBox.hidden && !$("tab-map").hidden && !$("tab-ext").hidden`), "匯入整理完要有會議紀錄、心智圖、延伸");
      await p.until(`saveAudio.checked`, 5000);
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "imp"; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const files = fs.readdirSync(path.join(work, "drive", "e2e", dir));
      assert(files.includes("audio.m4a") && files.includes("transcript.txt"), `Drive 要有逐字稿與 m4a：${files}`);
    });
  },

  // 匯入逐字稿（#174）：不轉錄，逐句當定稿、分段交給 AI；總結、會議紀錄、心智圖、延伸照常；存暫存
  async "import-transcript"() {
    const reqs = [];
    await withEnv(async ({ page: p, port }) => {
      await setup(p, { ai: true });
      const dir = tmpdir("tr");
      const pick = async (file) => {
        const doc = await p.send("DOM.getDocument", {});
        const { nodeId } = await p.send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#importFile" }).then((r) => r.result);
        await p.send("DOM.setFileInputFiles", { nodeId, files: [file] });
      };
      // 沒勾 AI 整理：不開始，提示先勾
      fs.writeFileSync(path.join(dir, "a.txt"), "隨便一句話。");
      await p.ev(`$("ai").checked = false; true`);
      await pick(path.join(dir, "a.txt"));
      await p.until(`/先勾/.test($("status").textContent)`, 5000);
      assert(await p.ev(`phase === "setup" && !draftId`), "沒勾 AI 整理不開始");
      await p.ev(`$("ai").checked = true; true`);
      // 本 App 存到 Drive 的 transcript.txt：表頭、優化版都略過，只讀原始逐字稿
      const said = Array.from({ length: 12 }, (_, i) => `[00:${String(i).padStart(2, "0")}:05] 第 ${i + 1} 句，我們討論個案的學習狀況與下一步的支持方式，請大家發表意見。`);
      const txt = ["會議：週三個案會議", "", "【優化逐字稿】", "", "AI 改寫過的內容不要讀。", "", "【原始逐字稿】", "", "[講者 1]", ...said.slice(0, 6), "", "[講者 2]", ...said.slice(6)].join("\n");
      fs.writeFileSync(path.join(dir, "transcript.txt"), txt);
      const before = reqs.length;
      await pick(path.join(dir, "transcript.txt"));
      await p.until(`phase === "done"`, 10000);
      const segs = await p.ev(`segs.map((s) => [s.start, s.speaker ?? null, s.text])`);
      assert(segs.length === 12 && segs[0][0] === 5000 && segs[0][1] === "1" && segs[11][1] === "2" && segs[11][0] === 11 * 60000 + 5000, `時間、講者要照檔案：${JSON.stringify(segs.slice(0, 2))}`);
      assert(!segs.some(([, , t]) => t.includes("改寫")), "優化逐字稿不讀");
      assert(/週三個案會議$|transcript$/.test(await p.ev("meetingTitle")), `會議名稱接檔名：${await p.ev("meetingTitle")}`);
      await p.until(`!!summary`, 30000);
      assert(await p.ev(`chunks.size`) >= 2, "照 150 字分段送 AI，不是整份一段");
      assert(await p.ev(`[...chunks.values()].every((c) => c.corrected)`), "每段都有整理結果");
      assert(await p.ev(`!minBox.hidden && !mapBox.hidden && !modBox.hidden && !$("tab-map").hidden && !$("tab-ext").hidden`), "會議紀錄、心智圖、延伸要出現");
      assert(/匯入逐字稿，沒有轉錄費/.test(await p.ev(`usageNote.textContent`)), `用量不列轉錄費：${await p.ev("usageNote.textContent")}`);
      assert(await p.ev(`saveAudio.disabled && !saveAudio.checked`), "沒有音檔可存");
      const hit = reqs.slice(before).map((q) => q.method + " " + q.url).filter((u) => /\/api\/(import|local)\/|^WS /.test(u));
      assert(reqs.slice(before).some((q) => q.url.includes("/api/agent/para")), "要有攔到送 AI 的請求（不然上面的檢查沒意義）");
      assert(!hit.length, `不能呼叫轉錄：${hit}`);
      // 暫存裡有逐字稿，關掉分頁也找得回來
      const did = await p.ev("draftId");
      await p.until(`draftSent === finals.length`, 10000);
      const got = await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${did}`)).json();
      assert(got.finals.length === 12 && got.meta.engine === "transcript", `暫存要有 12 句：${got.finals?.length} ${got.meta?.engine}`);
      // 不是錄音、影片也不是逐字稿
      await p.ev(`setPhase("setup"); true`);
      fs.writeFileSync(path.join(dir, "x.pdf"), "%PDF");
      await pick(path.join(dir, "x.pdf"));
      await p.until(`/不是錄音、影片或逐字稿檔/.test($("status").textContent)`, 5000);
    }, {
      before: async (cdp) => {
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSent", (q) => reqs.push(q.request));
        cdp.on("Network.webSocketCreated", (q) => reqs.push({ method: "WS", url: q.url }));
      },
    });
  },

  // 很長的逐字稿（#176）：十萬句也不卡、不會因為參數太多而壞；超過字數上限就不開始
  async "import-transcript-big"() {
    await withEnv(async ({ page: p }) => {
      await setup(p, { ai: true });
      const dir = tmpdir("trbig");
      const pick = async (file) => {
        const doc = await p.send("DOM.getDocument", {});
        const { nodeId } = await p.send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#importFile" }).then((r) => r.result);
        await p.send("DOM.setFileInputFiles", { nodeId, files: [file] });
      };
      fs.writeFileSync(path.join(dir, "long.txt"), "這一行很長。".repeat(30000));
      await pick(path.join(dir, "long.txt"));
      await p.until(`/逐字稿太長/.test($("status").textContent)`, 10000);
      assert(await p.ev(`phase === "setup" && !$("btn").disabled`), "太長的不開始，按鈕可以按");
      // 十萬句：送 AI 的請求在頁面上直接回 202（只測頁面本身），要在時限內排完、到會後畫面
      await p.ev(`window.__fetch = fetch; window.__paras = 0; fetch = (u, o) => ["/api/agent/para", "/api/agent/end"].some((k) => String(u).includes(k)) ? (__paras++, Promise.resolve(new Response("{}", { status: 202 }))) : __fetch(u, o); true`);
      fs.writeFileSync(path.join(dir, "many.txt"), Array.from({ length: 100000 }, () => "好").join("\n"));
      const t0 = Date.now();
      await pick(path.join(dir, "many.txt"));
      await p.until(`phase === "done"`, 30000);
      const ms = Date.now() - t0;
      assert(ms < 10000, `十萬句要在 10 秒內排完（一次畫好，不是每句重畫整份）：${ms} ms`);
      assert(await p.ev(`segs.length`) === 100000 && await p.ev(`!$("btn").disabled`), "十萬句都要排好，按鈕恢復");
      assert(await p.ev(`__paras`) >= 600, `照 150 字分段：${await p.ev("__paras")}`);
    });
  },

  // AI 整理中重新整理頁面（#126）：「有新版本」不跳；重新整理後自動打開這場、接上事件，結果全部補齊、總結產生
  async "ai-resume-reload"() {
    await withEnv(async ({ page: p, work, port }) => {
      fs.writeFileSync(path.join(work, "claude-delay"), "1.2");   // 假 Claude 每則回覆慢一點，才來得及在整理中重新整理
      await setup(p, { ai: true });
      await dropWav(p, "長會議.wav", 100);
      await p.until(`phase === "done" && aiEnded && inflight.size === 0 && chunks.size >= 3`, 60000);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 20000);
      const n = await p.ev("chunks.size"), id = await p.ev("draftId");
      assert(await p.ev(`[...chunks.values()].some((c) => !c.corrected)`), "要在還有段落沒整理完時重新整理（假 Claude 太快）");
      // 有新版本：整理中不跳提醒、按鈕也不會重新整理
      await p.ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith("/healthz")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, build: "ffffffffffff" }), { headers: { "Content-Type": "application/json" } })) : real(u, o); return true; })()`);
      await p.ev(`newBuild = false; (async () => { await checkBuild(); return true; })()`);
      assert(await p.ev(`alertKind !== "update"`), "AI 整理中不該提示重新整理");
      await p.go();
      await p.until(`phase === "done" && draftId === ${JSON.stringify(id)} && aiResumed && !!evtSrc`, 15000);
      assert(/還在整理/.test(await p.ev(`$("aiNote").textContent`)), "要告訴使用者還在整理");
      await p.until(`!evtSrc && !!summary`, 60000);
      assert(await p.ev(`chunks.size`) === n && await p.ev(`[...chunks.values()].every((c) => c.corrected && !c.error)`), "重新整理後每一段都要補上結果");
      assert(/整理完成/.test(await p.ev(`$("aiNote").textContent`)), "整理完要說完成了");
      assert(await p.ev(`$("aiBackfill").hidden`), "沒有缺的段落就不顯示補跑");
      const ai = (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${id}`)).json()).ai;
      assert(ai.chunks.length === n && ai.chunks.every((c) => c.corrected) && ai.summary?.intro, "暫存裡也要有全部結果與總結");
      // 整理完了才提示新版本
      await p.ev(`(async () => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith("/healthz")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, build: "ffffffffffff" }), { headers: { "Content-Type": "application/json" } })) : real(u, o); await checkBuild(); return true; })()`);
      assert(await p.ev(`alertKind === "update"`), "整理完之後要提示新版本");
    });
  },

  // 匯入後送完段落就關掉頁面（#126）：伺服器自己把每段結果與總結寫進暫存；之後從「最近的會議」打開都在
  async "ai-close-page"() {
    await withEnv(async ({ page: p, work, port }) => {
      fs.writeFileSync(path.join(work, "claude-delay"), "1");
      await setup(p, { ai: true });
      await dropWav(p, "關掉頁面.wav", 80);
      await p.until(`phase === "done" && aiEnded && inflight.size === 0 && chunks.size >= 2`, 60000);
      const n = await p.ev("chunks.size"), id = await p.ev("draftId");
      assert(await p.ev(`[...chunks.values()].some((c) => !c.corrected)`), "要在還有段落沒整理完時關掉（假 Claude 太快）");
      await p.send("Page.navigate", { url: "about:blank" });
      const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${id}`)).json());
      for (let t = Date.now(); (await get()).agent; await sleep(500)) if (Date.now() - t > 60000) throw new Error("伺服器一直沒整理完");
      const ai = (await get()).ai;
      assert(ai.chunks.length === n && ai.chunks.every((c) => c.corrected && c.summary), `頁面關掉後每段結果要由伺服器寫進暫存：${JSON.stringify(ai.chunks.map((c) => !!c.corrected))}`);
      assert(ai.summary?.intro && ai.summary.whole, "總結也要寫進暫存");
      fs.rmSync(path.join(work, "claude-delay"));
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      assert(await p.ev(`phase === "setup"`), "整理完了就不自動打開");
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`phase === "done" && !!summary && chunks.size === ${n}`, 10000);
      assert(await p.ev(`[...chunks.values()].every((c) => c.corrected) && !evtSrc`), "打開後直接讀暫存，不必再接事件");
    });
  },

  // 補跑缺少的段落（#126）：暫存裡有段落沒有結果（例如舊版頁面重新整理丟掉的）→ 打開後補跑，只送缺的段落，結果與整場總結寫回暫存
  async "ai-backfill"() {
    await withEnv(async ({ page: p, port, server }) => {
      const id = "e".repeat(32);
      const post = async (q, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${q}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" }, body: JSON.stringify(body) });
        assert(r.ok, `${q} ${r.status}`);
      };
      await post("/api/drafts/meta", { draft: id, meta: { title: "缺段落的會議", place: "", engine: "soniox", started_at: Date.now(), duration_ms: 30000, state: "done" } });
      await post("/api/drafts/finals", { draft: id, from: 0, tokens: [["第一句書上。", "1", 0, true], ["第二句。", "1", 10000, true], ["第三句書上。", "1", 20000, true]] });
      await post("/api/drafts/ai", { draft: id, ai: { chunks: [
        { idx: 1, start: 0, end: 0, text: "第一句書上。", corrected: "已經有的結果", summary: "已有重點", seg: 0 },
        { idx: 2, start: 10000, end: 10000, text: "第二句。", corrected: "", summary: "", seg: 1 },
        { idx: 3, start: 20000, end: 20000, text: "第三句書上。", corrected: "", error: "AI 整理失敗（TimeoutError）", seg: 2 }], summary: null } });
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`phase === "done" && chunks.size === 3`, 10000);
      assert(await p.ev(`!$("aiBackfill").hidden && /2 段/.test($("aiBackfill").textContent)`), `要顯示補跑 2 段：${await p.ev(`$("aiBackfill").textContent`)}`);
      const before = (server.log.match(/POST \/api\/agent\/para/g) || []).length;
      await p.ev(`$("aiBackfill").click(); true`);
      await p.until(`!evtSrc && !!summary && [...chunks.values()].every((c) => c.corrected)`, 30000);
      const sent = (server.log.match(/POST \/api\/agent\/para/g) || []).length - before;
      assert(sent === 2, `只送缺的 2 段，實際 ${sent}`);
      assert(await p.ev(`chunks.get(1).corrected === "已經有的結果" && chunks.get(3).corrected === "第三句學障。" && !chunks.get(3).el.classList.contains("err")`), "已有的結果不動，缺的補上、拿掉失敗樣式");
      assert(/^重產：/.test(await p.ev("summary.intro")), "補完用整場重新產生總結");
      assert(await p.ev(`$("aiBackfill").hidden`), "補完就不再顯示補跑");
      let ai;
      for (let t = Date.now(); Date.now() - t < 10000; await sleep(250)) {
        ai = (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${id}`)).json()).ai;
        if (ai.summary) break;
      }
      assert(ai.chunks.map((c) => c.corrected).join("|") === "已經有的結果|第二句。|第三句學障。" && /^重產：/.test(ai.summary?.intro || ""), `補跑結果要寫回暫存：${JSON.stringify(ai.chunks)}`);
    });
  },

  // 依說明重整（#191）：開回一場已有結果與心智圖的會議 → 改會議說明 → 按兩次重整 → 全部段落帶新說明重送，
  // 總結用整場重產、心智圖重產（舊的放進復原）；按一次只是確認
  async "context-redo"() {
    await withEnv(async ({ page: p, port }) => {
      const id = "d".repeat(32);
      const post = async (q, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${q}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" }, body: JSON.stringify(body) });
        assert(r.ok, `${q} ${r.status}`);
      };
      await post("/api/drafts/meta", { draft: id, meta: { title: "要重整的會議", place: "", engine: "soniox", started_at: Date.now(), duration_ms: 30000, state: "done", context: "舊說明" } });
      await post("/api/drafts/finals", { draft: id, from: 0, tokens: [["主持人開場書上。", "1", 0, true], ["第一位分享。", "2", 10000, true], ["第二位分享書上。", "3", 20000, true]] });
      await post("/api/drafts/ai", { draft: id, ai: { chunks: [
        { idx: 1, start: 0, end: 0, text: "講者 1：主持人開場書上。", corrected: "舊一", summary: "舊重點一", seg: 0 },
        { idx: 2, start: 10000, end: 10000, text: "講者 2：第一位分享。", corrected: "舊二", summary: "舊重點二", seg: 1 },
        { idx: 3, start: 20000, end: 20000, text: "講者 3：第二位分享書上。", corrected: "舊三", summary: "舊重點三", seg: 2 }],
        summary: { intro: "舊總結", full: "舊", short: "舊", chapters: [] }, mindmap: { center: "舊的心智圖", branches: [{ label: "舊議題", children: [] }] } } });
      await p.go();
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`phase === "done" && chunks.size === 3 && mindmap?.center === "舊的心智圖"`, 10000);
      assert(await p.ev(`meetingContext === "舊說明"`), "說明跟著暫存開回來");
      await p.ev(`window._paras = []; window._f0 = window.fetch;
        window.fetch = (u, o) => { if (String(u).includes("/api/agent/para")) _paras.push(JSON.parse(o.body)); return _f0(u, o); };
        ctxOpen.click(); ctxText.value = "講者 1 是主持人小美，講者 2、3 輪流分享"; true`);   // 沒按「存好說明」就直接重整：用視窗裡的說明
      assert(await p.ev(`!ctxRedo.hidden`), "會議結束、有暫存：可以依說明重整");
      await p.ev(`ctxRedo.click(); true`);
      assert(await p.ev(`/再按一次/.test(ctxRedo.textContent) && _paras.length === 0`), "按一次只是確認，還沒送");
      await p.ev(`ctxRedo.click(); true`);
      await p.until(`_paras.length === 3`, 10000);
      assert(await p.ev(`_paras.every((x) => x.redo === true && x.backfill === true && x.context === "講者 1 是主持人小美，講者 2、3 輪流分享")`), "全部段落帶重整旗標與新說明");
      await p.until(`!evtSrc && !!summary && summary.intro !== "舊總結" && [...chunks.values()].every((c) => c.corrected && !c.corrected.startsWith("舊"))`, 30000);
      let saved;
      for (let t = Date.now(); Date.now() - t < 10000; await sleep(250)) {
        saved = (await (await fetch(`http://127.0.0.1:${port}/api/drafts/get?draft=${id}`)).json()).ai;
        if (saved.summary?.whole && saved.summary.intro !== "舊總結") break;
      }
      assert(saved.summary?.whole && saved.summary.intro !== "舊總結", `總結要用整場重新產生並寫回暫存：${JSON.stringify(saved.summary).slice(0, 120)}`);
      await p.until(`mindmap?.center === "IEP 會議" && !mapBusy`, 20000);
      assert(await p.ev(`!!lastLive?.text`), "重整會更新即時摘要");
    });
  },

  // 拖檔案進畫面、用 Soniox 非即時（假的）：講者分開、停頓斷句；開始前以外的時候拖進來不會匯入（#90）
  async "import-soniox"() {
    await withEnv(async ({ page: p }) => {
      await setup(p, { ai: false });
      await p.ev(`engine.value = "soniox"; engine.onchange(); true`);
      const drop = (name) => dropWav(p, name);
      await drop("訪談.wav");
      await p.until(`phase === "rec" && !!importing`, 10000);
      await p.until(`phase === "done"`, 30000);
      const segs = await p.ev(`segs.map((s) => [s.speaker, s.text])`);
      assert(segs.some(([spk, t]) => spk === "2" && t.includes("下週再談")), `要分出講者 2：${JSON.stringify(segs)}`);
      assert(segs.some(([, t]) => t.includes("第二批")), "第二批結果也要收到");
      assert(await p.ev(`dropOverlay.hidden`), "放開後提示要收起來");
      // 會後畫面再拖檔案：不會開始新的匯入，也不會離開這一頁
      const before = await p.ev("meetingId");
      await drop("另一個.wav");
      await sleep(500);
      assert(await p.ev(`phase === "done" && meetingId === ${JSON.stringify(before)}`), "開始前以外不收拖進來的檔案");
      // 取消匯入後、伺服器的 done 還沒回來（importing 還在）：回到開始前畫面也不收新的檔案
      await p.ev(`importing = { name: "x", cancelled: true, lastEvt: Date.now() }; setPhase("setup"); true`);
      await drop("第三個.wav");
      await sleep(500);
      assert(await p.ev(`meetingId === ${JSON.stringify(before)}`), "上一個匯入還沒收尾時不開新的匯入");
      await p.ev(`importing = null; true`);
      // 取消匯入後伺服器的 done 一直沒來（例如主機剛好重啟）：頁面自己問 status，連兩次不在就收尾
      await p.ev(`meetingId = newMeetingId(); draftId = null; importing = { name: "y", size: 1, sent: 0, stage: "upload", done: 0, total: 0, elapsed: 0, lastEvt: Date.now() };
        setRecording(true); setPhase("rec"); btn.click(); true`);
      assert(await p.ev(`!!importing && importing.cancelled`), "按「取消匯入」先標成取消中");
      await p.until(`importing === null && phase !== "rec"`, 20000);
      // 伺服器回錯誤（例如 500）不算「不在了」：不收尾
      await p.ev(`window.__fetch = fetch; fetch = (u, o) => String(u).includes("/api/import/status") ? Promise.resolve(new Response('{"error":"x"}', { status: 500 })) : __fetch(u, o);
        meetingId = newMeetingId(); importing = { name: "z", size: 1, sent: 0, stage: "upload", done: 0, total: 0, elapsed: 0, lastEvt: Date.now() };
        setRecording(true); setPhase("rec"); btn.click(); true`);
      await sleep(12000);
      assert(await p.ev(`!!importing`), "伺服器回錯誤時不能當成匯入不在了");
      await p.ev(`fetch = __fetch; true`);
      await p.until(`importing === null`, 20000);
    });
  },

  // 個人修正清單：存了重新整理還在；正確的字接在這場名詞後面送給 Whisper，重複的只算一次
  async corrections() {
    await withEnv(async ({ page: p, port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/corrections`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" },
        body: JSON.stringify({ hints: [["書上", "學障"], ["IEP 計畫", "IEP"]], fixed: [["下周", "下週"]] }) });
      assert(r.ok, `存修正清單失敗 ${r.status}`);
      await p.go();
      await p.until(`document.getElementById("corrHints").value.includes("書上 → 學障")`, 10000);
      const terms = await p.ev(`document.getElementById("terms").value = "IEP\\n資源教室"; asrTerms()`);
      assert(JSON.stringify(terms) === JSON.stringify(["IEP", "資源教室", "學障", "下週"]), `asrTerms 不對：${terms}`);
    });
  },

  // 共用用詞正本（#140）：專有名詞提示預設換成正本的領域詞（改過就不動）；設定面板說讀到正本、這台加的有幾組還沒收回；
  // AI 校正的段落照正本的固定替換
  async "shared-vocabulary"() {
    const note = "# 轉錄用詞正本\n\n## 領域詞與專有名詞\n\n資源教室、班導\n\n## 固定替換（所有工具一律換）\n\n### 中文\n\n- 班長 → 班導\n\n## 誤聽對照（AI 依上下文判斷）\n\n- 思妤 → 詩妤\n";
    await withEnv(async ({ page: p, port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/corrections`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" },
        body: JSON.stringify({ hints: [["思妤", "詩妤"], ["詩語", "詩妤"]], fixed: [["班長", "班代"]] }) });
      assert(r.ok, `存修正清單失敗 ${r.status}`);
      await p.go();
      await p.until(`corrLoaded`, 10000);
      assert(await p.ev(`document.getElementById("terms").value`) === "資源教室\n班導", "專有名詞提示要換成正本的領域詞");
      const msg = await p.ev(`document.getElementById("corrNote").textContent`);
      assert(/共用用詞正本/.test(msg) && /一定換 1 組/.test(msg) && /1 組還沒收回/.test(msg), `設定面板說明不對：${msg}`);
      assert(/1 組和正本寫法不同，以正本為準/.test(msg) && /班長：這裡寫 班代、正本是 班導/.test(msg), `要說出和正本衝突的組合（#148）：${msg}`);
      await setup(p, { ai: true });
      await record(p, 1500);
      await p.ev(`finals.push({ text: "今天書上的學生由班長報告。", start: 1000, brk: true }); updateSegs(); maybeSendChunk(true); true`);
      await p.until(`[...chunks.values()].some((c) => c.corrected)`, 15000);
      const corrected = await p.ev(`[...chunks.values()].find((c) => c.corrected).corrected`);
      assert(corrected.includes("由班導報告"), `AI 段落要照正本的固定替換：${corrected}`);
      await stopRec(p);
    }, { wav: SILENT, pre: (work) => fs.writeFileSync(path.join(work, "vocabulary.md"), note) });
    // 改過的專有名詞不被蓋掉
    await withEnv(async ({ page: p }) => {
      await p.ev(`document.getElementById("terms").value = "自己的詞"; loadCorr(); true`);
      await p.until(`corrLoaded`, 10000);
      assert(await p.ev(`document.getElementById("terms").value`) === "自己的詞", "使用者改過的專有名詞提示不能蓋掉");
    }, { wav: SILENT, pre: (work) => fs.writeFileSync(path.join(work, "vocabulary.md"), note) });
  },

  // 部署後提示重新整理：錄音中不跳，停下來才跳，按掉之後先不再跳（#66）
  // 慢線路（#102）：1.1 MB 的簡繁轉換檔晚到時頁面要先能用，載好後「轉台灣繁體」才啟用；載不到就維持停用
  async "slow-opencc"() {
    await withEnv(async ({ page: p, work, url }) => {
      await p.send("Network.enable");
      await p.send("Network.setCacheDisabled", { cacheDisabled: true });
      const reload = () => p.send("Page.navigate", { url });
      fs.writeFileSync(path.join(work, "slow-vendor"), "8");
      await reload();
      await p.until(`!!document.getElementById("btn") && typeof openccReady === "function" && document.getElementById("agType").options.length > 2`, 5000);
      assert(await p.ev(`typeof OpenCC === "undefined" && document.getElementById("t2s").disabled`), "轉換檔還沒到：轉台灣繁體要先停用");
      assert(await p.ev(`show("软件") === "软件"`), "轉換檔還沒到：先原樣顯示");
      await p.until(`!document.getElementById("t2s").disabled`, 20000);
      assert(await p.ev(`show("简体软件") === "簡體軟體"`), "轉換檔到了要轉成台灣繁體");
      fs.rmSync(path.join(work, "slow-vendor"));
      fs.writeFileSync(path.join(work, "fail-vendor"), "");
      await reload();
      await p.until(`document.readyState === "complete" && !!document.getElementById("btn") && document.getElementById("agType").options.length > 2`);
      assert(await p.ev(`document.getElementById("t2s").disabled && show("软件") === "软件"`), "轉換檔載不到：維持停用、原樣顯示");
    });
  },
  async "reload-banner"() {
    await withEnv(async ({ page: p }) => {
      await p.ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith("/healthz")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, build: "ffffffffffff" }), { headers: { "Content-Type": "application/json" } })) : real(u, o); return true; })()`);
      await setup(p);
      await record(p, 2000);
      await p.ev("checkBuild()");
      assert(await p.ev(`alertKind !== "update"`), "錄音中不該提示新版本");
      await stopRec(p);
      await p.ev("checkBuild()");
      assert(await p.ev(`alertKind === "update"`), "停下來後要提示新版本");
      await p.ev(`document.getElementById("alertClose").click(); true`);
      await p.ev("checkBuild()");
      assert(await p.ev(`alertKind !== "update"`), "按掉之後一段時間內不再提示");
    });
  },

  // 金鑰保管箱：建立、設定兩家、只顯示末四碼、測試鍵、上鎖、錯的密語、重新整理後仍在；錄音只送臨時金鑰（#105）
  async "client-vault"() {
    await clientEnv(async ({ page: p, reqs }) => {
      await p.until(`[...engine.options].some((o) => o.value === "azure")`, 10000);
      await p.until(`!$("vaultBox").hidden && !$("vaultSetup").hidden`, 10000);
      await p.ev(`$("vaultPass1").value = $("vaultPass2").value = "short"; $("vaultCreate").click(); true`);
      assert(/至少 8/.test(await p.ev(`$("vaultNote").textContent`)), "密語太短要擋下");
      await p.ev(`$("vaultPass1").value = "abcdefgh1"; $("vaultPass2").value = "abcdefgh2"; $("vaultCreate").click(); true`);
      assert(/不一樣/.test(await p.ev(`$("vaultNote").textContent`)), "兩次密語不同要擋下");
      await vaultFill(p);
      const list = await p.ev(`$("vaultList").textContent`);
      assert(/…1234/.test(list) && /…5678（eastasia）/.test(list) && !list.includes("MASTER"), `清單只顯示末四碼：${list}`);
      await p.ev(`[...$("vaultList").querySelectorAll("button")].find((b) => b.textContent === "測試").click(); true`);
      await p.until(`/Soniox 金鑰有效/.test($("vaultNote").textContent)`, 5000);
      // 上鎖：記憶體裡的金鑰清掉，不能開始錄音
      await p.ev(`$("vaultLockBtn").click(); true`);
      assert(await p.ev(`!$("vaultLocked").hidden && vault.secrets === null && vault.dek === null`), "上鎖後要清掉記憶體裡的金鑰");
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = false; $("btn").click(); true`);
      await p.until(`/上鎖/.test($("status").textContent) && !recording && !$("btn").disabled`, 5000);
      await p.ev(`$("vaultPass").value = "wrong pass!"; $("vaultUnlock").click(); true`);
      await p.until(`/密語不對/.test($("vaultNote").textContent)`, 20000);
      assert(await p.ev(`vault.secrets === null`), "密語錯了不能解開");
      await p.ev(`$("vaultPass").value = ${JSON.stringify(PASS)}; $("vaultUnlock").click(); true`);
      await p.until(`!$("vaultOpenBox").hidden`, 20000);
      // 重新整理：保管箱還在，但要重新解鎖
      await p.go();
      await p.until(`keyMode === "client" && !$("vaultLocked").hidden && vault.secrets === null`, 10000);
      await p.ev(`$("vaultPass").value = ${JSON.stringify(PASS)}; $("vaultUnlock").click(); true`);
      await p.until(`vault.secrets && vault.secrets.soniox && vault.secrets.soniox.key === ${JSON.stringify(KEY_S)}`, 20000);
      // 錄一段：瀏覽器用主金鑰向 Soniox 換臨時金鑰，WebSocket 只帶臨時金鑰
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = false; true`);
      await record(p, 3500);
      await stopNow(p);
      await p.until(`!recording && phase === "done" && !asr`, 15000);
      const log = JSON.parse(await p.ev(`JSON.stringify({ s: __asr.soniox, ws: __asr.ws.map((w) => ({ protocols: w.protocols, config: w.config })) })`));
      const mint = log.s[log.s.length - 1];
      assert(mint.auth === `Bearer ${KEY_S}` && mint.body.usage_type === "transcribe_websocket" && mint.body.single_use === true && mint.body.expires_in_seconds <= 60, `換臨時金鑰的請求不對：${JSON.stringify(mint.body)}`);
      assert(log.ws.length === 1 && log.ws[0].protocols[0] === "soniox-api-key" && /^tmp-soniox-/.test(log.ws[0].protocols[1]), `WebSocket 只能帶臨時金鑰：${log.ws[0]?.protocols}`);
      assert(log.ws[0].config && log.ws[0].config.model === "stt-rt-v5" && !JSON.stringify(log.ws[0].config).includes("MASTER"), "設定訊息不能帶主金鑰");
      const text = await p.ev(`finals.map((t) => t.text).join("")`);
      assert(/甲\d+/.test(text) && text.endsWith("尾"), `逐字稿要有 Soniox 的字並正常收尾：${text}`);
      await noLeak(p, reqs);
    });
  },

  // 忘記密語：上鎖狀態不解鎖也能清除保管箱，兩段式確認，清完回到建立畫面（#115）
  async "client-vault-reset-locked"() {
    await clientEnv(async ({ page: p }) => {
      await vaultFill(p);
      await p.ev(`$("vaultLockBtn").click(); true`);
      assert(await p.ev(`!$("vaultLocked").hidden && $("vaultOpenBox").hidden && !$("vaultResetLocked").hidden`), "上鎖時要看得到「忘記密語？清除保管箱」");
      await p.ev(`$("vaultPass").value = "wrong pass!"; $("vaultUnlock").click(); true`);
      await p.until(`/密語不對/.test($("vaultNote").textContent)`, 20000);
      const hint = await p.ev(`$("vaultNote").textContent`);
      assert(/清除保管箱/.test(hint) && /Soniox／Azure 後台/.test(hint), `解鎖失敗要提示可以清除重設：${hint}`);
      // 第一次按只提醒，不刪
      await p.ev(`$("vaultResetLocked").click(); true`);
      await p.until(`/再按一次「忘記密語？清除保管箱」/.test($("vaultNote").textContent)`, 5000);
      assert(await p.ev(`!!vault.rec && !$("vaultLocked").hidden`), "按一次不能就清掉");
      assert(await p.ev(`(async () => !!(await idb("readonly", (st) => st.get("v1"))))()`), "按一次時 IndexedDB 的保管箱還要在");
      // 5 秒內再按一次才清
      await p.ev(`$("vaultResetLocked").click(); true`);
      await p.until(`!vault.rec && !$("vaultSetup").hidden && $("vaultLocked").hidden`, 5000);
      assert(/已清除/.test(await p.ev(`$("vaultNote").textContent`)), "清完要說明可以重新建立");
      assert(await p.ev(`(async () => (await idb("readonly", (st) => st.get("v1"))) === undefined)()`), "IndexedDB 裡的保管箱要刪掉");
      // 重新整理後仍是建立畫面，可以用新密語重建
      await p.go();
      await p.until(`keyMode === "client" && !$("vaultSetup").hidden && $("vaultLocked").hidden && !vault.rec`, 10000);
      await vaultFill(p);
      assert(await p.ev(`vault.secrets.soniox.key === ${JSON.stringify(KEY_S)}`), "清除後要能重新建立保管箱");
    });
  },

  // Soniox 中途斷線自動改用 Azure，逐字稿不遺失、時間接得上；之後手動換回 Soniox（#105）
  async "client-switch"() {
    await clientEnv(async ({ page: p, reqs }) => {
      await vaultFill(p);
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = false; window.__sonioxDropAt = 25; window.__azureDelay = 1500; true`);
      await record(p, 500);
      await p.until(`engineNow === "azure" && !!asr`, 15000);
      assert(/改用 Azure/.test(await p.ev(`$("alertText").textContent`)), "斷線改用 Azure 時要告訴使用者");
      await sleep(2500);
      const mid = JSON.parse(await p.ev(`JSON.stringify(finals)`));
      const firstAz = mid.find((t) => /^乙/.test(t.text));
      assert(mid.some((t) => /^甲/.test(t.text)) && firstAz, `兩家的字都要在：${mid.map((t) => t.text).join("")}`);
      assert(mid.some((t) => t.text === "暫"), "斷線前的暫定字要當定稿留下");
      // 假 Azure 收到第 10 包音訊（1 秒）回第一句；換 token 故意慢 1.5 秒，時間仍要從斷線那一刻接（PR #111 review）
      const dropped = await p.ev("window.__droppedAt");
      assert(Math.abs(firstAz.start - (dropped + 1000)) < 700, `Azure 的時間要從斷線那一刻接：第一句 ${firstAz.start}，斷線 ${dropped}`);
      const az = JSON.parse(await p.ev(`JSON.stringify(__asr.azure)`));
      assert(az.length >= 1 && az.every((a) => a.region === "eastasia" && a.key === KEY_A), "Azure token 要用這台裝置的金鑰向指定區域換");
      await p.until(`!$("asrSwap").hidden && /Soniox/.test($("asrSwap").textContent)`, 5000);
      await p.ev(`$("asrSwap").click(); true`);
      await p.until(`engineNow === "soniox" && !!asr`, 10000);
      await sleep(2000);
      await stopNow(p);
      await p.until(`!recording && phase === "done" && !asr`, 20000);
      const text = await p.ev(`finals.map((t) => t.text).join("")`);
      assert(await p.ev(`__asr.ws.length`) === 2 && text.endsWith("尾"), `換回 Soniox 後要正常收尾：${text}`);
      assert(await p.ev(`__asr.sdk.every((r) => r.closed)`), "換掉的 Azure 連線要關掉");
      await noLeak(p, reqs);
    });
  },

  // 只用 Azure 錄一段：結束時等 Azure 把剩下的辨識完再收尾（#105）
  async "client-azure"() {
    await clientEnv(async ({ page: p, reqs }) => {
      await vaultFill(p);
      await p.ev(`engine.value = "azure"; engine.onchange(); $("ai").checked = false; true`);
      assert(await p.ev(`!$("azDiarBox").hidden`), "選 Azure 時要顯示講者分離選項");
      await record(p, 2500);
      await p.ev(`$("vaultLockBtn").click(); true`);
      assert(await p.ev(`vault.secrets !== null && /錄音中不能上鎖/.test($("vaultNote").textContent)`), "錄音中不能上鎖（Azure 續 token 要用金鑰）");
      await stopNow(p);
      await p.until(`!recording && phase === "done" && !asr`, 20000);
      const text = await p.ev(`finals.map((t) => t.text).join("")`);
      assert(/乙\d+/.test(text) && text.includes("乙尾"), `Azure 收尾要等最後一句：${text}`);
      assert(await p.ev(`__asr.sdk.length === 1 && __asr.sdk[0].stopped && __asr.sdk[0].closed`), "結束後要停止並關掉 Azure 辨識");
      assert(await p.ev(`__asr.ws.length === 0`), "只用 Azure 時不該連 Soniox");
      await noLeak(p, reqs);
    });
  },

  // passkey 解鎖：用 Chrome 的虛擬驗證器（含 PRF）建立 passkey，上鎖後用 passkey 解開（#105）
  async "client-passkey"() {
    await clientEnv(async ({ page: p }) => {
      await vaultFill(p);
      await p.until(`!$("vaultPasskeyAdd").hidden`, 5000);
      await p.ev(`$("vaultPasskeyAdd").click(); $("vaultPkPass").value = "wrong pass!"; $("vaultPkGo").click(); true`);
      await p.until(`/密語不對/.test($("vaultNote").textContent)`, 20000);
      assert(await p.ev(`!vault.rec.passkey`), "密語錯了不能加 passkey");
      await p.ev(`$("vaultPkPass").value = ${JSON.stringify(PASS)}; $("vaultPkGo").click(); true`);
      await p.until(`!!vault.rec.passkey || $("vaultNote").className.includes("err")`, 20000);
      assert(await p.ev(`!!vault.rec.passkey`), `建立 passkey 失敗：${await p.ev(`$("vaultNote").textContent`)}`);
      await p.ev(`$("vaultLockBtn").click(); true`);
      await p.until(`!$("vaultPasskeyBtn").hidden`, 5000);
      await p.ev(`$("vaultPasskeyBtn").click(); true`);
      await p.until(`vault.secrets && vault.secrets.azure && vault.secrets.azure.key === ${JSON.stringify(KEY_A)}`, 20000);
    }, {
      host: "localhost",
      before: async ({ send }) => {
        await send("WebAuthn.enable");
        const r = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
        if (r.error) throw new Error("虛擬驗證器開不起來：" + r.error.message);
      },
    });
  },

  // client 模式匯入檔案（#114）：主機只轉檔，瀏覽器用保管箱的主金鑰直接送 Soniox，tokens 送回主機後照常 AI 整理、存 Drive
  async "client-import"() {
    await clientEnv(async ({ page: p, work, reqs }) => {
      await vaultFill(p);
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = true; window.__sxUploadMs = 1500; window.__sxPolls = 3;
        window.__stages = []; setInterval(() => { if (importing && __stages.at(-1)?.[0] !== importing.stage) __stages.push([importing.stage, $("status").textContent]); }, 50); true`);
      await dropWav(p, "家長座談.wav", 12);
      await p.until(`phase === "rec" && !!importing`, 10000);
      await p.until(`importing?.stage === "upload_stt" && importing.sttSent > 0 && /送到 Soniox \\d+%/.test($("status").textContent)`, 20000)
        .catch(async (e) => { throw new Error(e.message + JSON.stringify(await p.ev("[__stages, $('status').textContent, __sx.calls]"))); });
      assert(/保持開著/.test(await p.ev(`$("status").textContent`)), "瀏覽器在轉錄時要提醒這頁保持開著");
      await p.until(`phase === "done"`, 30000);
      const stages = (await p.ev("__stages")).map(([k]) => k);
      for (const k of ["upload_stt", "queued", "transcribing"]) assert(stages.includes(k), `要看到 ${k} 階段：${stages}`);
      // 每換一個步驟都跟主機回報（主機靠這個知道頁面還開著）
      const told = reqs.filter((q) => q.url.endsWith("/api/import/progress")).map((q) => JSON.parse(q.postData).stage);
      for (const k of ["fetch_audio", "upload_stt", "queued", "transcribing", "send_result"]) assert(told.includes(k), `要跟主機回報 ${k}：${told}`);
      const segs = await p.ev(`segs.map((s) => [s.speaker, s.text])`);
      assert(segs.some(([spk, t]) => spk === "2" && t.includes("下週再談")) && segs.some(([, t]) => t.includes("第二批")), `講者與第二批都要在：${JSON.stringify(segs)}`);
      assert(/家長座談$/.test(await p.ev("meetingTitle")), "會議名稱接檔名");
      const sx = JSON.parse(await p.ev(`JSON.stringify(__sx)`));
      assert(sx.calls.every((c) => c.auth === `Bearer ${KEY_S}`), "Soniox 的每個請求都用保管箱的主金鑰");
      const up = sx.calls.find((c) => c.path === "/files");
      assert(up && up.body.name === "meeting.m4a" && up.body.size > 10000, `上傳的是主機轉好的 m4a：${JSON.stringify(up)}`);
      const create = sx.calls.find((c) => c.path === "/transcriptions" && c.method === "POST").body;
      assert(create.model === "stt-async-v5" && create.enable_speaker_diarization === true && Array.isArray(create.context.terms), `轉錄設定不對：${JSON.stringify(create)}`);
      assert(Object.keys(sx.files).length === 0 && Object.keys(sx.jobs).length === 0, "Soniox 上的檔案與轉錄用完就刪");
      const host = reqs.map((q) => new URL(q.url).pathname);
      assert(host.includes("/api/import/audio") && host.includes("/api/import/transcript") && host.includes("/api/import/progress"), `要跟主機拿音檔、回報進度、送回結果：${host}`);
      const sent = reqs.find((q) => q.url.endsWith("/api/import/transcript"));
      assert(!sent.postData.includes("confidence"), "送回主機的 token 只帶需要的欄位");
      await p.until("!!summary", 30000);
      await p.until(`saveAudio.checked`, 5000);
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "cimp"; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const files = fs.readdirSync(path.join(work, "drive", "e2e", dir));
      assert(files.includes("audio.m4a") && files.includes("transcript.txt"), `Drive 要有逐字稿與 m4a：${files}`);
      await noLeak(p, reqs);
    });
  },

  // client 模式匯入的失敗與取消（#114）：保管箱上鎖不開始、Soniox 錯誤講清楚、取消時刪掉 Soniox 上的資料
  async "client-import-errors"() {
    await clientEnv(async ({ page: p, port, reqs }) => {
      await vaultFill(p);
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = false; $("vaultLockBtn").click(); true`);
      await dropWav(p, "a.wav");
      await p.until(`/上鎖/.test($("status").textContent) && $("status").className === "err"`, 5000);
      assert(await p.ev(`!importing && phase === "setup"`) && !reqs.some((q) => q.url.includes("/api/import/start")), "保管箱上鎖時不開始匯入");
      await p.ev(`$("vaultPass").value = ${JSON.stringify(PASS)}; $("vaultUnlock").click(); true`);
      await p.until(`!!vault.secrets`, 20000);
      // 餘額不足：清楚告知、回到開始前、已上傳的檔案刪掉、主機那邊也收掉
      await p.ev(`window.__sxFail = { "POST /transcriptions": 402 }; true`);
      await dropWav(p, "b.wav");
      await p.until(`!!importing`, 10000);
      await p.until(`importing === null && phase === "setup"`, 30000);
      assert(/匯入失敗：Soniox 帳戶餘額不足/.test(await p.ev(`$("status").textContent`)), `要說餘額不足：${await p.ev(`$("status").textContent`)}`);
      assert(await p.ev(`Object.keys(__sx.files).length === 0 && __sx.calls.some((c) => c.method === "DELETE")`), "失敗也要刪掉 Soniox 上的檔案");
      const st = await (await fetch(`http://127.0.0.1:${port}/api/import/status?meeting=${await p.ev("meetingId")}`)).json();
      assert(!st.running, "主機那邊的匯入要收掉");
      // 金鑰無效
      await p.ev(`window.__sxFail = { "POST /files": 401 }; true`);
      await dropWav(p, "c.wav");
      await p.until(`!!importing`, 10000);
      await p.until(`importing === null && phase === "setup"`, 30000);
      assert(/金鑰無效/.test(await p.ev(`$("status").textContent`)), "上傳被拒要說金鑰無效");
      // 轉錄中取消：停止輪詢、刪掉 Soniox 上的轉錄與檔案，不算錯誤
      await p.ev(`window.__sxFail = {}; window.__sxPolls = 1e9; true`);
      await dropWav(p, "d.wav");
      await p.until(`importing?.stage === "transcribing"`, 30000);
      await p.ev(`$("btn").click(); true`);
      await p.until(`importing === null && phase === "setup"`, 30000);
      assert(await p.ev(`Object.keys(__sx.files).length === 0 && Object.keys(__sx.jobs).length === 0`), "取消要刪掉 Soniox 上的轉錄與檔案");
      assert(await p.ev(`$("status").className !== "err"`), "取消不是錯誤");
      const after = await p.ev(`__sx.calls.length`);
      await sleep(4000);
      assert(await p.ev(`__sx.calls.length`) === after, "取消後不再查 Soniox");
      // 主機那邊先結束這個匯入（例如頁面太久沒回報而逾時）：瀏覽器也停止輪詢、刪掉 Soniox 上的資料
      await dropWav(p, "e.wav");
      await p.until(`importing?.stage === "transcribing"`, 30000);
      await fetch(`http://127.0.0.1:${port}/api/import/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "X-Meeting-Scribe": "1" }, body: JSON.stringify({ meeting: await p.ev("meetingId") }) });
      await p.until(`importing === null && phase === "setup"`, 15000);
      await p.until(`Object.keys(__sx.files).length === 0 && Object.keys(__sx.jobs).length === 0`, 5000);
      const left = await p.ev(`__sx.calls.length`);
      await sleep(4000);
      assert(await p.ev(`__sx.calls.length`) === left, "主機結束後瀏覽器不再查 Soniox");
      await noLeak(p, reqs);
    });
  },

  // 網頁在 Pages、API 在主機（不同來源）：讀設定、金鑰保管箱、Soniox 錄音、AI 整理的 SSE、會後總結、暫存、存 Drive 都走得通（#106）
  async "pages-cross-origin"() {
    await pagesEnv(async ({ page: p, work, apiOrigin, pageOrigin, reqs }) => {
      assert(await p.ev(`API_BASE`) === apiOrigin && await p.ev(`location.origin`) === pageOrigin, "網頁要從 Pages 那個來源來、API 指向主機");
      await vaultFill(p);
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = true; true`);
      await record(p, 6000);
      await stopNow(p);
      await p.until(`!recording && phase === "done" && !asr`, 20000);
      await p.until("!!summary", 30000);
      assert(reqs.some((q) => q.url.startsWith(apiOrigin + "/api/agent/events?")), "AI 整理的 SSE 要連到主機");
      await p.until(`[...saveRoot.options].some((o) => o.value === "t")`, 5000);
      await p.ev(`saveRoot.value = "t"; saveFolder.value = "e2e"; saveTitle.value = "pages"; saveAudio.checked = true; saveBtn.click(); true`);
      await p.until(`/已存到/.test(document.getElementById("saveStatus").textContent)`, 20000);
      const dir = fs.readdirSync(path.join(work, "drive", "e2e"))[0];
      const files = fs.readdirSync(path.join(work, "drive", "e2e", dir)).sort();
      for (const f of ["summary.md", "transcript.txt"]) assert(files.includes(f), `Drive 應有 ${f}：${files}`);
      assert(files.some((f) => /^audio/.test(f) || /\.(webm|m4a|mp4|ogg)$/.test(f)), `Drive 應有音檔：${files}`);
      const host = reqs.filter((q) => q.url.startsWith(apiOrigin));
      assert(host.some((q) => q.url.includes("/api/agent/para")) && host.some((q) => q.url.includes("/api/drafts/")), "段落與暫存都要送到主機");
      const strays = reqs.filter((q) => q.url.startsWith(pageOrigin) && /\/(api|token|healthz)\b/.test(new URL(q.url).pathname));
      assert(strays.length === 0, `不能有 API 請求打到 Pages：${strays.map((q) => q.url)}`);
      assert(reqs.some((q) => q.url === pageOrigin + "/vendor/opencc-js-1.0.5-full.js"), "vendor 檔要從 Pages 拿");
      await noLeak(p, reqs.filter((q) => q.url.startsWith(apiOrigin)));
    });
  },

  // 網頁在 Pages 時匯入檔案（#114）：上傳、取回 m4a、回報進度、送回結果都跨來源打主機，Soniox 由瀏覽器直接呼叫
  async "pages-import"() {
    await pagesEnv(async ({ page: p, apiOrigin, pageOrigin, reqs }) => {
      await vaultFill(p);
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = false; true`);
      await dropWav(p, "跨來源.wav", 4);
      await p.until(`phase === "rec" && !!importing`, 10000);
      await p.until(`phase === "done"`, 30000);
      assert(await p.ev(`segs.some((s) => s.text.includes("下週再談"))`), "要收到轉好的逐字稿");
      const host = reqs.filter((q) => q.url.startsWith(apiOrigin)).map((q) => new URL(q.url).pathname);
      for (const k of ["/api/import/start", "/api/import/file", "/api/import/audio", "/api/import/progress", "/api/import/transcript"]) assert(host.includes(k), `${k} 要打到主機：${host}`);
      assert(!reqs.some((q) => q.url.startsWith(pageOrigin + "/api/")), "API 不能打到 Pages");
      assert(await p.ev(`Object.keys(__sx.files).length === 0 && __sx.calls.length >= 5`), "Soniox 由瀏覽器呼叫並清乾淨");
      await noLeak(p, reqs.filter((q) => q.url.startsWith(apiOrigin)));
    });
  },

  // 網頁在 Pages、主機 API 連不到（#178，手機沒開 Tailscale）：所有送往主機的請求都是網路錯誤。
  // 要明講連不到主機、提示 Tailscale，不能只丟瀏覽器的「Load failed」；主機恢復後按開始要先重新問主機，保管箱照常出現
  async "pages-host-unreachable"() {
    let down = true;
    const cdp = async (c, ctx) => {
      c.on("Fetch.requestPaused", (q) => {
        if (down && q.request.url.startsWith(ctx.apiOrigin)) c.send("Fetch.failRequest", { requestId: q.requestId, errorReason: "AddressUnreachable" });
        else c.send("Fetch.continueRequest", { requestId: q.requestId });
      });
      const r = await c.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      if (r.error) throw new Error("沒辦法攔請求：" + r.error.message);
    };
    await pagesEnv(async ({ page: p }) => {
      await p.until(`!$("alert").hidden && /連不到/.test($("alertText").textContent)`, 10000);
      assert(await p.ev(`/Tailscale/.test($("alertText").textContent) && !$("alertAct").hidden`), "提醒條要提到 Tailscale 並有重試按鈕");
      await p.ev(`$("btn").click(); true`);
      await p.until(`$("status").className === "err"`, 15000);
      const st = await p.ev(`$("status").textContent`);
      assert(/連不到/.test(st) && /Tailscale/.test(st), `按開始要說連不到主機：${st}`);
      assert(await p.ev(`!recording && !$("btn").disabled && phase === "setup"`), "連不到主機時不能進入錄音");
      // 主機恢復：直接按開始，要先重新問主機，照 client 模式要求先設定保管箱
      down = false;
      await p.ev(`$("btn").click(); true`);
      await p.until(`$("status").className === "err" && !/連不到/.test($("status").textContent)`, 15000);
      assert(await p.ev(`keyMode === "client" && !$("vaultBox").hidden`), "連上主機後保管箱要出現");
      assert(await p.ev(`/保管箱|金鑰/.test($("status").textContent)`), `要提示設定金鑰：${await p.ev(`$("status").textContent`)}`);
      assert(await p.ev(`$("alert").hidden || alertKind !== "host"`), "連上後連不到主機的提醒要收掉");
      // 再斷一次：網路恢復（online）時自動再問主機；提醒條的重試按鈕也能收掉提醒
      down = true;
      await p.ev(`loadEngines().then(() => true)`);
      assert(await p.ev(`alertKind === "host"`), "再次連不到要顯示提醒");
      down = false;
      await p.ev(`window.dispatchEvent(new Event("online")); true`);
      await p.until(`alertKind !== "host"`, 10000);
      down = true;
      await p.ev(`loadEngines().then(() => true)`);
      down = false;
      await p.ev(`$("alertAct").click(); true`);
      await p.until(`alertKind !== "host"`, 10000);
    }, { cdp });
  },

  // 主機的 cors_origins 沒列這個網頁來源：瀏覽器拿不到任何 API 回應，server 自己也回 403（#106）
  async "pages-origin-refused"() {
    await pagesEnv(async ({ page: p, apiOrigin, pageOrigin }) => {
      const r = await p.ev(`fetch(api("/api/engines")).then((x) => "ok " + x.status, (e) => e.name)`);
      assert(r === "TypeError", `不在白名單的來源要被擋：${r}`);
      const post = await p.ev(`postJson("/api/drafts/delete", { draft: "x" }).then((x) => "ok " + x.status, (e) => e.name)`);
      assert(post === "TypeError", `POST 也要被擋：${post}`);
      // 主機是 client 模式，讀得到的話會顯示保管箱與 Azure
      assert(await p.ev(`keyMode === "server" && $("vaultBox").hidden && ![...engine.options].some((o) => o.value === "azure")`), "讀不到主機設定");
      const direct = await fetch(apiOrigin + "/api/engines", { headers: { Origin: pageOrigin } });
      assert(direct.status === 403 && !direct.headers.get("access-control-allow-origin"), `server 要直接拒絕：${direct.status}`);
      const pre = await fetch(apiOrigin + "/api/agent/para", { method: "OPTIONS", headers: { Origin: pageOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-meeting-scribe" } });
      assert(pre.status === 403 && !pre.headers.get("access-control-allow-origin"), `preflight 要被拒：${pre.status}`);
    }, { allow: false });
  },

  // 網頁在 Pages、存到 Google Drive 由瀏覽器直傳（#107）：建根資料夾與子資料夾、小檔 multipart、音檔續傳；
  // 續傳中途斷線（只收到一半）要照 Google 說的位置接著傳，token 過期要停下來，重新授權後沿用同一個續傳網址接著傳
  async "drive-browser-pages"() {
    await pagesEnv(async ({ page: p, apiOrigin, pageOrigin, reqs, google, port }) => {
      await vaultFill(p);
      await p.until(`driveMode === "browser" && !!googleCfg`, 5000);
      assert(await p.ev(`$("saveRootBox").hidden && !$("gdriveBox").hidden`), "browser 模式不顯示主機的 Drive 位置，改顯示 Google 連線");
      await p.ev(`engine.value = "soniox"; engine.onchange(); $("ai").checked = true; true`);
      await record(p, 6000);
      await stopNow(p);
      await p.until(`!recording && phase === "done" && !asr`, 20000);
      await p.until("!!summary", 30000);
      await p.ev(`DRIVE_CHUNK = 4096; DRIVE_BACKOFF = 50; true`);
      const size = await p.ev(`(async () => { await audioDone; return new Blob(audioChunks).size; })()`);
      assert(size > 4096 * 5, `音檔太小，測不到分段續傳：${size}`);
      const audioSha = await p.ev(pageSha(`new Blob(audioChunks)`));
      // 第 2 次續傳 PUT 只收一半就斷線；收到 3 段的量以後 token 全部失效
      await gctl(google, "drop_puts", [2]);
      await gctl(google, "short_puts", [4]);   // 第 4 次（斷線後問完進度的下一段）只收一半，照常回 308
      await gctl(google, "expire_after_bytes", 4096 * 3);
      await p.ev(`saveFolder.value = "e2e/學期"; saveTitle.value = "drive"; saveAudio.checked = true; saveBtn.click(); true`);
      await p.until(`/授權過期|已存到|失敗|沒有/.test(saveStatus.textContent)`, 30000);
      assert(/授權過期/.test(await p.ev(`saveStatus.textContent`)), `token 過期要停下來：${await p.ev(`saveStatus.textContent`)}`);
      assert(!(await p.ev("savedOk")), "沒傳完不算存好");
      let st = await gstate(google);
      assert(st.log.some((l) => l[2] === 401), "應該遇到 401");
      await p.ev(`saveBtn.click(); true`);
      await p.until(`/已存到/.test(saveStatus.textContent) || /失敗|沒有/.test(saveStatus.textContent)`, 30000);
      const status = await p.ev(`saveStatus.textContent`);
      assert(/已存到：Google Drive／會議紀錄（meeting-scribe）／e2e／學期／\d{4}-\d{2}-\d{2} \d{4} drive（/.test(status), `存好的訊息不對：${status}`);
      assert(await p.ev(`saveWhereText.textContent.startsWith("Google Drive／會議紀錄（meeting-scribe）／e2e／學期")`), `預覽跟存檔結果要一致：${await p.ev(`saveWhereText.textContent`)}`);
      st = await gstate(google);
      assert(st.auths.length === 2, `應授權兩次（第二次是過期後）：${st.auths.length}`);
      for (const a of st.auths) {
        assert(a.redirect_uri === pageOrigin + "/oauth/" && a.response_type === "token" && a.scope === "https://www.googleapis.com/auth/drive.file", `授權參數不對：${JSON.stringify(a)}`);
        assert(/^[0-9a-f]{32}$/.test(a.state), "state 要是隨機值");
      }
      assert(st.auths[0].state !== st.auths[1].state, "每次授權的 state 都不一樣");
      const roots = st.files.filter((f) => f.appProperties.meetingScribeRoot === "1");
      assert(roots.length === 1 && roots[0].parents[0] === "root" && roots[0].name === "會議紀錄（meeting-scribe）", `根資料夾不對：${JSON.stringify(roots)}`);
      const e2e = kids(st, roots[0].id).filter((f) => f.mimeType === FOLDER);
      assert(e2e.length === 1 && e2e[0].name === "e2e", "子資料夾 e2e");
      const term = kids(st, e2e[0].id);
      assert(term.length === 1 && term[0].name === "學期", "子資料夾 學期");
      const meet = kids(st, term[0].id);
      assert(meet.length === 1 && /^\d{4}-\d{2}-\d{2} \d{4} drive$/.test(meet[0].name), `一場一個資料夾：${meet.map((f) => f.name)}`);
      const files = kids(st, meet[0].id);
      const names = files.map((f) => f.name).sort();
      assert(names.filter((n) => /^audio/.test(n)).length === 1 && names.includes("transcript.txt") && names.includes("summary.md"), `Drive 的檔：${names}`);
      assert(new Set(names).size === names.length, `重新授權後不能重傳已經在 Drive 的檔：${names}`);
      assert(files.find((f) => f.name === "transcript.txt").text === await p.ev(`transcriptFile()`), "逐字稿內容要一樣");
      const audio = files.find((f) => /^audio/.test(f.name));
      assert(audio.sha256 === audioSha && audio.size === size, `音檔內容要完整：${audio.size}／${size}`);
      assert(st.sessions === 1, `中斷與過期都要接著同一個續傳網址傳，不是重來：${st.sessions}`);
      assert(st.dropped === 1 && st.status_queries >= 2, `要真的遇到斷線、並問過 Google 收到哪裡：斷線 ${st.dropped} 次、查進度 ${st.status_queries} 次`);
      await sleep(500);
      const drafts = (await (await fetch(`${apiOrigin}/api/drafts`)).json()).drafts;
      assert(drafts.length === 0, "全部傳完才刪暫存");
      // Google 的 token 不能送到主機，也不能放 localStorage
      const host = reqs.filter((q) => q.url.startsWith(apiOrigin));
      assert(host.some((q) => q.url.includes("/api/save/bundle")), "要向主機拿整理好的檔");
      for (const t of st.tokens) {
        assert(!host.some((q) => (q.url + JSON.stringify(q.headers || {}) + (q.postData || "")).includes(t)), "Google token 不能送到主機");
        assert(!(await p.ev(`JSON.stringify(Object.entries(localStorage))`)).includes(t), "Google token 不能放 localStorage");
      }
      assert(!reqs.some((q) => /googleapis\.com|accounts\.google\.com/.test(q.url)), "e2e 不能連到真的 Google");
    }, { google: true });
  },

  // 部分失敗：音檔沒傳上去要說清楚、暫存留著；重新整理後從「最近的會議」打開，沿用同一個 Drive 資料夾，
  // 只補傳音檔（瀏覽器裡已經沒有錄音，改從主機暫存拿）；不同意授權要說清楚（#107）
  async "drive-browser-resume"() {
    await driveEnv(async ({ page: p, port, google, server, reqs }) => {
      await p.until(`driveMode === "browser" && !!googleCfg`, 5000);
      await setup(p);
      await record(p, 8000);
      await stopRec(p);
      await p.ev(`DRIVE_CHUNK = 4096; DRIVE_BACKOFF = 50; true`);
      // 授權等待中，別的地方塞來 state 對不上的 token（BroadcastChannel 或 postMessage）都不能收
      await p.ev(`(() => { const o = window.open; window.open = () => { window.open = o; return {}; }; saveBtn.click(); return true; })()`);
      await p.ev(`(() => { const bc = new BroadcastChannel("ms-google-auth"); bc.postMessage({ state: "0".repeat(32), access_token: "evil-1", expires_in: "3600" });
        window.postMessage({ msGoogleAuth: { state: "1".repeat(32), access_token: "evil-2", expires_in: "3600" } }, location.origin); return true; })()`);
      await sleep(500);
      assert(await p.ev(`gToken === null && !!gAuthPending`), "state 對不上的 token 不能收");
      await gctl(google, "deny", true);
      await p.ev(`saveFolder.value = ""; saveTitle.value = "resume"; saveAudio.checked = true; saveBtn.click(); true`);
      await p.until(`/沒有同意/.test(saveStatus.textContent)`, 20000);
      await gctl(google, "deny", false);
      const ext = await p.ev(`audioExt(audioMime)`);
      await gctl(google, "fail", [{ name: `audio.${ext}`, status: 403, times: 1 }]);
      await p.ev(`saveBtn.click(); true`);
      await p.until(`/沒有上傳成功/.test(saveStatus.textContent)`, 30000);
      const status = await p.ev(`saveStatus.textContent`);
      assert(status.includes(`audio.${ext}`) && /已上傳：transcript\.txt/.test(status), `要說哪個檔沒傳上去：${status}`);
      const id = await p.ev("draftId");
      await sleep(1500);
      const listed = (await (await fetch(`http://127.0.0.1:${port}/api/drafts`)).json()).drafts;
      assert(listed.some((d) => d.id === id), "沒傳完不能刪暫存");
      const hostAudio = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/drafts/audio-file?draft=${id}&part=1`)).arrayBuffer());
      assert(hostAudio.length > 4096, `主機暫存要有音檔：${hostAudio.length}`);
      // 使用者在 Drive 上把根資料夾改名、搬到別的資料夾底下（#124）：畫面要改顯示新名字，檔案照樣存進同一個資料夾
      const root0 = (await gstate(google)).files.find((f) => f.appProperties.meetingScribeRoot === "1");
      assert(root0 && root0.name === "會議紀錄（meeting-scribe）", "第一次建的根資料夾用預設名");
      assert(/^Google Drive／會議紀錄（meeting-scribe）($|，)/.test(await p.ev(`saveWhereText.textContent`)), `改名前的預覽：${await p.ev(`saveWhereText.textContent`)}`);
      const renamed = "我的 IEP 會議（改過名）";
      assert((await gctl(google, "rename", { id: root0.id, name: renamed })).ok && (await gctl(google, "move", { id: root0.id, parent: "someOtherFolder" })).ok, "假 Drive 改名、搬移");
      await p.go();
      // 這個分頁的授權還在：載入時就查到新名字，存檔前的預覽也是新名字
      await p.until(`saveWhereText.textContent.includes(${JSON.stringify(renamed)})`, 10000);
      await p.until(`document.querySelectorAll("#recentList li").length > 0`, 10000);
      await p.ev(`[...document.querySelectorAll("#recentList .btn")].find((b) => b.textContent === "開啟").click(); true`);
      await p.until(`finals.length > 0 && draftId === ${JSON.stringify(id)}`, 10000);
      assert(await p.ev(`audioChunks.length === 0`), "重新整理後瀏覽器裡沒有錄音");
      await p.ev(`DRIVE_CHUNK = 4096; DRIVE_BACKOFF = 50; saveAudio.checked = true; saveBtn.click(); true`);
      await p.until(`/已存到/.test(saveStatus.textContent) || /失敗|沒有/.test(saveStatus.textContent)`, 30000);
      const done = await p.ev(`saveStatus.textContent`);
      assert(/已存到/.test(done), `第二次要存好：${done}`);
      assert(new RegExp(`^已存到：Google Drive／${renamed.replace(/[()（）]/g, "\\$&")}／\\d{4}-\\d{2}-\\d{2} \\d{4} resume（`).test(done) && !done.includes("會議紀錄（meeting-scribe）"), `要顯示根資料夾的新名字：${done}`);
      assert(await p.ev(`saveWhereText.textContent.startsWith("Google Drive／" + ${JSON.stringify(renamed)})`), `存完後的預覽也是新名字：${await p.ev(`saveWhereText.textContent`)}`);
      assert(await p.ev(`gdriveNote.textContent.includes(${JSON.stringify("「" + renamed + "」")})`), "設定裡的說明也是新名字");
      const st = await gstate(google);
      const roots = st.files.filter((f) => f.appProperties.meetingScribeRoot === "1");
      assert(roots.length === 1 && roots[0].id === root0.id && roots[0].name === renamed, `改名後不能另建根資料夾：${JSON.stringify(roots.map((f) => [f.id, f.name]))}`);
      assert(st.auths.length === 2, `不同意一次、同意一次；重新整理後同一個分頁沿用 token：${st.auths.length}`);
      const root = st.files.find((f) => f.appProperties.meetingScribeRoot === "1");
      const meet = kids(st, root.id);
      assert(meet.length === 1 && /^\d{4}-\d{2}-\d{2} \d{4} resume$/.test(meet[0].name), `沿用同一個資料夾：${meet.map((f) => f.name)}`);
      const files = kids(st, meet[0].id), names = files.map((f) => f.name).sort();
      assert(names.join() === [`audio.${ext}`, "transcript.txt"].sort().join(), `只補傳音檔：${names}`);
      assert(files.find((f) => f.name === `audio.${ext}`).sha256 === sha256(hostAudio), "音檔要跟主機暫存的一樣");
      assert(/GET \/api\/drafts\/audio-file/.test(server.log), "音檔要從主機暫存拿");
      await sleep(500);
      const after = (await (await fetch(`http://127.0.0.1:${port}/api/drafts`)).json()).drafts;
      assert(!after.some((d) => d.id === id), "全部傳完才刪暫存");
      assert(!reqs.some((q) => /googleapis\.com|accounts\.google\.com/.test(q.url)), "e2e 不能連到真的 Google");
    });
  },

  // server 模式（預設）不顯示保管箱、沒有 Azure，頁面有 CSP（#105）
  async "server-key-mode"() {
    await withEnv(async ({ page: p }) => {
      await p.until(`engine.options.length > 0 && keyMode === "server"`, 10000);
      assert(await p.ev(`$("vaultBox").hidden && ![...engine.options].some((o) => o.value === "azure")`), "server 模式不顯示保管箱與 Azure");
      assert(await p.ev(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`), "頁面要有 CSP");
      assert(await p.ev(`typeof window.SpeechSDK === "undefined"`), "沒選 Azure 不載入 Azure SDK");
      const worker = await p.ev(`new Promise((resolve) => {
        try { const w = new Worker("data:text/javascript;base64," + btoa("postMessage(7)")); w.onmessage = (e) => resolve(e.data); w.onerror = () => resolve("error"); }
        catch (e) { resolve(e.name); }
        setTimeout(() => resolve("timeout"), 3000);
      })`);
      assert(worker === 7, `CSP 要允許 Azure SDK 用的 data: Worker：${worker}`);
    });
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const t0 = Date.now();
  try {
    if (!SCENARIOS[name]) throw new Error("沒有這個情境");
    await SCENARIOS[name]();
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n  ${e.message}`);
  }
}
fs.rmSync(fixtures, { recursive: true, force: true });
console.log(failed ? `${failed} 個情境失敗` : `全部 ${names.length} 個情境通過`);
process.exit(failed ? 1 : 0);
