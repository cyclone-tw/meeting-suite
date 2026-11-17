// 網址匯入的影片來源（#173）：YouTube、Facebook、X。只認得的網址才收，取出網站與影片 id，
// 再自己組出標準網址交給 yt-dlp（一律放在 `--` 後面）；使用者貼的字串本身不會進 yt-dlp。
// Threads 不收：本機 yt-dlp 2026.08.19 沒有 Threads 的擷取器。

import { youtubeId, watchUrl } from "./youtube-source.mjs";

const FB_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{4,39}$/;   // share/v、share/r、fb.watch 的短代碼（開頭不能是 -）
const DIGITS = /^\d{5,25}$/;                   // Facebook 影片、X 貼文的數字 id
const FB_HOSTS = new Set(["facebook.com", "fb.watch"]);
const X_HOSTS = new Set(["x.com", "twitter.com"]);

// 網址 → { site, id, url }；不認得就回傳 null。url 是組出來的標準網址，key 用來比對「同一支」
export function videoSource(value) {
  let u;
  try { u = new URL(String(value || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return null;
  const yt = youtubeId(u.href);
  if (yt) return { site: "youtube", id: yt, url: watchUrl(yt), key: `youtube:${yt}` };
  const host = u.hostname.toLowerCase().replace(/^(www|m|web|mobile|mbasic)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (FB_HOSTS.has(host)) return facebook(host, parts, u.searchParams);
  if (X_HOSTS.has(host)) {
    // /<帳號>/status/<id>、/i/status/<id>、/i/web/status/<id>，後面可能還有 /video/1
    const at = parts.indexOf("status");
    const id = at >= 1 ? parts[at + 1] || "" : "";
    return DIGITS.test(id) ? { site: "x", id, url: `https://x.com/i/status/${id}`, key: `x:${id}` } : null;
  }
  return null;
}

function facebook(host, parts, query) {
  const fb = (id, url) => ({ site: "facebook", id, url, key: `facebook:${id}` });
  if (host === "fb.watch") return FB_CODE.test(parts[0] || "") ? fb(parts[0], `https://fb.watch/${parts[0]}/`) : null;
  // 分享短網址：/share/v/<代碼>/、/share/r/<代碼>/（r 是 reel）
  if (parts[0] === "share" && (parts[1] === "v" || parts[1] === "r") && FB_CODE.test(parts[2] || "")) return fb(parts[2], `https://www.facebook.com/share/${parts[1]}/${parts[2]}/`);
  if (parts[0] === "reel" && DIGITS.test(parts[1] || "")) return fb(parts[1], `https://www.facebook.com/reel/${parts[1]}`);
  if (parts[0] === "watch" && DIGITS.test(query.get("v") || "")) return fb(query.get("v"), `https://www.facebook.com/watch/?v=${query.get("v")}`);
  // /<專頁>/videos/<id>、/<專頁>/videos/<標題>/<id>：只取數字 id，用 watch 網址
  const at = parts.indexOf("videos");
  if (at >= 1) {
    const id = parts.slice(at + 1).find((p) => DIGITS.test(p));
    if (id) return fb(id, `https://www.facebook.com/watch/?v=${id}`);
  }
  return null;
}

export const SITE_LABEL = { youtube: "YouTube", facebook: "Facebook", x: "X" };
