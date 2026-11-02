#!/usr/bin/env node
// 影片上字幕
//
//   pnpm run subtitle <影片> [--privacy public|sensitive|student-private]
//     [--engine soniox|whisper] [--proofreader claude|codex|cursor|grok|pi] [--burn] [--size small|medium|large] [--style box|outline]
//     [--terms 詞1,詞2] [--out <資料夾>]
//     [--remote [--host <ssh 主機>]] [--timeout-minutes 120]
//
// 預設在本機跑：辨識送 Soniox 雲端，本機只做抽音訊、切字幕與硬體編碼燒字幕，負擔很輕。
// --remote 才交給另一台 Mac（使用者設定的 remote_host）：上傳影片到 job → 跑 scripts/subtitle-run.mjs → 取回輸出 →
// 刪掉遠端的 job（含影片）；遠端任一步失敗就改在本機跑，回報寫明原因。
// 兩台之間不在同一網路時影片傳輸很慢（實測約 1 MB/s），大影片不建議 --remote。
// --privacy 預設 public；非 public 只代表「含個資」，此時校對者不能是可能走中國大陸雲端模型的 agent。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkProofreader } from "../lib/proofreaders.mjs";
import { remoteHost, remoteToolDirShell } from "../lib/asr-profile.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(TOOL_ROOT, "scripts", "subtitle-run.mjs");
// iCloud、Drive 等同步資料夾；開了 iCloud「桌面與文件」時桌面和文件也算
export function cloudDirs(home = os.homedir()) {
  const dirs = [path.join(home, "Library", "Mobile Documents"), path.join(home, "Library", "CloudStorage")];
  if (fs.existsSync(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Desktop"))) dirs.push(path.join(home, "Desktop"));
  if (fs.existsSync(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"))) dirs.push(path.join(home, "Documents"));
  return dirs.map(realDir);   // 和影片／輸出路徑一樣比對實際位置（/var → /private/var 之類）
}

// 還不存在的資料夾：用最近一層存在的上層判斷實際位置
export function realDir(p) {
  let cur = path.resolve(p), rest = [];
  while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(fs.realpathSync(cur), ...rest);
}

export function parseArgs(argv) {
  const o = {
    video: "", privacy: "public", engine: "soniox", proofreader: process.env.CYCLONE_PROOFREADER || "claude", burn: false, size: "medium", style: "box", terms: "", out: "",
    host: remoteHost(), remote: false,
    timeoutMinutes: Number(process.env.CYCLONE_SUBTITLE_TIMEOUT_MINUTES || 120),
  };
  const a = argv.filter((x) => x !== "--");
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "--privacy") o.privacy = a[++i] || "";
    else if (x === "--engine") o.engine = a[++i] || "";
    else if (x === "--burn") o.burn = true;
    else if (x === "--size") o.size = a[++i] || "";
    else if (x === "--style") o.style = a[++i] || "";
    else if (x === "--proofreader") o.proofreader = a[++i] || "";
    else if (x === "--terms") o.terms = a[++i] || "";
    else if (x === "--out") o.out = a[++i] || "";
    else if (x === "--host") o.host = a[++i] || "";
    else if (x === "--remote") o.remote = true;
    else if (x === "--local-only") o.remote = false;
    else if (x === "--timeout-minutes") o.timeoutMinutes = Number(a[++i]);
    else if (x.startsWith("--")) throw new Error(`unknown option: ${x}`);
    else if (!o.video) o.video = x;
    else throw new Error("only one video is allowed");
  }
  if (!o.video) throw new Error("usage: pnpm run subtitle <video> [--privacy public|sensitive|student-private] [--burn]");
  if (!["public", "sensitive", "student-private"].includes(o.privacy)) throw new Error("--privacy must be public, sensitive or student-private");
  if (!["soniox", "whisper"].includes(o.engine)) throw new Error("--engine must be soniox or whisper");
  if (!["small", "medium", "large"].includes(o.size)) throw new Error("--size must be small, medium or large");
  if (!["box", "outline"].includes(o.style)) throw new Error("--style must be box or outline");
  checkProofreader(o.proofreader, o.privacy);
  if (o.host && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.host)) throw new Error("invalid host alias");
  if (o.remote && !o.host) throw new Error("--remote needs a host: set remote_host in the user profile or pass --host");
  if (!(o.timeoutMinutes > 0)) throw new Error("invalid --timeout-minutes");
  return o;
}

export function inCloudFolder(file, dirs = cloudDirs()) {
  return dirs.some((d) => file === d || file.startsWith(d + path.sep));
}

const sshBase = (host) => ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", host];
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function job(host, args, timeoutSeconds = 60) {
  const dir = remoteToolDirShell();
  const cmd = `cd ${dir} && PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" node scripts/transcript-job.mjs ${args.map(q).join(" ")}`;
  const r = spawnSync(process.env.CYCLONE_TRANSCRIBE_SSH || "ssh", [...sshBase(host), cmd], { encoding: "utf8", timeout: timeoutSeconds * 1000 });
  let json = null;
  try { json = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { json = null; }
  if (r.status !== 0 || !json?.ok) throw new Error(`${args[0]} failed: ${json?.error || String(r.stderr || r.error?.message || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  return json;
}

function rsync(src, dest, timeoutSeconds) {
  const r = spawnSync("rsync", ["-a", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15", src, dest], { encoding: "utf8", timeout: timeoutSeconds * 1000 });
  if (r.status !== 0) throw new Error(`rsync failed: ${String(r.stderr || r.error?.message || "").trim().split("\n").pop()}`);
}

const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

function runRemote(o, video, out, id, report) {
  const ping = job(o.host, ["ping"]);
  report.remote = { host: o.host, job_id: id };
  if (o.engine === "soniox" && !ping.soniox_key) throw new Error("remote host has no Soniox key");
  if (o.engine === "whisper" && !ping.mlx_whisper) throw new Error("remote host has no mlx_whisper");
  if (o.burn && !ping.ffmpeg_full) throw new Error("remote host has no ffmpeg with libass");
  if (!ping.claude) throw new Error("remote host has no Claude Code");
  const prep = job(o.host, ["prepare", id]);
  report.remote.prepared = true;
  const name = `source${path.extname(video).toLowerCase()}`;
  const t0 = Date.now();
  rsync(video, `${o.host}:${prep.input_dir}/${name}`, 3600);
  report.steps.upload_s = Math.round((Date.now() - t0) / 100) / 10;
  job(o.host, ["subtitle", id, "--input", name, "--privacy", o.privacy, "--engine", o.engine, "--proofreader", o.proofreader, ...(o.burn ? ["--burn", "--size", o.size, "--style", o.style] : []), ...(o.terms ? ["--terms", o.terms] : [])]);
  console.error(`[subtitle] job ${id} running on ${o.host}`);
  report.remote.started = true;
  const deadline = Date.now() + o.timeoutMinutes * 60_000;
  let status = null, misses = 0;
  while (Date.now() < deadline) {
    sleep(Number(process.env.CYCLONE_TRANSCRIBE_POLL_SECONDS || 5));
    try { status = job(o.host, ["status", id]); misses = 0; } catch (e) { if (++misses >= 3) throw new Error(`lost the remote host: ${e.message}`); continue; }
    report.remote.last_state = status.state;
    if (["succeeded", "failed", "missing"].includes(status.state)) break;
  }
  report.remote.cleanup = status?.cleanup;
  if (status?.state !== "succeeded") throw new Error(`remote job ${status?.state || "timed out"}: ${status?.error || ""}`.trim());
  const t1 = Date.now();
  rsync(`${o.host}:${path.dirname(prep.input_dir)}/outputs/`, out + path.sep, 3600);
  report.steps.download_s = Math.round((Date.now() - t1) / 100) / 10;
  Object.assign(report, status.report || {}, { steps: { ...report.steps, ...(status.report?.steps || {}) } });
  // mini 上的檔名是 source-字幕.mp4，改回原影片的名稱
  const burned = path.join(out, "source-字幕.mp4");
  if (fs.existsSync(burned)) {
    const target = path.join(out, `${path.basename(video, path.extname(video))}-字幕.mp4`);
    fs.renameSync(burned, target);
    report.outputs = (report.outputs || []).map((n) => (n === "source-字幕.mp4" ? path.basename(target) : n));
  }
  report.executed_on = o.host;
}

function finishRemote(o, id, report) {
  if (!report.remote?.prepared) return;
  try {
    const r = job(o.host, ["finish", id]);
    report.remote.job_dir_removed = Boolean(r.removed);
  } catch (e) {
    report.remote.job_dir_removed = false;
    report.remote.finish_error = e.message;
  }
}

function runLocal(o, video, out, report) {
  const args = [RUN, video, "--out", out, "--privacy", o.privacy, "--engine", o.engine, "--proofreader", o.proofreader, ...(o.burn ? ["--burn", "--size", o.size, "--style", o.style] : []), ...(o.terms ? ["--terms", o.terms] : [])];
  const r = spawnSync(process.execPath, args, { cwd: TOOL_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { json = null; }
  if (r.status !== 0 || !json?.ok) throw new Error(`local run failed: ${json?.error || `exit ${r.status}`}`);
  const { ok, ...rest } = json;
  Object.assign(report, rest, { steps: { ...report.steps, ...rest.steps } });
  report.executed_on = "local";
}

const usd = (v) => `US$${(v || 0).toFixed(3)}（NT$${((v || 0) * 32).toFixed(1)}）`;

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
  const stop = (msg) => { console.error(msg); process.exit(2); };
  if (!fs.existsSync(o.video) || !fs.statSync(o.video).isFile()) stop(`video not found: ${o.video}`);
  const video = fs.realpathSync(path.resolve(o.video));
  const base = path.basename(video, path.extname(video));
  const out = realDir(o.out || path.join(path.dirname(video), `${base}-字幕`));
  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length)) stop("--out must be a new or empty folder");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.chmodSync(out, 0o700);
  const id = `sub-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(3).toString("hex")}`;
  const report = { job_id: id, privacy: o.privacy, executed_on: "", fallback_reason: "", steps: {} };
  const t0 = Date.now();
  if (o.remote) {
    try { runRemote(o, video, out, id, report); } catch (e) {
      report.fallback_reason = e.message;
    } finally { finishRemote(o, id, report); }
    // 遠端還在跑（逾時或連不到）就不在本機重做，免得同一支影片送兩次 Soniox；job 之後由 gc 收
    const stillRunning = !report.executed_on && report.remote?.started && ["queued", "running", undefined].includes(report.remote.last_state) && !report.remote.job_dir_removed;
    if (stillRunning) report.error = `remote job may still be running on ${o.host}; not repeating it locally (${report.fallback_reason})`;
    else if (!report.executed_on) console.error(`[subtitle] falling back to local: ${report.fallback_reason}`);
  }
  if (!report.executed_on && !report.error) {
    try { runLocal(o, video, out, report); } catch (e) { report.error = e.message; }
  }
  if (report.error) console.error(`[subtitle] ${report.error}`);
  report.steps.total_s = Math.round((Date.now() - t0) / 100) / 10;
  if (fs.existsSync(path.join(out, "report.json"))) fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.error(`[subtitle] executed_on=${report.executed_on || "none"}${report.fallback_reason ? ` (fallback: ${report.fallback_reason})` : ""}`);
  const corr = report.corrections;
  if (corr) console.error(`[corrections] ${corr.hints + corr.fixed} pairs from ${corr.source}${corr.error ? ` (meeting-scribe unreachable: ${corr.error})` : ""}`);
  if (report.soniox) console.error(`[cost] Soniox ${(report.soniox.audio_ms / 60000).toFixed(1)} min ≈ ${usd(report.soniox.cost_usd)}`);
  if (report.claude && report.proofreader !== "claude") console.error(`[cost] ${report.proofreader} ${report.claude.calls} calls (token usage not reported by this agent)`);
  else if (report.claude) console.error(`[cost] Claude ${report.claude.calls} calls, ${report.claude.input + report.claude.output + report.claude.cache_write + report.claude.cache_read} tokens, API-equivalent ${usd(report.claude.cost_usd)} (subscription)`);
  if (report.remote?.prepared) {
    const c = report.remote.cleanup;
    console.error(c ? `[cleanup] remote video: deleted ${c.deleted} file(s) (${((c.bytes_deleted || 0) / 1048576).toFixed(1)} MB)${c.leftovers ? `; LEFTOVERS ${c.leftovers}` : "; no leftovers"}` : "[cleanup] remote video: no receipt");
    console.error(report.remote.job_dir_removed ? `[cleanup] remote job dir removed` : `[cleanup] REMOTE JOB DIR LEFT on ${o.host}: ${id} (${report.remote.finish_error || "unknown"})`);
  }
  console.error(`[subtitle] outputs in ${out}`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.executed_on ? 0 : 1);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
