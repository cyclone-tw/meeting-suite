// 工作室的 AI 產出自動存一份到 Drive（使用者設定的 studio_drive，沒設就不存）：
// 和會議轉錄 App 同一個資料夾，每支影片一個子資料夾「日期 時分 名稱」（照 App 的 meeting_folder_name），
// 時間用錄影的時間，同一天好幾場也排得出先後。清除專案時，Drive 這份還在。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pad = (n) => String(n).padStart(2, "0");
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
// 檔名裡的時間：2026-10-25 21-01-30、2026-10-25_2101、20261025-210130 這類
const NAME_TIME = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]+(\d{2})[-_.:]?(\d{2})(?:[-_.:]?\d{2})?/;

// 錄影時間：先看名稱裡的時間，沒有就用影片檔的建立時間，都沒有用現在
export function recordingStamp(name, video, { statImpl = fs.statSync, now = new Date() } = {}) {
  const m = NAME_TIME.exec(String(name || ""));
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}${m[5]}`;
  }
  try {
    const st = statImpl(video);
    const t = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
    if (t && !Number.isNaN(t.getTime())) return stampOf(t);
  } catch { /* 讀不到就用現在 */ }
  return stampOf(now);
}

// 資料夾名「日期 時分 名稱」：名稱去掉開頭的時間（不重複），空的就叫「錄影」；不能有路徑符號
export function driveFolderName(name, stamp) {
  const title = String(name || "").replace(NAME_TIME, "").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/^[\s._-]+|[\s._-]+$/g, "").slice(0, 60);
  return `${stamp} ${title || "錄影"}`;
}

// 要存的 Drive 資料夾：CYCLONE_STUDIO_DRIVE_DIR 可改（空字串＝不存）；
// 沒設就找 ~/Library/CloudStorage 裡帳號結尾是 profile 的 account_suffix 那個，接上 folder
export function driveRoot(env = process.env, profile = {}, { home = os.homedir(), readdir = fs.readdirSync } = {}) {
  if (env.CYCLONE_STUDIO_DRIVE_DIR !== undefined) return env.CYCLONE_STUDIO_DRIVE_DIR;
  const cfg = profile.studio_drive || {};
  if (!cfg.account_suffix || !cfg.folder) return "";
  const base = path.join(home, "Library", "CloudStorage");
  let hit = "";
  try { hit = readdir(base).find((n) => n.startsWith("GoogleDrive-") && n.endsWith(cfg.account_suffix)) || ""; } catch { /* 沒掛載 */ }
  return hit ? path.join(base, hit, ...String(cfg.folder).split("/").filter(Boolean)) : "";
}

// 把檔案複製到這支影片在 Drive 的資料夾。第一次決定資料夾（已經有同名的就加 (2)），之後沿用 existing。
// 回傳 { folder, files }；失敗丟出人看得懂的錯
export function saveToDrive({ root, existing, name, stamp, files }) {
  if (!root) throw new Error("沒有設定要存的 Drive 資料夾");
  if (!fs.existsSync(root)) throw new Error("找不到要存的 Drive 資料夾（Google Drive 桌面版有開著、有登入設定的帳號嗎？）");
  let folder = existing && fs.existsSync(path.join(root, existing)) ? existing : "";
  if (!folder) {
    const base = driveFolderName(name, stamp);
    for (let n = 1; !folder; n += 1) {
      if (n > 50) throw new Error("同名的資料夾太多了");
      const cand = n === 1 ? base : `${base} (${n})`;
      try { fs.mkdirSync(path.join(root, cand)); folder = cand; } catch (e) { if (e.code !== "EEXIST") throw e; }
    }
  }
  const saved = [];
  try {
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      fs.copyFileSync(f, path.join(root, folder, path.basename(f)));
      saved.push(path.basename(f));
    }
  } catch (e) {
    throw Object.assign(e, { folder });   // 資料夾已經建好：記下來，下次沿用，不會多一個 (2)
  }
  return { folder, files: saved };
}

// 畫面上怎麼稱呼存的地方：「<label>／<資料夾名>」，label 預設 Google Drive
export function driveWhere(env = process.env, profile = {}) {
  const cfg = profile.studio_drive || {};
  const folder = env.CYCLONE_STUDIO_DRIVE_DIR || cfg.folder || "";
  const last = String(folder).split("/").filter(Boolean).pop() || "";
  const label = typeof cfg.label === "string" && cfg.label.trim() ? cfg.label.trim() : "Google Drive";
  return last ? `${label}／${last}` : label;
}

// 設定成不存：CYCLONE_STUDIO_DRIVE_DIR 是空字串，或沒設也沒有 studio_drive
export const driveDisabled = (env = process.env, profile = {}) =>
  env.CYCLONE_STUDIO_DRIVE_DIR === "" || (env.CYCLONE_STUDIO_DRIVE_DIR === undefined && !(profile.studio_drive?.account_suffix && profile.studio_drive?.folder));

// ---- 在另一個程序裡存（#105）----
// Google Drive 桌面版卡住時，讀寫它的資料夾會一直等。整件事交給一個小程序做、超過時間就放棄：
// 卡住的只是那個小程序，工作室照常可以用。找 Drive 資料夾（列 ~/Library/CloudStorage）也在小程序裡做
export const DRIVE_TIMEOUT_MS = 30_000;
const COPY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "drive-copy.mjs");

export function copyToDriveIsolated(job, { timeoutMs = DRIVE_TIMEOUT_MS, spawnImpl = spawn, script = COPY_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    let out = "", done = false;
    const child = spawnImpl(process.execPath, [script], { stdio: ["pipe", "pipe", "ignore"] });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已經結束 */ }
      finish(() => reject(new Error(`Google Drive 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應，先不存。Drive 恢復後按「再存一次」`)));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (out.length < 100_000) out += d; });
    child.on("error", (e) => finish(() => reject(new Error(`存 Drive 的程式跑不起來：${e.code || e.message}`))));
    child.on("close", () => finish(() => {
      let j = null;
      try { j = JSON.parse(out.trim().split("\n").pop() || "null"); } catch { /* 下面當失敗 */ }
      if (j && !j.error && j.folder) return resolve(j);
      reject(Object.assign(new Error(String(j?.error || "存 Drive 失敗").slice(0, 200)), { folder: j?.folder || "", root: j?.root || "" }));
    }));
    child.stdin.on("error", () => { /* 程序先結束時寫不進去，close 會處理 */ });
    child.stdin.end(JSON.stringify(job));
  });
}
