// 常駐一個 Claude Code 程序做多輪問答。和 meeting-scribe 一樣：
// 不存 session、關掉工具／MCP／使用者設定／slash commands，只帶指定的 system prompt
// （不關的話一次就會載入十幾萬 token 的工具與設定）。工作目錄是空的暫存資料夾。
//
// 用量：usage 每次各自加總；total_cost_usd 是同一程序內的累計值，只加差額。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function claudeBin(env = process.env) {
  return env.CYCLONE_CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", "claude");
}

export function claudeArgs(model, systemPrompt) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", model, "--no-session-persistence", "--system-prompt", systemPrompt,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--disable-slash-commands",
    "--tools", "",  // variadic，放最後
  ];
}

// 給 agent 的環境：拿掉 Soniox 金鑰相關的變數（逐字稿是不可信的資料，agent 可能被誘導讀環境）
export function agentEnv(env = process.env) {
  const out = { ...env };
  delete out.SONIOX_API_KEY;
  delete out.CYCLONE_SONIOX_KEY_FILE;
  // lib/keys.mjs 解析的其他憑證也一併清掉（#163）：逐字稿是不可信資料，agent 不該讀到任何金鑰
  for (const k of ["GROQ_API_KEY", "APIFY_TOKEN", "GROQ_CONFIG_JSON", "APIFY_CONFIG_JSON"]) delete out[k];
  return out;
}

export function newUsage() {
  return { calls: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, cost_usd: 0 };
}

export function addResultUsage(usage, ev, state) {
  const u = ev && typeof ev.usage === "object" && ev.usage ? ev.usage : {};
  const num = (v) => (typeof v === "number" && v >= 0 ? v : 0);
  usage.calls += 1;
  usage.input += num(u.input_tokens);
  usage.output += num(u.output_tokens);
  usage.cache_write += num(u.cache_creation_input_tokens);
  usage.cache_read += num(u.cache_read_input_tokens);
  const total = ev?.total_cost_usd;
  if (typeof total === "number" && total >= 0) {
    usage.cost_usd += total >= state.procCost ? total - state.procCost : total;
    state.procCost = total;
  }
}

export function openClaude(systemPrompt, { model = process.env.CYCLONE_SUBTITLE_MODEL || "sonnet", timeoutMs = 300_000, command } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-claude-"));
  const [bin, ...args] = command || [claudeBin(), ...claudeArgs(model, systemPrompt)];
  const lines = [];
  let waiter = null, closed = false, spawnError = null;
  const proc = spawn(bin, args, { cwd: workdir, stdio: ["pipe", "pipe", "ignore"], env: agentEnv() });
  // 找不到程式或提早結束：不讓 error／EPIPE 變成未處理的例外，ask() 會回報錯誤
  proc.on("error", (e) => { spawnError = e; closed = true; waiter?.(); });
  proc.stdin.on("error", () => {});
  createInterface({ input: proc.stdout }).on("line", (line) => { lines.push(line); waiter?.(); });
  proc.on("exit", () => { closed = true; waiter?.(); });
  const usage = newUsage(), state = { procCost: 0 };

  async function ask(prompt) {
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (lines.length) {
        let ev;
        try { ev = JSON.parse(lines.shift()); } catch { continue; }
        if (ev.type !== "result") continue;
        addResultUsage(usage, ev, state);
        if (ev.is_error) throw new Error("Claude reported an error");
        return String(ev.result || "");
      }
      if (closed) throw new Error(spawnError ? `Claude could not start: ${spawnError.code || spawnError.message}` : "Claude process exited");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Claude timed out");
      await new Promise((r) => { const t = setTimeout(r, left); waiter = () => { clearTimeout(t); waiter = null; r(); }; });
    }
  }

  function close() {
    try { proc.stdin.end(); } catch { /* 已關 */ }
    setTimeout(() => { if (!closed) proc.kill(); }, 5000).unref();
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  return { ask, close, usage };
}

// 回覆裡的 JSON 物件（容許 ```json 圍欄或前後多餘文字）。
export function parseJsonReply(text) {
  const s = String(text || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("reply has no JSON object");
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("reply is not a JSON object");
  return obj;
}
