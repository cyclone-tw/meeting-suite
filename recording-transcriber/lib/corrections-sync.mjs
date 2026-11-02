// 常錯字表只有一份，存在會議轉錄 App（meeting-scribe）的主機上（使用者設定的 meeting_scribe_url）。
// 每台 Mac 每次從 meeting-scribe 的 /api/corrections 取，存一份本機快取；
// 連不上就用快取，再沒有才讀本機 meeting-scribe 的檔案（備援主機上的那份）。
// 快取不放 meeting-scribe 的路徑，免得在 mini 上蓋到備援那份。
// 錯字表可能有人名：只回筆數，內容不寫進報告或 log。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { correctionsFile, parseCorrections } from "./subtitle-ai.mjs";
import { loadAsrProfile } from "./asr-profile.mjs";

// 環境變數設成空字串就是「不連主機」（docs/setup.md）
export function meetingScribeUrl(env = process.env) {
  return String(env.CYCLONE_MEETING_SCRIBE_URL ?? loadAsrProfile().profile.meeting_scribe_url ?? "").replace(/\/+$/, "");
}

export function correctionsCacheFile(env = process.env) {
  return env.CYCLONE_CORRECTIONS_CACHE || path.join(os.homedir(), ".local", "share", "cyclone-transcribe", "corrections-cache.json");
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  // 會議轉錄 App 的 POST 一律要 X-Meeting-Scribe 標頭（擋跨站），GET 帶著也無妨（#124）
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), "X-Meeting-Scribe": "1" }, signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`meeting-scribe ${r.status}${body?.error ? `: ${String(body.error).slice(0, 120)}` : ""}`);
  return body;
}

const count = (c) => ({ hints: c.hints.length, fixed: c.fixed.length });

// 回傳 { corrections: {hints, fixed}, source: "meeting-scribe"|"cache"|"local"|"none", error? }
export async function syncCorrections({ env = process.env, timeoutMs = 8000 } = {}) {
  const cache = correctionsCacheFile(env);
  const url = meetingScribeUrl(env);
  let error = "";   // 主機刻意設成不連（空字串）不算錯誤
  if (url) {
    try {
      const corrections = parseCorrections(await fetchJson(`${url}/api/corrections`, {}, timeoutMs));
      writePrivate(cache, corrections);
      return { corrections, source: "meeting-scribe" };
    } catch (e) {
      error = String(e?.message || e).slice(0, 200);
    }
  }
  const cached = readJson(cache);
  if (cached) return { corrections: parseCorrections(cached), source: "cache", error };
  const raw = readJson(correctionsFile(env));   // 備援主機上：本機 meeting-scribe 那份
  if (raw) return { corrections: parseCorrections(raw), source: "local", error };
  return { corrections: { hints: [], fixed: [] }, source: "none", error: error || (url ? "" : "no meeting-scribe url") };
}

export function correctionsSummary(r) {
  return { source: r.source, ...count(r.corrections), ...(r.error ? { error: r.error } : {}) };
}

// 把一組「錯→對」加進 meeting-scribe 的錯字表（讀最新的整份、加上去、整份寫回），並更新本機快取。
export async function addCorrection(wrong, right, opts = {}) {
  const r = await addCorrections([[wrong, right]], opts);
  return { ...r, added: r.added > 0 };
}

export const MAX_ADD = 40;

// 一次加好幾組（AI 更正名字，#60）：一樣讀一次最新的整份、加上去、只寫回一次。
// 先檢查每一組，有一組不合規就整批不寫；已經有的、重複的不再加；全部都有了就不寫。
export async function addCorrections(pairs, { kind = "hints", env = process.env, timeoutMs = 8000 } = {}) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error("沒有要加的錯字");
  if (pairs.length > MAX_ADD) throw new Error(`一次最多加 ${MAX_ADD} 組錯字`);
  if (!["hints", "fixed"].includes(kind)) throw new Error("kind must be hints or fixed");
  const add = pairs.map((x) => {
    const w = String((Array.isArray(x) ? x[0] : "") || "").trim(), r = String((Array.isArray(x) ? x[1] : "") || "").trim();
    if (!w || !r || w === r || [...w].length > 40 || [...r].length > 40) throw new Error("錯字與正確字都要填，且不超過 40 字");
    if (kind === "fixed" && [...w].length < 2) throw new Error("一個字的錯字不能設成一定替換");
    return [w, r];
  });
  const url = meetingScribeUrl(env);
  if (!url) throw new Error("no meeting-scribe url");
  const current = await fetchJson(`${url}/api/corrections`, {}, timeoutMs);
  // 整份寫回、沒有備份：拿到的不是正常的錯字表（代理頁、格式改了）就不寫，免得蓋掉正本
  if (!current || !Array.isArray(current.hints) || !Array.isArray(current.fixed)) throw new Error("meeting-scribe 回傳的錯字表格式不對，沒有寫入");
  if (current.recovered) throw new Error("meeting-scribe 的錯字表剛從損壞檔救回，請先在會議轉錄頁確認後再加");
  // 寫回時用 meeting-scribe 給的原樣清單，不用本機解析過的版本，免得本機規則不同而刪掉正本的條目
  // meeting-scribe 沒有版本號：讀和寫之間若有人在會議轉錄頁改錯字表會被蓋掉；兩步緊接著做，窗口只有一次往返
  const lists = { hints: current.hints, fixed: current.fixed };
  const fresh = [];
  for (const [w, r] of add) {
    if ([...lists[kind], ...fresh].some((x) => Array.isArray(x) && x[0] === w && x[1] === r)) continue;
    fresh.push([w, r]);
  }
  if (!fresh.length) return { added: 0, ...count(parseCorrections(lists)) };
  lists[kind] = [...lists[kind], ...fresh];
  const saved = parseCorrections(await fetchJson(`${url}/api/corrections`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lists),
  }, timeoutMs));
  writePrivate(correctionsCacheFile(env), saved);
  return { added: fresh.length, ...count(saved) };
}
