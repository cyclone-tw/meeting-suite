// YouTube 上傳（recording-transcriber#40）。只用 fetch，不加套件。
// 每個使用者用自己的 Google Cloud 專案與 OAuth 用戶端（電腦版應用程式），設定方法見 docs/youtube-setup.md；
// repo 裡沒有任何人的帳號或金鑰。
//   授權：OAuth 2.0 桌面 App 流程，一律 PKCE，授權完回到工作室本身（http://127.0.0.1:port）
//   上傳：videos.insert 可續傳上傳（斷線從斷掉的地方接著傳）；CC 字幕 captions.insert；播放清單 playlistItems.insert
// 呼叫 Google 的地方都收 fetch 參數，測試換成假的 Google。

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

// youtube.force-ssl 涵蓋上傳、字幕、讀頻道與播放清單（captions.insert 一定要這個）
export const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
export const CHUNK = 16 * 1024 * 1024;   // 續傳每一塊；一定要是 256 KiB 的倍數
const RETRIES = 6;

export const PRIVACY = ["private", "unlisted", "public"];
export const SUBTITLE_MODES = ["cc", "burned"];
// 常用的影片分類（YouTube 的 categoryId）；選單照 CATEGORY_ORDER 排，教育放最前面
export const CATEGORY_ORDER = ["27", "22", "28", "26", "24", "25", "29", "1", "10", "17", "19", "20", "23"];
export const CATEGORIES = {
  27: "教育", 22: "人物與網誌", 28: "科學與技術", 26: "DIY 與生活風格", 24: "娛樂", 25: "新聞與政治",
  29: "非營利組織與社運", 1: "電影與動畫", 10: "音樂", 17: "運動", 19: "旅遊與活動", 20: "遊戲", 23: "喜劇",
};
const LANGUAGE_NAMES = { "zh-TW": "中文（台灣）", "zh-Hant": "中文（繁體）", zh: "中文", en: "English", ja: "日本語" };
export const DEFAULTS = { privacy: "private", subtitles: "cc", playlistId: "", categoryId: "27", language: "zh-TW", madeForKids: false, tags: [], notify: true };

const MIME = { ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo" };

// Google 下載的 OAuth 用戶端 JSON → { client_id, client_secret, project_id }
export function parseClient(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { throw new Error("這不是 Google 下載的 JSON 檔"); }
  if (j?.web) throw new Error("這是「網頁應用程式」的用戶端。請在 Google Cloud 另外建立「電腦版應用程式」類型的 OAuth 用戶端，再下載它的 JSON。");
  const c = j?.installed;
  if (typeof c?.client_id !== "string" || typeof c?.client_secret !== "string" || !c.client_secret) {
    throw new Error("檔案裡找不到 OAuth 用戶端（client_id、client_secret）。請下載「OAuth 2.0 用戶端 ID」的 JSON。");
  }
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(c.client_id)) throw new Error("client_id 的格式不對");
  return { client_id: c.client_id, client_secret: c.client_secret, project_id: typeof c.project_id === "string" ? c.project_id : "" };
}

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// prompt=consent：每次都拿得到 refresh token；select_account：可以選別的帳號或品牌頻道
export function authUrl({ clientId, redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account",
  });
  return `${AUTH_URL}?${q}`;
}

// Google 的錯誤 → 白話；code 讓呼叫的人分辨要不要重新連結
export function googleError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
  const raw = typeof body?.error === "string" ? body.error : body?.error?.message || "";
  const e = (msg, code = "") => Object.assign(new Error(msg), { status, code, reason: reason || raw });
  if (body?.error === "invalid_grant") return e("YouTube 的授權過期或被取消了，請到「設定」重新連結這個頻道。", "reauth");
  if (body?.error === "invalid_client" || body?.error === "unauthorized_client") return e("OAuth 用戶端不對或被刪掉了，請到「設定」重新選 JSON 檔。", "client");
  if (status === 401) return e("YouTube 的授權失效了，請到「設定」重新連結這個頻道。", "reauth");
  if (reason === "quotaExceeded" || reason === "rateLimitExceeded") return e("今天的 YouTube API 額度用完了，台灣時間下午 3、4 點會重置，之後再試。", "quota");
  if (reason === "uploadLimitExceeded") return e("這個頻道今天上傳的數量到上限了，明天再試。", "quota");
  if (reason === "youtubeSignupRequired") return e("這個 Google 帳號還沒有 YouTube 頻道，請先到 YouTube 建立頻道。", "channel");
  if (reason === "invalidTitle") return e("YouTube 不接受這個標題。", "meta");
  if (reason === "invalidDescription") return e("YouTube 不接受這段說明欄。", "meta");
  if (reason === "invalidPublishAt") return e("排程時間不對：要是未來的時間。", "meta");
  if (reason === "playlistNotFound") return e("找不到這個播放清單，可能被刪掉了。", "playlist");
  if (reason === "forbidden" || status === 403) return e(`YouTube 拒絕了這個動作（${reason || raw || status}）。`, "forbidden");
  return e(`YouTube 回傳錯誤（${status}${raw ? `：${String(raw).slice(0, 160)}` : ""}）`);
}

async function readJson(r) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text.slice(0, 200) } }; }
}

async function form(fetch, url, params, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), signal });
  const j = await readJson(r);
  if (!r.ok) throw googleError(r.status, j);
  return j;
}

export function exchangeCode({ fetch, client, code, verifier, redirectUri, signal }) {
  return form(fetch, TOKEN_URL, {
    code, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri,
  }, signal);
}

export function refreshAccess({ fetch, client, refreshToken, signal }) {
  return form(fetch, TOKEN_URL, { client_id: client.client_id, client_secret: client.client_secret, refresh_token: refreshToken, grant_type: "refresh_token" }, signal);
}

// 取消授權（移除頻道時）；失敗也沒關係，使用者可以到 Google 帳戶的第三方存取頁面自己移除
export async function revoke({ fetch, token }) {
  try { await fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }); } catch { /* 盡力就好 */ }
}

// access token 一小時過期：上傳很久的影片中途要換新的。getToken(true) 強制重拿
async function call(fetch, getToken, method, url, { body, headers = {}, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(attempt > 0);
    const r = await fetch(url, {
      method, signal,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { "Content-Type": "application/json; charset=UTF-8" } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    if (r.status === 401 && attempt === 0) { await r.text(); continue; }
    const j = await readJson(r);
    if (!r.ok) throw googleError(r.status, j);
    return { json: j, headers: r.headers };
  }
}

export async function myChannel({ fetch, getToken, signal }) {
  const { json } = await call(fetch, getToken, "GET", `${API}/channels?part=snippet&mine=true`, { signal });
  const c = json.items?.[0];
  if (!c) throw Object.assign(new Error("這個 Google 帳號沒有 YouTube 頻道，請先到 YouTube 建立頻道。"), { code: "channel" });
  return { id: c.id, title: c.snippet?.title || c.id, thumb: c.snippet?.thumbnails?.default?.url || "" };
}

export async function myPlaylists({ fetch, getToken, signal }) {
  const out = [];
  let page = "";
  for (let i = 0; i < 4; i++) {
    const { json } = await call(fetch, getToken, "GET", `${API}/playlists?part=snippet&mine=true&maxResults=50${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { signal });
    for (const p of json.items || []) out.push({ id: p.id, title: p.snippet?.title || p.id });
    page = json.nextPageToken || "";
    if (!page) break;
  }
  return out;
}

// 上傳表單 → videos.insert 的內容。檢查 YouTube 的限制，不合格的直接說哪裡不對
export function videoMeta(o) {
  const clean = (s) => String(s ?? "").replace(/</g, "＜").replace(/>/g, "＞");   // YouTube 不收角括號
  const title = clean(o.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("請填標題");
  if ([...title].length > 100) throw new Error(`標題太長：YouTube 最多 100 個字，現在 ${[...title].length} 個字`);
  const description = clean(o.description).replace(/\r\n/g, "\n");
  if (Buffer.byteLength(description, "utf8") > 5000) throw new Error("說明欄太長：YouTube 最多 5000 位元組（中文約 1600 字），請刪短一點");
  const tags = (Array.isArray(o.tags) ? o.tags : String(o.tags || "").split(/[,，、]/)).map((t) => clean(t).trim()).filter(Boolean);
  if (tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1) > 500) throw new Error("標籤加起來太長：YouTube 最多 500 個字");
  const privacy = PRIVACY.includes(o.privacy) ? o.privacy : "private";
  const categoryId = Object.hasOwn(CATEGORIES, String(o.categoryId)) ? String(o.categoryId) : DEFAULTS.categoryId;
  const language = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(o.language || "")) ? String(o.language) : DEFAULTS.language;
  const status = { privacyStatus: privacy, selfDeclaredMadeForKids: o.madeForKids === true };
  if (o.publishAt) {
    const t = Date.parse(o.publishAt);
    if (!Number.isFinite(t)) throw new Error("排程時間看不懂");
    if (t < Date.now() + 60_000) throw new Error("排程時間要在現在之後");
    // YouTube 規定排程發布的影片要先是私人
    Object.assign(status, { privacyStatus: "private", publishAt: new Date(t).toISOString() });
  }
  return { snippet: { title, description, tags, categoryId, defaultLanguage: language, defaultAudioLanguage: language }, status };
}

export const languageName = (lang) => LANGUAGE_NAMES[lang] || lang;
export const videoMime = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

async function readChunk(fd, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fd.read(buf, got, length - got, start + got);
    if (!bytesRead) throw new Error("影片檔在上傳中被改動或截斷了");
    got += bytesRead;
  }
  return buf;
}

const nextOffset = (headers) => {
  const m = /bytes=0-(\d+)/.exec(headers.get("range") || "");
  return m ? Number(m[1]) + 1 : 0;
};
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }, { once: true });
});

// 可續傳上傳：先開一個上傳工作，再一塊一塊送；網路斷了或 Google 5xx 就問它收到哪裡，從那裡接著傳。
// onProgress(0–1)。回傳 YouTube 的 video 資源（含 id）
export async function uploadVideo({ fetch, getToken, file, meta, notify = true, onProgress = () => {}, signal, chunk = CHUNK, backoffMs = 1000 }) {
  const size = fs.statSync(file).size;
  if (!size) throw new Error("影片檔是空的");
  const { headers } = await call(fetch, getToken, "POST", `${UPLOAD}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notify ? "true" : "false"}`, {
    body: meta, signal, headers: { "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": videoMime(file) },
  });
  const session = headers.get("location");
  if (!session) throw new Error("YouTube 沒有給上傳網址");
  const fd = await fs.promises.open(file, "r");
  try {
    let offset = 0, failures = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const end = Math.min(offset + chunk, size);
      let r;
      try {
        const body = await readChunk(fd, offset, end - offset);
        r = await fetch(session, { method: "PUT", signal, headers: { Authorization: `Bearer ${await getToken(false)}`, "Content-Length": String(body.length), "Content-Range": `bytes ${offset}-${end - 1}/${size}` }, body });
      } catch (e) {
        if (signal?.aborted) throw new Error("cancelled");
        if (/截斷/.test(e.message)) throw e;
        r = null;   // 網路斷了：下面問 Google 收到哪裡
      }
      if (r && (r.status === 200 || r.status === 201)) { onProgress(1); return await readJson(r); }
      if (r?.status === 308) { await r.text(); offset = nextOffset(r.headers); failures = 0; onProgress(offset / size); continue; }
      if (r && r.status === 401) {
        await r.text();
        if (++failures > RETRIES) throw googleError(401, {});
        await getToken(true);
        continue;
      }
      if (r && r.status < 500) throw googleError(r.status, await readJson(r));
      if (r) await r.text();
      // 5xx 或斷線：等一下再問進度
      if (++failures > RETRIES) throw new Error("網路一直斷，上傳停在一半；請確認網路後再上傳一次");
      await sleep(backoffMs * 2 ** (failures - 1), signal);
      let q;
      try {
        q = await fetch(session, { method: "PUT", signal, headers: { Authorization: `Bearer ${await getToken(false)}`, "Content-Length": "0", "Content-Range": `bytes */${size}` } });
      } catch {
        if (signal?.aborted) throw new Error("cancelled");
        continue;
      }
      if (q.status === 200 || q.status === 201) { onProgress(1); return await readJson(q); }
      if (q.status === 308) { await q.text(); offset = nextOffset(q.headers); onProgress(offset / size); continue; }
      if (q.status === 404 || q.status === 410) throw new Error("上傳工作過期了，請再上傳一次");
      await q.text();
    }
  } finally {
    await fd.close();
  }
}

// CC 字幕：multipart（一段 JSON、一段 SRT）
export async function uploadCaption({ fetch, getToken, videoId, srt, language, name, signal }) {
  const boundary = `studio-${randomBytes(12).toString("hex")}`;
  const meta = { snippet: { videoId, language, name: name || languageName(language), isDraft: false } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(String(srt), "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { json } = await call(fetch, getToken, "POST", `${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
    body, signal, headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  return json;
}

export async function addToPlaylist({ fetch, getToken, playlistId, videoId, signal }) {
  const { json } = await call(fetch, getToken, "POST", `${API}/playlistItems?part=snippet`, {
    body: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }, signal,
  });
  return json;
}

// 頻道預設值：只收認得的欄位，其餘照 DEFAULTS
export function checkDefaults(raw = {}) {
  const d = { ...DEFAULTS };
  if (PRIVACY.includes(raw.privacy)) d.privacy = raw.privacy;
  if (SUBTITLE_MODES.includes(raw.subtitles)) d.subtitles = raw.subtitles;
  if (typeof raw.playlistId === "string" && /^[\w-]{0,64}$/.test(raw.playlistId)) d.playlistId = raw.playlistId;
  if (Object.hasOwn(CATEGORIES, String(raw.categoryId))) d.categoryId = String(raw.categoryId);
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(raw.language || ""))) d.language = String(raw.language);
  if (typeof raw.madeForKids === "boolean") d.madeForKids = raw.madeForKids;
  if (typeof raw.notify === "boolean") d.notify = raw.notify;
  const tags = Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === "string" ? raw.tags.split(/[,，、]/) : [];
  d.tags = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50).map((t) => t.slice(0, 100));
  return d;
}
