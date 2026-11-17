// 影片庫（#184）：左欄列使用者加入的資料夾與影片檔。資料夾掃成一棵樹（子資料夾可以收合），
// 只掃清單上的資料夾，限深度與數量；跳過隱藏檔、專案資料夾「-字幕」、工作室輸出的影片、各種套件。
// 清單上是使用者用 Finder 選的資料夾與檔案；第一次用（還沒有清單檔）會先放入舊首頁原本會掃的資料夾
// （影片、桌面、下載、iCloud 共用資料夾），之後只增減使用者自己加、自己移除的。
// 清單記在狀態資料夾的 library.json（0600），只有路徑。

import fs from "node:fs";
import path from "node:path";
import { VIDEO_EXTENSIONS } from "./studio-project.mjs";

export const MAX_DEPTH = 3;          // 加入的資料夾往下最多幾層
export const MAX_VIDEOS = 800;       // 一個資料夾最多列幾支
export const MAX_ENTRIES = 300;      // 清單最多幾個資料夾＋檔案

// 工作室自己輸出的（燒好字幕、剪接版、直式短片）不列；套件資料夾（App、照片圖庫、剪輯專案）不進去
const OUTPUT = /-字幕\.mp4$|-剪輯\.mp4$|-短片-\d+\.mp4$/u;
const SKIP_DIR = /(^\.|-字幕$|^\.work-|\.(app|photoslibrary|fcpbundle|imovielibrary|tvlibrary|musiclibrary|bundle|framework)$|^node_modules$)/iu;

export const isListedVideo = (name) => !name.startsWith(".") && VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) && !OUTPUT.test(name);
const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true });

// 資料夾 → { path, name, videos: [{ path, name, size, mtime }], dirs: [同樣的結構], truncated }。
// 影片新的在前；子資料夾照名稱排；裡面（含更深）沒有影片的子資料夾不列
export function scanFolder(root, { maxDepth = MAX_DEPTH, maxVideos = MAX_VIDEOS, fsImpl = fs } = {}) {
  let count = 0, truncated = false;
  function walk(dir, depth) {
    const node = { path: dir, name: path.basename(dir) || dir, videos: [], dirs: [] };
    let entries = [];
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return node; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIR.test(e.name)) {
          const sub = walk(p, depth + 1);
          if (sub.videos.length || sub.dirs.length) node.dirs.push(sub);
        }
      } else if (e.isFile() && isListedVideo(e.name)) {
        if (count >= maxVideos) { truncated = true; continue; }
        try {
          const st = fsImpl.statSync(p);
          node.videos.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs, offline: st.size > 0 && st.blocks === 0 });
          count += 1;
        } catch { /* 讀不到就略過 */ }
      }
    }
    node.videos.sort((a, b) => b.mtime - a.mtime);
    node.dirs.sort(byName);
    return node;
  }
  const tree = walk(path.resolve(root), 0);
  return { ...tree, truncated };
}

// library.json：{ version: 1, folders: [路徑], files: [路徑] }。
// 沒有這個檔（ENOENT）才算「還沒有清單」；檔案在但讀不到或壞掉時回空清單並標 broken，
// 呼叫端不能把它當成第一次而重建覆寫（改清單前先備份壞檔，見 backupBroken）
export function loadLibrary(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return e?.code === "ENOENT" ? { exists: false, broken: false, folders: [], files: [] } : { exists: true, broken: true, folders: [], files: [] };
  }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
    const list = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === "string" && path.isAbsolute(x)))].slice(0, MAX_ENTRIES);
    return { exists: true, broken: false, folders: list(j.folders), files: list(j.files) };
  } catch { return { exists: true, broken: true, folders: [], files: [] }; }
}

// 壞掉的清單檔在改寫前先留一份（library.json.broken，0600），之後還救得回來。
// 回傳有沒有備份成功：讀不到原檔或寫不出備份都是 false，呼叫端就不能覆寫原檔
export function backupBroken(file) {
  try { fs.writeFileSync(`${file}.broken`, fs.readFileSync(file), { mode: 0o600 }); return true; } catch { return false; }
}

export function saveLibrary(file, { folders, files }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, folders, files }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 加進清單：同一個路徑只留一個；資料夾和檔案分開
export function addEntry(lib, kind, p) {
  const key = kind === "folder" ? "folders" : "files";
  const abs = path.resolve(p);
  if (lib[key].includes(abs)) return lib;
  if (lib.folders.length + lib.files.length >= MAX_ENTRIES) throw new Error("影片庫的資料夾和檔案太多了");
  return { ...lib, [key]: [...lib[key], abs] };
}
export const removeEntry = (lib, p) => ({ ...lib, folders: lib.folders.filter((x) => x !== p), files: lib.files.filter((x) => x !== p) });
