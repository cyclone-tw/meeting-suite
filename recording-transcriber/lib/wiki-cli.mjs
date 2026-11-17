// 使用者的 wiki 工具（CLI）：個人設定 wiki_cli 填指令名稱（#194、#197）。wiki 不在這台電腦上，
// 連線、金鑰與權限都由那支工具自己處理；這裡只負責找到它、叫它、把失敗說清楚。
// 用到的指令：
//   get --content -- <路徑>     印筆記正文（Ask AI、詞彙筆記）
//   get -- <路徑>               印 JSON 收據 {ok, commit, blob, path, content}（改筆記之前讀）
//   put --agent <名稱> --base-json <收據檔> --body-file <整篇> -- <路徑>   blob 對不上就拒寫
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 工具裝在哪裡因機器而異；從 Dock 開的工作室 PATH 很短，所以照固定順序找絕對路徑。
// 都沒有就回第一個，讓呼叫端標成「找不到」。CYCLONE_WIKI_BIN 可直接指定
export function wikiBin(name, env = process.env, { home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.CYCLONE_WIKI_BIN) return env.CYCLONE_WIKI_BIN;
  const candidates = [path.join(home, ".local", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  return candidates.find((p) => exists(p)) || candidates[0];
}

// 筆記在 wiki 裡的路徑（個人設定填的）：相對路徑、.md，不能往上跳，也不能長得像指令的選項。不合格回 ""
export function wikiNotePath(value) {
  const p = typeof value === "string" ? value.trim() : "";
  if (!p || p.length > 300 || p.startsWith("-") || !p.endsWith(".md") || /[\0\r\n\\]/.test(p)) return "";
  return p.split("/").some((part) => !part || part === "." || part === "..") ? "" : p;
}

export const WIKI_READ_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 4 * 1024 * 1024;

// 失敗的原因只說種類與工具自己給的錯誤代碼（「A1-unavailable: …」的冒號前面那段），
// 不照印工具的輸出：裡面可能有筆記內容或主機位址
function failure(r, timeoutMs) {
  if (r.error?.code === "ENOENT") return { kind: "missing", reason: "找不到 wiki 工具" };
  if (r.error?.code === "ETIMEDOUT" || r.signal) return { kind: "timeout", reason: `wiki 工具逾時，${Math.round(timeoutMs / 1000)} 秒沒有回應` };
  if (r.error) return { kind: "failed", reason: `wiki 工具跑不起來（${r.error.code || "error"}）` };
  let reply = null;
  try { reply = JSON.parse(String(r.stderr || "").trim().split("\n").pop()); } catch { /* 不是 JSON：只報結束碼 */ }
  const code = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}/.exec(typeof reply?.error === "string" ? reply.error : "")?.[0] || "";
  const id = reply?.receipt?.request_id;
  return {
    kind: "failed", code, reason: code ? `wiki 工具回報 ${code}` : `wiki 工具失敗，結束碼 ${r.status}`,
    ...(typeof id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(id) ? { requestId: id } : {}),
  };
}

// 跑一次工具（同步，不經過 shell）。回傳 { ok: true, stdout } 或 { ok: false, kind, reason, code?, requestId? }
export function wikiRun(bin, args, { timeoutMs = WIKI_READ_TIMEOUT_MS, env = process.env } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return { ok: false, ...failure(r, timeoutMs) };
  return { ok: true, stdout: r.stdout };
}

export const wikiGetContent = (bin, note, opts) => wikiRun(bin, ["get", "--content", "--", note], opts);
