// 會後總結（recording-transcriber#80）：和會議轉錄 App（meeting-scribe）用同一份提示詞與格式。
// 工作室不自己寫提示詞：把字幕切成段落交給 App，拿回簡介、分段章節、完整總結、短總結。
// App 是唯一正本，之後 App 的提示詞改了，這裡不用跟著改。
// 先在這台 MacBook 跑 App 的本機入口（`python3 -I server.py summary`，meeting-scribe#139），
// 本機跑不了或失敗才送到主機 App（#83），所以主機關著也能用。

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 和 App 頁面送段落的規則一樣：滿 150 字就切；超過 60 秒、且至少 20 字也切
export const PARA_CHARS = 150;
export const PARA_MS = 60000;
const PARA_MIN_CHARS = 20;
// App 的總結要讀整場，伺服器自己給 300 秒，這裡多等一點
export const RECAP_TIMEOUT_MS = 330_000;

export const fmtHms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

// cues 已經是剪輯後的時間；回傳 [{start, text}]，start 是段落第一句的開始（毫秒）
export function recapParagraphs(cues) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur?.text) out.push({ start: cur.start, text: cur.text }); cur = null; };
  for (const c of cues) {
    const text = String(c.text || "").trim();
    if (!text) continue;
    if (!cur) cur = { start: Math.max(0, Math.round(c.start)), text: "" };
    cur.text = cur.text ? `${cur.text} ${text}` : text;
    const len = [...cur.text].length;
    if (len >= PARA_CHARS || (c.end - cur.start >= PARA_MS && len >= PARA_MIN_CHARS)) flush();
  }
  flush();
  return out;
}

// 字幕內容的指紋：送去總結的段落一樣，總結就還是新的（rev 每次存檔都會加，不能拿來比）
export const recapKey = (paras) => createHash("sha256").update(JSON.stringify(paras)).digest("hex").slice(0, 16);

function cleanReply(j) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const recap = { intro: str(j?.intro), full: str(j?.full), short: str(j?.short), chapters: [] };
  for (const c of Array.isArray(j?.chapters) ? j.chapters : []) {
    const t = Number(c?.t_ms), title = str(c?.title);
    if (Number.isFinite(t) && t >= 0 && title) recap.chapters.push({ t_ms: Math.round(t), title: title.slice(0, 60) });
  }
  if (!recap.intro && !recap.full && !recap.short) throw new Error("會議轉錄 App 回來的總結是空的");
  return recap;
}

// 呼叫會議轉錄 App（url 是使用者設定的 meeting_scribe_url）。what 是錯誤訊息裡的「什麼」
async function callApp(apiPath, { url, body, what, fetchImpl = fetch, signal, timeoutMs = RECAP_TIMEOUT_MS } = {}) {
  if (!url) throw new Error("沒有設定會議轉錄 App 的網址（使用者設定檔的 meeting_scribe_url）");
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let r;
  try {
    r = await fetchImpl(`${url.replace(/\/+$/, "")}${apiPath}`, {
      method: body ? "POST" : "GET",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), "X-Meeting-Scribe": "1" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: sig,
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error("已經停止"), { cancelled: true });
    if (e?.name === "TimeoutError") throw new Error(`會議轉錄 App 太久沒有回應（超過 ${timeoutMs >= 60_000 ? `${Math.floor(timeoutMs / 60_000)} 分鐘` : `${Math.round(timeoutMs / 1000)} 秒`}）`);
    throw new Error(`連不到會議轉錄 App（${url}）：${String(e?.cause?.code || e?.message || e).slice(0, 120)}`);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`會議轉錄 App 沒有${what}：${String(j?.error || `HTTP ${r.status}`).slice(0, 200)}`), { status: r.status });
  return j;
}

// App 每次請求都要一個會議 id；這裡只是借用它的整理，給一個用完即丟的
const throwawayMeeting = () => randomBytes(16).toString("hex");

// ---- 本機入口（#83）----
// 會議轉錄 App 的程式在這台的位置：預設是旁邊的 meeting-scribe 資料夾（同一個 meeting-suite）；
// CYCLONE_MEETING_SCRIBE_DIR 可改，設成空字串就不在本機跑
const SIBLING_SCRIBE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "meeting-scribe");
export const scribeDir = (env = process.env) => env.CYCLONE_MEETING_SCRIBE_DIR ?? SIBLING_SCRIBE;

// 輸入 {paras, module?, options?}，輸出和主機 API 一樣的一行 JSON。exit 2 輸入不合法、3 找不到 Claude Code、1 AI 失敗
export function runLocalScribe(input, { dir, env = process.env, signal, timeoutMs = RECAP_TIMEOUT_MS, spawnImpl = spawn, python = "python3" } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("已經停止"), { cancelled: true }));
  if (!dir || !fs.existsSync(path.join(dir, "server.py"))) return Promise.reject(new Error("這台沒有會議轉錄 App 的程式"));
  return new Promise((resolve, reject) => {
    let out = "", err = "", done = false, timedOut = false;
    // 自己一個程序群組：停止時連它叫起來的 Claude Code 一起收掉；三秒還不結束就強制
    const child = spawnImpl(python, ["-I", "server.py", "summary"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const signalAll = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* 已經結束 */ } } };
    const stop = () => { signalAll("SIGTERM"); setTimeout(() => { if (!done) signalAll("SIGKILL"); }, 3000).unref?.(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (out.length < 2_000_000) out += d; });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (d) => { err = (err + d).slice(-400); });   // 只留最後一段，失敗時說明原因
    child.on("error", (e) => finish(() => reject(new Error(`本機跑不起來：${e.code || e.message}`))));
    child.on("close", (code) => finish(() => {
      if (signal?.aborted) return reject(Object.assign(new Error("已經停止"), { cancelled: true }));
      if (timedOut) return reject(new Error(`本機太久沒有回應（超過 ${Math.floor(timeoutMs / 60_000) || 1} 分鐘）`));
      let j = null;
      try { j = JSON.parse(out.trim().split("\n").pop() || "null"); } catch { /* 下面當失敗 */ }
      if (code === 0 && j && typeof j === "object" && !j.error) return resolve(j);
      const why = j?.error || `exit ${code}${err.trim() ? `：${err.trim().split("\n").pop()}` : ""}`;
      reject(new Error(`本機沒有產生：${String(why).slice(0, 200)}`));
    }));
    child.stdin.on("error", () => { /* 程式先結束時寫不進去，close 會處理 */ });
    child.stdin.end(JSON.stringify(input));
  });
}

// 有給 local（{dir, env}）就先在本機跑；本機失敗（停止除外）才送主機，並記下原因
async function localThenApp(input, opts, viaApp) {
  let localError = "";
  if (opts.local?.dir) {
    try {
      return { reply: await runLocalScribe(input, { ...opts.local, signal: opts.signal, timeoutMs: opts.timeoutMs }), via: "local" };
    } catch (e) {
      if (e.cancelled || opts.signal?.aborted) throw Object.assign(new Error("已經停止"), { cancelled: true });
      localError = e.message;
    }
  }
  try {
    return { reply: await viaApp(), via: "app", ...(localError ? { local_error: localError } : {}) };
  } catch (e) {
    if (localError && !e.cancelled) e.message = `${e.message}（這台也沒成功：${localError}）`;
    throw e;
  }
}

// 產生會後總結：先本機，再主機 App。回傳的 via 是實際在哪裡產生的
export async function requestRecap(paras, opts = {}) {
  const r = await localThenApp({ paras }, opts, () => callApp("/api/agent/summary", { ...opts, what: "產生總結", body: { meeting: throwawayMeeting(), paras } }));
  return { ...cleanReply(r.reply), via: r.via, ...(r.local_error ? { local_error: r.local_error } : {}) };
}

// ---- 延伸模組（#88，App 端是 meeting-scribe#136）----
// App 的 GET /api/modules：{modules:[{id,title,output,description?,options?:[{id,label,choices:[[id,label]]}]}]}。
// summary 就是上面的會後總結，不重複列；工作室只認得 markdown 輸出的模組
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export function cleanModules(j) {
  const out = [];
  for (const m of Array.isArray(j?.modules) ? j.modules : []) {
    const id = text(m?.id, 40), title = text(m?.title, 60);
    // markdown → 延伸的子頁籤；mindmap → 心智圖頁籤（#101、#106）；其他輸出工作室還不認得
    if (!ID.test(id) || !title || id === "summary" || !["markdown", "mindmap"].includes(m?.output) || out.some((x) => x.id === id)) continue;
    const options = [];
    for (const o of Array.isArray(m.options) ? m.options : []) {
      const oid = text(o?.id, 40), label = text(o?.label, 40);
      const choices = (Array.isArray(o?.choices) ? o.choices : [])
        .filter((c) => Array.isArray(c) && ID.test(text(c[0], 40)) && text(c[1], 40))
        .map((c) => [text(c[0], 40), text(c[1], 40)]);
      if (ID.test(oid) && label && choices.length) options.push({ id: oid, label, choices });
    }
    out.push({ id, title, description: text(m.description, 200), output: m.output, options: m.output === "mindmap" ? [] : options });
  }
  return out;
}

export async function requestModules(opts = {}) {
  return cleanModules(await callApp("/api/modules", { timeoutMs: 15_000, ...opts, what: "回傳模組清單" }));
}

// 模組＋選項（依模組列的順序）決定一份結果：同一個組合再產生就蓋過去
export function moduleKey(mod, options = {}) {
  return [mod.id, ...mod.options.map((o) => `${o.id}=${options[o.id]}`)].join(":");
}
// 每個選項都要是清單裡的選擇；沒給就用第一個（和 App 一樣）
export function resolveModuleOptions(mod, given = {}) {
  const out = {};
  for (const o of mod.options) {
    const v = given?.[o.id];
    if (v === undefined || v === null || v === "") out[o.id] = o.choices[0][0];
    else if (o.choices.some(([c]) => c === v)) out[o.id] = v;
    else throw new Error(`「${o.label}」沒有這個選擇`);
  }
  return out;
}
// 顯示與檔名用的名稱，例如「視角回饋（家長）」
export function moduleLabel(mod, options = {}) {
  const picked = mod.options.map((o) => o.choices.find(([c]) => c === options[o.id])?.[1]).filter(Boolean);
  return picked.length ? `${mod.title}（${picked.join("、")}）` : mod.title;
}

export async function requestModule(paras, mod, options, opts = {}) {
  const r = await localThenApp({ paras, module: mod.id, options }, opts, () => callApp("/api/agent/module", { ...opts, what: `產生「${mod.title}」`, body: { meeting: throwawayMeeting(), module: mod.id, paras, options } }));
  const markdown = text(r.reply?.markdown, 200_000);
  if (!markdown) throw new Error(`會議轉錄 App 回來的「${mod.title}」是空的`);
  const extra = mod.output === "mindmap" ? cleanMindmapReply(r.reply, mod) : {};
  return { markdown, title: text(r.reply?.title, 60) || mod.title, ...extra, via: r.via, ...(r.local_error ? { local_error: r.local_error } : {}) };
}

// 心智圖（App 的 mindmap 模組，meeting-scribe#150）：{center, branches:[{label, children?:[{label, children?:[{label}]}]}]}，
// 議題≤7、重點≤5、細節≤3、每格≤24 字；children 沒有子項時不存在。另外帶 App 轉好的 mermaid 與 opml（和 App 一字不差）
const MAX_LABEL = 40;
function cleanNode(n, depth) {
  const label = text(n?.label, MAX_LABEL);
  if (!label) return null;
  const kids = depth < 3 && Array.isArray(n.children) ? n.children.map((c) => cleanNode(c, depth + 1)).filter(Boolean).slice(0, 12) : [];
  return kids.length ? { label, children: kids } : { label };
}
export function cleanMindmapReply(j, mod = { title: "心智圖" }) {
  const center = text(j?.mindmap?.center, MAX_LABEL);
  const branches = (Array.isArray(j?.mindmap?.branches) ? j.mindmap.branches : []).map((b) => cleanNode(b, 1)).filter(Boolean).slice(0, 12);
  if (!center || !branches.length) throw new Error(`會議轉錄 App 回來的「${mod.title}」不是心智圖`);
  const opml = text(j?.opml, 200_000);
  return { mindmap: { center, branches }, mermaid: text(j?.mermaid, 100_000), opml: opml.startsWith("<?xml") ? opml : "" };
}


export const recapTranscript = (cues) => cues.filter((c) => String(c.text || "").trim()).map((c) => `[${fmtHms(c.start)}] ${String(c.text).trim()}`).join("\n");

// 心智圖的 SVG（App 的 MindMap.toSvg 畫的）存檔前檢查（#111）：檔案會進 Drive、可能在別處打開或嵌進網頁，
// 所以用白名單：只收畫心智圖用得到的元素；屬性不能是事件、連結、style，值裡不能有 javascript:／data:／外部 url()／實體編碼
const SVG_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc"]);
export function safeMindmapSvg(svg) {
  try { return checkSvg(svg); } catch { return false; }
}
function checkSvg(svg) {
  const t = String(svg ?? "").trim();
  if (!t || t.length > 3_000_000 || !/^<svg[\s>]/.test(t) || !/<\/svg>$/.test(t)) return false;
  if (/<!|<\?|&#|\\u/i.test(t)) return false;   // DOCTYPE、實體、CDATA、處理指令、數字字元參照都不收
  const TAG = /<\/?([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*\/?>/g;
  let rest = t.replace(TAG, (m, name, attrs) => {
    if (!SVG_TAGS.has(name)) throw new Error("tag");
    for (const a of attrs.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = a[1].toLowerCase(), value = (a[2] ?? a[3] ?? "").toLowerCase();
      if (key.startsWith("on") || key === "style" || key.endsWith("href") || key === "src") throw new Error("attr");
      if (/javascript:|data:|vbscript:|url\(\s*['"]?(?!#)|expression\(/.test(value)) throw new Error("value");
    }
    return "";
  });
  return !rest.includes("<") && !rest.includes(">");
}

