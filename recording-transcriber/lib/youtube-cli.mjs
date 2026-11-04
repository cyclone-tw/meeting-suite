// youtube-upload 指令的核心（recording-transcriber#159）：不開工作室，直接把一支做好的影片傳到 YouTube。
// 共用工作室的頻道設定（state 目錄的 youtube.json）與鑰匙圈裡的授權，不另存任何金鑰；不改設定檔。
// 預設私人、不通知訂閱者；要公開一定要明確傳 --privacy public。不帶字幕（要 CC 字幕請用工作室）。
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, PRIVACY, addToPlaylist, uploadVideo, videoMeta } from "./youtube.mjs";
import { VIDEO_EXTENSIONS } from "./studio-project.mjs";
import { accessTokenGetter, loadClient, loadSettings } from "./youtube-settings.mjs";

export class UsageError extends Error {}

const VALUE = new Set(["--title", "--desc", "--desc-file", "--channel", "--playlist", "--privacy", "--tags", "--category", "--language"]);
const FLAG = new Set(["--kids", "--notify", "--json", "--channels"]);
const DESC_MAX = 64 * 1024;

export const USAGE = `用法：pnpm run youtube-upload <影片> --title <標題> [選項]
  --desc <文字> | --desc-file <檔案>   說明欄（二選一，預設空白）
  --privacy private|unlisted|public    預設 private；要公開一定要明確寫 public
  --channel <id 或名稱>                預設用工作室設定裡的預設頻道
  --playlist <播放清單 id>             傳完加進這個播放清單
  --tags a,b  --category <id>  --language zh-TW  --kids  --notify  --json
  --channels                           列出已連結的頻道後結束
頻道與授權沿用字幕工作室「設定」裡連結的；不帶字幕（要 CC 字幕請用工作室）。`;

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--channels") return { channels: true };
  const o = { privacy: "private", notify: false, kids: undefined, json: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { files.push(a); continue; }
    if (FLAG.has(a)) { if (a === "--channels") throw new UsageError("--channels 要單獨用"); o[a.slice(2)] = true; continue; }
    if (!VALUE.has(a)) throw new UsageError(`不認得的選項：${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} 需要一個值`);
    o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  if (files.length > 1) throw new UsageError("一次只能傳一支影片");
  if (!files.length) throw new UsageError("請指定要上傳的影片");
  if (!PRIVACY.includes(o.privacy)) throw new UsageError("--privacy 只能是 private、unlisted 或 public");
  if (o.desc !== undefined && o.descFile !== undefined) throw new UsageError("--desc 和 --desc-file 不能同時用");
  if (o.category !== undefined && !Object.hasOwn(CATEGORIES, o.category)) throw new UsageError(`--category 不認得這個分類（可用：${Object.keys(CATEGORIES).join("、")}）`);
  if (!String(o.title || "").trim()) throw new UsageError("請用 --title 給標題");
  return { ...o, video: files[0] };
}

function resolveVideo(value) {
  const raw = path.resolve(String(value));
  if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) throw new Error("找不到這支影片");
  const video = fs.realpathSync(raw);
  if (!VIDEO_EXTENSIONS.has(path.extname(video).toLowerCase())) throw new Error("不支援這種檔案（mp4、mov、m4v、mkv、webm、avi）");
  return video;
}

function readDescription(o) {
  if (o.desc !== undefined) return o.desc;
  if (o.descFile === undefined) return "";
  let st;
  try { st = fs.statSync(o.descFile); } catch { throw new Error("找不到說明欄檔"); }
  if (!st.isFile() || st.size > DESC_MAX) throw new Error("說明欄檔不是檔案，或超過 64 KB");
  return fs.readFileSync(o.descFile, "utf8");
}

function pickChannel(settings, want) {
  if (!settings.channels.length) throw new Error("還沒連結 YouTube 頻道：請先在字幕工作室的「設定」連結");
  const ch = want ? settings.channels.find((c) => c.id === want || c.title === want) : settings.channels.find((c) => c.id === settings.default_channel);
  if (!ch) throw new Error(`找不到頻道「${want}」；用 --channels 看有哪些`);
  if (!ch.connected) throw new Error(`「${ch.title}」的授權失效了，請到字幕工作室的「設定」重新連結`);
  return ch;
}

export function channelsText(env = process.env) {
  const s = loadSettings(env);
  if (!s.channels.length) return "還沒連結任何頻道：請先在字幕工作室的「設定」連結。";
  return s.channels.map((c) => `${c.id}\t${c.title}${c.id === s.default_channel ? "\t（預設）" : ""}${c.connected ? "" : "\t（授權失效）"}`).join("\n");
}

// opts 是 parseArgs 的結果；deps 讓測試換掉網路、鑰匙圈與輸出。回傳 { id, url, studio_url, channel, privacy }
export async function runUpload(o, { env = process.env, fetch, secrets, out = () => {}, err = () => {}, signal } = {}) {
  // 先把所有不用連網的檢查做完，任何一個不對都還沒碰 YouTube
  const video = resolveVideo(o.video);
  const description = readDescription(o);
  const settings = loadSettings(env);
  const client = loadClient({ settings, secrets });
  const ch = pickChannel(settings, o.channel);
  const d = ch.defaults;
  const meta = videoMeta({
    title: o.title, description, privacy: o.privacy, tags: o.tags ?? d.tags, categoryId: o.category ?? d.categoryId,
    language: o.language ?? d.language, madeForKids: o.kids ?? d.madeForKids,
  });
  if (o.playlist !== undefined && !/^[\w-]{1,64}$/.test(o.playlist)) throw new Error("播放清單 id 格式不對");
  const getToken = accessTokenGetter({ fetch, secrets, client, channelId: ch.id });
  let lastTen = -1;
  err(`上傳到「${ch.title}」（${meta.status.privacyStatus}）：${path.basename(video)}`);
  const v = await uploadVideo({ fetch, getToken, file: video, meta, notify: o.notify === true, signal, onProgress: (x) => {
    const t = Math.floor(x * 10);
    if (t > lastTen) { lastTen = t; err(`  ${t * 10}%`); }
  } });
  const result = { id: v.id, url: `https://youtu.be/${v.id}`, studio_url: `https://studio.youtube.com/video/${v.id}/edit`, channel: ch.title, privacy: meta.status.privacyStatus };
  if (o.playlist) {
    try { await addToPlaylist({ fetch, getToken, playlistId: o.playlist, videoId: v.id, signal }); } catch (e) { err(`影片已經上傳，但沒有加進播放清單（${e.message}）`); }
  }
  out(o.json ? JSON.stringify(result) : `已上傳（${result.privacy}）：${result.url}\nYouTube Studio：${result.studio_url}`);
  return result;
}
