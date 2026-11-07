// 共用元件的完整性釘選（#165）：Studio 直接執行隔壁 meeting-scribe checkout 的 web/shared/*.js，頁面上還有 Studio token，
// 所以公開版出貨時把那一份的 SHA-256 釘在 web/shared-pin.json（匯出工具自動產生），Studio 供應前對照，不符就拒絕。
// 私有開發的 checkout 沒有這個檔，就不檢查（兩個 repo 各自演進，不卡日常開發）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PIN_FILE = "web/shared-pin.json";
export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// 工作室的 Node 行程自己也會執行 meeting-scribe 的這些程式（不在瀏覽器沙箱裡），一併釘住：相對於 meeting-scribe 根目錄的路徑
export const PINNED_SCRIPTS = ["deploy/build-pages.py"];

// shared 目錄裡的 .js／.css（一般檔案，不跟符號連結）→ { schema, files: { 檔名: sha256 }, scripts: { 相對路徑: sha256 } }
// scripts：{ 相對路徑: 實際檔案路徑 }，沒有那個檔就略過
export function buildPin(sharedDir, scripts = {}) {
  const files = {};
  for (const ent of fs.readdirSync(sharedDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !/\.(js|css)$/.test(ent.name)) continue;
    files[ent.name] = sha256(fs.readFileSync(path.join(sharedDir, ent.name)));
  }
  const pinnedScripts = {};
  for (const [rel, file] of Object.entries(scripts)) if (fs.existsSync(file)) pinnedScripts[rel] = sha256(fs.readFileSync(file));
  return { schema: 1, files, scripts: pinnedScripts };
}

// scribeRoot：meeting-scribe 根目錄（PINNED_SCRIPTS 從那裡找）
export function scriptsOf(scribeRoot) {
  return Object.fromEntries(PINNED_SCRIPTS.map((rel) => [rel, path.join(scribeRoot, rel)]));
}

export function writePin(sharedDir, outFile, scripts = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(buildPin(sharedDir, scripts), null, 2) + "\n");
}

// 沒有釘選檔回 null；格式不對丟錯（寧可讓共用元件起不來，也不要當作沒釘）
export function loadPin(root) {
  const file = path.join(root, PIN_FILE);
  if (!fs.existsSync(file)) return null;
  let pin;
  try { pin = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${PIN_FILE} (shared-pin) is not valid JSON`); }
  const isMap = (m) => m && typeof m === "object" && !Array.isArray(m) && Object.values(m).every((h) => /^[0-9a-f]{64}$/.test(String(h)));
  if (!(pin && pin.schema === 1 && isMap(pin.files) && (pin.scripts === undefined || isMap(pin.scripts)))) throw new Error(`${PIN_FILE} (shared-pin) has an unknown format`);
  return { schema: 1, files: pin.files, scripts: pin.scripts || {} };
}

// 對得上回 null，否則回原因。which：files（shared 目錄的檔名）或 scripts（相對路徑）
export function verifyShared(pin, name, bytes, which = "files") {
  const map = pin[which] || {};
  const want = Object.hasOwn(map, name) ? map[name] : null;
  if (!want) return `${name} 不在釘的清單上 (not pinned)`;
  return sha256(bytes) === want ? null : `${name} 和釘的內容不一樣 (differs from the pin)`;
}
