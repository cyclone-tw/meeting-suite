#!/usr/bin/env node
// Subtitle Studio 的背景啟動與關閉（recording-transcriber#3）
//
//   pnpm run studio:start   在背景啟動並打開瀏覽器（已經在跑就只打開瀏覽器）；--no-open 只啟動
//   pnpm run studio:stop    關閉（先中止燒錄、清掉暫存，和網頁上的「關閉工作室」一樣）
//   pnpm run studio:status  在不在跑
//   pnpm run studio:app     在 ~/Applications 做「字幕工作室.app」，放進 Dock 點一下就開
//
// 背景的 Studio 把輸出寫到 <state>/studio.log（每次啟動重寫、0600、路徑已遮掉），
// 自己在 <state>/studio.pid 記下 pid 與 port；stop 先確認那個程序真的是 Studio 才送 SIGTERM。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateDir, writePrivate } from "../lib/studio-project.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = path.join(TOOL_ROOT, "scripts", "subtitle-studio.mjs");
const LAUNCH = path.join(TOOL_ROOT, "scripts", "studio-app-launch.sh");
const ICON = path.join(TOOL_ROOT, "assets", "studio-app.icns");
export const APP_NAME = "字幕工作室";

export const studioPort = (env = process.env) => Number(env.CYCLONE_STUDIO_PORT || 8766);
export const pidFile = (env = process.env) => path.join(stateDir(env), "studio.pid");
export const logFile = (env = process.env) => path.join(stateDir(env), "studio.log");
// 正在啟動中的 Studio（還沒回應 healthz、還沒寫 pid 檔）：連點 Dock 圖示時，第二次就等它，不再開一個
const startingFile = (env = process.env) => path.join(stateDir(env), "studio.starting");

export async function health(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await r.json())?.app === "subtitle-studio";
  } catch {
    return false;
  }
}

export function readPid(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(pidFile(env), "utf8"));
    return Number.isInteger(j?.pid) && j.pid > 1 ? j : null;
  } catch {
    return null;
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// pid 檔可能是上次當掉留下的、pid 也可能被別的程序重用：命令列要真的是 subtitle-studio.mjs 才算
export function isStudioProcess(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return r.status === 0 && /subtitle-studio\.mjs/.test(r.stdout);
}

export async function status(env = process.env) {
  const port = studioPort(env);
  const p = readPid(env);
  const running = await health(port);
  const pid = p && p.port === port && alive(p.pid) && isStudioProcess(p.pid) ? p.pid : null;
  return { running, pid, port, url: `http://127.0.0.1:${port}/` };
}

function openUrl(url) {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(port, until, isDone = () => false) {
  while (Date.now() < until && !isDone()) {
    if (await health(port, 800)) return true;
    await sleep(250);
  }
  return health(port, 800);   // 子程序結束的同時可能剛好是別人啟動好了：最後再看一次
}

export async function start({ env = process.env, open = true, timeoutMs = 15000 } = {}) {
  const port = studioPort(env);
  const url = `http://127.0.0.1:${port}/`;
  const ready = (started, pid) => { if (open) openUrl(url); return { started, url, ...(pid ? { pid } : {}) }; };
  if (await health(port)) return ready(false);
  fs.mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const until = Date.now() + timeoutMs;
  let starting = null;
  try { starting = JSON.parse(fs.readFileSync(startingFile(env), "utf8")); } catch { /* 沒有人在啟動 */ }
  if (starting?.port === port && Number.isInteger(starting.pid) && alive(starting.pid) && isStudioProcess(starting.pid)) {
    if (await waitHealthy(port, until)) return ready(false);
    throw new Error("Studio 沒有啟動成功（另一次啟動還沒好）");
  }
  const log = logFile(env);
  fs.rmSync(log, { force: true });
  const fd = fs.openSync(log, "w", 0o600);
  let exited = null;
  const child = spawn(process.execPath, [STUDIO, "--no-open"], {
    cwd: TOOL_ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...env, CYCLONE_STUDIO_PORT: String(port) },
  });
  fs.closeSync(fd);
  child.on("exit", (code) => { exited = code ?? 1; });
  child.unref();
  writePrivate(startingFile(env), JSON.stringify({ pid: child.pid, port }));
  try {
    if (await waitHealthy(port, until, () => exited !== null)) return ready(exited === null, exited === null ? child.pid : 0);
  } finally {
    try { if (JSON.parse(fs.readFileSync(startingFile(env), "utf8")).pid === child.pid) fs.rmSync(startingFile(env), { force: true }); } catch { /* 已經清掉 */ }
  }
  const last = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).pop() || "";
  if (exited === null) { try { process.kill(child.pid, "SIGTERM"); } catch { /* 已經結束 */ } }
  throw new Error(last ? `Studio 沒有啟動成功：${last.replace(/^\[studio\]\s*/, "")}` : "Studio 沒有啟動成功（逾時）");
}

export async function stop({ env = process.env, timeoutMs = 8000 } = {}) {
  const s = await status(env);
  if (!s.pid) {
    if (s.running) throw new Error(`port ${s.port} 上的 Studio 不是用 studio:start 或 pnpm run studio 啟動的，請到它的終端機按 Ctrl+C`);
    fs.rmSync(pidFile(env), { force: true });
    return { stopped: false };
  }
  process.kill(s.pid, "SIGTERM");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && alive(s.pid)) await sleep(200);
  if (alive(s.pid)) {
    process.kill(s.pid, "SIGKILL");
    fs.rmSync(pidFile(env), { force: true });
    return { stopped: true, killed: true };
  }
  return { stopped: true };
}

// ---- Dock 用的 App ----

export function appleScript({ launch = LAUNCH, nodeHint = process.execPath } = {}) {
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "-- 字幕工作室：在背景啟動 Subtitle Studio 並打開瀏覽器（recording-transcriber#3）",
    "on run",
    "  try",
    `    do shell script "CYCLONE_NODE_HINT=" & quoted form of ${q(nodeHint)} & " /bin/bash " & quoted form of ${q(launch)} & " start"`,
    "  on error errMsg",
    `    display alert ${q(`${APP_NAME}沒有啟動`)} message errMsg as warning`,
    "  end try",
    "end run",
    "",
  ].join("\n");
}

// 內容沒變就不重做：重做會換掉 App 的簽章，macOS 會再問一次「要不要讓它取用桌面、下載」
export function buildApp({ dir = path.join(os.homedir(), "Applications"), launch = LAUNCH, nodeHint = process.execPath, icon = ICON } = {}) {
  const script = appleScript({ launch, nodeHint });
  const digest = createHash("sha256").update(script).update(fs.readFileSync(icon)).digest("hex");
  const app = path.join(dir, `${APP_NAME}.app`);
  const stamp = path.join(app, "Contents", "Resources", "cyclone-studio-app.sha256");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === digest) return { app, changed: false };
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "studio-app-"));
  try {
    const src = path.join(work, "app.applescript");
    fs.writeFileSync(src, script);
    const built = path.join(work, `${APP_NAME}.app`);
    const r = spawnSync("osacompile", ["-o", built, src], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`osacompile failed: ${String(r.stderr || r.error?.message).trim()}`);
    const res = path.join(built, "Contents", "Resources");
    // 換成場記板圖示：Assets.car 與 CFBundleIconName 會蓋過 applet.icns，要一起拿掉（#16）
    fs.copyFileSync(icon, path.join(res, "applet.icns"));
    fs.rmSync(path.join(res, "Assets.car"), { force: true });
    spawnSync("/usr/libexec/PlistBuddy", ["-c", "Delete :CFBundleIconName", path.join(built, "Contents", "Info.plist")], { stdio: "ignore" });
    fs.writeFileSync(path.join(res, "cyclone-studio-app.sha256"), `${digest}\n`);
    // 改過內容後重新做 ad-hoc 簽章，不然簽章對不上
    const sign = spawnSync("codesign", ["--force", "--sign", "-", built], { encoding: "utf8" });
    if (sign.status !== 0) throw new Error(`codesign failed: ${String(sign.stderr || sign.error?.message).trim()}`);
    fs.rmSync(app, { recursive: true, force: true });
    fs.renameSync(built, app);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { app, changed: true };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2).filter((x) => x !== "--");
  try {
    if (cmd === "start") {
      const r = await start({ open: !rest.includes("--no-open") });
      console.log(r.started ? `[studio] started at ${r.url}` : `[studio] already running at ${r.url}`);
    } else if (cmd === "stop") {
      const r = await stop();
      console.log(r.stopped ? `[studio] stopped${r.killed ? " (forced after 8 s)" : ""}` : "[studio] not running");
    } else if (cmd === "status") {
      const s = await status();
      console.log(JSON.stringify(s));
      process.exitCode = s.running ? 0 : 3;
    } else if (cmd === "app") {
      if (/\/worktrees\//.test(TOOL_ROOT) && !rest.includes("--allow-worktree")) {
        throw new Error("run studio:app from the main checkout, not a worktree");
      }
      const r = buildApp();
      console.log(r.changed ? `[studio] built ${r.app}` : `[studio] ${r.app} is up to date`);
    } else {
      console.error("usage: studio-ctl.mjs start [--no-open] | stop | status | app");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(String(e?.message || e));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
