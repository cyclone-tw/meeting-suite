#!/usr/bin/env node
// 用 Discord（Craig）分軌幫字幕標講者（recording-transcriber#126；工作室介面 #129）
//
//   pnpm run speakers <影片或專案資料夾> <craig-….zip> [--name 帳號=名字 ...] [--dry-run]
//
// 專案要先在字幕工作室跑完（ready）。對齊影片與分軌 → 每句判斷講者 → 換人的那句前面加「【名字】」→
// 存回專案（rev 加一，開著的頁面存檔會被擋下、提示重新整理）並更新 subtitles.srt。
// 帳號對應的名字存在工作室 state 目錄的 speakers.json（只存帳號名稱，不存 Discord ID），
// --name 給過一次就記住；沒對應到的用帳號名稱，結果會提醒。
// 不要在這支影片正在燒字幕、上傳或翻譯時跑。
// 這裡的 describeCraig／findCraig／loadCraig／labelWith 也給字幕工作室用（#129）。

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SAMPLE_RATE, TRACK_FILE, alignTracks, aligned, assignSpeakers, cleanName, createEnvelope, labelCues, missingVoices, parseCraigInfo, pickCraig, startFromName, trackFiles } from "../lib/speaker-tracks.mjs";
import { projectDirFor, readProject, sourceVideo, stateDir, writePrivate, writeProject } from "../lib/studio-project.mjs";
import { makeRunTempDir } from "../lib/run-temp.mjs";

process.env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || "/usr/bin:/bin"].join(":");

export function parseArgs(argv) {
  const o = { target: "", zip: "", names: {}, dryRun: false };
  const a = argv.filter((x) => x !== "--");
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "--dry-run") o.dryRun = true;
    else if (x === "--name") {
      const m = /^([^=]+)=(.+)$/u.exec(a[++i] || "");
      if (!m || !cleanName(m[2])) throw new Error("--name 要寫成「帳號=名字」，例如 --name alice=小美");
      o.names[m[1].trim()] = cleanName(m[2]);
    } else if (x.startsWith("--")) throw new Error(`unknown option: ${x}`);
    else if (!o.target) o.target = x;
    else if (!o.zip) o.zip = x;
    else throw new Error("只能給一支影片和一個 zip");
  }
  if (!o.target || !o.zip) throw new Error("usage: speaker-tracks.mjs <影片或專案資料夾> <craig.zip> [--name 帳號=名字] [--dry-run]");
  return o;
}

export const namesFile = (env = process.env) => path.join(stateDir(env), "speakers.json");

// 帳號 → 名字。用沒有原型的物件：帳號剛好叫 constructor、toString 也不會拿到繼承來的東西（#128）
export function namesMap(...sources) {
  const out = Object.create(null);
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    for (const [k, v] of Object.entries(s)) {
      const name = cleanName(v);
      if (typeof k === "string" && k && k.length <= 64 && name) out[k] = name;
    }
  }
  return out;
}

// 講者名冊（#132）：names 是帳號 → 名字，seen 是帳號 → 最近一次出現的會議日期（YYYY-MM-DD）。
// 舊的 speakers.json 只有 names，照常讀
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const okUser = (u) => typeof u === "string" && u.length > 0 && u.length <= 64 && u === u.trim() && !/[\u0000-\u001f\u007f]/u.test(u);
function seenMap(s) {
  const out = Object.create(null);
  if (s && typeof s === "object") for (const [k, v] of Object.entries(s)) if (okUser(k) && typeof v === "string" && DAY.test(v)) out[k] = v;
  return out;
}
function readRoster(env) {
  try {
    const j = JSON.parse(fs.readFileSync(namesFile(env), "utf8"));
    return { names: namesMap(j?.names), seen: seenMap(j?.seen) };
  } catch {
    return { names: namesMap(), seen: seenMap() };
  }
}
function writeRoster(r, env) {
  fs.mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  writePrivate(namesFile(env), JSON.stringify({ names: { ...r.names }, seen: { ...r.seen } }, null, 1) + "\n");
}
// 本機日期：會議是晚上開的，用 UTC 會差一天
const dayOf = (ms) => {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function loadNames(env = process.env) {
  return readRoster(env).names;
}

// 這次給的名字併進 speakers.json
export function rememberNames(given, env = process.env) {
  const add = namesMap(given);
  if (!Object.keys(add).length) return;
  const r = readRoster(env);
  Object.assign(r.names, add);
  writeRoster(r, env);
}

// 分軌對上了這場：記下這些帳號最近一次出現的日期（when 是 Craig 開始錄的時間）。記不了不影響標講者
export function noteSeen(users, when, env = process.env) {
  try {
    const day = dayOf(when);
    const r = readRoster(env);
    let changed = false;
    for (const u of users || []) if (okUser(u) && !(r.seen[u] >= day)) { r.seen[u] = day; changed = true; }
    if (changed) writeRoster(r, env);
  } catch { /* 名冊寫不了，下次再記 */ }
}

// 名冊頁：有名字或出現過的帳號都列出來，最近出現的在前
export function rosterList(env = process.env) {
  const r = readRoster(env);
  const users = new Set([...Object.keys(r.names), ...Object.keys(r.seen)]);
  return [...users].map((user) => ({ user, name: r.names[user] || "", seen: r.seen[user] || "" }))
    .sort((a, b) => (b.seen || "").localeCompare(a.seen || "") || a.user.localeCompare(b.user));
}

// 名冊頁新增或改名
export function setRosterName(user, name, env = process.env) {
  const u = typeof user === "string" ? user.trim() : "";
  if (!okUser(u)) throw new Error("Discord 帳號要填，最多 64 個字");
  const n = cleanName(name);
  if (!n) throw new Error("字幕上的名字要填");
  const r = readRoster(env);
  r.names[u] = n;
  writeRoster(r, env);
  return { user: u, name: n, seen: r.seen[u] || "" };
}

// 名冊頁刪除：名字和出現日期都清掉（已經標好的字幕不會變）
export function removeRosterUser(user, env = process.env) {
  if (!okUser(user)) return false;
  const r = readRoster(env);
  if (!(user in r.names) && !(user in r.seen)) return false;
  delete r.names[user];
  delete r.seen[user];
  writeRoster(r, env);
  return true;
}

export function resolveProjectDir(target) {
  const t = path.resolve(target);
  if (fs.existsSync(path.join(t, "project.json"))) return t;
  const dir = projectDirFor(t);
  if (fs.existsSync(path.join(dir, "project.json"))) return dir;
  throw new Error(`找不到字幕專案：${target}（要先在字幕工作室跑完這支影片）`);
}

// 頁面或指令給的 zip 路徑：完整路徑、真的是 .zip 檔
export function resolveZip(value) {
  const raw = String(value || "").trim().replace(/^file:\/\//, "");
  if (!raw || !path.isAbsolute(raw)) throw new Error("zip 路徑要是完整路徑");
  if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) throw new Error("找不到這個 zip");
  const zip = fs.realpathSync(raw);
  if (path.extname(zip).toLowerCase() !== ".zip") throw new Error("Discord 分軌要是 Craig 下載的 .zip 檔");
  return zip;
}

// 不解音檔，只讀 info.txt：哪場、幾點開始、有哪些帳號（附上記過的名字）
export function describeCraig(zip, env = process.env) {
  const r = spawnSync("unzip", ["-p", zip, "info.txt"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error("zip 裡沒有 info.txt，這不像 Craig 的錄音檔");
  const info = parseCraigInfo(r.stdout);
  const names = loadNames(env);
  return { zip, file: path.basename(zip), start: info.start, tracks: info.tracks.map((t) => ({ n: t.n, user: t.user, name: names[t.user] || "" })) };
}

// 在這些資料夾裡找錄音時間對得上這支影片的 craig-*.zip（影片開始時間看 OBS 檔名，沒有就看建立時間）
export function findCraig(video, dirs, durationMs, env = process.env) {
  let start = startFromName(path.basename(video));
  if (start === null) {
    try { const st = fs.statSync(video); start = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; } catch { return null; }
  }
  const zips = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^craig[-_].*\.zip$/iu.test(n)) continue;
      try { const st = fs.statSync(path.join(dir, n)); if (st.isFile()) zips.push({ file: path.join(dir, n), mtime: st.mtimeMs }); } catch { /* 讀不到就略過 */ }
    }
  }
  const candidates = [];
  for (const z of zips.sort((a, b) => b.mtime - a.mtime).slice(0, 20)) {
    try { candidates.push(describeCraig(z.file, env)); } catch { /* 不是 Craig 的 zip */ }
  }
  return pickCraig(candidates, start, durationMs);
}

// zip 只解 info.txt 和「編號-帳號.副檔名」的音檔，而且不保留路徑
export function unpackCraig(zip, dir) {
  const ls = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
  if (ls.status !== 0) throw new Error(`讀不了 zip：${String(ls.stderr || "").trim().split("\n").pop()}`);
  const entries = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!entries.includes("info.txt")) throw new Error("zip 裡沒有 info.txt，這不像 Craig 的錄音檔");
  const audio = entries.filter((e) => TRACK_FILE.test(e));
  const r = spawnSync("unzip", ["-o", "-q", "-j", zip, "info.txt", ...audio, "-d", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`解 zip 失敗：${String(r.stderr || "").trim().split("\n").pop()}`);
  const info = parseCraigInfo(fs.readFileSync(path.join(dir, "info.txt"), "utf8"));
  const tracks = trackFiles(audio, info.tracks).map((t) => ({ ...t, file: path.join(dir, t.file) }));
  if (!tracks.length) throw new Error("zip 裡沒有對得上 info.txt 的音檔");
  return { ...info, tracks };
}

// 任何影音檔 → 每 10 毫秒的均方值
export function envelopeOf(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"], signal });
    const env = createEnvelope();
    let err = "";
    p.stdout.on("data", (b) => env.push(b));
    p.stderr.on("data", (b) => { err += b; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(env.done()) : reject(new Error(`讀不了音訊 ${path.basename(file)}：${err.trim().split("\n").pop()}`))));
  });
}

// 解 zip、算影片與每一軌的音量、對齊。對不起來就丟錯（拿錯場的 zip）
export async function loadCraig(zip, video, work, { envelope = envelopeOf, signal } = {}) {
  const craig = unpackCraig(zip, work);
  const [videoEnv, ...trackEnvs] = await Promise.all([envelope(video, { signal }), ...craig.tracks.map((t) => envelope(t.file, { signal }))]);
  const align = alignTracks(videoEnv, trackEnvs);
  if (!aligned(align)) throw new Error(`影片和分軌對不起來（相關 ${align.corr}、突出度 ${align.peak_z}），是不是拿錯場的 zip？`);
  return { craig, videoEnv, trackEnvs, align };
}

export const shownNames = (tracks, names) => tracks.map((t) => names[t.user] || cleanName(t.user) || `講者${t.n}`);

// 標講者：回傳新的字幕與每人的句數；known 是可以拿掉的舊標籤名字
export function labelWith(cues, trackEnvs, align, shown, names) {
  const who = assignSpeakers(cues, trackEnvs, align);
  const known = new Set([...shown, ...Object.values(names), ...cues.map((c) => c.spk).filter(Boolean)]);
  const out = labelCues(cues, who.map((k) => (k >= 0 ? shown[k] : null)), known);
  const counts = Object.fromEntries(shown.map((s) => [s, 0]));
  for (const c of out) if (c.spk && c.text.trim() && Object.hasOwn(counts, c.spk)) counts[c.spk]++;
  return { cues: out, counts, unlabeled: out.filter((c) => !c.spk && c.text.trim()).length };
}

// 存進專案的紀錄：zip 路徑、帳號與名字、對齊結果（不含 Discord ID）
export const speakersRecord = (zip, craig, shown, align, extra = {}) => ({
  zip, source: path.basename(zip), tracks: craig.tracks.map((t, i) => ({ user: t.user, name: shown[i] })),
  offset_ms: Math.round(align.offset_ms), drift: align.drift, ref_ms: align.ref_ms, corr: align.corr, at: new Date().toISOString(), ...extra,
});

export async function applySpeakers(o, deps = {}) {
  const env = deps.env || process.env;
  const dir = resolveProjectDir(o.target);
  const project = readProject(dir);
  if (project.status !== "ready" || !Array.isArray(project.cues)) throw new Error("這支影片還沒處理完，等字幕工作室跑完再標講者");
  if (!fs.existsSync(project.video)) throw new Error("原始影片不見了（被移動或刪除）");

  const names = namesMap(loadNames(env), o.names);
  const zip = path.resolve(o.zip);
  const work = makeRunTempDir("speakers-");
  try {
    const { craig, videoEnv, trackEnvs, align } = await loadCraig(zip, project.video, work, { envelope: deps.envelopeOf || envelopeOf });
    const shown = shownNames(craig.tracks, names);
    const { cues, counts, unlabeled } = labelWith(project.cues, trackEnvs, align, shown, names);
    const missing = missingVoices(videoEnv, trackEnvs, align).map((m, k) => (m.missing ? shown[k] : null)).filter(Boolean);
    const summary = {
      project: dir,
      video: sourceVideo(project),
      offset_s: Math.round(align.offset_ms) / 1000,
      drift_ms_per_hour: Math.round(align.drift * 3600 * 1000),
      corr: align.corr,
      peak_z: align.peak_z,
      tail_corr: align.tail_corr,
      cues: counts,
      unlabeled,
      unnamed: craig.tracks.filter((t) => !names[t.user]).map((t) => t.user),
      missing,
      dry_run: Boolean(o.dryRun),
    };
    if (!o.dryRun) {
      // 讀到寫之間工作室可能存過或開始重新處理：重讀一次，rev 沒變、還是 ready 才寫（#128）
      const latest = readProject(dir);
      if (latest.rev !== project.rev || latest.status !== "ready") throw new Error("剛剛工作室裡改過這支影片的字幕，請再跑一次");
      latest.cues = cues;
      latest.speakers = speakersRecord(zip, craig, shown, align, { missing });
      latest.rev = (latest.rev || 0) + 1;
      latest.updated = new Date().toISOString();
      writeProject(dir, latest);
      rememberNames(o.names, env);
      noteSeen(craig.tracks.map((t) => t.user), craig.start, env);
    }
    return summary;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const s = await applySpeakers(o);
    console.log(`[speakers] 分軌比影片${s.offset_s >= 0 ? "早" : "晚"} ${Math.abs(s.offset_s)} 秒開始（相關 ${s.corr}${s.tail_corr === null ? "" : `，尾段 ${s.tail_corr}`}，每小時漂 ${s.drift_ms_per_hour} 毫秒）`);
    console.log(`[speakers] 每人的字幕句數：${Object.entries(s.cues).map(([k, v]) => `${k} ${v}`).join("、")}；沒判斷出講者 ${s.unlabeled} 句`);
    if (s.unnamed.length) console.log(`[speakers] 這些帳號還沒有對應的名字，先用帳號名稱：${s.unnamed.join("、")}（用 --name 帳號=名字 補上）`);
    if (s.missing.length) console.log(`[speakers] 注意：影片裡沒錄到 ${s.missing.join("、")} 的聲音，字幕會缺他們講的話；在字幕工作室加分軌重新處理會自動補回`);
    console.log(s.dry_run ? "[speakers] 試跑，沒有寫入" : "[speakers] 已寫入專案與 subtitles.srt；工作室開著這支的話請重新整理");
    console.log(JSON.stringify(s));
  } catch (e) {
    console.error(`[speakers] ${e.message}`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
