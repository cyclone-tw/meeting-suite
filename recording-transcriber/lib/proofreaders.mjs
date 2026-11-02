// 逐字校對可以交給不同的 coding agent（有能力的 coding agent 都可以做這個工作）。每個 agent 只負責回傳修正清單 JSON，
// 驗證與套用都在程式裡（lib/subtitle-text.mjs applyEdits），所以換誰做規則都一樣。
//
// claude 是常駐程序多輪對話（lib/claude-stream.mjs）；其他 agent 每段跑一次 CLI，
// 在空的暫存資料夾裡執行，system prompt 併在每段前面。限制：codex 唯讀 sandbox、cursor 問答模式、
// grok plan 模式且關網路搜尋、pi 關掉全部工具。環境變數裡的 Soniox 金鑰不傳給任何 agent。
//
// 個資：含個資（--privacy 非 public）的內容不得交給可能走中國大陸雲端語言模型的校對者；
// 除此之外沒有隱私或上雲限制。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentEnv, claudeBin, newUsage, openClaude } from "./claude-stream.mjs";

const bin = (name, envKey) => process.env[envKey] || name;

// 每個 preset：(prompt, workdir, outFile) → { cmd, args, input?, readOut? }
export const PRESETS = {
  codex: (prompt, dir, outFile) => ({
    cmd: bin("codex", "CYCLONE_CODEX_BIN"),
    args: ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "-o", outFile],
    input: prompt,
    readOut: true,
  }),
  cursor: (prompt, dir) => ({
    cmd: bin("cursor-agent", "CYCLONE_CURSOR_BIN"),
    args: ["-p", "--output-format", "text", "--mode", "ask", "--trust", "--workspace", dir, prompt],
  }),
  grok: (prompt) => ({ cmd: bin("grok", "CYCLONE_GROK_BIN"), args: ["--permission-mode", "plan", "--disable-web-search", "--single", prompt] }),
  pi: (prompt) => ({ cmd: bin("pi", "CYCLONE_PI_BIN"), args: ["-p", "--no-session", "--no-tools", prompt] }),
};

export const PROOFREADERS = ["claude", ...Object.keys(PRESETS)];

// 可能把內容送到中國大陸雲端語言模型的校對者。pi 的 jev-router 擴充會把 fast 層路由到
// Z.ai（智譜 GLM），所以整個 pi 都算。claude（Anthropic）、codex（OpenAI）、cursor、
// grok（xAI）不在清單內。日後新增 preset 若可能走中國大陸雲端模型，要加進這裡。
export const MAY_USE_CHINA_CLOUD_LLM = ["pi"];

export function checkProofreader(name, privacy) {
  if (!PROOFREADERS.includes(name)) throw new Error(`--proofreader must be one of: ${PROOFREADERS.join(", ")}`);
  if (privacy !== "public" && MAY_USE_CHINA_CLOUD_LLM.includes(name)) {
    throw new Error(
      `--proofreader ${name} may route to a mainland-China cloud language model, so it cannot proofread content marked as containing personal data (--privacy ${privacy}); use another proofreader`,
    );
  }
}

function oneShot(name, systemPrompt, { timeoutMs = 300_000 } = {}) {
  const usage = newUsage();
  return {
    usage,
    async ask(userPrompt) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rt-${name}-`));
      const outFile = path.join(dir, "last-message.txt");
      try {
        const spec = PRESETS[name](`${systemPrompt}\n\n${userPrompt}`, dir, outFile);
        const r = spawnSync(spec.cmd, spec.args, { cwd: dir, input: spec.input ?? "", encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: agentEnv() });
        usage.calls += 1;
        if (r.error) throw new Error(`${name} could not run: ${r.error.code || r.error.message}`);
        if (r.status !== 0) throw new Error(`${name} exited ${r.status}`);
        return spec.readOut ? fs.readFileSync(outFile, "utf8") : String(r.stdout || "");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    close() {},
  };
}

// 動工前先確認這個 agent 的程式找得到，免得音訊抽完才失敗
export function proofreaderAvailable(name) {
  const cmd = name === "claude" ? null : PRESETS[name]?.("", os.tmpdir(), "").cmd;
  if (name === "claude") return fs.existsSync(claudeBin());
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  return spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" }).status === 0;
}

export function openProofreader(name, systemPrompt, opts = {}) {
  if (name === "claude") return openClaude(systemPrompt, opts);
  if (!PRESETS[name]) throw new Error(`unknown proofreader: ${name}`);
  return oneShot(name, systemPrompt, opts);
}
