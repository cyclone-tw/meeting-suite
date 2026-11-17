// Ask AI 查 wiki 的 MCP 轉接器（#194）：讓 Claude 透過使用者的 wiki 查詢工具（CLI）唯讀查筆記。
// wiki 不在這台電腦上（放在遠端主機），工具自己負責連線；這裡只開兩個唯讀工具：
//   query → `<cli> search -n <n> -- <關鍵字>`（輸出 JSON：{results:[{path,title,snippet}]}）
//   get   → `<cli> get --content -- <路徑>`（輸出筆記正文）
// CLI 的寫入指令（capture、put…）不開放：關鍵字和路徑來自 AI，AI 讀的字幕是不可信資料。
// 協定是 MCP 的 stdio：一行一則 JSON-RPC。stdout 只能放協定訊息，錯誤只回給 AI，不寫 log（可能有人名）。

import { execFile } from "node:child_process";
import readline from "node:readline";

const PROTOCOL = "2025-06-18";
const MAX_QUERY = 200, MAX_PATH = 300, MAX_TEXT = 60_000, MAX_BUFFER = 4 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;

export const TOOLS = [
  {
    name: "query",
    description: "搜尋使用者的 wiki 筆記，回傳筆記路徑、標題與摘要片段。要看全文再用 get。",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "搜尋關鍵字" }, limit: { type: "integer", minimum: 1, maximum: 10, description: "最多幾筆，預設 5" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "get",
    description: "讀一則 wiki 筆記的全文。路徑用 query 結果裡的 path。",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "筆記路徑，例如 Topics/example.md" } }, required: ["path"], additionalProperties: false },
  },
];

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…（後面還有 ${s.length - n} 字，已截斷）` : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 搜尋結果整理成短短的清單，省 token；看不懂的輸出就原樣（截斷）交給 AI
export function formatResults(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return clip(String(stdout).trim(), MAX_TEXT); }
  const rows = Array.isArray(j?.results) ? j.results : null;
  if (!rows) return clip(String(stdout).trim(), MAX_TEXT);
  if (!rows.length) return "沒有找到相關筆記。";
  return clip(rows.map((r, i) => `${i + 1}. ${oneLine(r?.path)}${r?.title ? `｜${oneLine(r.title)}` : ""}\n   ${clip(oneLine(r?.snippet), 600)}`).join("\n"), MAX_TEXT);
}

// 檢查 AI 給的參數；回傳 { args } 或 { error }
export function toolArgs(name, input) {
  const a = input && typeof input === "object" ? input : {};
  if (name === "query") {
    const q = typeof a.query === "string" ? a.query.trim() : "";
    if (!q) return { error: "query 不能是空的" };
    if (q.length > MAX_QUERY) return { error: `query 最多 ${MAX_QUERY} 字` };
    const n = Number.isInteger(a.limit) ? Math.min(10, Math.max(1, a.limit)) : 5;
    return { args: ["search", "-n", String(n), "--", q] };
  }
  if (name === "get") {
    const p = typeof a.path === "string" ? a.path.trim() : "";
    if (!p) return { error: "path 不能是空的" };
    if (p.length > MAX_PATH || /[\0\n\r]/.test(p)) return { error: "path 格式不對" };
    return { args: ["get", "--content", "--", p] };
  }
  return { error: `沒有這個工具：${name}` };
}

// 跑 CLI：回傳 { ok, stdout, stderr }。不經過 shell，參數一律分開傳
export function runCli(bin, args, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: cliEnv(env), timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") || (err ? String(err.message || err) : "") });
    });
  });
}

// 從 Dock 開的工作室 PATH 很短；CLI 可能用 `#!/usr/bin/env python3`，確保找得到系統的直譯器
export function cliEnv(env = process.env) {
  const dirs = String(env.PATH || "").split(":").filter(Boolean);
  for (const d of ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"]) if (!dirs.includes(d)) dirs.push(d);
  return { ...env, PATH: dirs.join(":") };
}

export async function callTool(name, input, { bin, run = runCli } = {}) {
  const t = toolArgs(name, input);
  if (t.error) return { content: [{ type: "text", text: t.error }], isError: true };
  const r = await run(bin, t.args);
  if (!r.ok) return { content: [{ type: "text", text: `wiki 查詢失敗：${clip(oneLine(r.stderr) || "沒有錯誤訊息", 500)}` }], isError: true };
  const text = name === "query" ? formatResults(r.stdout) : clip(r.stdout.trim() || "（這則筆記是空的）", MAX_TEXT);
  return { content: [{ type: "text", text }] };
}

// 處理一則 JSON-RPC；通知（沒有 id）不回。回傳要寫出去的物件或 null
export async function handle(msg, opts) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return null;
  const has = Object.hasOwn(msg, "id");
  const reply = (result) => (has ? { jsonrpc: "2.0", id: msg.id, result } : null);
  const fail = (code, message) => (has ? { jsonrpc: "2.0", id: msg.id, error: { code, message } } : null);
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "studio-wiki", version: "1.0.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      return reply(await callTool(msg.params?.name, msg.params?.arguments, opts));
    default:
      return msg.method?.startsWith("notifications/") ? null : fail(-32601, `unknown method: ${msg.method}`);
  }
}

export function serve({ bin, input = process.stdin, output = process.stdout, run } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (o) => { if (o) output.write(`${JSON.stringify(o)}\n`); };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
    handle(msg, { bin, run }).then(write, (e) => write(Object.hasOwn(msg, "id") ? { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } } : null));
  });
  return rl;
}
