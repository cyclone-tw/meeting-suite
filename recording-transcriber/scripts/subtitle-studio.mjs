#!/usr/bin/env node
// Subtitle Studio：在 MacBook 本機用瀏覽器上字幕
//
//   pnpm run studio            啟動並打開瀏覽器（已經在跑就只打開瀏覽器）
//   pnpm run studio --no-open  只啟動
//   背景啟動與關閉、Dock 用的 App：scripts/studio-ctl.mjs（recording-transcriber#3）
//
// 流程：選影片 → 自動辨識＋逐字校對（scripts/subtitle-run.mjs 的 prepareSubtitles）→
// 邊看影片邊改字幕（自動存檔，SRT 隨時是最新的）→ 燒字幕（burnSubtitles）。
// 常錯字表和即時會議轉錄共用（lib/corrections-sync.mjs），改字時可以一鍵加進去。
//
// 安全：只綁 127.0.0.1；檢查 Host 與 Origin（擋 DNS rebinding 與別的網頁）；每次啟動產生
// token，API 一律要帶 X-Studio-Token（影片串流因為 <video> 不能帶 header，改用網址參數）。
// 終端機只印網址與錯誤，不印字幕內容。

import fs from "node:fs";
import { pipeline } from "node:stream";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { burnSubtitles, prepareFromCaptions, prepareSubtitles, preflight, renderShort, runFfmpeg, subAdvances, SUBTITLE_SIZES, taiwanConverter, videoDurationMs, videoSize, writeBurnSubtitles } from "./subtitle-run.mjs";
import { describeCraig, envelopeOf, findCraig, labelWith, loadCraig, loadNames, namesMap, noteSeen, rememberNames, removeRosterUser, resolveZip, rosterList, setRosterName, shownNames, speakersRecord } from "./speaker-tracks.mjs";
import { fillArgs, missingVoices, voiceGain } from "../lib/speaker-tracks.mjs";
import { LANG_MODES, langModeOf, styleOf, SUBTITLE_STYLES } from "../lib/subtitle-box.mjs";
import { captionSource, fetchCaptions, fetchInfo, fetchVideo, parseVtt, youtubeId } from "../lib/youtube-source.mjs";
import { translateCues } from "../lib/subtitle-translate.mjs";
import { measureAdvances } from "../lib/text-measure.mjs";
import { keepSegments, remapCues, remapDescription } from "../lib/cuts.mjs";
import { poster, thumbnails, waveform } from "../lib/media-preview.mjs";
import { detectBlack, detectSilence, mergeSuggestions, rangesToSuggestions, suggestFromTranscript } from "../lib/cut-suggest.mjs";
import { inCloudFolder, realDir } from "./subtitle-cli.mjs";
import { MAY_USE_CHINA_CLOUD_LLM, checkProofreader, PROOFREADERS, proofreaderAvailable } from "../lib/proofreaders.mjs";
import { addCorrection, addCorrections, correctionsCacheFile, correctionsSummary, meetingScribeUrl, syncCorrections } from "../lib/corrections-sync.mjs";
import { loadAsrProfile } from "../lib/asr-profile.mjs";
import { copyToDriveIsolated, driveDisabled, driveWhere, recordingStamp } from "../lib/studio-drive.mjs";
import { loadRecapFiles, localBuild } from "../lib/shared-components.mjs";
import { cleanMindmapReply, safeMindmapSvg, moduleKey, moduleLabel, recapTranscript, scribeDir, recapKey, recapParagraphs, requestModule, requestModules, requestRecap, resolveModuleOptions } from "../lib/meeting-recap.mjs";
import { resolveSonioxKey } from "../lib/soniox-async.mjs";
import { buildCues, cueOptsFor, toSrt } from "../lib/subtitle-text.mjs";
import { describe, nameFixes, suggestShorts } from "../lib/subtitle-ai.mjs";
import { MAX_ITEMS as MAX_SHORTS, nextN, shortAss, shortCues, shortKeep, shortLayout, validateShorts } from "../lib/shorts.mjs";
import { icloudRoot } from "../lib/paths.mjs";
import { handoffEnabled, handoffFromStudio, handoffSubdir } from "../lib/wiki-handoff.mjs";
import { nearbySubtitles, parseSubtitleText, readSubtitleFile } from "../lib/subtitle-file.mjs";
import {
  CATEGORIES, CATEGORY_ORDER, SCOPE, SUBTITLE_MODES, addToPlaylist, authUrl, checkDefaults, exchangeCode, myChannel, myPlaylists, parseClient, pkce, refreshAccess, revoke, uploadCaption, uploadVideo, videoMeta,
} from "../lib/youtube.mjs";
import { keychainSecrets, loadSettings, saveSettings, secretAccount } from "../lib/youtube-settings.mjs";
import {
  BROWSER_PLAYABLE, VIDEO_EXTENSIONS, forgetRecent, icloudStudioDir, isForeign, isOffline, keepTranslations, loadRecent, markAiCues, parseSrt, projectDirFor, projectId,
  readProject, recentVideos, rememberRecent, sourceVideo, stateDir, validateCues, validateCuts, validateDescription, writePrivate, writeProject,
} from "../lib/studio-project.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVACY = new Set(["public", "sensitive", "student-private"]);
// 影片說的語言（#56）：zh 是一般的中文影片；其他語言會翻成中文、可以做雙語字幕
const LANG = /^[a-z]{2,3}$/;
// 從 YouTube 下載的影片放這裡（首頁的影片清單也會列這個資料夾）
export const youtubeDownloadDir = (home = os.homedir()) => path.join(home, "Movies", "YouTube 下載");
const MAX_BODY = 8 * 1024 * 1024;

process.env.PATH = [path.join(process.env.HOME || "", ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || "/usr/bin:/bin"].join(":");

// 背景執行時輸出會寫進 log 檔：錯誤訊息裡的完整路徑（檔名可能有空白）先遮掉，讓 log 乾淨。
// 有已知副檔名的遮到副檔名為止；沒有的遮到冒號、引號或行尾。寧可多遮，不要漏。
const PATH_EXT = "(?:mp4|mov|m4v|mkv|webm|avi|mts|srt|vtt|wav|m4a|mp3|aac|flac|json|md|txt)";
export const redactPaths = (msg) => String(msg)
  .replace(new RegExp(`(^|[\\s'"(（=])(?:~/|/(?!/))[^\\n]*?\\.${PATH_EXT}(?![\\w])`, "gi"), "$1<path>")
  .replace(/(^|[\s'"(（=])(?:~\/|\/(?!\/))[^\n:'"]+/g, "$1<path>");
const logError = (msg) => console.error(redactPaths(msg));
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; img-src 'self' data: https://yt3.ggpht.com https://yt3.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'";

// 頁面拆出去的 CSS／JS（#50）：只服務這份清單上的檔，路徑整串比對，碰不到 web/ 以外
const PAGE_ASSETS = new Map([
  ["/studio.css", "text/css; charset=utf-8"],
  ["/studio/libs.mjs", "text/javascript; charset=utf-8"],
  ["/studio/lang-en.js", "text/javascript; charset=utf-8"],
  ["/studio/i18n.js", "text/javascript; charset=utf-8"],
  ...["common", "home", "timeline", "trim", "editor", "cues", "names", "speakers", "burn", "shorts", "youtube", "recap", "mindmap", "main"]
    .map((n) => [`/studio/${n}.js`, "text/javascript; charset=utf-8"]),
]);

// 會議轉錄 App 的共用元件（#111）：Markdown 排版、延伸頁籤、心智圖
// 介面中英切換（#152）：翻譯引擎 i18n.js 與共用元件的英文字典 lang-en.js 也從那裡讀
const SHARED_ASSETS = new Map([...["md", "ext", "mindmap"].flatMap((n) => [[`/shared/${n}.js`, "text/javascript; charset=utf-8"], [`/shared/${n}.css`, "text/css; charset=utf-8"]]),
  ...["recap-files", "icons", "i18n", "lang-en"].map((n) => [`/shared/${n}.js`, "text/javascript; charset=utf-8"])]);

// 剪輯的指紋：剪接版只要剪輯沒變就不用重新輸出
export const cutsKey = (cuts) => (cuts || []).map((c) => `${c.start}-${c.end}`).join(",");
// 上傳到 YouTube 之後還能補掛 CC 字幕（#71）：燒在畫面上的、停在半路的、或當時字幕那一步沒成功的
const CC_FAILED = "CC 字幕沒有掛上去";
// 已經上傳到 YouTube 的自己的錄影（#75）：整理時才可以連原始錄影一起丟垃圾桶；從 YouTube 下載的走 trashVideo
export const uploadedOwnVideo = (p) => Boolean(p?.youtube?.video_id) && p.youtube.status === "done" && !p.source?.downloaded;
// 不要字幕的專案（#158）：demo 影片等不需要字幕的，不辨識、不校對，上傳時不燒也不掛 CC
export const isPlain = (p) => p?.source?.captions === "none";
// 不要字幕的專案沒有字幕可做的事（POST 的 action）
const PLAIN_BLOCKED = new Set(["retry", "reprocess", "relayout", "describe", "recap", "module", "mindmap", "names", "speakers", "translate", "subtitle-file", "handoff"]);
export const needsCc = (y = {}) => Boolean(y.video_id) && y.subtitles !== "none" && !y.cc_added
  && (y.status === "cancelled" || y.subtitles === "burned" || (y.warnings || []).some((w) => w.startsWith(CC_FAILED)));

// 直式短片的指紋（#54）：片段範圍、標題、片段內的剪輯與字幕都沒變，輸出的影片就還是最新的
const SHORT_LAYOUT_VERSION = 1;
export function shortKey(item, p) {
  const cuts = p.cuts || [];
  // 外語影片（#56）多算顯示方式；一般影片的指紋和以前一樣，已經輸出的短片不會變成要重做
  return createHash("sha256").update(JSON.stringify([SHORT_LAYOUT_VERSION, styleOf(p), item.start, item.end, item.title, shortKeep(item, cuts), shortCues(item, p.cues || [], cuts),
    ...(isForeign(p) ? [langModeOf(p)] : [])]))
    .digest("hex").slice(0, 16);
}
const shortFile = (p, item) => `${p.name}-短片-${String(item.n).padStart(2, "0")}.mp4`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

function ffprobeFps(video) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video], { encoding: "utf8" });
  const [n, d] = String(r.stdout || "").trim().split("/").map(Number);
  const fps = d ? n / d : n;
  return Number.isFinite(fps) && fps > 1 && fps < 241 ? Math.round(fps * 1000) / 1000 : 30;
}

// 瀏覽器播不了的格式（mkv 等）複製一份 mp4 容器給預覽用，不重新編碼
function remuxPreview(video, target, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = `${target}.partial.mp4`;
    const p = spawn("ffmpeg", ["-v", "error", "-y", "-i", video, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", tmp], { stdio: ["ignore", "ignore", "pipe"], signal });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (code) => {
      // 在事件裡丟例外會讓整個服務掛掉，一律轉成 reject
      try {
        if (code !== 0) throw new Error(`這個影片格式無法預覽（${err.trim().split("\n").pop() || code}）`);
        fs.renameSync(tmp, target);
        resolve();
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        reject(e);
      }
    });
  });
}

export function createStudio({ env = process.env, token = randomBytes(24).toString("hex"), deps = {}, onShutdown = () => {} } = {}) {
  // 本機優先（#83）：先在這台跑會議轉錄 App 的本機入口，帶上從主機同步來的常錯字對照（App 讀 MEETING_SCRIBE_CORRECTIONS）；
  // 本機失敗才送主機
  // syncCorrections 不會丟錯：主機連不上就用上次的快取（本機照跑）
  async function localScribe() {
    const dir = scribeDir(env);
    if (!dir) return null;
    await syncCorrections({ env });
    return { dir, env: { ...env, MEETING_SCRIBE_CORRECTIONS: correctionsCacheFile(env) } };
  }
  // 檔案結尾剛好一個換行（元件轉好的文字版本來就以換行結尾，不再多加）
  const withNewline = (t) => { const x = String(t ?? "").replace(/\s+$/, ""); return x ? `${x}\n` : ""; };
  // AI 產出自動存一份到 Drive（設定的 studio_drive）。在背景、另一個程序裡存（#105）：
  // 產生的結果先回給頁面，Drive 那行顯示「正在存」；Drive 卡住或寫不進去也不擋工作室，記下原因可以再存一次。
  // 同一個專案一次只存一份，接著排隊
  const driveTasks = new Map();
  async function runDrive(dir) {
    const p = readProject(dir);
    const files = [...(p.recap ? [path.join(dir, "summary.md")] : []), ...Object.values(p.modules || {}).flatMap((m) => [m.file, ...(m.extra_files || [])].map((f) => path.join(dir, f)))];
    let drive;
    try {
      const r = await d.driveCopy({ override: env.CYCLONE_STUDIO_DRIVE_DIR, profile: loadAsrProfile().profile.studio_drive || {}, home: os.homedir(), existing: p.drive?.folder, name: p.name, stamp: recordingStamp(p.name, sourceVideo(p)), files });
      drive = { root: r.root, folder: r.folder, files: r.files, saved: new Date().toISOString() };
    } catch (e) {
      logError(`[studio] drive save failed: ${String(e?.message || e).slice(0, 200)}`);
      const { pending, ...prev } = p.drive || {};
      drive = { ...prev, ...(e.folder ? { folder: e.folder, root: e.root || prev.root } : {}), error: String(e?.message || e).slice(0, 200), failed: new Date().toISOString() };
    }
    const latest = readProject(dir);   // 存 Drive 的時候可能有人改了字：只換 drive
    latest.drive = drive;
    save(dir, latest);
    return drive;
  }
  // 排一次存檔；回傳完成的 promise（自動存不用等，「再存一次」會等）
  function queueDrive(id, dir) {
    const t = (driveTasks.get(id) || Promise.resolve()).catch(() => {}).then(() => runDrive(dir));
    driveTasks.set(id, t);
    t.catch(() => {}).finally(() => { if (driveTasks.get(id) === t) driveTasks.delete(id); });
    return t;
  }
  const markDrivePending = (p) => { if (!d.driveDisabled()) p.drive = { ...(p.drive || {}), pending: new Date().toISOString() }; };
  const d = {
    prepareSubtitles, burnSubtitles, preflight, syncCorrections, addCorrection, addCorrections, pickFile, pickSubtitles, reveal, ffprobeFps, remuxPreview, inCloudFolder,
    thumbnails, waveform, poster, videoDurationMs, detectSilence, detectBlack, suggestFromTranscript, trash, describe,
    suggestShorts, renderShort, videoSize, writeBurnSubtitles, measureAdvances, nameFixes,
    // 外語影片與 YouTube 下載（#56）
    fetchInfo, fetchVideo, fetchCaptions, translateCues, prepareFromCaptions, taiwanConverter, downloadDir: () => youtubeDownloadDir(),
    hasYtDlp: () => spawnSync("/usr/bin/which", ["yt-dlp"], { encoding: "utf8" }).status === 0,
    // YouTube（#40）：呼叫 Google 用的 fetch、存機密的鑰匙圈、用預設瀏覽器打開授權頁
    // 會後總結（#80）：送到會議轉錄 App 產生，和 App 同一份提示詞
    driveDisabled: () => driveDisabled(env, loadAsrProfile().profile),
    // 會後內容的存檔格式是 App 的共用元件 RecapFiles（#116），從這台 meeting-scribe checkout 載入
    recapFiles: () => loadRecapFiles(scribeDir(env)),
    sharedBuilds: async () => {
      const [local, remote] = await Promise.allSettled([
        localBuild(scribeDir(env)),
        (async () => { const url = meetingScribeUrl(env); if (!url) throw new Error("沒有設定主機"); const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) }); return String((await r.json())?.build || ""); })(),
      ]);
      return { local: local.status === "fulfilled" ? local.value : "", remote: remote.status === "fulfilled" ? remote.value : "" };
    },
    driveCopy: (job, o) => copyToDriveIsolated(job, o),
    meetingRecap: async (paras, o = {}) => requestRecap(paras, { url: meetingScribeUrl(env), local: await localScribe(), ...o }),
    // 延伸模組（#88）：清單與產生都由 App 提供，App 加了新模組這裡不用改
    meetingModules: (o = {}) => requestModules({ url: meetingScribeUrl(env), ...o }),
    meetingModule: async (paras, mod, options, o = {}) => requestModule(paras, mod, options, { url: meetingScribeUrl(env), local: await localScribe(), ...o }),
    youtubeFetch: (...a) => fetch(...a), secrets: keychainSecrets(), openUrl: (u) => spawn("open", [u], { stdio: "ignore", detached: true }).unref(),
    icloudDir: () => icloudStudioDir(),
    icloudRoot: () => icloudRoot(),
    videoDirs: () => [icloudStudioDir(), path.join(os.homedir(), "Movies"), youtubeDownloadDir(), path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Downloads")].filter(Boolean),
    isOffline: (file) => { try { return isOffline(fs.statSync(file)); } catch { return false; } },
    // Discord 分軌（#129）：在下載資料夾和影片旁邊找 Craig 的 zip；算音量、補聲音都是本機 ffmpeg
    craigDirs: (video) => [path.join(os.homedir(), "Downloads"), path.dirname(video)],
    findCraig: (video, dirs, durationMs) => findCraig(video, dirs, durationMs, env),
    pickZip, envelopeOf,
    fillVoices: (args, o) => runFfmpeg("ffmpeg", args, { ...o, what: "filling in missing voices" }),
    // 請 iCloud 把檔案下載到這台；不等它下載完，brctl 失敗時呼叫 onFail（#22）
    icloudDownload: (file, onFail = () => {}) => {
      const p = spawn("/usr/bin/brctl", ["download", file], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (x) => { err = (err + x).slice(0, 2000); });
      p.on("error", (e) => onFail(e.message));
      // brctl 的錯誤很長；只取引號裡那句說明，例如 "Path is outside of any CloudDocs app library, will never sync"
      p.on("close", (code) => { if (code) onFail(err.match(/"([^"]+)"/)?.[1] || err.trim().split("\n")[0] || `brctl exit ${code}`); });
    },
    ...deps,
  };
  const projects = new Map();   // id → 專案資料夾
  const jobs = new Map();       // id → { kind, step, progress, abort, done }
  const previewing = new Map(); // id → 正在重做預覽的 Promise（同一專案共用一次）
  // 還沒開專案的影片（首頁的預覽與粗剪，recording-transcriber#4）：id → { video, name, duration_ms, ... }
  const previews = new Map();
  // 首頁清單上的影片：key → 路徑。縮圖只給清單上的影片，不接受任意路徑（#18）
  let homeVideos = new Map();
  const posters = new Map();    // key → { jpg, duration_ms }（只放記憶體，最多留 60 支）
  const downloads = new Map();  // 影片 → { at: 上次請 iCloud 下載的時間, error }（#20、#22）
  const waves = new Map();      // 預覽 id → 波形的 Promise（只放記憶體，最多留 6 支）
  let previewTmp = "";          // 瀏覽器播不了的格式先轉成 mp4 放這裡（私人暫存，關掉 Studio 時刪）
  const oauthPending = new Map(); // 連結 YouTube 中：state → { verifier, at }（只能用一次，10 分鐘內有效）
  const imports = new Map();      // 從 YouTube 下載（#56）：匯入 id → { status, step, progress, title, error, project, abort }
  const ytTokens = new Map();     // 頻道 → { token, exp }（access token 只放記憶體）
  let port = 0;
  let correctionsCache = null;
  let ytdlpOk = false;

  for (const r of loadRecent(env)) projects.set(projectId(r.dir), r.dir);

  // 啟動時把最近的專案整理一遍：上次被中斷留下的暫存刪掉、狀態改成中斷。
  // 只在確定自己拿到 port 之後做；port 被占用（已經有一個 Studio 在跑）時絕不能動別人正在用的檔案
  function tidyRecent() {
    for (const dir of projects.values()) {
      try { recover(dir); } catch (e) { logError(`[studio] could not tidy a project: ${e.message}`); }
    }
  }

  // 選用功能（沒設定就不顯示）：handoff＝交給 agent 的交接單，icloud＝iCloud 共用資料夾，drive＝AI 產出存 Drive
  const features = () => [handoffEnabled() && "handoff", d.icloudDir() && "icloud", !d.driveDisabled() && "drive"].filter(Boolean).join(" ");
  const html = () => fs.readFileSync(path.join(TOOL_ROOT, "web", "studio.html"), "utf8").replace("__STUDIO_TOKEN__", token).replace("__STUDIO_FEATURES__", features());

  function allowed(req, url) {
    const host = String(req.headers.host || "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    // 打開頁面本身可以從別處連過來（書籤、擴充功能）；API 一律不接受跨站請求
    if (!url.pathname.startsWith("/api/")) return true;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const sent = req.headers["x-studio-token"] || (req.method === "GET" && /\/video$/.test(url.pathname) ? url.searchParams.get("t") : "");
    return safeEqual(sent, token);
  }

  const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(status, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", ...extra,
    });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const fail = (res, status, msg) => send(res, status, { error: msg });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error("內容太大"), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("JSON 格式錯誤"), { status: 400 })); }
      });
      req.on("error", reject);
    });
  }

  // 沒有工作在跑的專案：清掉上次被中斷留下的暫存（抽出的音訊、含字幕的 SRT、燒到一半或轉到一半的影片），
  // 「處理中／燒錄中」改成中斷，讓使用者重試
  function recover(dir) {
    const id = projectId(dir);
    if (jobs.has(id) || !fs.existsSync(path.join(dir, "project.json"))) return;
    for (const n of fs.readdirSync(dir)) {
      if (/^\.(work|burn)-/.test(n) || (!previewing.has(id) && /^\.preview\.mp4\.partial/.test(n))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
    const project = readProject(dir);
    const shortRunning = (project.shorts?.items || []).filter((x) => x.export?.status === "running");
    if (project.status === "processing" || project.burn?.status === "running" || project.youtube?.status === "uploading" || shortRunning.length) {
      for (const x of shortRunning) x.export = { status: "failed", error: "輸出到一半 Studio 被關掉了，請再輸出一次" };
      if (project.status === "processing") Object.assign(project, { status: "failed", error: "處理到一半 Studio 被關掉了，請按重試" });
      if (project.burn?.status === "running") project.burn = { status: "failed", error: "燒字幕到一半 Studio 被關掉了，請再燒一次" };
      if (project.youtube?.status === "uploading") project.youtube = { ...project.youtube, status: "failed", error: "上傳到一半 Studio 被關掉了，請再上傳一次" };
      save(dir, project);
    }
  }

  function load(id) {
    const dir = projects.get(id);
    if (!dir || !fs.existsSync(path.join(dir, "project.json"))) return null;
    recover(dir);
    return { dir, project: readProject(dir) };
  }

  // 背景工作：例外不能讓整個服務掛掉，也不能讓 jobs 卡住
  function startJob(id, fn) {
    const done = fn().catch((e) => {
      logError(`[studio] job error: ${String(e?.message || e).slice(0, 200)}`);
    }).finally(() => { jobs.delete(id); });
    return done;
  }

  const asrFile = (dir) => path.join(dir, "asr.json");

  // 輸出過、檔案還在的影片：{ burn: { file, rev, cuts, … }, cut: … }（#39）
  function outputsOf(dir, p) {
    const out = {};
    for (const [k, v] of Object.entries(p.outputs || {})) if (v?.file && fs.existsSync(path.join(dir, v.file))) out[k] = v;
    // #39 之前燒的只記在 burn
    const b = p.burn;
    if (b?.status === "done" && b.output && !out[b.subtitles === false ? "cut" : "burn"] && fs.existsSync(path.join(dir, b.output))) {
      out[b.subtitles === false ? "cut" : "burn"] = { file: b.output, rev: b.rev, size: b.size, finished: b.finished };
    }
    // 直式短片（#54）：清掉處理資料時一樣先搬出來
    for (const x of p.shorts?.items || []) if (x.output?.file && fs.existsSync(path.join(dir, x.output.file))) out[`short-${x.n}`] = x.output;
    return out;
  }

  // 專案資料夾佔多少空間（含備份與輸出的影片）
  const fileBytes = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  function folderBytes(dir) {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) n += fs.statSync(f).size;
      }
    };
    try { walk(dir); } catch { /* 讀不到的就不算 */ }
    return n;
  }

  // 會後總結用的字幕：剪輯後的時間軸（和上傳 YouTube 的影片一致），被剪掉的句子不算
  const recapCues = (p) => { const cuts = p.cuts || []; return remapCues((p.cues || []).filter((c) => c.text.trim()), cuts, cuts.length ? undefined : 0); };
  // 延伸模組的結果（#88）：最新的在前；字幕改過就標成舊的
  const modulesView = (p, nowKey) => Object.entries(p.modules || {})
    .map(([key, m]) => ({ key, ...m, stale: p.status === "ready" && nowKey() !== m.paras_key }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  // 存成「-字幕」資料夾裡的「模組名稱（選項）.md」：檔名不能有路徑符號
  // 模組清單問一次記一分鐘：打開分頁、按產生都會用到
  let modulesCache = null;
  async function moduleList({ fresh = false } = {}) {
    if (!fresh && modulesCache && Date.now() - modulesCache.at < 60_000) return modulesCache.list;
    const list = await d.meetingModules();
    modulesCache = { at: Date.now(), list };
    return list;
  }

  // 「正在存」看有沒有存檔還在排隊（#110）：兩次存檔重疊時，前一次存完不會把後一次的「正在存」洗掉；
  // 工作室中途重開留下的 pending 也不算
  const driveView = (id, dr) => {
    if (!dr) return null;
    const { pending, root, ...rest } = dr;
    return { ...rest, where: driveWhere(env, loadAsrProfile().profile), ...(driveTasks.has(id) ? { pending: true } : {}) };
  };
  function publicView(id, dir, p) {
    const job = jobs.get(id);
    let key = null;
    const nowKey = () => (key ??= recapKey(recapParagraphs(recapCues(p))));
    const burned = p.burn?.output && fs.existsSync(path.join(dir, p.burn.output)) ? p.burn.output : "";
    return {
      id, name: p.name, video: p.video, folder: dir, privacy: p.privacy, proofreader: p.proofreader, size: p.size || "medium", subtitle_style: styleOf(p),
      status: p.status, error: p.error || "", stopped_at: p.status === "cancelled" ? p.stopped_at || "" : "", rev: p.rev, fps: p.fps || 30, duration_ms: p.duration_ms || 0,
      cues: p.status === "ready" ? p.cues : [], cuts: p.cuts || [], suggestions: p.suggestions || null, description: p.description || "", report: p.report || null,
      burn: { ...(p.burn || {}), output: burned }, outputs: outputsOf(dir, p), youtube: p.youtube || null, youtube_suggest: p.youtube_suggest || null, handoff: p.handoff || null, shorts: shortsView(dir, p),
      recap: p.recap ? { ...p.recap, stale: p.status === "ready" && nowKey() !== p.recap.key } : null, modules: modulesView(p, nowKey), drive: driveView(id, p.drive), updated: p.updated, has_asr: fs.existsSync(asrFile(dir)), has_timing: fs.existsSync(path.join(dir, "timing.json")),
      lang: p.lang || "zh", foreign: isForeign(p), lang_mode: isForeign(p) ? langModeOf(p) : null, source: p.source || null, translate: p.translate || null,
      tracks: p.tracks ? { file: path.basename(p.tracks.zip), fill: p.tracks.fill, filled: p.tracks.filled || [], error: p.tracks.error || "" } : null,
      speakers: p.speakers ? { file: p.speakers.source, tracks: p.speakers.tracks, counts: p.speakers.counts || null, missing: p.speakers.missing || [] } : null,
      video_original: p.video_original || "",
      job: job ? { kind: job.kind, step: job.step, progress: job.progress, started: job.started, ...(job.steps ? { steps: job.steps } : {}), ...(job.short ? { short: job.short } : {}) } : null,
    };
  }

  // 用過的最大序號：刪掉的片段的序號也不再用，免得新的一段輸出時蓋掉留在資料夾裡的舊檔
  const shortsMaxN = (sh) => Math.max(Number(sh?.max_n) || 0, nextN(sh?.items) - 1);

  // 片段清單給頁面看：輸出的檔還在才算，fresh 表示輸出之後片段、字幕、剪輯都沒變
  function shortsView(dir, p) {
    if (!p.shorts) return null;
    return {
      created: p.shorts.created || "", error: p.shorts.error || "", max_n: shortsMaxN(p.shorts),
      items: (p.shorts.items || []).map((x) => {
        const out = x.output?.file && fs.existsSync(path.join(dir, x.output.file)) ? { ...x.output, fresh: x.output.key === shortKey(x, p) } : null;
        return { ...x, output: out, file: shortFile(p, x) };
      }),
    };
  }

  function save(dir, p) {
    p.updated = new Date().toISOString();
    writeProject(dir, p);
  }

  async function runPrepare(id, dir) {
    const p = readProject(dir);
    // 可以按停止（#67）：抽音的 ffmpeg、Soniox、校對與說明欄的 agent 都會被中止
    const ac = new AbortController();
    const job = { kind: "prepare", step: p.tracks ? "tracks" : "extract", progress: 0, started: Date.now(), abort: () => ac.abort() };
    jobs.set(id, job);
    // 「重新處理」做好的專案時按停止：原本的字幕都還在，回到可以編輯，什麼都沒換掉
    const hadCues = Array.isArray(p.cues) && p.cues.length > 0;
    job.done = new Promise((r) => { job.finish = r; });
    const work = fs.mkdtempSync(path.join(dir, ".work-"));
    try {
      if (!BROWSER_PLAYABLE.has(path.extname(p.video).toLowerCase())) {
        job.step = "preview";
        await d.remuxPreview(p.video, path.join(dir, ".preview.mp4"), { signal: ac.signal });
      }
      // 粗剪過的：只把保留段送辨識，回來的時間已經換回原片時間
      const keep = p.cuts?.length ? keepSegments(p.cuts, p.duration_ms) : undefined;
      // 辨識結果一直留在專案資料夾（asr.json）：出錯重試、重新處理都不用再付辨識費（#28、#30）
      const asrCache = asrFile(dir);
      const legacy = path.join(dir, "asr-cache.json");   // #29 失敗時留下的
      if (fs.existsSync(legacy) && !fs.existsSync(asrCache)) fs.renameSync(legacy, asrCache);
      // YouTube 作者上傳的字幕（#56）或使用者自己的字幕檔（#148）：直接用，不送辨識
      const captions = p.source?.captions_file ? path.join(dir, path.basename(p.source.captions_file)) : "";
      // Discord 分軌（#129）：先對齊；有人沒錄進影片就把他那一軌補進去，之後的辨識、預覽、燒字幕、上傳都用補好的
      const spk = p.tracks && !captions ? await prepareTracks(p, dir, work, job, ac.signal) : null;
      const r = captions && fs.existsSync(captions)
        ? await d.prepareFromCaptions({ privacy: p.privacy, proofreader: p.proofreader, lang: p.lang }, { cues: captionCues(p, captions), onStep: (s) => { job.step = s; }, signal: ac.signal })
        : await d.prepareSubtitles({ video: p.video, privacy: p.privacy, engine: "soniox", proofreader: p.proofreader, terms: [], keep, durationMs: p.duration_ms, asrCache, lang: p.lang },
          { work, onStep: (s) => { job.step = s; }, signal: ac.signal });
      if (ac.signal.aborted) throw new Error("cancelled");   // 最後一步剛好做完才按停止：照樣算停止
      if (Array.isArray(r.timing)) writePrivate(path.join(dir, "timing.json"), JSON.stringify(r.timing));
      let cues = markAiCues(r.cues, r.applied);
      if (spk) {
        job.step = "speakers";
        const l = labelWith(cues, spk.trackEnvs, spk.align, spk.shown, spk.names);
        cues = l.cues;
        p.speakers = speakersRecord(p.tracks.zip, spk.craig, spk.shown, spk.align, { counts: l.counts, missing: spk.missing });
      }
      Object.assign(p, { status: "ready", error: "", cues, description: r.description, report: r.report, rev: (p.rev || 0) + 1 });
      // 外語影片：字幕重新做了，舊的翻譯狀態不算數（接著會自動翻譯）
      if (isForeign(p)) p.translate = null;
      // 說明欄沒寫成功（suggest 是 null）時，舊的名稱與標籤建議也一起清掉，和空白的說明欄一致
      p.youtube_suggest = r.suggest ? { ...r.suggest, created: new Date().toISOString() } : null;
    } catch (e) {
      if (ac.signal.aborted && hadCues) {
        Object.assign(p, { status: "ready", error: "" });
      } else if (ac.signal.aborted) {
        // 使用者自己停的：不是失敗、不寫錯誤 log；停在哪一步記在 stopped_at，畫面用來說明
        Object.assign(p, { status: "cancelled", error: "", stopped_at: job.step, report: e?.report || p.report || null });
      } else {
        // 上傳就失敗的：雲端沒開始辨識、AI 也沒跑，講清楚沒有花到額度（#121）
        const free = e?.notCharged || e?.cause?.notCharged;
        Object.assign(p, { status: "failed", error: `${String(e?.message || e).slice(0, 260)}${free ? "。還沒開始辨識，沒有花到 Soniox 或 AI 的額度，網路穩了按「重試」" : ""}`, report: e?.report || p.report || null });
        // log 多記是哪一步、連線錯誤代碼，下次查得到
        logError(`[studio] processing failed at ${job.step || "?"}: ${p.error}${e?.code || e?.cause?.code ? ` (${e.code || e.cause.code})` : ""}`);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      jobs.delete(id);
      job.finish();
      save(dir, p);
    }
  }

  // Discord 分軌（#129）：對齊影片、找出沒錄進影片的人並補回。對不起來（拿錯 zip）不擋上字幕，只是不標講者
  async function prepareTracks(p, dir, work, job, signal) {
    job.step = "tracks";
    const names = namesMap(loadNames(env), p.tracks.names);
    let got;
    try {
      got = await loadCraig(p.tracks.zip, p.video, fs.mkdtempSync(path.join(work, "craig-")), { envelope: d.envelopeOf, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      p.tracks = { ...p.tracks, error: String(e?.message || e).slice(0, 200) };
      return null;
    }
    const { craig, videoEnv, trackEnvs, align } = got;
    noteSeen(craig.tracks.map((t) => t.user), craig.start, env);   // 名冊的「最近出現」（#132）
    const shown = shownNames(craig.tracks, names);
    const miss = missingVoices(videoEnv, trackEnvs, align);
    const absent = miss.map((m, k) => (m.missing ? k : -1)).filter((k) => k >= 0);
    let missing = absent.map((k) => shown[k]);
    if (p.tracks.fill && absent.length) {
      job.step = "fill";
      const present = miss.map((m, k) => (!m.missing && m.ratio !== null ? k : -1)).filter((k) => k >= 0);
      const tmp = path.join(work, "filled.mp4"), out = path.join(dir, `${p.name}-補音.mp4`);
      await d.fillVoices(fillArgs({ video: p.video, tracks: absent.map((k) => craig.tracks[k].file), align, gain: voiceGain(videoEnv, trackEnvs, align, present), out: tmp }), { signal, durationMs: p.duration_ms });
      fs.renameSync(tmp, out);
      p.video_original ||= p.video;
      p.video = out;
      p.tracks = { ...p.tracks, filled: missing, error: "" };
      missing = [];
      save(dir, p);   // 頁面看得到補了誰；之後就算失敗，重試也直接用補好的這支
    } else {
      p.tracks = { ...p.tracks, error: "" };
    }
    return { craig, trackEnvs, align, shown, names, missing };
  }

  // 辨識（或讀作者字幕）做完，外語影片接著自動翻譯（#56）。runPrepare 的 finally 清掉自己的工作之後
  // 同步接上翻譯的工作（中間沒有 await），別的請求插不進來
  async function prepareAndTranslate(id, dir) {
    await runPrepare(id, dir);
    let p;
    try { p = readProject(dir); } catch { return; }
    if (p.status === "ready" && isForeign(p) && !jobs.has(id)) await runTranslate(id, dir, { all: false });
  }

  const cueKey = (c) => `${c.start}\u0000${c.text}`;

  // 翻譯（#56）：all 為 false 只翻還沒有譯文的句子。每翻好一批就寫回專案（不加 rev，頁面存檔不會被擋），
  // 對的是「開始時間＋原文」都一樣的那一句，翻譯中改了字或拆合，那句就不會被蓋掉
  async function runTranslate(id, dir, { all = false } = {}) {
    const p = readProject(dir);
    const ac = new AbortController();
    const job = { kind: "translate", step: "translate", progress: 0, started: Date.now(), abort: () => ac.abort(), before: new Map(), written: new Map() };
    jobs.set(id, job);
    job.done = new Promise((r) => { job.finish = r; });
    const todo = (p.cues || []).filter((c) => c.text.trim() && (all || !String(c.tr || "").trim()));
    for (const c of todo) job.before.set(cueKey(c), c.tr);
    const started = new Date().toISOString();
    let result;
    try {
      const who = p.proofreader || "claude";
      checkProofreader(who, p.privacy);
      const convert = await d.taiwanConverter();
      const r = await d.translateCues(todo, {
        lang: p.lang, proofreader: who, signal: ac.signal, convert,
        onBatch: (from, trs) => {
          const got = new Map(trs.map((t, i) => [cueKey(todo[from + i]), t]));
          for (const [k, t] of got) job.written.set(k, t);
          const latest = readProject(dir);
          latest.cues = (latest.cues || []).map((c) => {
            const t = got.get(cueKey(c));
            // 只翻沒譯文的：翻譯中使用者自己填了譯文就不蓋掉
            return t === undefined || (!all && String(c.tr || "").trim()) ? c : { ...c, tr: t };
          });
          latest.translate = { status: "running", done: from + trs.length, total: todo.length, started };
          save(dir, latest);
          job.progress = todo.length ? (from + trs.length) / todo.length : 1;
        },
      });
      result = { status: "done", done: r.done, total: todo.length, started, finished: new Date().toISOString(),
        usage: r.usage ? { calls: r.usage.calls || 0, cost_usd: Math.round((r.usage.cost_usd || 0) * 10000) / 10000 } : null };
    } catch (e) {
      result = ac.signal.aborted
        ? { status: "cancelled", done: job.written.size, total: todo.length, started }
        : { status: "failed", error: String(e?.message || e).slice(0, 300), done: job.written.size, total: todo.length, started };
      if (!ac.signal.aborted) logError(`[studio] translation failed: ${result.error}`);
    } finally {
      jobs.delete(id);
      job.finish();
      const latest = readProject(dir);
      latest.translate = result || { status: "failed", error: "沒有翻譯成功", started };
      save(dir, latest);
    }
  }

  // 從 YouTube 下載一支影片、建立專案、開始做字幕（#56）。
  // 作者有上傳和影片同語言的字幕就直接用；只有自動字幕或沒有字幕時才送 Soniox。
  async function runImport(key, vid, want) {
    const imp = imports.get(key);
    const ac = new AbortController();
    imp.abort = () => ac.abort();
    let tmp = "", dirMade = "";
    try {
      imp.step = "info";
      const info = await d.fetchInfo(vid, { signal: ac.signal });
      if (info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming") throw new Error("直播中或還沒開始的影片不能下載");
      imp.title = info.title;
      const src = captionSource(info, want);
      imp.captions = src.kind;
      imp.lang = src.lang;
      const proofreader = "claude", privacy = "public";
      d.preflight({ privacy, proofreader, engine: src.kind === "author" ? "captions" : "soniox", burn: false });
      const home = d.downloadDir();
      fs.mkdirSync(home, { recursive: true });
      // 下載過同一支（檔名有 [影片 id]）就直接用
      let video = fs.readdirSync(home).map((n) => path.join(home, n))
        .find((f) => f.includes(`[${vid}]`) && VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()) && !/-字幕\.mp4$|-剪輯\.mp4$|-短片-\d+\.mp4$/u.test(f));
      if (!video) {
        imp.step = "download";
        tmp = fs.mkdtempSync(path.join(home, ".dl-"));
        const got = await d.fetchVideo(vid, tmp, { signal: ac.signal, onProgress: (x) => { imp.progress = x; } });
        video = freeName(home, path.basename(got));
        fs.renameSync(got, video);
      }
      const dir = realDir(projectDirFor(video));
      const id = projectId(dir);
      const name = path.basename(video, path.extname(video));
      if (fs.existsSync(path.join(dir, "project.json"))) {
        projects.set(id, dir);
        rememberRecent({ dir, name }, env);
        Object.assign(imp, { status: "done", project: id, reopened: true });
        return;
      }
      if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new Error(`「${path.basename(dir)}」資料夾已經有別的檔案，請先移走`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      dirMade = dir;
      let captionsFile = "";
      if (src.kind === "author") {
        imp.step = "captions";
        captionsFile = path.basename(await d.fetchCaptions(vid, src.track, dir, { signal: ac.signal }));
      }
      const source = { kind: "youtube", id: vid, url: info.url, title: info.title, uploader: info.uploader, captions: src.kind, ...(src.track ? { caption_track: src.track } : {}),
        ...(captionsFile ? { captions_file: captionsFile } : {}), downloaded: true };
      const foreign = src.lang !== "zh";
      save(dir, { version: 1, video, name, privacy, proofreader, size: "medium", rev: 0, created: new Date().toISOString(), cues: [], description: "",
        fps: d.ffprobeFps(video), duration_ms: d.videoDurationMs(video), cuts: [], status: "processing", ...(foreign ? { lang: src.lang, lang_mode: "both" } : {}), source });
      dirMade = "";
      projects.set(id, dir);
      rememberRecent({ dir, name }, env);
      startJob(id, () => prepareAndTranslate(id, dir));
      Object.assign(imp, { status: "done", project: id });
    } catch (e) {
      // 下載到一半或建專案失敗：剛建的空資料夾收掉（裡面只有字幕檔）
      if (dirMade) fs.rmSync(dirMade, { recursive: true, force: true });
      Object.assign(imp, { status: ac.signal.aborted ? "cancelled" : "failed", error: ac.signal.aborted ? "" : redactPaths(String(e?.message || e)).slice(0, 300) });
      if (!ac.signal.aborted) logError(`[studio] YouTube import failed: ${imp.error}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      imp.abort = null;
      imp.finished = Date.now();
    }
  }

  // AI 剪輯建議（#6）：本機找靜音、黑畫面，再把逐字時間交給校對用的 agent（含個資時不會是 pi）
  // 找口誤重講、贅詞、離題、等待。結果只是建議，存在 project.suggestions，套用與否由頁面決定。
  async function runSuggest(id, dir, { ai = true } = {}) {
    const p = readProject(dir);
    const ac = new AbortController();
    const job = { kind: "suggest", step: "silence", progress: 0, started: Date.now(), abort: () => ac.abort() };
    jobs.set(id, job);
    job.done = new Promise((r) => { job.finish = r; });
    let result;
    try {
      const dur = p.duration_ms || Infinity;   // 讀不到片長時不要把結尾夾到 0
      const silence = rangesToSuggestions(await d.detectSilence(p.video, { durationMs: dur, signal: ac.signal }), "silence", { durationMs: dur });
      job.step = "black";
      const black = rangesToSuggestions(await d.detectBlack(p.video, { signal: ac.signal }), "black", { durationMs: dur });
      let fromAi = [], usage = null, aiError = "", aiWarning = "";
      if (ai && !ac.signal.aborted) {
        job.step = "ai";
        checkProofreader(p.proofreader || "claude", p.privacy);
        try {
          const r = await d.suggestFromTranscript(timingFor(dir, p), { proofreader: p.proofreader || "claude", signal: ac.signal });
          fromAi = r.suggestions;
          usage = r.usage ? { calls: r.usage.calls || 0, cost_usd: Math.round((r.usage.cost_usd || 0) * 10000) / 10000 } : null;
          // 有幾批回覆格式壞掉（#36）：全壞才算 AI 失敗；只壞幾批就說是哪幾段沒有 AI 建議
          const failed = r.failed || [];
          if (failed.length && failed.length >= (r.chunks || 0)) aiError = "AI 回覆的格式不對，讀不出建議";
          else if (failed.length) {
            const clock = (ms) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
            aiWarning = `${failed.map((f) => `${clock(f.start)}–${clock(f.end)}`).join("、")} 這段 AI 回覆的格式不對，沒有 AI 建議；其他段落照常。按「重新找」可以再試一次。`;
            logError(`[studio] AI cut suggestions: ${failed.length}/${r.chunks} chunks unreadable`);
          }
        } catch (e) {
          aiError = String(e?.message || e).slice(0, 200);
          logError(`[studio] AI cut suggestions failed: ${aiError}`);
        }
      }
      if (ac.signal.aborted) throw new Error("cancelled");
      const merged = mergeSuggestions([silence, black, fromAi], p.cuts || [], dur);
      // id 每次都不同：頁面還拿著上一次的清單存檔時，不會把這次的新結果過濾掉
      const run = Date.now().toString(36);
      result = { status: "done", created: new Date().toISOString(), ai, usage, error: aiError, ...(aiWarning ? { warning: aiWarning } : {}), dropped: merged.dropped,
        items: merged.suggestions.map((x, i) => ({ id: `${run}-${i + 1}`, start: x.start, end: x.end, kind: x.kind, reason: x.reason, ...(x.text ? { text: x.text.slice(0, 200) } : {}) })) };
    } catch (e) {
      result = ac.signal.aborted ? null : { status: "failed", error: String(e?.message || e).slice(0, 300), items: [] };
      if (result) logError(`[studio] cut suggestions failed: ${result.error}`);
    } finally {
      jobs.delete(id);
      job.finish();
      const latest = readProject(dir);   // 找建議的時候可能有人在改字：只更新建議
      // 這次失敗：上一次的建議留著，只記下錯誤（頁面只提示一次）
      if (result?.status === "failed" && latest.suggestions?.items?.length) latest.suggestions = { ...latest.suggestions, lastError: result.error, lastErrorAt: new Date().toISOString() };
      else if (result) latest.suggestions = result.status === "failed" ? { ...result, created: new Date().toISOString() } : result;
      save(dir, latest);
    }
  }

  // 逐字時間：辨識時存的 timing.json；匯入的舊專案沒有，就用字幕平均分配
  function timingFor(dir, p) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, "timing.json"), "utf8"));
      if (Array.isArray(t) && t.length) return t;
    } catch { /* 沒有就用字幕 */ }
    return p.cues.flatMap((c) => {
      const chars = [...c.text], n = Math.max(1, chars.length), step = (c.end - c.start) / n;
      return chars.map((ch, i) => [ch, Math.round(c.start + i * step), Math.round(c.start + (i + 1) * step)]);
    });
  }

  // 輸出一支影片：subtitles 為 false 時只剪接、不燒字幕（字幕用專案資料夾裡已換算好的 subtitles.srt，#5）。
  // 回傳 [種類, 紀錄]：兩種輸出分開記，燒字幕版看字幕版本（rev），剪接版只看剪輯（#39）
  async function exportVideo(dir, p, { size, subtitles, signal, onProgress }) {
    const work = fs.mkdtempSync(path.join(dir, ".burn-"));
    const output = subtitles ? `${p.name}-字幕.mp4` : `${p.name}-剪輯.mp4`;
    const style = styleOf(p);
    try {
      // 有剪輯：字幕換算成剪輯後的時間，剪接和燒字幕一次完成。圓角底框寫 ASS、白字黑邊寫 SRT（#55）
      const cuts = p.cuts || [];
      const cues = remapCues(p.cues.filter((c) => c.text.trim()), cuts, cuts.length ? undefined : 0);
      const mode = isForeign(p) ? langModeOf(p) : undefined;
      const srt = d.writeBurnSubtitles({ dir: work, cues, video: p.video, size, style: subtitles ? style : "outline", mode, measure: d.measureAdvances, dims: subtitles && style === "box" ? d.videoSize(p.video) : undefined });
      const keep = cuts.length ? keepSegments(cuts, p.duration_ms) : undefined;
      const partial = path.join(work, "burned.mp4");
      await d.burnSubtitles({ video: p.video, srt, target: partial, size, keep, subtitles, signal, onProgress });
      fs.renameSync(partial, path.join(dir, output));
      return [subtitles ? "burn" : "cut", { file: output, rev: p.rev, size, ...(subtitles ? { style, ...(mode ? { lang_mode: mode } : {}) } : {}), cuts: cutsKey(cuts), finished: new Date().toISOString() }];
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async function runBurn(id, dir, size, { subtitles = true } = {}) {
    const p = readProject(dir);
    const ac = new AbortController();
    const job = { kind: "burn", step: "burn", progress: 0, started: Date.now(), abort: () => ac.abort() };
    jobs.set(id, job);
    job.done = new Promise((r) => { job.finish = r; });
    let done = null;
    p.burn = { status: "running", size, subtitles, started: new Date().toISOString() };
    save(dir, p);
    try {
      done = await exportVideo(dir, p, { size, subtitles, signal: ac.signal, onProgress: (x) => { job.progress = x; } });
      p.burn = { status: "done", size, subtitles, ...(done[1].style ? { style: done[1].style } : {}), ...(done[1].lang_mode ? { lang_mode: done[1].lang_mode } : {}), output: done[1].file, rev: p.rev, finished: done[1].finished, seconds: Math.round((Date.now() - job.started) / 1000) };
    } catch (e) {
      p.burn = { status: ac.signal.aborted ? "cancelled" : "failed", size, subtitles, error: ac.signal.aborted ? "" : String(e?.message || e).slice(0, 300) };
      if (!ac.signal.aborted) logError(`[studio] burn failed: ${p.burn.error}`);
    } finally {
      jobs.delete(id);
      job.finish();
      const latest = readProject(dir);   // 燒錄中可能有人繼續改字，只更新燒錄狀態
      latest.burn = p.burn;
      if (done) latest.outputs = { ...(latest.outputs || {}), [done[0]]: done[1] };
      save(dir, latest);
    }
  }

  // 輸出一支直式短片（#54）：用開始時的片段、字幕與剪輯；輸出中改了片段，fresh 會變 false，頁面提示重新輸出
  async function runShort(id, dir, sid) {
    const p = readProject(dir);
    const item = (p.shorts?.items || []).find((x) => x.id === sid);
    const ac = new AbortController();
    const job = { kind: "short", short: sid, step: "short", progress: 0, started: Date.now(), abort: () => ac.abort() };
    jobs.set(id, job);
    job.done = new Promise((r) => { job.finish = r; });
    const mark = (fn) => {
      const latest = readProject(dir);
      const x = (latest.shorts?.items || []).find((y) => y.id === sid);
      if (x) { fn(x); save(dir, latest); }
    };
    let result;
    const work = fs.mkdtempSync(path.join(dir, ".burn-"));
    try {
      mark((x) => { x.export = { status: "running", started: new Date().toISOString() }; });
      const cuts = p.cuts || [];
      const keep = shortKeep(item, cuts);
      const sz = d.videoSize(p.video);
      const layout = shortLayout(sz.w, sz.h);
      const durationMs = keep.reduce((n, [a, b]) => n + (b - a), 0);
      const ass = path.join(work, "short.ass");
      const cues = shortCues(item, p.cues || [], cuts);
      fs.writeFileSync(ass, shortAss({ title: item.title, cues, durationMs, layout, style: styleOf(p), mode: isForeign(p) ? langModeOf(p) : undefined, adv: d.measureAdvances(cues.flatMap((c) => (c.tr ? [c.text, c.tr] : [c.text]))),
        advSub: isForeign(p) ? subAdvances(cues, langModeOf(p), d.measureAdvances) : undefined }), { mode: 0o600 });
      const partial = path.join(work, "short.mp4");
      await d.renderShort({ video: p.video, ass, target: partial, keep, layout, signal: ac.signal, onProgress: (x) => { job.progress = x; } });
      const file = shortFile(p, item);
      // 最後一道保險：同名的檔已經在、又不是這一段自己上次輸出的，就不蓋掉
      if (fs.existsSync(path.join(dir, file)) && item.output?.file !== file) throw new Error(`資料夾裡已經有「${file}」，沒有蓋掉它；請先把那個檔搬走或改名再輸出`);
      fs.renameSync(partial, path.join(dir, file));
      result = { output: { file, key: shortKey(item, p), finished: new Date().toISOString() }, export: { status: "done", seconds: Math.round((Date.now() - job.started) / 1000) } };
    } catch (e) {
      result = { export: { status: ac.signal.aborted ? "cancelled" : "failed", error: ac.signal.aborted ? "" : String(e?.message || e).slice(0, 300) } };
      if (!ac.signal.aborted) logError(`[studio] short export failed: ${result.export.error}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      jobs.delete(id);
      job.finish();
      // 只更新這一段的輸出紀錄：輸出時可能有人在改字或改別的片段；這段被刪掉了就只留檔案
      mark((x) => { Object.assign(x, result || { export: { status: "failed", error: "沒有輸出成功" } }); });
    }
  }

  // 片段清單的路由（#54）：AI 挑片段、存清單、輸出某一段
  async function shortsRoute(req, res, id, dir, project, sub, sid, body) {
    if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
    if (jobs.get(id)?.kind === "clear") return fail(res, 409, "正在清掉這支的處理資料");
    const items = project.shorts?.items || [];
    if (req.method === "PUT" && !sub) {
      if (jobs.get(id)?.kind === "shorts") return fail(res, 409, "AI 正在挑片段，等它挑完再改");
      // 序號由伺服器決定：原本就有的片段用原本的序號；新加的片段一律編在用過的最大序號後面
      const old = new Map(items.map((x) => [x.id, x]));
      let hw = shortsMaxN(project.shorts);
      const raw = Array.isArray(body.items) ? body.items.map((x) => ({ ...x, n: old.has(x?.id) ? old.get(x.id).n : ++hw })) : body.items;
      let list;
      try { list = validateShorts(raw, project.cues || [], project.cuts || []); } catch (e) { return fail(res, 400, e.message); }
      // 輸出紀錄只由伺服器寫：照 id 從原本的清單帶過來
      project.shorts = { ...(project.shorts || {}), max_n: Math.max(hw, shortsMaxN(project.shorts)), items: list.map((x) => ({ ...x, ...(old.get(x.id)?.output ? { output: old.get(x.id).output } : {}), ...(old.get(x.id)?.export ? { export: old.get(x.id).export } : {}) })) };
      save(dir, project);
      return send(res, 200, { shorts: shortsView(dir, project) });
    }
    if (req.method === "POST" && sub === "suggest") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      const cues = (project.cues || []).filter((c) => c.text.trim());
      if (!cues.length) return fail(res, 409, "沒有字幕，挑不出片段");
      const who = project.proofreader || "claude";
      checkProofreader(who, project.privacy);
      if (!proofreaderAvailable(who)) return fail(res, 409, `${who} 沒有裝在這台電腦`);
      const ac = new AbortController();
      const job = { kind: "shorts", step: "shorts", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        const run = Date.now().toString(36);
        const r = await d.suggestShorts(cues, { cuts: project.cuts || [], chapters: project.description || "", proofreader: who, signal: ac.signal, makeId: (i) => `${run}-${i + 1}` });
        if (!r.items.length) throw new Error("AI 沒挑到適合的片段");
        const latest = readProject(dir);   // 等的時候可能有人在改字：只更新片段清單
        // 已經輸出過的片段留著（檔案還在）；沒輸出過的換成這次的建議，序號接著往下編，不會蓋掉舊檔
        const kept = (latest.shorts?.items || []).filter((x) => x.output);
        let n = shortsMaxN(latest.shorts) + 1;
        const fresh = r.items.slice(0, Math.max(0, MAX_SHORTS - kept.length)).map((x) => ({ ...x, n: n++ }));
        latest.shorts = { items: [...kept, ...fresh].sort((a, b) => a.start - b.start), max_n: n - 1, created: new Date().toISOString(), error: "" };
        save(dir, latest);
        return send(res, 200, { shorts: shortsView(dir, latest), added: fresh.length });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，片段清單沒有變");
        logError(`[studio] shorts suggestion failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, 502, `AI 沒挑成功：${String(e?.message || e).slice(0, 200)}`);
      } finally {
        jobs.delete(id);
        job.finish();
      }
    }
    if (req.method === "POST" && sub === "export") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (!items.some((x) => x.id === sid)) return fail(res, 404, "找不到這一段，可能已經刪掉了");
      startJob(id, () => runShort(id, dir, sid));
      return send(res, 200, { started: true });
    }
    if (req.method === "POST" && sub === "reveal") {
      const x = items.find((y) => y.id === sid);
      const target = x?.output?.file ? path.join(dir, x.output.file) : "";
      d.reveal(target && fs.existsSync(target) ? target : dir);
      return send(res, 200, { ok: true });
    }
    return fail(res, 405, "method not allowed");
  }

  // ---- YouTube（#40）----
  const redirectUri = () => `http://127.0.0.1:${port}`;
  function ytClient() {
    const s = loadSettings(env);
    const secret = s.client ? d.secrets.get(secretAccount.client) : "";
    if (!s.client || !secret) throw Object.assign(new Error("還沒設定 YouTube：請到「設定」選 Google 下載的 OAuth 用戶端 JSON 檔"), { status: 409 });
    return { client_id: s.client.client_id, client_secret: secret };
  }
  function updateChannel(id, fn) {
    const s = loadSettings(env);
    const c = s.channels.find((x) => x.id === id);
    if (c) { fn(c, s); saveSettings(s, env); }
    return c;
  }
  // 拿這個頻道的 access token：快過期或 force 就用 refresh token 換新的；授權被取消時標成要重新連結
  function tokenGetter(channelId) {
    return async (force = false) => {
      const c = ytTokens.get(channelId);
      if (!force && c && c.exp > Date.now() + 60_000) return c.token;
      const refreshToken = d.secrets.get(secretAccount.channel(channelId));
      if (!refreshToken) throw Object.assign(new Error("這個頻道的授權不見了，請到「設定」重新連結"), { code: "reauth" });
      try {
        const t = await refreshAccess({ fetch: d.youtubeFetch, client: ytClient(), refreshToken });
        ytTokens.set(channelId, { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 });
        return t.access_token;
      } catch (e) {
        if (e.code === "reauth") updateChannel(channelId, (x) => { x.connected = false; });
        throw e;
      }
    };
  }
  function ytView() {
    const s = loadSettings(env);
    return {
      client: s.client ? { project_id: s.client.project_id, client_id: s.client.client_id.replace(/^(.{8}).*(\.apps\.googleusercontent\.com)$/, "$1…$2"), ready: Boolean(d.secrets.get(secretAccount.client)) } : null,
      channels: s.channels, default_channel: s.default_channel, categories: CATEGORY_ORDER.map((k) => [k, CATEGORIES[k]]),
    };
  }

  // Google 授權完導回工作室首頁（帶 state、code）：換 token、讀頻道、refresh token 存進鑰匙圈
  async function oauthCallback(res, url) {
    const page = (title, msg, ok) => send(res, ok ? 200 : 400, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/app-icon.png"><title>${escHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:16px/1.7 -apple-system,"PingFang TC",sans-serif;background:Canvas;color:CanvasText}main{max-width:520px;margin:12vh auto;padding:0 20px}h1{font-size:22px}a{color:#2f9e7e}</style>
<main><h1>${escHtml(title)}</h1><p>${escHtml(msg)}</p><p><a href="/">回到字幕工作室</a></p></main></html>`, "text/html; charset=utf-8", { "Content-Security-Policy": PAGE_CSP });
    const key = url.searchParams.get("state") || "";
    const pending = oauthPending.get(key);
    oauthPending.delete(key);
    if (!pending || Date.now() - pending.at > 600_000) return page("沒有連結成功", "這個授權連結過期或已經用過了，請回到工作室的「設定」再按一次「連結 YouTube 頻道」。", false);
    const error = url.searchParams.get("error");
    if (error) return page("沒有連結成功", error === "access_denied" ? "在 Google 的畫面按了取消或不允許，所以沒有連結。" : `Google 回傳：${error}`, false);
    try {
      const client = ytClient();
      const t = await exchangeCode({ fetch: d.youtubeFetch, client, code: url.searchParams.get("code") || "", verifier: pending.verifier, redirectUri: redirectUri() });
      if (t.scope && !String(t.scope).split(" ").includes(SCOPE)) throw new Error("沒有拿到管理 YouTube 的權限：連結時請勾選允許「查看、編輯及永久刪除你的 YouTube 影片…」那一項。");
      if (!t.refresh_token) throw new Error("Google 沒有給長期授權。請到 Google 帳戶的「第三方應用程式存取權」移除這個應用程式，再連結一次。");
      const ch = await myChannel({ fetch: d.youtubeFetch, getToken: async () => t.access_token });
      d.secrets.set(secretAccount.channel(ch.id), t.refresh_token);
      ytTokens.set(ch.id, { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 });
      const s = loadSettings(env);
      const old = s.channels.find((x) => x.id === ch.id);
      if (old) Object.assign(old, { title: ch.title, thumb: ch.thumb, connected: true });
      else s.channels.push({ ...ch, connected: true, added: new Date().toISOString(), defaults: checkDefaults() });
      if (!s.default_channel) s.default_channel = ch.id;
      saveSettings(s, env);
      return page("連結好了", `已連結 YouTube 頻道「${ch.title}」。可以關掉這個分頁，回到字幕工作室。`, true);
    } catch (e) {
      logError(`[studio] YouTube connect failed: ${String(e?.message || e).slice(0, 200)}`);
      return page("沒有連結成功", String(e?.message || e).slice(0, 300), false);
    }
  }

  // 上傳一支影片：需要的影片沒有或過期就先輸出 → 可續傳上傳 → CC 字幕 → 播放清單。
  // 影片上傳好之後，字幕或播放清單失敗只記成提醒，不算整個失敗（影片已經在 YouTube 上了）
  async function runUpload(id, dir, o) {
    const p = readProject(dir);
    const ac = new AbortController();
    const job = { kind: "upload", step: "upload", progress: 0, started: Date.now(), abort: () => ac.abort() };
    jobs.set(id, job);
    job.done = new Promise((r) => { job.finish = r; });
    const record = {
      status: "uploading", channel: o.channel.id, channel_title: o.channel.title, title: o.meta.snippet.title, privacy: o.meta.status.privacyStatus,
      publish_at: o.meta.status.publishAt || "", subtitles: o.subtitles, rev: p.rev, started: new Date().toISOString(), warnings: [],
      cuts: cutsKey(p.cuts || []), language: o.meta.snippet.defaultLanguage,   // 事後補 CC 字幕（#71）要對得上這支影片
    };
    const store = (extra = {}) => { const latest = readProject(dir); Object.assign(latest, extra, { youtube: { ...record } }); save(dir, latest); };
    store();
    const cuts = p.cuts || [];
    try {
      const outs = outputsOf(dir, p);
      let file = o.subtitles === "burned"
        ? (outs.burn?.rev === p.rev && (outs.burn.style || "outline") === styleOf(p) && (outs.burn.lang_mode || "") === (isForeign(p) ? langModeOf(p) : "") ? path.join(dir, outs.burn.file) : "")
        : !cuts.length ? p.video : outs.cut?.cuts === cutsKey(cuts) ? path.join(dir, outs.cut.file) : "";
      // 這次會經過哪些步驟（頁面照這個列）
      const withCc = o.subtitles === "cc" || o.alsoCc;
      job.steps = [...(file ? [] : ["export"]), "upload", ...(withCc ? ["captions"] : []), ...(o.playlistId ? ["playlist"] : [])];
      if (!file) {
        job.step = "export";
        const size = Object.hasOwn(SUBTITLE_SIZES, p.size) ? p.size : "medium";
        const [kind, rec] = await exportVideo(dir, p, { size, subtitles: o.subtitles === "burned", signal: ac.signal, onProgress: (x) => { job.progress = x; } });
        file = path.join(dir, rec.file);
        const latest = readProject(dir);
        latest.outputs = { ...(latest.outputs || {}), [kind]: rec };
        save(dir, latest);
      }
      if (!fs.existsSync(file)) throw new Error("找不到要上傳的影片（原始影片可能被移動或刪除）");
      const getToken = tokenGetter(o.channel.id);
      job.step = "upload";
      job.progress = 0;
      const video = await uploadVideo({ fetch: d.youtubeFetch, getToken, file, meta: o.meta, notify: o.notify, signal: ac.signal, onProgress: (x) => { job.progress = x; } });
      Object.assign(record, { video_id: video.id, url: `https://youtu.be/${video.id}`, studio_url: `https://studio.youtube.com/video/${video.id}/edit` });
      if (withCc) {
        job.step = "captions";
        try {
          // 字幕用開始上傳時的版本：上傳中改了剪輯，字幕時間還是對得上這支影片
          const srt = toSrt(remapCues(p.cues.filter((c) => c.text.trim()), cuts, cuts.length ? undefined : 0));
          await uploadCaption({ fetch: d.youtubeFetch, getToken, videoId: video.id, srt, language: o.meta.snippet.defaultLanguage, signal: ac.signal });
          record.cc_added = new Date().toISOString();
        } catch (e) {
          if (ac.signal.aborted) throw e;
          record.warnings.push(`${CC_FAILED}（${e.message}）。可以在上傳視窗按「補上 CC 字幕」再試一次。`);
        }
      }
      if (o.playlistId) {
        job.step = "playlist";
        try { await addToPlaylist({ fetch: d.youtubeFetch, getToken, playlistId: o.playlistId, videoId: video.id, signal: ac.signal }); } catch (e) {
          if (ac.signal.aborted) throw e;
          record.warnings.push(`沒有加進播放清單（${e.message}）。`);
        }
      }
      Object.assign(record, { status: "done", finished: new Date().toISOString(), seconds: Math.round((Date.now() - job.started) / 1000) });
    } catch (e) {
      const cancelled = ac.signal.aborted;
      Object.assign(record, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "" : String(e?.message || e).slice(0, 300), finished: new Date().toISOString() });
      if (!cancelled) logError(`[studio] YouTube upload failed: ${record.error}`);
    } finally {
      jobs.delete(id);
      job.finish();
      store();
    }
  }

  function resolveVideo(value) {
    const raw = String(value || "").trim().replace(/^file:\/\//, "");
    if (!raw || !path.isAbsolute(raw)) throw new Error("影片路徑要是完整路徑");
    if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) throw new Error("找不到這支影片");
    const video = fs.realpathSync(raw);
    if (!VIDEO_EXTENSIONS.has(path.extname(video).toLowerCase())) throw new Error("不支援這種檔案（mp4、mov、m4v、mkv、webm、avi）");
    return video;
  }

  // 首頁點影片：還不建資料夾、不送辨識，只讓瀏覽器播放、看時間軸、先粗剪
  function openPreview(body) {
    const video = resolveVideo(body.video);
    // 還在 iCloud：請它下載，回 202 讓頁面過幾秒再來；下載請求 30 秒內不重送
    if (d.isOffline(video)) {
      const now = Date.now();
      for (const [k, v] of downloads) if (now - v.at > 600_000) downloads.delete(k);   // 放棄下載的舊紀錄
      let job = downloads.get(video);
      if (!job || now - job.at > 30_000) {
        const fresh = { at: now, error: "" };
        downloads.set(video, fresh);
        d.icloudDownload(video, (msg) => { fresh.error = redactPaths(String(msg)).slice(0, 200); });
        job = fresh;
      }
      if (job.error) {
        downloads.delete(video);
        throw Object.assign(new Error(`iCloud 沒辦法下載這支影片（${job.error}）。可以在 Finder 對這個檔案按右鍵，選「立即下載」，下載好再點一次。`), { status: 502 });
      }
      let st = { size: 0, blocks: 0 };
      try { st = fs.statSync(video); } catch { /* 讀不到就當 0% */ }
      const progress = st.size ? Math.min(0.99, (st.blocks * 512) / st.size) : 0;
      return { status: 202, body: { downloading: true, name: path.basename(video, path.extname(video)), size: st.size, progress } };
    }
    downloads.delete(video);
    const id = projectId(video);
    const dir = realDir(projectDirFor(video));
    let project = null, projectStatus = "";
    if (fs.existsSync(path.join(dir, "project.json"))) {
      project = projectId(dir);
      try { projectStatus = readProject(dir).status; } catch { /* 讀不到就照一般的說 */ }
      projects.set(project, dir);
      rememberRecent({ dir, name: path.basename(video, path.extname(video)) }, env);   // 從這裡打開的也進「繼續編輯」
    }
    const ext = path.extname(video).toLowerCase();
    const info = { id, video, name: path.basename(video, ext), size: fs.statSync(video).size, duration_ms: d.videoDurationMs(video), fps: d.ffprobeFps(video), playable: BROWSER_PLAYABLE.has(ext) };
    previews.set(id, info);
    return { ...info, project, project_status: projectStatus, craig: project ? null : craigFor(video, info.duration_ms), subtitles: project ? [] : nearbySubtitles(video) };
  }

  // 錄音時間對得上這支影片的 Craig zip（#129）；找不到或讀不了就當沒有
  function craigFor(video, durationMs) {
    try { return craigView(d.findCraig(video, d.craigDirs(video), durationMs)); } catch { return null; }
  }
  // 給頁面看的：zip 的完整路徑（本機頁面選檔要用）、檔名、開始時間、帳號與記過的名字
  const craigView = (c) => c && { zip: c.zip, file: c.file, start: c.start, tracks: c.tracks.map((t) => ({ user: t.user, name: t.name })) };

  // 開始處理時帶的分軌設定：zip 要讀得到 info.txt；名字只收這個 zip 裡有的帳號
  function checkedTracks(t) {
    if (t === undefined || t === null) return null;
    if (typeof t !== "object") throw new Error("Discord 分軌的設定不對");
    const zip = resolveZip(t.zip);
    const c = describeCraig(zip, env);
    const users = new Set(c.tracks.map((x) => x.user));
    const given = namesMap(t.names);
    const names = Object.fromEntries(Object.entries(given).filter(([u]) => users.has(u)));
    return { zip, fill: t.fill !== false, names };
  }

  function previewVideoFile(id) {
    const info = previews.get(id);
    if (info.playable) return Promise.resolve(info.video);
    if (!previewTmp) previewTmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-preview-"));
    const file = path.join(previewTmp, `${id}.mp4`);
    if (fs.existsSync(file)) return Promise.resolve(file);
    const key = `preview:${id}`;
    if (!previewing.has(key)) previewing.set(key, d.remuxPreview(info.video, file).finally(() => previewing.delete(key)));
    return previewing.get(key).then(() => file);
  }

  // 時間軸的波形：同一支影片的請求共用一次計算；所有等它的頁面都離開了就中止 ffmpeg（只放記憶體，最多留 6 支）
  async function serveWave(res, key, video, durationMs) {
    let entry = waves.get(key);
    if (!entry) {
      const ac = new AbortController();
      entry = { ac, waiters: 0, promise: d.waveform(video, durationMs, { signal: ac.signal }).catch(() => (ac.signal.aborted ? null : { bucket_ms: 0, peaks: new Uint8Array(0) })) };
      waves.set(key, entry);
      while (waves.size > 6) waves.delete(waves.keys().next().value);
    }
    entry.waiters += 1;
    let left = false;
    res.on("close", () => {
      if (left || res.writableEnded) return;
      left = true;
      if (--entry.waiters === 0 && waves.get(key) === entry) { entry.ac.abort(); waves.delete(key); }
    });
    const w = await entry.promise;
    if (!left) entry.waiters -= 1;
    left = true;
    if (!w) { if (!res.headersSent) fail(res, 499, "已取消"); return; }
    send(res, 200, { bucket_ms: w.bucket_ms, peaks: Buffer.from(w.peaks).toString("base64") });
  }

  // 首頁縮圖：一支好了就送一行（NDJSON），同時最多抓 3 支；頁面離開就停
  async function servePosters(req, res) {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const todo = [...homeVideos].filter(([, v]) => !v.offline);
    const line = (key, x) => { if (!res.writableEnded) res.write(`${JSON.stringify({ key, duration_ms: x.duration_ms, jpg: x.jpg ? x.jpg.toString("base64") : null })}\n`); };
    const worker = async () => {
      while (todo.length && !ac.signal.aborted) {
        const [key, v] = todo.shift();
        let x = posters.get(key);
        if (!x) {
          x = await d.poster(v.path, { signal: ac.signal }).catch(() => ({ jpg: null, duration_ms: 0 }));
          if (ac.signal.aborted) break;
          posters.set(key, x);
          if (posters.size > 60) posters.delete(posters.keys().next().value);
        }
        line(key, x);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    res.end();
  }

  async function serveThumbs(req, res, video, durationMs) {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    await d.thumbnails(video, durationMs, {
      signal: ac.signal,
      onTile: ({ i, t_ms, jpg }) => { if (!res.writableEnded) res.write(`${JSON.stringify({ i, t_ms, jpg: jpg.toString("base64") })}\n`); },
    }).catch(() => {});
    res.end();
  }

  // 剪輯區段：檢查格式；讀不到片長或整支都剪掉時不收（整支剪掉會變成「沒剪」，反而整支送辨識）
  function checkedCuts(raw, durationMs) {
    const cuts = validateCuts(raw, durationMs);
    if (cuts.length && !durationMs) throw new Error("讀不到影片長度，沒辦法剪輯；請先不要剪，直接上字幕");
    if (cuts.length && !keepSegments(cuts, durationMs).length) throw new Error("整支影片都剪掉了，至少要留一段");
    return cuts;
  }

  async function openProject(body) {
    const privacy = String(body.privacy || "public"), proofreader = String(body.proofreader || "claude");
    if (!PRIVACY.has(privacy)) throw new Error("privacy 只能是 public、sensitive 或 student-private");
    const lang = String(body.lang || "zh");
    if (!LANG.test(lang)) throw new Error("影片語言不對");
    checkProofreader(proofreader, privacy);
    const video = resolveVideo(body.video);
    const dir = realDir(projectDirFor(video));
    const id = projectId(dir);
    const name = path.basename(video, path.extname(video));
    // 使用者自己的字幕檔（#148）：先讀過一次，檔案不對就不建專案
    const plain = body.noSubtitles === true;
    if (plain && body.subtitles) throw new Error("「不要字幕」和字幕檔不能同時用");
    if (plain && body.tracks) throw new Error("「不要字幕」不能同時用 Discord 分軌（分軌是替辨識出來的字幕標講者）");
    const own = body.subtitles ? readSubtitleFile(body.subtitles) : null;
    if (own && body.tracks) throw new Error("用字幕檔時不能同時用 Discord 分軌（分軌是替辨識出來的字幕標講者）");
    if (fs.existsSync(path.join(dir, "project.json"))) {
      if (own) throw new Error("這支影片之前做過字幕；要改用字幕檔，先在首頁按「整理…」清掉這支的處理資料");
      if (plain) throw new Error("這支影片之前做過字幕；要改用「不要字幕」，先在首頁按「整理…」清掉這支的處理資料");
      const p = readProject(dir);
      // 這次改標成含個資（公開 → 非公開）：照這次的算；原本的校對者若可能走中國大陸雲端模型就改回 Claude
      const stricter = p.privacy === "public" && privacy !== "public";
      if (stricter) {
        if (jobs.has(id)) throw new Error("這支影片正在處理，等處理完再改成含個資");
        Object.assign(p, { privacy, proofreader: MAY_USE_CHINA_CLOUD_LLM.includes(p.proofreader) ? "claude" : p.proofreader });
        save(dir, p);
      }
      projects.set(id, dir);
      rememberRecent({ dir, name }, env);
      return { id, reopened: true };
    }
    const duration = d.videoDurationMs(video);
    const cuts = checkedCuts(body.cuts, duration);
    const tracks = checkedTracks(body.tracks);
    const base = { version: 1, video, name, privacy, proofreader, size: "medium", rev: 0, created: new Date().toISOString(), cues: [], description: "",
      fps: d.ffprobeFps(video), duration_ms: duration, cuts, ...(lang !== "zh" ? { lang, lang_mode: "both" } : {}), ...(tracks ? { tracks } : {}),
      ...(own ? { source: { kind: "file", captions: "file", captions_file: `captions${own.ext}`, file_name: path.basename(own.file) } } : {}) };
    if (!own && !plain && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "subtitles.srt"))) {
      // pnpm run subtitle 做過的：直接讀它的 SRT 與說明欄，不重新辨識
      const desc = path.join(dir, "youtube-description.md");
      const p = { ...base, cuts: [], status: "ready", rev: 1, cues: validateCues(parseSrt(fs.readFileSync(path.join(dir, "subtitles.srt"), "utf8"))),
        description: fs.existsSync(desc) ? fs.readFileSync(desc, "utf8") : "", imported: true };
      save(dir, p);
      projects.set(id, dir);
      rememberRecent({ dir, name }, env);
      return { id, imported: true };
    }
    if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new Error(`「${path.basename(dir)}」資料夾已經有別的檔案，請先移走`);
    d.preflight({ privacy, proofreader, engine: own || plain ? "none" : "soniox", burn: false });
    if (tracks) rememberNames(tracks.names, env);   // 下次同一群人自動帶入
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // 字幕檔複製一份進專案：原檔之後搬走或改掉，重新處理還是用當初選的那份
    if (own) writePrivate(path.join(dir, base.source.captions_file), own.raw);
    // 不要字幕（#158）：沒有東西要處理，建好就是 ready，不送辨識、不跑校對、不寫說明欄
    if (plain) {
      save(dir, { ...base, status: "ready", rev: 1, source: { kind: "none", captions: "none" } });
      projects.set(id, dir);
      rememberRecent({ dir, name }, env);
      return { id, ready: true };
    }
    save(dir, { ...base, status: "processing" });
    projects.set(id, dir);
    rememberRecent({ dir, name }, env);
    startJob(id, () => prepareAndTranslate(id, dir));
    return { id, started: true };
  }

  function serveVideo(req, res, file) {
    const size = fs.statSync(file).size;
    const type = { ".mov": "video/quicktime", ".m4v": "video/x-m4v" }[path.extname(file).toLowerCase()] || "video/mp4";
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (!m) {
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      pipeline(fs.createReadStream(file), res, () => {});   // 中途斷線或讀不到：關掉檔案，不讓服務掛掉
      return;
    }
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));   // bytes=-N 比檔案大：給整個檔案
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!m[1] && !m[2] || start < 0 || start >= size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  }

  async function corrections(force = false) {
    if (!correctionsCache || force) {
      const r = await d.syncCorrections({ env });
      correctionsCache = { ...correctionsSummary(r), hints: r.corrections.hints, fixed: r.corrections.fixed };
    }
    return correctionsCache;
  }

  function tools() {
    return {
      soniox: Boolean(resolveSonioxKey()),
      proofreaders: Object.fromEntries(PROOFREADERS.map((n) => [n, proofreaderAvailable(n)])),
      chinaCloudProofreaders: MAY_USE_CHINA_CLOUD_LLM,
      sizes: Object.keys(SUBTITLE_SIZES),
      ytdlp: ytdlpOk ||= Boolean(d.hasYtDlp()),   // 只記住「有」：裝好 yt-dlp 後不用重開工作室
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!allowed(req, url)) return fail(res, 403, "forbidden");
    const p = url.pathname;
    if (req.method === "GET" && p === "/" && url.searchParams.has("state")) return oauthCallback(res, url);
    if (req.method === "GET" && p === "/") {
      return send(res, 200, html(), "text/html; charset=utf-8", {
        "Content-Security-Policy": PAGE_CSP,
      });
    }
    if (req.method === "GET" && PAGE_ASSETS.has(p)) return send(res, 200, fs.readFileSync(path.join(TOOL_ROOT, "web", p.slice(1))), PAGE_ASSETS.get(p));
    if (req.method === "GET" && (p === "/cue-ops.mjs" || p === "/cuts.mjs" || p === "/shorts.mjs" || p === "/subtitle-box.mjs")) return send(res, 200, fs.readFileSync(path.join(TOOL_ROOT, "lib", p.slice(1))), "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true, app: "subtitle-studio" });
    // 會議轉錄 App 的共用元件（#111，meeting-scribe#157）：直接讀這台 meeting-scribe checkout 的 web/shared/，不複製。
    // 只認清單上的檔名；checkout 不在就 404，頁面會說明並退回純文字
    if (req.method === "GET" && SHARED_ASSETS.has(p)) {
      const base = scribeDir(env);
      const file = base ? path.join(base, "web", "shared", p.slice("/shared/".length)) : "";
      if (!file || !fs.existsSync(file)) return fail(res, 404, "找不到會議轉錄 App 的共用元件");
      return send(res, 200, fs.readFileSync(file), SHARED_ASSETS.get(p));
    }

    // 共用元件的版本比對（#116）：這台 meeting-scribe checkout 的網頁版本和主機（meeting_scribe_url）的一不一樣
    if (req.method === "GET" && p === "/api/shared-version") {
      try {
        const v = await d.sharedBuilds();
        return send(res, 200, { ...v, same: Boolean(v.local && v.remote && v.local === v.remote) });
      } catch (e) {
        return fail(res, 502, String(e?.message || e).slice(0, 200));
      }
    }
    // 延伸模組清單（#88）：會議轉錄 App 有哪些模組；連不上時頁面說明原因
    if (req.method === "GET" && p === "/api/modules") {
      try {
        return send(res, 200, { modules: await moduleList({ fresh: url.searchParams.get("fresh") === "1" }) });
      } catch (e) {
        return fail(res, 502, String(e?.message || e).slice(0, 300));
      }
    }
    if (req.method === "GET" && p === "/api/home") {
      const recent = loadRecent(env).map((r) => {
        const id = projectId(r.dir);
        projects.set(id, r.dir);
        let pr = null;
        try { pr = readProject(r.dir); } catch { /* 壞掉的專案略過 */ }
        return pr && { id, name: pr.name, status: { burn: "burning", upload: "uploading" }[jobs.get(id)?.kind] || pr.status, privacy: pr.privacy, updated: pr.updated, cues: pr.cues?.length || 0,
          bytes: folderBytes(r.dir), outputs: Object.values(outputsOf(r.dir, pr)).map((x) => x.file), busy: jobs.has(id), downloaded: Boolean(pr.source?.downloaded), foreign: isForeign(pr),
          // 整理視窗（#75）：上傳過就能連原始錄影一起丟；還沒掛 CC 的先提醒
          ...(pr.youtube?.video_id && pr.youtube.status === "done" ? { youtube: { url: pr.youtube.url, needs_cc: needsCc(pr.youtube) } } : {}),
          ...(uploadedOwnVideo(pr) ? { original_bytes: fileBytes(sourceVideo(pr)) } : {}) };
      }).filter(Boolean);
      homeVideos = new Map();
      const icloudDir = d.icloudDir();
      const icloud = icloudDir ? realDir(icloudDir) + path.sep : "";
      const videos = recentVideos(d.videoDirs(), 24).map((v) => {
        const key = createHash("sha256").update(`${v.path}\0${v.mtime}\0${v.size}`).digest("hex").slice(0, 16);
        // iCloud 還沒下載到這台的不抓縮圖：讀它會先整支下載
        const offline = Boolean(d.isOffline(v.path));
        homeVideos.set(key, { path: v.path, offline });
        return { ...v, key, offline, icloud: Boolean(icloud) && realDir(v.path).startsWith(icloud) };
      });
      return send(res, 200, { recent, videos, tools: tools() });
    }
    if (req.method === "GET" && p === "/api/home/posters") return servePosters(req, res);
    // 沒有 icon link 的頁面，瀏覽器會自己要 /favicon.ico：也給 App 圖示，分頁才不會是地球
    if (req.method === "GET" && (p === "/app-icon.png" || p === "/favicon.ico")) {
      return send(res, 200, fs.readFileSync(path.join(TOOL_ROOT, "assets", "studio-icon.png")), "image/png", { "Cache-Control": "max-age=86400" });
    }
    // 網頁上的「關閉工作室」：有工作在跑時先回 409 讓頁面問一次，確定了再帶 force
    if (req.method === "POST" && p === "/api/shutdown") {
      const b = await readBody(req);
      const busy = [...jobs.entries()].map(([id, job]) => {
        let name = "";
        try { name = readProject(projects.get(id)).name; } catch { /* 讀不到就不顯示名稱 */ }
        return { name, kind: job.kind };
      });
      if (busy.length && b.force !== true) return send(res, 409, { error: "還有工作在跑", busy });
      send(res, 200, { ok: true });
      setImmediate(onShutdown);
      return;
    }
    if (req.method === "POST" && p === "/api/pick") {
      const picked = await d.pickFile();
      return send(res, 200, picked ? { path: picked } : { cancelled: true });
    }
    // 使用者自己的字幕檔（#148）：macOS 選檔窗只挑 .srt／.vtt
    if (req.method === "POST" && p === "/api/pick-subtitles") {
      const picked = await d.pickSubtitles();
      return send(res, 200, picked ? { path: picked } : { cancelled: true });
    }
    // Discord 分軌（#129）：自己選 zip，回傳裡面有哪些帳號
    if (req.method === "POST" && p === "/api/pick-zip") {
      const picked = await d.pickZip();
      if (!picked) return send(res, 200, { cancelled: true });
      try { return send(res, 200, { craig: craigView(describeCraig(resolveZip(picked), env)) }); } catch (e) { return fail(res, 400, e.message); }
    }
    // 講者名冊（#132）：設定裡看、改名、刪除、先加新成員
    if (req.method === "GET" && p === "/api/speakers") return send(res, 200, { people: rosterList(env) });
    if (req.method === "POST" && p === "/api/speakers") {
      const b = await readBody(req);
      try { setRosterName(b.user, b.name, env); } catch (e) { return fail(res, 400, e.message); }
      return send(res, 200, { people: rosterList(env) });
    }
    if (req.method === "POST" && p === "/api/speakers/remove") {
      const b = await readBody(req);
      if (!removeRosterUser(b.user, env)) return fail(res, 404, "名冊裡沒有這個帳號");
      return send(res, 200, { people: rosterList(env) });
    }
    if (req.method === "POST" && p === "/api/open") return send(res, 200, await openProject(await readBody(req)));
    // 從 YouTube 下載外語影片做雙語字幕（#56）：開始、看進度、停止
    if (req.method === "POST" && p === "/api/import") {
      const b = await readBody(req);
      const vid = youtubeId(b.url);
      if (!vid) return fail(res, 400, "這不是 YouTube 影片的網址");
      const want = String(b.lang || "");
      if (want && !LANG.test(want)) return fail(res, 400, "影片語言不對");
      if (!d.hasYtDlp()) return fail(res, 409, "這台電腦沒有 yt-dlp，沒辦法下載 YouTube 影片");
      for (const [k, v] of imports) if (v.finished && Date.now() - v.finished > 3600_000) imports.delete(k);
      const running = [...imports.values()].find((x) => x.vid === vid && x.status === "running");
      if (running) return send(res, 200, { import: running.key });
      const key = randomBytes(8).toString("hex");
      imports.set(key, { key, vid, status: "running", step: "info", progress: 0, title: "", started: Date.now() });
      runImport(key, vid, want).catch((e) => logError(`[studio] import error: ${String(e?.message || e).slice(0, 200)}`));
      return send(res, 200, { import: key });
    }
    const im = /^\/api\/import\/([0-9a-f]{16})(?:\/(cancel))?$/.exec(p);
    if (im) {
      const imp = imports.get(im[1]);
      if (!imp) return fail(res, 404, "找不到這次下載");
      if (req.method === "GET" && !im[2]) {
        const { abort, ...view } = imp;
        return send(res, 200, view);
      }
      if (req.method === "POST" && im[2] === "cancel") {
        if (!imp.abort) return fail(res, 409, "已經結束了");
        imp.abort();
        return send(res, 200, { cancelled: true });
      }
      return fail(res, 405, "method not allowed");
    }
    if (req.method === "POST" && p === "/api/preview") {
      const r = openPreview(await readBody(req));
      return r.status === 202 ? send(res, 202, r.body) : send(res, 200, r);
    }
    const pv = /^\/api\/preview\/([0-9a-f]{16})\/(video|thumbs|wave|silence)$/.exec(p);
    if (pv) {
      const [, id, what] = pv;
      if (req.method !== "GET") return fail(res, 405, "method not allowed");
      if (!previews.has(id)) return fail(res, 404, "請重新選一次影片");
      if (!fs.existsSync(previews.get(id).video)) return fail(res, 404, "原始影片不見了（被移動或刪除）");
      if (what === "video") return serveVideo(req, res, await previewVideoFile(id));
      const info = previews.get(id);
      if (what === "thumbs") return serveThumbs(req, res, info.video, info.duration_ms);
      // 粗剪前先找長時間的靜音（只解聲音、很快，不送雲端）
      if (what === "silence") {
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        const ranges = await d.detectSilence(info.video, { durationMs: info.duration_ms, signal: ac.signal });
        return send(res, 200, { items: rangesToSuggestions(ranges, "silence", { durationMs: info.duration_ms }) });
      }
      return serveWave(res, `preview:${id}`, info.video, info.duration_ms);
    }
    if (req.method === "GET" && p === "/api/corrections") return send(res, 200, await corrections(url.searchParams.get("refresh") === "1"));
    if (req.method === "POST" && p === "/api/corrections") {
      const b = await readBody(req);
      // 一次好幾組（AI 更正名字，#60）：只加成 hints，一樣讀回整份再寫回一次
      const r = Array.isArray(b.pairs) ? await d.addCorrections(b.pairs, { kind: "hints", env })
        : await d.addCorrection(b.wrong, b.right, { kind: b.kind === "fixed" ? "fixed" : "hints", env });
      correctionsCache = null;
      return send(res, 200, r);
    }

    if (p === "/api/youtube" || p.startsWith("/api/youtube/")) return youtubeRoute(req, res, p);

    // 直式短片（#54）：/shorts、/shorts/suggest、/shorts/<片段>/(export|reveal)
    const sm = /^\/api\/projects\/([0-9a-f]{16})\/shorts(?:\/(suggest)|\/([a-z0-9-]{1,40})\/(export|reveal))?$/.exec(p);
    if (sm) {
      const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : {};
      const found = load(sm[1]);
      if (!found) return fail(res, 404, "找不到這個專案");
      if (req.method !== "GET" && isPlain(found.project)) return fail(res, 409, "這支影片是「不要字幕」的，沒有字幕可以挑短片");
      return shortsRoute(req, res, sm[1], found.dir, found.project, sm[2] || sm[4] || "", sm[3] || "", body);
    }
    const m = /^\/api\/projects\/([0-9a-f]{16})(?:\/(video|thumbs|wave|burn|suggest|cancel|reveal|retry|reprocess|relayout|forget|clear|youtube|captions|recap|module|mindmap|drive|describe|handoff|names|speakers|translate|subtitle-file))?$/.exec(p);
    if (!m) return fail(res, 404, "not found");
    const [, id, action] = m;
    // 先收完內容再讀專案，存檔才是拿最新的版本比 rev（中間可能剛好燒完字幕）
    const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : {};
    const found = load(id);
    if (!found) return fail(res, 404, "找不到這個專案");
    const { dir, project } = found;

    if (req.method === "GET" && !action) return send(res, 200, publicView(id, dir, project));
    if (req.method === "GET" && action === "video") {
      const preview = path.join(dir, ".preview.mp4");
      // 瀏覽器播不了的格式：預覽檔不見了（移出清單時刪掉）就重做一份
      if (!fs.existsSync(preview) && fs.existsSync(project.video) && !BROWSER_PLAYABLE.has(path.extname(project.video).toLowerCase())) {
        if (!previewing.has(id)) previewing.set(id, d.remuxPreview(project.video, preview).finally(() => previewing.delete(id)));
        await previewing.get(id);
      }
      const file = fs.existsSync(preview) ? preview : project.video;
      if (!fs.existsSync(file)) return fail(res, 404, "原始影片不見了（被移動或刪除）");
      if (!BROWSER_PLAYABLE.has(path.extname(file).toLowerCase())) return fail(res, 415, "這個格式瀏覽器播不了");
      return serveVideo(req, res, file);
    }
    if (req.method === "GET" && (action === "thumbs" || action === "wave")) {
      if (!fs.existsSync(project.video)) return fail(res, 404, "原始影片不見了（被移動或刪除）");
      if (action === "thumbs") return serveThumbs(req, res, project.video, project.duration_ms || 0);
      return serveWave(res, `project:${id}`, project.video, project.duration_ms || 0);
    }
    if (req.method === "PUT" && !action) {
      const b = body;
      if (project.status !== "ready") return fail(res, 409, "還在處理中");
      if (jobs.get(id)?.kind === "clear") return fail(res, 409, "正在清掉這支的處理資料");
      if (b.rev !== project.rev) return fail(res, 409, "這個專案在別的分頁改過了，請重新整理");
      if (b.cues !== undefined) {
        // 外語影片（#56）：頁面沒帶到的譯文留著；翻譯中，頁面帶的是翻譯前的舊譯文時換成剛翻好的
        let cues = keepTranslations(validateCues(b.cues), project.cues);
        const tj = jobs.get(id);
        if (tj?.kind === "translate") {
          cues = cues.map((c) => {
            const k = `${c.start}\u0000${c.text}`;
            return tj.written.has(k) && c.tr === tj.before.get(k) ? { ...c, tr: tj.written.get(k) } : c;
          });
        }
        project.cues = cues;
      }
      if (b.lang_mode !== undefined) {
        if (!LANG_MODES.includes(b.lang_mode)) return fail(res, 400, "字幕語言的顯示方式不對");
        if (isForeign(project)) project.lang_mode = b.lang_mode;
      }
      if (b.description !== undefined) project.description = validateDescription(b.description);
      if (b.cuts !== undefined) project.cuts = checkedCuts(b.cuts, project.duration_ms);
      // 處理過的建議（套用或不要）從清單拿掉：只收目前還在的 id
      // 頁面拿的是舊一輪的建議（剛好在新結果出來時存檔）就不動清單
      if (b.suggestions !== undefined && project.suggestions && b.suggestionsCreated === project.suggestions.created) {
        if (!Array.isArray(b.suggestions)) return fail(res, 400, "建議格式不對");
        const keepIds = new Set(b.suggestions.map(String));
        project.suggestions.items = (project.suggestions.items || []).filter((x) => keepIds.has(x.id));
      }
      if (b.size !== undefined) {
        if (!Object.hasOwn(SUBTITLE_SIZES, b.size)) return fail(res, 400, "字級不對");
        project.size = b.size;
      }
      if (b.style !== undefined) {
        if (!SUBTITLE_STYLES.includes(b.style)) return fail(res, 400, "字幕樣式不對");
        project.subtitle_style = b.style;
      }
      project.rev += 1;
      save(dir, project);
      return send(res, 200, { rev: project.rev, updated: project.updated });
    }
    // 不要字幕的專案（#158）：沒有字幕可以處理、燒、翻或總結；只剪接與本機的靜音偵測照常
    if (req.method === "POST" && isPlain(project)
      && (PLAIN_BLOCKED.has(action) || (action === "burn" && body.subtitles !== false) || (action === "suggest" && body.ai !== false))) {
      return fail(res, 409, "這支影片是「不要字幕」的，沒有字幕可以做這件事");
    }
    if (req.method === "POST" && action === "burn") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const size = Object.hasOwn(SUBTITLE_SIZES, project.size) ? project.size : "medium";
      const subtitles = body.subtitles !== false;
      if (!subtitles && !project.cuts?.length) return fail(res, 400, "沒有剪輯，不用另外輸出剪接版");
      startJob(id, () => runBurn(id, dir, size, { subtitles }));
      return send(res, 200, { started: true });
    }
    if (req.method === "POST" && action === "youtube") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const ch = loadSettings(env).channels.find((x) => x.id === body.channel);
      if (!ch) return fail(res, 400, "請先選要上傳到哪個頻道");
      if (!ch.connected) return fail(res, 409, `「${ch.title}」的授權失效了，請到「設定」重新連結`);
      ytClient();
      const meta = videoMeta({ ...body, description: typeof body.description === "string" ? body.description : remapDescription(project.description || "", project.cuts || []) });
      // 不要字幕的專案（#158）：不管頁面或頻道預設怎麼選，都不燒、不掛 CC
      const subtitles = isPlain(project) ? "none" : SUBTITLE_MODES.includes(body.subtitles) ? body.subtitles : ch.defaults.subtitles;
      const playlistId = typeof body.playlistId === "string" && /^[\w-]{0,64}$/.test(body.playlistId) ? body.playlistId : "";
      // 燒在畫面上也預設掛 CC 字幕（#71）：觀眾通常要自己開 CC 才看得到，YouTube 卻能搜尋、翻譯，別人要引用內容也方便
      const alsoCc = subtitles === "burned" && body.alsoCc !== false;
      startJob(id, () => runUpload(id, dir, { channel: ch, meta, subtitles, alsoCc, playlistId, notify: body.notify !== false }));
      return send(res, 200, { started: true });
    }
    // 上傳後補掛 CC 字幕（#71）：燒在畫面上的、或當時字幕那一步沒成功的。用目前的字幕（上傳後改過的字也算），
    // 時間照上傳時的剪輯換算；上傳後改過剪輯就擋下來，免得字幕對不上 YouTube 上那支
    if (req.method === "POST" && action === "captions") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      const y = project.youtube || {};
      if (!y.video_id || !["done", "cancelled"].includes(y.status)) return fail(res, 409, "這支還沒上傳到 YouTube");
      if (!needsCc(y)) return fail(res, 409, "這支的 CC 字幕已經掛上了");
      const cuts = project.cuts || [];
      const uploadedCuts = y.cuts ?? (cuts.length ? null : "");   // #71 之前的紀錄沒記剪輯：只有現在也沒剪才確定對得上
      if (uploadedCuts !== cutsKey(cuts)) return fail(res, 409, "上傳之後改過剪輯，字幕時間會對不上 YouTube 上的影片。請把剪輯改回上傳時的樣子，或到 YouTube Studio 手動上傳字幕");
      const ch = loadSettings(env).channels.find((x) => x.id === y.channel);
      if (!ch) return fail(res, 409, `「${y.channel_title || "上傳的頻道"}」已經從設定移除，請到「設定」重新連結`);
      if (!ch.connected) return fail(res, 409, `「${ch.title}」的授權失效了，請到「設定」重新連結`);
      ytClient();
      const cues = (project.cues || []).filter((c) => c.text.trim());
      if (!cues.length) return fail(res, 409, "沒有字幕可以掛");
      const srt = toSrt(remapCues(cues, cuts, cuts.length ? undefined : 0));
      const ac = new AbortController();
      const job = { kind: "captions", step: "captions", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        await uploadCaption({ fetch: d.youtubeFetch, getToken: tokenGetter(ch.id), videoId: y.video_id, srt, language: y.language || ch.defaults.language, signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，字幕沒有掛上去");
        if (e.code === "reauth") return fail(res, 409, e.message);
        logError(`[studio] adding CC captions failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, 502, `CC 字幕沒有掛上去：${String(e?.message || e).slice(0, 200)}`);
      } finally {
        jobs.delete(id);
        job.finish();
      }
      const latest = readProject(dir);   // 等的時候可能有人在改字：只更新上傳紀錄
      latest.youtube = { ...latest.youtube, cc_added: new Date().toISOString(), warnings: (latest.youtube?.warnings || []).filter((w) => !w.startsWith(CC_FAILED)) };
      save(dir, latest);
      return send(res, 200, { youtube: latest.youtube });
    }
    if (req.method === "POST" && action === "suggest") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const ai = body.ai !== false;
      if (ai) {
        checkProofreader(project.proofreader || "claude", project.privacy);
        if (!proofreaderAvailable(project.proofreader || "claude")) return fail(res, 409, `${project.proofreader || "claude"} 沒有裝在這台電腦`);
      }
      startJob(id, () => runSuggest(id, dir, { ai }));
      return send(res, 200, { started: true });
    }
    // 只重新寫 YouTube 說明欄（#46）：依目前的字幕重寫簡介、章節與每章重點，也重新建議名稱和標籤；字幕不動。
    // 頁面等這個請求回來（約一分鐘），期間仍可以改字幕，可以按停止
    if (req.method === "POST" && action === "describe") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const cues = (project.cues || []).filter((c) => c.text.trim());
      if (!cues.length) return fail(res, 409, "沒有字幕，寫不出說明欄");
      const who = project.proofreader || "claude";
      checkProofreader(who, project.privacy);
      if (!proofreaderAvailable(who)) return fail(res, 409, `${who} 沒有裝在這台電腦`);
      const ac = new AbortController();
      const job = { kind: "describe", step: "describe", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        const r = await d.describe(cues, { proofreader: who, signal: ac.signal });
        if (!r.text.trim()) throw new Error("AI 沒有寫出說明欄");
        const latest = readProject(dir);   // 等的時候可能有人在改字：只更新說明欄與建議
        latest.description = validateDescription(r.text);
        latest.youtube_suggest = { ...r.suggest, created: new Date().toISOString() };
        save(dir, latest);
        return send(res, 200, { description: latest.description, youtube_suggest: latest.youtube_suggest, chapters: r.chapters.length });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，說明欄沒有變");
        logError(`[studio] describe failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, 502, `AI 沒寫成功：${String(e?.message || e).slice(0, 200)}`);
      } finally {
        jobs.delete(id);
        job.finish();
      }
    }
    // 會後總結（#80）：簡介＋分段章節、完整總結、短總結，由會議轉錄 App 產生（同一份提示詞），存進專案並寫 summary.md。
    // 等的時候可以改字幕、可以按停止；改過字幕之後頁面會提示可以重新產生
    if (req.method === "POST" && action === "recap") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const cues = recapCues(project);
      const paras = recapParagraphs(cues);
      if (!paras.length) return fail(res, 409, "沒有字幕，做不出會後總結");
      let rf;
      try { rf = d.recapFiles(); } catch (e) { return fail(res, 502, e.message); }   // 存不了檔就先不產生，免得白花
      const ac = new AbortController();
      const job = { kind: "recap", step: "recap", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        const recap = await d.meetingRecap(paras, { signal: ac.signal });
        const latest = readProject(dir);   // 等的時候可能有人在改字：只更新總結
        latest.recap = { ...recap, key: recapKey(paras), created: new Date().toISOString() };
        fs.writeFileSync(path.join(dir, "summary.md"), rf.summaryMarkdown({ header: rf.headerLines({ name: latest.name }), intro: recap.intro, chapters: recap.chapters, full: recap.full, short: recap.short, transcript: recapTranscript(cues) }));
        markDrivePending(latest);
        save(dir, latest);
        if (!d.driveDisabled()) queueDrive(id, dir);
        return send(res, 200, { recap: { ...latest.recap, stale: false }, drive: driveView(id, latest.drive) });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，會後總結沒有變");
        logError(`[studio] recap failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, 502, String(e?.message || e).slice(0, 300));
      } finally {
        jobs.delete(id);
        job.finish();
      }
    }
    // 延伸模組（#88）：例如「讓這場會議發芽」「視角回饋」，由會議轉錄 App 產生。
    // 和會後總結一樣送剪輯後的段落、可以停止；同一個模組＋選項再產生就蓋過去
    if (req.method === "POST" && action === "module") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      let mod, options;
      try {   // 清單裡找不到就再問一次：App 可能剛加了模組
        mod = (await moduleList()).find((m) => m.id === body?.module) || (await moduleList({ fresh: true })).find((m) => m.id === body?.module);
      } catch (e) {
        return fail(res, 502, String(e?.message || e).slice(0, 300));
      }
      if (!mod) return fail(res, 400, "會議轉錄 App 沒有這個模組");
      try {
        options = resolveModuleOptions(mod, body?.options && typeof body.options === "object" ? body.options : {});
      } catch (e) {
        return fail(res, 400, String(e?.message || e).slice(0, 300));
      }
      let rf = null;
      if (mod.output !== "mindmap") { try { rf = d.recapFiles(); } catch (e) { return fail(res, 502, e.message); } }   // 存不了檔就先不產生
      const cues = recapCues(project);
      const paras = recapParagraphs(cues);
      if (!paras.length) return fail(res, 409, "沒有字幕，做不出來");
      if (jobs.has(id)) return fail(res, 409, "已經在處理");   // 問清單的時候可能有別的工作開始了
      const ac = new AbortController();
      const job = { kind: "module", step: "module", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        const out = await d.meetingModule(paras, mod, options, { signal: ac.signal });
        const latest = readProject(dir);   // 等的時候可能有人在改字：只更新這份結果
        const key = moduleKey(mod, options), label = moduleLabel(mod, options);
        // 檔名與內容照 App 的共用存檔格式（RecapFiles.extraFiles）：撞到別份結果、會後總結、心智圖或專案自己的檔就加 -2
        const others = Object.entries(latest.modules || {}).filter(([k]) => k !== key).flatMap(([, m]) => [m.file, ...(m.extra_files || [])]).filter(Boolean);
        const isMap = mod.output === "mindmap";
        let file = "mindmap.md", content = withNewline(out.markdown);   // 心智圖照 App 的檔名，內容是元件轉好的原樣
        if (!isMap) {
          const [x] = rf.extraFiles([{ label, markdown: out.markdown }], { header: rf.headerLines({ name: latest.name }), taken: ["summary.md", "mindmap.md", "mindmap.opml", "mindmap.svg", "project.json", "timing.json", "asr.json", ...others] });
          [file, content] = [x.file, x.markdown];
        }
        const extras = isMap && out.opml ? ["mindmap.opml"] : [];
        const old = latest.modules?.[key]?.file;
        fs.writeFileSync(path.join(dir, file), content);
        if (isMap) { if (out.opml) fs.writeFileSync(path.join(dir, "mindmap.opml"), out.opml); else fs.rmSync(path.join(dir, "mindmap.opml"), { force: true }); }
        if (old && old.toLowerCase() !== file.toLowerCase() && !others.some((f) => f.toLowerCase() === old.toLowerCase())) fs.rmSync(path.join(dir, old), { force: true });
        const mapFields = isMap ? { output: "mindmap", mindmap: out.mindmap, mermaid: out.mermaid, opml: out.opml, extra_files: extras } : {};
        latest.modules = { ...(latest.modules || {}), [key]: { module: mod.id, title: mod.title, label, options, markdown: out.markdown, file, ...mapFields, paras_key: recapKey(paras), created: new Date().toISOString(), ...(out.via ? { via: out.via } : {}), ...(out.local_error ? { local_error: out.local_error } : {}) } };
        markDrivePending(latest);
        save(dir, latest);
        if (!d.driveDisabled()) queueDrive(id, dir);
        return send(res, 200, { module: { key, ...latest.modules[key], stale: false }, drive: driveView(id, latest.drive) });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，結果沒有變");
        logError(`[studio] module ${mod.id} failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, e?.status === 503 ? 503 : 502, e?.status === 503 ? "會議轉錄 App 正在產生另一份，等一下再按一次。" : String(e?.message || e).slice(0, 300));
      } finally {
        jobs.delete(id);
        job.finish();
      }
    }
    // AI 更正名字（#60）：使用者用一句話說哪些名字寫錯，AI 讀目前的字幕回傳「錯 → 對」的組合。
    // 只回建議、不改專案；頁面讓使用者勾選後才套用，再照常自動存檔。和說明欄一樣可以按停止
    if (req.method === "POST" && action === "names") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (!instruction) return fail(res, 400, "請先寫哪些名字或地名寫錯了");
      if ([...instruction].length > 500) return fail(res, 400, "說明太長了，請在 500 字以內");
      const cues = (project.cues || []).filter((c) => c.text.trim());
      if (!cues.length) return fail(res, 409, "沒有字幕，沒有可以改的地方");
      const who = project.proofreader || "claude";
      checkProofreader(who, project.privacy);
      if (!proofreaderAvailable(who)) return fail(res, 409, `${who} 沒有裝在這台電腦`);
      const ac = new AbortController();
      const job = { kind: "names", step: "names", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      try {
        const r = await d.nameFixes(cues, instruction, { proofreader: who, signal: ac.signal });
        return send(res, 200, { pairs: r.pairs, dropped: r.dropped || 0 });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，字幕沒有變");
        // 只記錯誤種類；說明和字幕可能有人名，不進 log
        logError(`[studio] name fix failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, 502, `AI 沒找成功：${String(e?.message || e).slice(0, 200)}`);
      } finally {
        jobs.delete(id);
        job.finish();
      }
    }
    // 講者（#129）：GET 看這支用過的分軌、或在下載資料夾找對得上的；POST 用分軌標講者（改了名字也是重標）
    if (req.method === "GET" && action === "speakers") {
      const used = project.speakers?.zip || project.tracks?.zip || "";
      let craig = null;
      if (used && fs.existsSync(used)) { try { craig = craigView(describeCraig(used, env)); } catch { /* 讀不了就重找 */ } }
      craig ||= craigFor(sourceVideo(project), project.duration_ms || 0);
      if (craig && project.speakers?.tracks) {
        const now = new Map(project.speakers.tracks.map((t) => [t.user, t.name]));
        craig.tracks = craig.tracks.map((t) => ({ ...t, name: now.get(t.user) || t.name }));
      }
      return send(res, 200, { craig });
    }
    if (req.method === "POST" && action === "speakers") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      if (body.rev !== project.rev) return fail(res, 409, "這個專案在別的分頁改過了，請重新整理");
      if (!(project.cues || []).some((c) => c.text.trim())) return fail(res, 409, "沒有字幕可以標");
      let zip;
      try { zip = resolveZip(body.zip); describeCraig(zip, env); } catch (e) { return fail(res, 400, e.message); }
      const ac = new AbortController();
      const job = { kind: "speakers", step: "speakers", progress: 0, started: Date.now(), abort: () => ac.abort() };
      job.done = new Promise((r) => { job.finish = r; });
      jobs.set(id, job);
      const work = fs.mkdtempSync(path.join(dir, ".work-"));
      try {
        const given = namesMap(body.names);
        const names = namesMap(loadNames(env), given);
        const { craig, videoEnv, trackEnvs, align } = await loadCraig(zip, project.video, work, { envelope: d.envelopeOf, signal: ac.signal });
        const shown = shownNames(craig.tracks, names);
        const l = labelWith(project.cues, trackEnvs, align, shown, names);
        const missing = missingVoices(videoEnv, trackEnvs, align).map((m, k) => (m.missing ? shown[k] : null)).filter(Boolean);
        // 算音量的這段時間頁面可能存過：重讀，rev 沒變才寫
        const latest = readProject(dir);
        if (latest.rev !== project.rev || latest.status !== "ready") return fail(res, 409, "標講者的時候字幕改過了，請再按一次");
        // 分軌記進專案：之後「重新處理」會用它補回沒錄到的聲音、重新標講者
        const users = new Set(craig.tracks.map((t) => t.user));
        const tracks = { zip, fill: true, names: Object.fromEntries(Object.entries(names).filter(([u]) => users.has(u))) };
        Object.assign(latest, { cues: l.cues, tracks, speakers: speakersRecord(zip, craig, shown, align, { counts: l.counts, missing }), rev: (latest.rev || 0) + 1 });
        save(dir, latest);
        rememberNames(Object.fromEntries(craig.tracks.filter((t) => given[t.user]).map((t) => [t.user, given[t.user]])), env);
        noteSeen(craig.tracks.map((t) => t.user), craig.start, env);
        return send(res, 200, { rev: latest.rev, counts: l.counts, unlabeled: l.unlabeled, missing });
      } catch (e) {
        if (ac.signal.aborted) return fail(res, 409, "已經停止，字幕沒有變");
        logError(`[studio] speaker labels failed: ${String(e?.message || e).slice(0, 200)}`);
        return fail(res, /對不起來|info\.txt|音檔/u.test(String(e?.message)) ? 409 : 502, String(e?.message || e).slice(0, 200));
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
        jobs.delete(id);
        job.finish();
      }
    }
    // 翻譯字幕（#56）：all 為 true 全部重翻（取代目前的譯文），否則只翻還沒有譯文的句子
    if (req.method === "POST" && action === "translate") {
      if (jobs.has(id)) return fail(res, 409, "已經在處理");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      if (!isForeign(project)) return fail(res, 409, "這支是中文影片，不用翻譯");
      const who = project.proofreader || "claude";
      checkProofreader(who, project.privacy);
      if (!proofreaderAvailable(who)) return fail(res, 409, `${who} 沒有裝在這台電腦`);
      startJob(id, () => runTranslate(id, dir, { all: body.all === true }));
      return send(res, 200, { started: true });
    }
    // 匯出雙語 ASS 字幕檔（#56）：圓角底框、中文在上原文在下，給 IINA、VLC 這類播放器外掛字幕用；時間是剪輯後的時間
    if (req.method === "POST" && action === "subtitle-file") {
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      if (!isForeign(project)) return fail(res, 409, "這支不是外語影片");
      const cuts = project.cuts || [];
      const cues = remapCues(project.cues.filter((c) => c.text.trim()), cuts, cuts.length ? undefined : 0);
      const size = Object.hasOwn(SUBTITLE_SIZES, project.size) ? project.size : "medium";
      const file = d.writeBurnSubtitles({ dir, cues, video: project.video, size, style: "box", mode: "both", measure: d.measureAdvances, dims: d.videoSize(project.video), name: `${project.name}-雙語` });
      fs.chmodSync(file, 0o600);
      d.reveal(file);
      return send(res, 200, { file: path.basename(file) });
    }
    // 交給 coding agent 寫 wiki（#49）：把字幕與說明欄整理成交接單，放 iCloud「<icloud_inbox>/to-wiki」（有設定才有）。
    // 交過一次再交要頁面先確認（force）；說明欄還在重寫時先不交，免得交出舊的
    if (req.method === "POST" && action === "handoff") {
      if (!handoffEnabled()) return fail(res, 409, "沒有設定 icloud_inbox，不能交接");
      if (project.status !== "ready") return fail(res, 409, "字幕還沒好");
      if (jobs.get(id)?.kind === "describe") return fail(res, 409, "說明欄還在重新寫，寫好再交");
      if (jobs.get(id)?.kind === "clear") return fail(res, 409, "正在清掉這支的處理資料");
      if (project.handoff && body.force !== true) return send(res, 409, { error: "這支已經交過了", handoff: project.handoff });
      let r;
      try {
        r = handoffFromStudio(project, { dir, icloud: d.icloudRoot() });
      } catch (e) {
        return fail(res, 409, String(e?.message || e).slice(0, 200));
      }
      project.handoff = { name: r.name, at: new Date().toISOString() };
      save(dir, project);
      return send(res, 200, { handoff: project.handoff, folder: `iCloud Drive/${handoffSubdir()}/${r.name}` });
    }
    if (req.method === "POST" && action === "cancel") {
      const job = jobs.get(id);
      if (!job?.abort) return fail(res, 409, "沒有可以取消的工作");
      job.abort();
      return send(res, 200, { cancelled: true });
    }
    // 重試（失敗的）和重新處理（做好的，會取代目前的字幕）走同一條路；有 asr.json 就不再送 Soniox
    if (req.method === "POST" && (action === "retry" || action === "reprocess")) {
      // 停止過的（#67）和失敗的一樣可以按「重新開始」
      const ok = action === "retry" ? ["failed", "cancelled"].includes(project.status) : ["ready", "failed", "cancelled"].includes(project.status);
      if (jobs.has(id) || !ok) return fail(res, 409, action === "retry" ? "現在不能重試" : "現在不能重新處理");
      // 用作者字幕或自己的字幕檔（#56、#148）的專案不辨識，不用 Soniox 金鑰
      d.preflight({ privacy: project.privacy, proofreader: project.proofreader, engine: project.source?.captions_file ? "none" : "soniox", burn: false });
      project.status = "processing";
      project.error = "";
      delete project.stopped_at;
      save(dir, project);
      startJob(id, () => prepareAndTranslate(id, dir));
      return send(res, 200, { started: true });
    }
    // 重新排字幕（#33）：只拿 timing.json（校對後每個字的時間）重新斷句；不辨識、不跑 AI、不花錢。
    // 會取代目前的字幕和手動修改，頁面會先確認；「AI 改過」的標記照原本的修正清單再標一次。
    if (req.method === "POST" && action === "relayout") {
      if (jobs.has(id) || project.status !== "ready") return fail(res, 409, "現在不能重新排字幕");
      if (isForeign(project)) return fail(res, 409, "外語影片不能重新排字幕：句子重新切過，譯文會對不上");
      let timing;
      try { timing = JSON.parse(fs.readFileSync(path.join(dir, "timing.json"), "utf8")); } catch { return fail(res, 409, "這支影片沒有每個字的時間，請用「重新處理」"); }
      const applied = [...new Map((project.cues || []).flatMap((c) => c.ai || []).map((e) => [`${e.find}\u0000${e.replace}`, e])).values()];
      const cues = markAiCues(buildCues(timing.map(([c, s, e]) => ({ c, s, e, spk: null })), cueOptsFor(project.lang)), applied);
      if (!cues.length) return fail(res, 409, "排不出字幕");
      Object.assign(project, { cues, rev: (project.rev || 0) + 1 });
      save(dir, project);
      return send(res, 200, { cues: cues.length, rev: project.rev });
    }
    // 心智圖改過之後存檔（#111）：頁面用會議 App 的心智圖元件（MindMap）編輯，把新的資料與元件轉好的
    // markdown／opml／mermaid／svg 一起送來；這裡檢查後寫回 mindmap.md、.opml、.svg，再排 Drive。
    // 剛產生時頁面也會送一次，補上 mindmap.svg（圖是頁面畫的，主機不產）
    if (req.method === "POST" && action === "mindmap") {
      if (jobs.has(id)) return fail(res, 409, "正在產生，好了再改");   // 不和重新產生搶同一份檔
      const key = typeof body?.key === "string" ? body.key : "";
      const latest = readProject(dir);
      const m = Object.hasOwn(latest.modules || {}, key) ? latest.modules[key] : null;
      if (!m || m.output !== "mindmap") return fail(res, 404, "找不到這份心智圖");
      let clean;
      try { clean = cleanMindmapReply({ mindmap: body.mindmap, mermaid: body.mermaid, opml: body.opml }); } catch (e) { return fail(res, 400, e.message); }
      const markdown = typeof body.markdown === "string" ? body.markdown.trim().slice(0, 200_000) : "";
      const svg = typeof body.svg === "string" ? body.svg.trim() : "";
      if (!markdown) return fail(res, 400, "心智圖的文字版是空的");
      // 存成檔案、也會進 Drive：只收白名單上的單純 SVG（safeMindmapSvg）
      if (svg && !safeMindmapSvg(svg)) return fail(res, 400, "心智圖的圖片格式不對");
      fs.writeFileSync(path.join(dir, "mindmap.md"), withNewline(markdown));
      if (clean.opml) fs.writeFileSync(path.join(dir, "mindmap.opml"), clean.opml);
      if (svg) fs.writeFileSync(path.join(dir, "mindmap.svg"), `${svg}\n`);
      const extra = [...new Set([...(m.extra_files || []).filter((f) => f !== "mindmap.svg" || svg || fs.existsSync(path.join(dir, f))), ...(clean.opml ? ["mindmap.opml"] : []), ...(svg ? ["mindmap.svg"] : [])])];
      latest.modules = { ...latest.modules, [key]: { ...m, file: "mindmap.md", markdown, mindmap: clean.mindmap, mermaid: clean.mermaid, opml: clean.opml || m.opml, extra_files: extra, ...(body.edited ? { edited: true, edited_at: new Date().toISOString() } : {}) } };
      markDrivePending(latest);
      save(dir, latest);
      if (!d.driveDisabled()) queueDrive(id, dir);
      return send(res, 200, { module: { key, ...latest.modules[key] }, drive: driveView(id, latest.drive) });
    }
    // 再存一次到 Drive（#100）：上次沒存成功，或之前產生的還沒存過
    if (req.method === "POST" && action === "drive") {
      if (jobs.has(id)) return fail(res, 409, "還在處理中，好了會自動存");
      if (d.driveDisabled()) return fail(res, 409, "已設定成不存到 Drive");
      if (!project.recap && !Object.keys(project.modules || {}).length) return fail(res, 409, "還沒有會後總結或延伸的結果可以存");
      const latest = readProject(dir);
      markDrivePending(latest);
      save(dir, latest);
      const drive = await queueDrive(id, dir);
      if (drive?.error && drive.failed && (!drive.saved || drive.failed > drive.saved)) return fail(res, 502, drive.error);
      return send(res, 200, { drive: driveView(id, drive) });
    }
    if (req.method === "POST" && action === "reveal") {
      const b = body;
      const target = b.what === "burned" && project.burn?.output ? path.join(dir, project.burn.output)
        : b.what === "summary" ? path.join(dir, "summary.md")
        : b.what === "drive" && project.drive?.folder && project.drive.root ? path.join(project.drive.root, project.drive.folder)
        : b.what === "module" && typeof b.key === "string" && Object.hasOwn(project.modules || {}, b.key) && project.modules[b.key].file ? path.join(dir, project.modules[b.key].file)
        : path.join(dir, "subtitles.srt");
      d.reveal(fs.existsSync(target) ? target : dir);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "forget") {
      if (jobs.has(id)) return fail(res, 409, "還在處理中");
      fs.rmSync(path.join(dir, ".preview.mp4"), { force: true });
      forgetRecent(dir, env);
      projects.delete(id);
      return send(res, 200, { ok: true });
    }
    // 清掉處理資料（#39）：輸出的影片預設先搬到原片旁邊，整個「名稱-字幕」資料夾丟垃圾桶（救得回來）；原片不動
    if (req.method === "POST" && action === "clear") {
      if (jobs.has(id)) return fail(res, 409, "還在處理中，處理完才能清");
      const trashOriginal = body.trashOriginal === true;
      if (trashOriginal && !uploadedOwnVideo(project)) return fail(res, 409, "這支還沒上傳到 YouTube，原始錄影不能一起丟");
      // 清理中占住這個專案，別的動作（輸出、上傳、存檔觸發的工作）不會同時碰資料夾
      jobs.set(id, { kind: "clear", step: "clear", progress: 0, started: Date.now(), abort() {}, done: Promise.resolve() });
      const moved = [];
      let videoTrashed = false, originalTrashed = false, originalFailed = false;
      try {
        if (body.keepOutputs !== false) {
          const home = path.dirname(sourceVideo(project));   // 補音版放在專案資料夾裡（#129），輸出檔搬到原檔旁邊
          for (const { file } of Object.values(outputsOf(dir, project))) {
            const target = freeName(home, file);
            moveFile(path.join(dir, file), target);
            moved.push([path.join(dir, file), target]);
          }
        }
        await d.trash(dir);
        // 從 YouTube 下載的影片（#56）：勾了就連原片一起丟垃圾桶；只動下載資料夾裡的檔
        if (body.trashVideo === true && project.source?.downloaded && fs.existsSync(project.video)
          && path.dirname(fs.realpathSync(project.video)) === realDir(d.downloadDir())) {
          try { await d.trash(project.video); videoTrashed = true; } catch (e) { logError(`[studio] could not trash the downloaded video: ${String(e?.message || e).slice(0, 200)}`); }
        }
        // 已經上傳到 YouTube 的原始錄影（#75）：資料夾已經清了，原片丟不掉只提醒，不算整個失敗
        if (trashOriginal && fs.existsSync(sourceVideo(project))) {
          try { await d.trash(sourceVideo(project)); originalTrashed = true; } catch (e) {
            originalFailed = true;
            logError(`[studio] could not trash the original recording: ${String(e?.message || e).slice(0, 200)}`);
          }
        }
      } catch (e) {
        // 沒清成：搬出去的影片搬回資料夾，專案維持原樣
        for (const [from, to] of moved.reverse()) { try { moveFile(to, from); } catch { /* 搬不回去就留在原片旁邊 */ } }
        throw e;
      } finally {
        jobs.delete(id);
      }
      forgetRecent(dir, env);
      projects.delete(id);
      return send(res, 200, { trashed: path.basename(dir), moved: moved.map(([, to]) => path.basename(to)), ...(videoTrashed ? { video_trashed: true } : {}),
        ...(originalTrashed ? { original_trashed: true } : {}), ...(originalFailed ? { original_failed: true } : {}) });
    }
    return fail(res, 405, "method not allowed");
  }

  // 設定頁的 YouTube：OAuth 用戶端、連結頻道、各頻道的預設值（#40）
  async function youtubeRoute(req, res, p) {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.method === "GET" && p === "/api/youtube") return send(res, 200, ytView());
    if (req.method === "POST" && p === "/api/youtube/client") {
      const c = parseClientOrFail(body.json);
      const s = loadSettings(env);
      // 換了另一個用戶端：舊的頻道授權綁在舊用戶端上，全部要重新連結
      if (s.client && s.client.client_id !== c.client_id) {
        for (const ch of s.channels) { d.secrets.delete(secretAccount.channel(ch.id)); ch.connected = false; }
        ytTokens.clear();
      }
      d.secrets.set(secretAccount.client, c.client_secret);
      s.client = { client_id: c.client_id, project_id: c.project_id };
      saveSettings(s, env);
      return send(res, 200, ytView());
    }
    // 完整的設定教學（repo 裡的 docs/youtube-setup.md，用預設的程式打開）
    if (req.method === "POST" && p === "/api/youtube/guide") {
      d.openUrl(path.join(TOOL_ROOT, "docs", "youtube-setup.md"));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/youtube/client/remove") {
      if ([...jobs.values()].some((j) => j.kind === "upload")) return fail(res, 409, "還有影片在上傳");
      const s = loadSettings(env);
      for (const ch of s.channels) d.secrets.delete(secretAccount.channel(ch.id));
      d.secrets.delete(secretAccount.client);
      ytTokens.clear();
      saveSettings({ client: null, channels: [], default_channel: "" }, env);
      return send(res, 200, ytView());
    }
    if (req.method === "POST" && p === "/api/youtube/connect") {
      const client = ytClient();
      for (const [k, v] of oauthPending) if (Date.now() - v.at > 600_000) oauthPending.delete(k);
      const state = randomBytes(16).toString("hex");
      const { verifier, challenge } = pkce();
      oauthPending.set(state, { verifier, at: Date.now() });
      const url = authUrl({ clientId: client.client_id, redirectUri: redirectUri(), state, challenge });
      d.openUrl(url);
      return send(res, 200, { url });
    }
    const m = /^\/api\/youtube\/channels\/([\w-]{1,64})(?:\/(playlists|remove|default))?$/.exec(p);
    if (!m) return fail(res, 404, "not found");
    const [, cid, what] = m;
    const s = loadSettings(env);
    const ch = s.channels.find((x) => x.id === cid);
    if (!ch) return fail(res, 404, "找不到這個頻道");
    if (req.method === "GET" && what === "playlists") return send(res, 200, { items: await myPlaylists({ fetch: d.youtubeFetch, getToken: tokenGetter(cid) }) });
    if (req.method === "POST" && what === "default") {
      s.default_channel = cid;
      saveSettings(s, env);
      return send(res, 200, ytView());
    }
    if (req.method === "POST" && what === "remove") {
      if ([...jobs.values()].some((j) => j.kind === "upload")) return fail(res, 409, "還有影片在上傳");
      const token = d.secrets.get(secretAccount.channel(cid));
      if (token) await revoke({ fetch: d.youtubeFetch, token });
      d.secrets.delete(secretAccount.channel(cid));
      ytTokens.delete(cid);
      s.channels = s.channels.filter((x) => x.id !== cid);
      if (s.default_channel === cid) s.default_channel = s.channels[0]?.id || "";
      saveSettings(s, env);
      return send(res, 200, ytView());
    }
    if (req.method === "POST" && !what) {
      ch.defaults = checkDefaults({ ...ch.defaults, ...(body.defaults || {}) });
      saveSettings(s, env);
      return send(res, 200, ytView());
    }
    return fail(res, 405, "method not allowed");
  }
  const parseClientOrFail = (text) => {
    try { return parseClient(text); } catch (e) { throw Object.assign(e, { status: 400 }); }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) fail(res, e?.status || 400, String(e?.message || e).slice(0, 300));
      else res.destroy();
    });
  });

  return {
    server, token, jobs,
    listen(p = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => { port = server.address().port; tidyRecent(); resolve(port); });
      });
    },
    close: () => new Promise((resolve) => server.close(() => {
      if (previewTmp) fs.rmSync(previewTmp, { recursive: true, force: true });
      resolve();
    })),
  };
}

// 不用辨識的字幕：YouTube 作者字幕（#56）照原本的 VTT 讀法；使用者自己的字幕檔（#148）照 lib/subtitle-file.mjs 的規則
function captionCues(p, file) {
  const raw = fs.readFileSync(file, "utf8");
  return p.source?.captions === "file" ? parseSubtitleText(raw, path.extname(file).toLowerCase()) : parseVtt(raw);
}

// macOS 原生選檔窗；按取消回傳空字串
async function pickFile() {
  return new Promise((resolve) => {
    const script = ['activate', 'set f to choose file with prompt "選擇要上字幕的影片" of type {"public.movie"} default location (path to movies folder)', "POSIX path of f"];
    const p = spawn("osascript", script.flatMap((s) => ["-e", s]), { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (x) => { out += x; });
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });
}

// 使用者自己的字幕檔（#148）：of type 寫副檔名，SRT／VTT 在 macOS 沒有固定的 UTI
async function pickSubtitles() {
  return new Promise((resolve) => {
    const script = ['activate', 'set f to choose file with prompt "選擇字幕檔（SRT 或 VTT）" of type {"srt", "vtt"} default location (path to movies folder)', "POSIX path of f"];
    const p = spawn("osascript", script.flatMap((s) => ["-e", s]), { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (x) => { out += x; });
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });
}

// Discord 分軌（#129）：讓使用者自己選 Craig 的 zip
async function pickZip() {
  return new Promise((resolve) => {
    const script = ['activate', 'set f to choose file with prompt "選擇 Discord 分軌（Craig 下載的 zip）" of type {"public.zip-archive"} default location (path to downloads folder)', "POSIX path of f"];
    const p = spawn("osascript", script.flatMap((s) => ["-e", s]), { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (x) => { out += x; });
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });
}

function reveal(file) {
  spawn("open", ["-R", file], { stdio: "ignore", detached: true }).unref();
}

// 丟到垃圾桶（macOS 內建的 trash，Finder 裡救得回來）
function trash(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("/usr/bin/trash", [file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (x) => { err = (err + x).slice(-500); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`沒辦法丟到垃圾桶（${redactPaths(err.trim()) || code}）`))));
  });
}

// 同名的檔案已經在了就加「 (2)」，不覆蓋
export function freeName(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 1; ; i++) {
    const f = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!fs.existsSync(f)) return f;
  }
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.rmSync(from);
  }
}

// 背景啟動（studio-ctl.mjs）和網頁上的關閉都靠這個檔找到正在跑的 Studio
function writePidFile(port) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(path.join(dir, "studio.pid"), `${JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() })}\n`);
}

function removePidFile() {
  const file = path.join(stateDir(), "studio.pid");
  try {
    if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* 沒有或不是自己的就不動 */ }
}

async function main() {
  const args = process.argv.slice(2).filter((x) => x !== "--");
  const port = Number(process.env.CYCLONE_STUDIO_PORT || 8766);
  const url = `http://127.0.0.1:${port}/`;
  // 停止：先中止燒錄、等工作把暫存刪掉（最多 3 秒；辨識中的沒辦法中止，暫存下次啟動時清）
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const pending = [...studio.jobs.values()].map((job) => { job.abort?.(); return job.done; }).filter(Boolean);
    Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 3000))]).then(() => { removePidFile(); process.exit(0); });
    studio.close();
  };
  const studio = createStudio({ onShutdown: () => { console.error("[studio] closed from the page"); stop(); } });
  try {
    await studio.listen(port);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    const r = await fetch(`${url}healthz`).then((x) => x.json()).catch(() => null);
    if (r?.app !== "subtitle-studio") { console.error(`[studio] port ${port} is used by another program; set CYCLONE_STUDIO_PORT`); process.exit(1); }
    console.error(`[studio] already running at ${url}`);
    if (!args.includes("--no-open")) spawn("open", [url], { stdio: "ignore" });
    return;
  }
  writePidFile(port);
  console.error(`[studio] Subtitle Studio is running at ${url} (Ctrl+C or the page's close button to stop)`);
  if (!args.includes("--no-open")) spawn("open", [url], { stdio: "ignore" });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch((e) => { logError(`[studio] ${e.message || e}`); process.exit(1); });
