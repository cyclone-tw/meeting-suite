import { test } from "node:test";
import assert from "node:assert/strict";
import { runLocalScribe, cleanModules, fmtHms, moduleKey, moduleLabel, recapKey, recapParagraphs, recapTranscript, requestModule, requestModules, requestRecap, resolveModuleOptions } from "../lib/meeting-recap.mjs";

const cue = (start, end, text) => ({ start, end, text });

test("recap paragraphs follow meeting-scribe: 150 characters, or 60 seconds with at least 20", () => {
  const long = "字".repeat(80);
  const paras = recapParagraphs([cue(1000, 2000, long), cue(2000, 3000, long), cue(3000, 4000, "下一段"), cue(4000, 5000, "  "), cue(70000, 71000, "過了一分鐘但太短")]);
  assert.deepEqual(paras.map((p) => p.start), [1000, 3000]);
  assert.equal(paras[0].text, `${long} ${long}`, "同一段的句子用空白接起來");
  assert.equal(paras[1].text, "下一段 過了一分鐘但太短", "超過 60 秒但不到 20 字：繼續接");
  const minute = recapParagraphs([cue(0, 1000, "一二三四五六七八九十一二三四五六七八九十"), cue(61000, 62000, "新的一段")]);
  assert.deepEqual(minute.map((p) => p.start), [0], "到第二句才滿 60 秒：兩句是同一段");
  const slow = recapParagraphs([cue(0, 1000, "一二三四五六七八九十"), cue(60000, 61000, "一二三四五六七八九十"), cue(62000, 63000, "後面")]);
  assert.deepEqual(slow.map((p) => [p.start, p.text]), [[0, "一二三四五六七八九十 一二三四五六七八九十"], [62000, "後面"]], "滿 60 秒又有 20 字就切");
  assert.deepEqual(recapParagraphs([]), []);
  assert.equal(recapKey(paras), recapKey(recapParagraphs([cue(1000, 2000, long), cue(2000, 3000, long), cue(3000, 4000, "下一段"), cue(70000, 71000, "過了一分鐘但太短")])));
  assert.notEqual(recapKey(paras), recapKey([{ ...paras[0], text: "改過" }, paras[1]]));
});

test("requesting a recap posts paragraphs to meeting-scribe and keeps only clean fields", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return Response.json({ type: "summary", intro: " 導言 ", full: "## 核心結論\n內容", short: "短", chapters: [{ t_ms: 0, title: "開場" }, { t_ms: "x", title: "壞的" }, { t_ms: 5000, title: "" }], usage: { cost: 1 } });
  };
  const r = await requestRecap([{ start: 0, text: "你好" }], { url: "https://mini.example:9443/", fetchImpl });
  assert.deepEqual(r, { intro: "導言", full: "## 核心結論\n內容", short: "短", chapters: [{ t_ms: 0, title: "開場" }], via: "app" }, "沒給本機位置就直接送主機");
  assert.equal(seen[0].url, "https://mini.example:9443/api/agent/summary");
  assert.equal(seen[0].init.headers["X-Meeting-Scribe"], "1", "App 要這個標頭才收 POST");
  const body = JSON.parse(seen[0].init.body);
  assert.match(body.meeting, /^[0-9a-f]{32}$/, "App 要 32 位十六進位的會議 id");
  assert.deepEqual(body.paras, [{ start: 0, text: "你好" }]);
});

test("recap errors say what happened: no URL, unreachable, App error, empty reply, stopped", async () => {
  await assert.rejects(requestRecap([], { url: "" }), /沒有設定會議轉錄 App 的網址/);
  await assert.rejects(requestRecap([], { url: "http://x", fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }), /連不到會議轉錄 App.*ECONNREFUSED/);
  await assert.rejects(requestRecap([], { url: "http://x", fetchImpl: async () => Response.json({ error: "另一份總結正在產生，稍後再試" }, { status: 503 }) }), /沒有產生總結：另一份總結正在產生/);
  await assert.rejects(requestRecap([], { url: "http://x", fetchImpl: async () => Response.json({ intro: "", full: "", short: "" }) }), /總結是空的/);
  const ac = new AbortController();
  const stopped = requestRecap([], { url: "http://x", signal: ac.signal, fetchImpl: (u, init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(init.signal.reason))) });
  ac.abort();
  await assert.rejects(stopped, (e) => e.cancelled === true);
});

test("the transcript for summary.md uses the edited timeline's start times; the file format itself lives in the App's RecapFiles (#116)", () => {
  assert.equal(recapTranscript([cue(1000, 2000, "第一句"), cue(3725000, 3726000, " 第二句 "), cue(3727000, 3728000, " ")]), "[00:00:01] 第一句\n[01:02:05] 第二句");
  assert.equal(fmtHms(-5), "00:00:00");
});


// ---- 延伸模組（#88）----
const APP_MODULES = { modules: [
  { id: "summary", title: "會後總結", output: "summary" },
  { id: "sprout", title: "讓這場會議發芽", description: "延伸探討與後續應用", output: "markdown", options: [] },
  { id: "perspective", title: "視角回饋", output: "markdown", options: [{ id: "who", label: "誰的視角", choices: [["boss", "老闆／主管"], ["parent", "家長"], ["bad id!", "壞的"]] }] },
  { id: "chart", title: "圖表", output: "image" },
  { id: "../x", title: "壞的", output: "markdown" },
  { id: "sprout", title: "重複", output: "markdown" },
] };

test("module list keeps App markdown modules only, without the recap itself, and cleans their options", async () => {
  const seen = [];
  const list = await requestModules({ url: "https://app.example:9443", fetchImpl: async (url, init) => { seen.push({ url, init }); return Response.json(APP_MODULES); } });
  assert.equal(seen[0].url, "https://app.example:9443/api/modules");
  assert.equal(seen[0].init.method, "GET");
  assert.deepEqual(list.map((m) => m.id), ["sprout", "perspective"], "summary 已經是會後總結；不是 markdown、id 不合法、重複的都不列");
  assert.deepEqual(list[1].options, [{ id: "who", label: "誰的視角", choices: [["boss", "老闆／主管"], ["parent", "家長"]] }]);
  assert.deepEqual(cleanModules(null), []);
});

test("module options: missing ones take the first choice, unknown ones are refused; key and label follow the option order", () => {
  const [, persp] = cleanModules(APP_MODULES);
  assert.deepEqual(resolveModuleOptions(persp, {}), { who: "boss" });
  assert.deepEqual(resolveModuleOptions(persp, { who: "parent", extra: "x" }), { who: "parent" }, "清單外的選項名稱不送");
  assert.throws(() => resolveModuleOptions(persp, { who: "cat" }), /誰的視角.*沒有這個選擇/);
  assert.equal(moduleKey(persp, { who: "parent" }), "perspective:who=parent");
  assert.equal(moduleLabel(persp, { who: "parent" }), "視角回饋（家長）");
  const [sprout] = cleanModules(APP_MODULES);
  assert.equal(moduleKey(sprout, {}), "sprout");
  assert.equal(moduleLabel(sprout, {}), "讓這場會議發芽");
});

test("running a module posts paragraphs and options; a busy App, an empty reply and a stop are told apart", async () => {
  const [sprout] = cleanModules(APP_MODULES);
  const seen = [];
  const r = await requestModule([{ start: 0, text: "你好" }], sprout, {}, { url: "http://x", fetchImpl: async (url, init) => { seen.push({ url, init }); return Response.json({ module: "sprout", title: "讓這場會議發芽", markdown: " ## 延伸\n內容 ", usage: {} }); } });
  assert.deepEqual(r, { markdown: "## 延伸\n內容", title: "讓這場會議發芽", via: "app" });
  assert.equal(seen[0].url, "http://x/api/agent/module");
  const body = JSON.parse(seen[0].init.body);
  assert.match(body.meeting, /^[0-9a-f]{32}$/);
  assert.deepEqual({ module: body.module, paras: body.paras, options: body.options }, { module: "sprout", paras: [{ start: 0, text: "你好" }], options: {} });
  await assert.rejects(requestModule([], sprout, {}, { url: "http://x", fetchImpl: async () => Response.json({ error: "另一份正在產生" }, { status: 503 }) }), (e) => e.status === 503 && /沒有產生「讓這場會議發芽」/.test(e.message));
  await assert.rejects(requestModule([], sprout, {}, { url: "http://x", fetchImpl: async () => Response.json({ markdown: "  " }) }), /是空的/);
  const ac = new AbortController();
  const stopped = requestModule([], sprout, {}, { url: "http://x", signal: ac.signal, fetchImpl: (u, init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(init.signal.reason))) });
  ac.abort();
  await assert.rejects(stopped, (e) => e.cancelled === true);
});

// ---- 本機優先（#83）----
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 假的 python3：記下參數與輸入，依 reply 回一行 JSON 與 exit code；hang 就等到被 kill
function fakeSpawn({ reply, code = 0, hang = false, spawnError } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    let input = "";
    child.stdin = new EventEmitter();
    child.stdin.end = (x) => {
      input = x;
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env, input: JSON.parse(x) });
      if (spawnError) return setImmediate(() => child.emit("error", Object.assign(new Error("spawn"), { code: spawnError })));
      if (!hang) setImmediate(() => { child.stdout.emit("data", `${JSON.stringify(reply)}\n`); child.emit("close", code); });
    };
    child.kill = () => setImmediate(() => child.emit("close", null));
    return child;
  };
  return { impl, calls };
}
const scribe = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rt-scribe-")); fs.writeFileSync(path.join(d, "server.py"), ""); return d; };

test("recap runs the meeting app's local entry first, with the same paragraphs, and says it ran here", async () => {
  const dir = scribe();
  const fake = fakeSpawn({ reply: { type: "summary", module: "summary", intro: "本機導言", full: "全文", short: "短", chapters: [], usage: {} } });
  let appCalled = false;
  const r = await requestRecap([{ start: 0, text: "你好" }], { url: "http://x", local: { dir, env: { A: "1" }, spawnImpl: fake.impl }, fetchImpl: async () => { appCalled = true; return Response.json({}); } });
  assert.deepEqual(r, { intro: "本機導言", full: "全文", short: "短", chapters: [], via: "local" });
  assert.equal(appCalled, false);
  assert.deepEqual(fake.calls[0], { cmd: "python3", args: ["-I", "server.py", "summary"], cwd: dir, env: { A: "1" }, input: { paras: [{ start: 0, text: "你好" }] } });
  const [sprout] = cleanModules(APP_MODULES);
  const mod = fakeSpawn({ reply: { module: "sprout", title: "讓這場會議發芽", options: {}, markdown: "## 本機", usage: {} } });
  const m = await requestModule([{ start: 0, text: "你好" }], sprout, {}, { url: "http://x", local: { dir, spawnImpl: mod.impl } });
  assert.deepEqual(m, { markdown: "## 本機", title: "讓這場會議發芽", via: "local" });
  assert.deepEqual(mod.calls[0].input, { paras: [{ start: 0, text: "你好" }], module: "sprout", options: {} });
});

test("when the local run cannot work the recap goes to the host and keeps the reason; a stop never falls back", async () => {
  const dir = scribe();
  const app = async () => Response.json({ intro: "主機導言", full: "全文", short: "短", chapters: [] });
  const failed = fakeSpawn({ reply: { error: "這台找不到 Claude Code" }, code: 3 });
  let r = await requestRecap([], { url: "http://x", local: { dir, spawnImpl: failed.impl }, fetchImpl: app });
  assert.equal(r.via, "app");
  assert.match(r.local_error, /本機沒有產生：這台找不到 Claude Code/);
  r = await requestRecap([], { url: "http://x", local: { dir: path.join(dir, "nope"), spawnImpl: failed.impl }, fetchImpl: app });
  assert.match(r.local_error, /這台沒有會議轉錄 App 的程式/);
  r = await requestRecap([], { url: "http://x", local: { dir, spawnImpl: fakeSpawn({ spawnError: "ENOENT" }).impl }, fetchImpl: app });
  assert.match(r.local_error, /本機跑不起來：ENOENT/);
  r = await requestRecap([], { url: "http://x", local: { dir, spawnImpl: fakeSpawn({ reply: "not json", code: 0 }).impl }, fetchImpl: app });
  assert.equal(r.via, "app", "看不懂的輸出也改走主機");
  r = await requestRecap([], { url: "http://x", timeoutMs: 50, local: { dir, spawnImpl: fakeSpawn({ hang: true }).impl }, fetchImpl: app });
  assert.match(r.local_error, /本機太久沒有回應/);
  let appCalled = false;
  const ac = new AbortController();
  const stopped = requestRecap([], { url: "http://x", signal: ac.signal, local: { dir, spawnImpl: fakeSpawn({ hang: true }).impl }, fetchImpl: async () => { appCalled = true; return app(); } });
  setImmediate(() => ac.abort());
  await assert.rejects(stopped, (e) => e.cancelled === true);
  assert.equal(appCalled, false, "按了停止就不改送主機");
});

test("a stop before or during the local run settles quickly and takes the run's own children with it", async () => {
  let spawned = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runLocalScribe({ paras: [] }, { dir: scribe(), signal: ac.signal, spawnImpl: () => { spawned += 1; } }), (e) => e.cancelled === true);
  assert.equal(spawned, 0, "已經按了停止就不啟動");
  // 真的 python3：server.py 再叫起一個子程序（像 Claude Code），停止時兩個都要結束
  const dir = scribe();
  fs.writeFileSync(path.join(dir, "server.py"), [
    "import subprocess, sys, time",
    "p = subprocess.Popen(['sleep', '60'])",
    "open('child.pid', 'w').write(str(p.pid))",
    "time.sleep(60)",
  ].join("\n"));
  const live = new AbortController();
  const run = runLocalScribe({ paras: [] }, { dir, signal: live.signal });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "child.pid")); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
  live.abort();
  await assert.rejects(run, (e) => e.cancelled === true);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), "孫程序也結束了");
});

test("a local failure without a JSON reply says what the app printed last", async () => {
  const dir = scribe();
  fs.writeFileSync(path.join(dir, "server.py"), "import sys\nprint('Traceback (most recent call last):', file=sys.stderr)\nprint('ModuleNotFoundError: No module named x', file=sys.stderr)\nsys.exit(1)\n");
  await assert.rejects(runLocalScribe({ paras: [] }, { dir }), /本機沒有產生：exit 1：ModuleNotFoundError: No module named x/);
});

// ---- 心智圖（#101，App 端 meeting-scribe#150）----
const MAP_REPLY = {
  module: "mindmap", title: "心智圖", options: {},
  mindmap: { center: "閱讀教材", branches: [{ label: "選用", children: [{ label: "試用版", children: [{ label: "下週三" }] }] }, { label: "  " }, { label: "家長", children: [{ label: "" }] }] },
  mermaid: "mindmap\n  root((閱讀教材))", opml: "<?xml version=\"1.0\"?><opml/>", markdown: "# 心智圖：閱讀教材", usage: {},
};
test("the mind map module is listed with its own output and its reply is cleaned", async () => {
  const list = cleanModules({ modules: [{ id: "mindmap", title: "心智圖", output: "mindmap", options: [{ id: "x", label: "y", choices: [["a", "b"]] }] }, { id: "sprout", title: "發芽", output: "markdown" }] });
  assert.deepEqual(list.map((m) => [m.id, m.output, m.options.length]), [["mindmap", "mindmap", 0], ["sprout", "markdown", 0]], "心智圖不帶選項");
  const r = await requestModule([{ start: 0, text: "x" }], list[0], {}, { url: "http://x", fetchImpl: async () => Response.json(MAP_REPLY) });
  assert.deepEqual(r.mindmap, { center: "閱讀教材", branches: [{ label: "選用", children: [{ label: "試用版", children: [{ label: "下週三" }] }] }, { label: "家長" }] }, "空的節點拿掉，沒有子項就不帶 children");
  assert.equal(r.mermaid, MAP_REPLY.mermaid);
  assert.equal(r.opml, MAP_REPLY.opml);
  assert.equal(r.markdown, "# 心智圖：閱讀教材");
  const noXml = await requestModule([], list[0], {}, { url: "http://x", fetchImpl: async () => Response.json({ ...MAP_REPLY, opml: "<script>" }) });
  assert.equal(noXml.opml, "", "不是 OPML 就不用");
  await assert.rejects(requestModule([], list[0], {}, { url: "http://x", fetchImpl: async () => Response.json({ ...MAP_REPLY, mindmap: { center: "x", branches: [] } }) }), /不是心智圖/);
});
