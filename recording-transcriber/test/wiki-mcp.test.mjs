// Ask AI 查 wiki 的 MCP 轉接器（#194）：只開唯讀的 query／get，參數分開傳、不經 shell
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS, callTool, cliEnv, formatResults, handle, toolArgs } from "../lib/wiki-mcp.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/wiki-mcp.mjs", import.meta.url));

// 假的 wiki 查詢工具：search 回 JSON（摘要放收到的參數），get 回正文；路徑 fail.md 模擬失敗
function fakeCli(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "notes-cli");
  fs.writeFileSync(bin, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "search") process.stdout.write(JSON.stringify({ sha: "x", results: [{ path: "Topics/a.md", title: "A 筆記", score: 0.5, snippet: "argv=" + JSON.stringify(a) }] }));
else if (a[0] === "get" && a.at(-1) === "fail.md") { process.stderr.write("not-found: fail.md"); process.exit(3); }
else if (a[0] === "get") process.stdout.write("BODY " + JSON.stringify(a));
else { process.stderr.write("unexpected " + JSON.stringify(a)); process.exit(9); }
`, { mode: 0o755 });
  return bin;
}

test("toolArgs: only query and get, the user text always comes after `--`, limits are clamped", () => {
  assert.deepEqual(toolArgs("query", { query: " 資源班 " }), { args: ["search", "-n", "5", "--", "資源班"] });
  assert.deepEqual(toolArgs("query", { query: "-n 99 --full", limit: 50 }), { args: ["search", "-n", "10", "--", "-n 99 --full"] }, "像選項的關鍵字不會被當成選項");
  assert.deepEqual(toolArgs("query", { query: "x", limit: 0 }).args.slice(1, 3), ["-n", "1"]);
  assert.deepEqual(toolArgs("get", { path: "Topics/a.md" }), { args: ["get", "--content", "--", "Topics/a.md"] });
  for (const [name, input] of [["query", {}], ["query", { query: "  " }], ["query", { query: "x".repeat(201) }], ["get", {}], ["get", { path: "a\nb" }], ["get", { path: "x".repeat(301) }], ["capture", { text: "x" }], ["put", { path: "a.md" }], [undefined, null]]) {
    assert.ok(toolArgs(name, input).error, `${name} ${JSON.stringify(input)}`);
  }
  assert.deepEqual(TOOLS.map((t) => t.name), ["query", "get"], "寫入指令不開放");
});

test("formatResults turns the search JSON into a short list and falls back to the raw text", () => {
  const out = formatResults(JSON.stringify({ results: [{ path: "Core/a.md", title: "標題", snippet: "第一行\n第二行" }, { path: "b.md", snippet: "" }] }));
  assert.equal(out, "1. Core/a.md｜標題\n   第一行 第二行\n2. b.md\n   ");
  assert.equal(formatResults(JSON.stringify({ results: [] })), "沒有找到相關筆記。");
  assert.equal(formatResults("not json"), "not json");
  assert.match(formatResults("x".repeat(70_000)), /已截斷/);
});

test("callTool reports CLI failures and bad input as tool errors, not crashes", async () => {
  const calls = [];
  const run = async (bin, args) => { calls.push([bin, args]); return args[0] === "get" ? { ok: false, stdout: "", stderr: "ssh: connect timed out\n" } : { ok: true, stdout: "{}" }; };
  const bad = await callTool("query", { query: "" }, { bin: "/b", run });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0, "參數不對不跑工具");
  const failed = await callTool("get", { path: "a.md" }, { bin: "/b", run });
  assert.deepEqual(failed, { content: [{ type: "text", text: "wiki 查詢失敗：ssh: connect timed out" }], isError: true });
  assert.deepEqual(calls, [["/b", ["get", "--content", "--", "a.md"]]]);
});

test("cliEnv keeps the PATH and adds the system folders a Dock-launched studio lacks", () => {
  assert.equal(cliEnv({ PATH: "/a:/usr/bin", X: "1" }).PATH, "/a:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(cliEnv({}).PATH, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(cliEnv({ X: "1" }).X, "1");
});

test("handle: initialize echoes the client's protocol version; notifications get no reply; unknown methods are errors", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, {});
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, {}), null);
  assert.deepEqual(await handle({ jsonrpc: "2.0", id: 2, method: "ping" }, {}), { jsonrpc: "2.0", id: 2, result: {} });
  assert.equal((await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, {})).error.code, -32601);
  assert.equal(await handle({ id: 4, method: "ping" }, {}), null, "不是 JSON-RPC 2.0 就不理");
});

test("scripts/wiki-mcp.mjs speaks MCP over stdio and runs the real CLI with separate arguments (#194)", async (t) => {
  const bin = fakeCli(t);
  const child = spawn(process.execPath, [SCRIPT, "--bin", bin], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const replies = new Map();
  let buf = "";
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const reply = async (id) => {
    const until = Date.now() + 10_000;
    while (!replies.has(id)) {
      if (Date.now() > until) throw new Error(`no reply for id ${id}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 500); });
    }
    return replies.get(id);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal((await reply(1)).result.serverInfo.name, "studio-wiki");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((await reply(2)).result.tools.map((x) => x.name), ["query", "get"]);

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query", arguments: { query: "-n 99; rm -rf ~", limit: 3 } } });
  const q = (await reply(3)).result;
  assert.equal(q.isError, undefined);
  assert.equal(q.content[0].text, `1. Topics/a.md｜A 筆記\n   argv=${JSON.stringify(["search", "-n", "3", "--", "-n 99; rm -rf ~"])}`, "整句當成一個參數，不經 shell");

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get", arguments: { path: "Topics/a.md" } } });
  assert.equal((await reply(4)).result.content[0].text, `BODY ${JSON.stringify(["get", "--content", "--", "Topics/a.md"])}`);
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get", arguments: { path: "fail.md" } } });
  assert.deepEqual((await reply(5)).result, { content: [{ type: "text", text: "wiki 查詢失敗：not-found: fail.md" }], isError: true });
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "put", arguments: { path: "x.md" } } });
  assert.equal((await reply(6)).result.isError, true);
  child.stdin.write("not json\n");
  assert.equal((await reply(null)).error.code, -32700);
});

test("scripts/wiki-mcp.mjs refuses to start without an absolute --bin", async () => {
  for (const args of [[], ["--bin"], ["--bin", "notes-cli"]]) {
    const code = await new Promise((r) => spawn(process.execPath, [SCRIPT, ...args], { stdio: "ignore" }).on("exit", r));
    assert.equal(code, 2, JSON.stringify(args));
  }
});
