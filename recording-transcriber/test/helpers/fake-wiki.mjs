#!/usr/bin/env node
// 測試用的假 wiki 工具（#197）：筆記就是 FAKE_WIKI_ROOT 底下的檔案，不連任何主機。
// 介面照真的工具：
//   get [--content] [--] <路徑>          --content 只印正文；不加就印 JSON 收據 {ok, commit, blob, path, content}
//   put --agent <名稱> --base-json <get 的 JSON> --body-file <整篇> [--] <路徑>
//                                        base 的 blob 和現在的不一樣就拒寫（blob-conflict）
// 失敗時 stderr 印一行 JSON（{ok:false, error:"代碼: 說明", receipt}），結束碼 1。
// 控制檔（放在 FAKE_WIKI_ROOT）：
//   .down             連不上（每個指令都失敗）
//   .hang             不回應（測逾時）
//   .edit-before-put  下一次 put 之前，別人先改了同一篇
// 每次呼叫記一行在 .calls，測試用來數「問了 wiki 幾次」。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// 和 git 的 blob 編號同一種算法
export const blobOf = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

// 建一支可執行的包裝（不依賴 repo 裡檔案的執行權限），CYCLONE_WIKI_BIN 指過去；測試啟動的子程序也會繼承
export function useFakeWiki() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-fake-wiki-"));
  const bin = path.join(dir, "fake-wiki");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${SELF}" "$@"\n`, { mode: 0o755 });
  process.env.CYCLONE_WIKI_BIN = bin;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

export function writeNote(root, rel, text) {
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

export const readNote = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

// 控制檔：mark(root, ".down") 開、mark(root, ".down", false) 關
export function mark(root, name, on = true) {
  if (on) fs.writeFileSync(path.join(root, name), "");
  else fs.rmSync(path.join(root, name), { force: true });
}

export function calls(root) {
  try { return fs.readFileSync(path.join(root, ".calls"), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

function main(argv) {
  const root = process.env.FAKE_WIKI_ROOT;
  const fail = (error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error, receipt: { request_id: "wiki-fake0001" } })}\n`);
    process.exit(1);
  };
  if (!root) fail("local-preflight-failed: no FAKE_WIKI_ROOT");
  const [op, ...rest] = argv;
  const flags = {}, pos = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--") { pos.push(...rest.slice(i + 1)); break; }
    if (a === "--content") flags.content = true;
    else if (["--agent", "--base-json", "--body-file"].includes(a)) flags[a.slice(2)] = rest[i += 1];
    else pos.push(a);
  }
  const rel = pos[0] || "";
  fs.appendFileSync(path.join(root, ".calls"), `${op}${flags.content ? " --content" : ""}${flags.agent ? ` agent=${flags.agent}` : ""} ${rel}\n`);
  if (fs.existsSync(path.join(root, ".hang"))) { setTimeout(() => {}, 600_000); return; }
  if (fs.existsSync(path.join(root, ".down"))) fail("A1-unavailable: SSH 或回應失敗；不使用本機 fallback");
  const file = path.join(root, rel);
  if (!rel || !fs.existsSync(file)) fail("not-found: 沒有這篇筆記");
  const current = () => fs.readFileSync(file, "utf8");
  if (op === "get") {
    const content = current();
    process.stdout.write(flags.content ? content : `${JSON.stringify({ ok: true, commit: "c".repeat(40), blob: blobOf(content), path: rel, content })}\n`);
    return;
  }
  if (op === "put") {
    if (!flags.agent) fail("invalid-agent: 要有 --agent");
    let base;
    try { base = JSON.parse(fs.readFileSync(flags["base-json"], "utf8")); } catch { fail("invalid-base-receipt: 讀不到 base JSON"); }
    if (base.ok !== true || base.path !== rel || !/^[0-9a-f]{40}$/.test(String(base.blob))) fail("invalid-base-receipt: 請使用同一路徑 get 的原始 JSON");
    const edit = path.join(root, ".edit-before-put");
    if (fs.existsSync(edit)) { fs.appendFileSync(file, "\n別人剛加的一行\n"); fs.rmSync(edit); }
    if (blobOf(current()) !== base.blob) fail("blob-conflict: 正本在讀取之後被改過，沒有寫入");
    const body = fs.readFileSync(flags["body-file"], "utf8");
    fs.writeFileSync(file, body);
    process.stdout.write(`${JSON.stringify({ ok: true, phase: "complete", path: rel, commit: "d".repeat(40), blob: blobOf(body), request_id: "wiki-fake0001" })}\n`);
    return;
  }
  fail(`unknown-op: ${op}`);
}

if (process.argv[1] === SELF) main(process.argv.slice(2));
