// Subtitle Studio 的背景啟動、關閉與 Dock 用的 App（recording-transcriber#3）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStudio, redactPaths } from "../scripts/subtitle-studio.mjs";
import { appleScript, buildApp, health, pidFile, logFile, start, status, stop } from "../scripts/studio-ctl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test("log lines hide full paths", () => {
  assert.equal(redactPaths("processing failed: /Users/me/Movies/王小明會議.mp4: Invalid data"), "processing failed: <path>: Invalid data");
  assert.equal(redactPaths("cannot open ~/Desktop/a.mov now"), "cannot open <path> now");
  assert.equal(redactPaths("[studio] Subtitle Studio is running at http://127.0.0.1:8766/"), "[studio] Subtitle Studio is running at http://127.0.0.1:8766/");
  assert.equal(redactPaths("burn failed: /Users/me/Movies/Screen Recording 王小明.mov: Invalid data"), "burn failed: <path>: Invalid data", "檔名有空白也要整個遮掉");
  assert.equal(redactPaths("cannot open ~/Desktop/王 小明 資料/a b"), "cannot open <path>", "沒有副檔名的遮到行尾");
  assert.equal(redactPaths("x /home/a/b c.mkv done; y=/opt/z.srt"), "x <path> done; y=<path>");
  assert.equal(redactPaths("cannot read /Users/me/王小明 (1)/dir"), "cannot read <path>", "資料夾名稱有括號也整個遮掉");
});

test("the page's close button stops the studio, asking first while work is running", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  let shutdowns = 0;
  const studio = createStudio({ env: { CYCLONE_STUDIO_STATE: path.join(dir, "state") }, token: "tok", onShutdown: () => { shutdowns += 1; } });
  const port = await studio.listen(0);
  t.after(async () => { await studio.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tok = { "X-Studio-Token": "tok" };

  assert.equal((await request(port, "POST", "/api/shutdown", { body: {} })).status, 403, "要帶 token");
  assert.equal((await request(port, "POST", "/api/shutdown", { body: {}, headers: { ...tok, "Sec-Fetch-Site": "cross-site" } })).status, 403, "別的網站不能關");
  assert.equal((await request(port, "POST", "/api/shutdown", { body: {}, headers: { ...tok, Origin: "http://evil.example" } })).status, 403);
  assert.equal(shutdowns, 0);

  studio.jobs.set("0123456789abcdef", { kind: "burn" });
  const busy = await request(port, "POST", "/api/shutdown", { body: {}, headers: tok });
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.json.busy, [{ name: "", kind: "burn" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(shutdowns, 0, "有工作在跑時先問，不直接關");

  const forced = await request(port, "POST", "/api/shutdown", { body: { force: true }, headers: tok });
  assert.equal(forced.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(shutdowns, 1);

  studio.jobs.clear();
  assert.equal((await request(port, "POST", "/api/shutdown", { body: {}, headers: tok })).status, 200, "沒有工作就直接關");
  await new Promise((r) => setImmediate(r));
  assert.equal(shutdowns, 2);
});

test("studio:start runs it in the background once, studio:stop ends it and cleans up", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state"), CYCLONE_STUDIO_PORT: String(await freePort()), CYCLONE_MEETING_SCRIBE_URL: "" };
  t.after(async () => {
    const p = (() => { try { return JSON.parse(fs.readFileSync(pidFile(env), "utf8")).pid; } catch { return 0; } })();
    if (p) { try { process.kill(p, "SIGKILL"); } catch { /* 已經停了 */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = await start({ env, open: false });
  assert.equal(first.started, true);
  const s = await status(env);
  assert.equal(s.running, true);
  assert.equal(s.pid, first.pid);
  assert.equal(fs.statSync(pidFile(env)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(logFile(env)).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(logFile(env), "utf8"), /Subtitle Studio is running/);

  const again = await start({ env, open: false });
  assert.equal(again.started, false, "已經在跑就不開第二個");
  assert.equal((await status(env)).pid, first.pid);

  const r = await stop({ env });
  assert.equal(r.stopped, true);
  assert.equal(r.killed, undefined, "用 SIGTERM 正常結束，不用強制");
  assert.equal(await health(Number(env.CYCLONE_STUDIO_PORT)), false);
  assert.equal(fs.existsSync(pidFile(env)), false, "停下時把 pid 檔收掉");
  assert.deepEqual(await stop({ env }), { stopped: false });
});

test("double-clicking the Dock icon while it starts waits for the first one", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state"), CYCLONE_STUDIO_PORT: String(await freePort()), CYCLONE_MEETING_SCRIBE_URL: "" };
  t.after(async () => {
    await stop({ env }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // 照實際連點的時序：第一次已經開始啟動（留下標記），第二次才點
  const first = start({ env, open: false });
  const marker = path.join(env.CYCLONE_STUDIO_STATE, "studio.starting");
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fs.existsSync(marker), "第一次啟動有留下標記");
  const [a, b] = await Promise.all([first, start({ env, open: false })]);
  assert.deepEqual([a.started, b.started].sort(), [false, true], "兩次都成功，只有一次真的啟動");
  const s = await status(env);
  assert.equal(s.running, true);
  assert.ok(s.pid);
  assert.match(fs.readFileSync(logFile(env), "utf8"), /Subtitle Studio is running/, "第一個的 log 沒被第二次洗掉");
  assert.equal(fs.existsSync(path.join(env.CYCLONE_STUDIO_STATE, "studio.starting")), false, "啟動完把標記收掉");
});

test("a marker left by a crashed start does not block the next start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state"), CYCLONE_STUDIO_PORT: String(await freePort()), CYCLONE_MEETING_SCRIBE_URL: "" };
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(async () => { other.kill("SIGKILL"); await stop({ env }).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(env.CYCLONE_STUDIO_STATE, { recursive: true });
  // 上次啟動當掉留下的標記：pid 已經不是 Studio（這裡是別的程序）
  fs.writeFileSync(path.join(env.CYCLONE_STUDIO_STATE, "studio.starting"), JSON.stringify({ pid: other.pid, port: Number(env.CYCLONE_STUDIO_PORT) }));
  const r = await start({ env, open: false, timeoutMs: 8000 });
  assert.equal(r.started, true, "不理會過期的標記，照常啟動");
  assert.equal(other.signalCode, null, "也不會動到那個程序");
});

test("studio:stop never signals a process that is not the studio", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const env = { CYCLONE_STUDIO_STATE: dir, CYCLONE_STUDIO_PORT: String(port) };
  // 上次當掉留下的 pid 檔，pid 已經被別的程序用掉
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  fs.writeFileSync(pidFile(env), JSON.stringify({ pid: other.pid, port }));
  assert.deepEqual(await stop({ env }), { stopped: false });
  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null, "別的程序不能收到訊號");
  assert.equal(fs.existsSync(pidFile(env)), false, "過期的 pid 檔清掉");
});

test("studio:start reports why it could not start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  const other = http.createServer((req, res) => res.end("not the studio")).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  t.after(() => { other.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CYCLONE_STUDIO_STATE: dir, CYCLONE_STUDIO_PORT: String(other.address().port) };
  await assert.rejects(start({ env, open: false }), /used by another program/);
});

test("the Dock app runs the launcher and is rebuilt only when it changes", (t) => {
  const script = appleScript({ launch: "/x/it's here/launch.sh", nodeHint: "/x/node" });
  assert.match(script, /quoted form of "\/x\/it's here\/launch\.sh" & " start"/);
  assert.match(script, /display alert "字幕工作室沒有啟動"/);
  if (spawnSync("osacompile", ["-l"], { stdio: "ignore" }).error) return t.skip("no osacompile on this host");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = buildApp({ dir, launch: "/x/launch.sh", nodeHint: "/x/node" });
  assert.equal(a.changed, true);
  assert.ok(fs.existsSync(path.join(a.app, "Contents", "Info.plist")));
  const res = path.join(a.app, "Contents", "Resources");
  const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  assert.equal(sha(path.join(res, "applet.icns")), sha(new URL("../assets/studio-app.icns", import.meta.url)), "用場記板圖示");
  assert.equal(fs.existsSync(path.join(res, "Assets.car")), false, "Assets.car 會蓋過 applet.icns");
  assert.doesNotMatch(fs.readFileSync(path.join(a.app, "Contents", "Info.plist"), "utf8"), /CFBundleIconName/);
  assert.equal(spawnSync("codesign", ["--verify", a.app]).status, 0, "改過內容後簽章仍然有效");
  const mtime = fs.statSync(path.join(a.app, "Contents", "Info.plist")).mtimeMs;
  assert.equal(buildApp({ dir, launch: "/x/launch.sh", nodeHint: "/x/node" }).changed, false, "內容一樣不重做（重做會讓 macOS 再問一次權限）");
  assert.equal(fs.statSync(path.join(a.app, "Contents", "Info.plist")).mtimeMs, mtime);
  assert.equal(buildApp({ dir, launch: "/y/launch.sh", nodeHint: "/x/node" }).changed, true);
});

test("the launcher finds node without a PATH and passes the command through", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-ctl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync("/bin/bash", [path.join(ROOT, "scripts", "studio-app-launch.sh"), "status"], {
    encoding: "utf8",
    env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", CYCLONE_NODE_HINT: process.execPath, CYCLONE_STUDIO_STATE: dir, CYCLONE_STUDIO_PORT: "1" },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(JSON.parse(r.stdout).running, false);
  const bad = spawnSync("/bin/bash", [path.join(ROOT, "scripts", "studio-app-launch.sh"), "status"], {
    encoding: "utf8", env: { HOME: dir, PATH: "/usr/bin:/bin", CYCLONE_NODE_HINT: "/nonexistent/node", CYCLONE_STUDIO_STATE: dir, CYCLONE_STUDIO_PORT: "1" },
  });
  // 這台的 Homebrew 有 node 就會找到；沒有就要清楚說找不到
  if (bad.status !== 3) assert.match(bad.stderr, /找不到 node/);
});
