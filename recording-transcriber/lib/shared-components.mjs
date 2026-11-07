// 會議轉錄 App 的共用元件（#111、#116，meeting-scribe#157、#166）：會後內容的畫面與存檔格式只在 App 的
// web/shared/ 改一處。工作室伺服器用這裡載入存檔格式 RecapFiles（recap-files.js），從這台的 meeting-scribe
// checkout 讀同一個檔，不複製；檔案改了（大小或修改時間）就重新載入。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { verifyShared } from "./shared-pin.mjs";

export const RECAP_FILES_MAJOR = "1";
let cached = null;

// 回傳 RecapFiles；找不到、載入失敗或主版號不對就丟出人看得懂的錯。
// pin：公開版釘的 SHA-256（lib/shared-pin.mjs）。有釘的話先驗證再執行「驗證過的那份內容」（不再讀一次檔，避免驗完被換掉），
// 因為這支程式是在工作室的 Node 行程裡直接跑，沒有瀏覽器沙箱。
export function loadRecapFiles(scribe, { pin = null } = {}) {
  const file = scribe ? path.join(scribe, "web", "shared", "recap-files.js") : "";
  let st;
  try { st = fs.statSync(file); } catch { throw new Error("找不到會議轉錄 App 的共用存檔格式（這台的 meeting-scribe 程式），先不寫檔"); }
  const stamp = `${file}|${st.size}|${st.mtimeMs}|${pin ? "pinned" : "open"}`;
  if (cached?.stamp === stamp) return cached.rf;
  let rf;
  if (pin) {
    const bytes = fs.readFileSync(file);
    const bad = verifyShared(pin, "recap-files.js", bytes);
    if (bad) throw new Error(`共用存檔格式和這個版本釘的不一致，先不寫檔：${bad}`);
    const mod = { exports: {} };
    try { new Function("module", "exports", "require", "__filename", "__dirname", bytes.toString("utf8")).call(mod.exports, mod, mod.exports, createRequire(file), file, path.dirname(file)); } catch (e) { throw new Error(`會議轉錄 App 的共用存檔格式載入失敗：${String(e?.message || e).slice(0, 120)}`); }
    rf = mod.exports;
  } else {
    const req = createRequire(file);
    delete req.cache[req.resolve(file)];
    try { rf = req(file); } catch (e) { throw new Error(`會議轉錄 App 的共用存檔格式載入失敗：${String(e?.message || e).slice(0, 120)}`); }
  }
  if (String(rf?.version || "").split(".")[0] !== RECAP_FILES_MAJOR) throw new Error(`會議轉錄 App 的共用存檔格式版本（${rf?.version || "?"}）和工作室不相容，先不寫檔`);
  cached = { stamp, rf };
  return rf;
}

// 這台 checkout 的網頁版本（App 的 deploy/build-pages.py --print-build；涵蓋 index.html 與 web/shared/ 全部檔）
export function localBuild(scribe, { spawnImpl = spawn, timeoutMs = 15_000, pin = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!scribe || !fs.existsSync(path.join(scribe, "deploy", "build-pages.py"))) return reject(new Error("找不到會議轉錄 App 的程式"));
    // 有釘選的話，叫起 python 之前先對照腳本內容（公開版出貨時釘的）
    if (pin) {
      const bad = verifyShared(pin, "deploy/build-pages.py", fs.readFileSync(path.join(scribe, "deploy", "build-pages.py")), "scripts");
      if (bad) return reject(new Error(`會議轉錄 App 的版本腳本和這個版本釘的不一致，不執行：${bad}`));
    }
    let out = "";
    const child = spawnImpl("python3", ["-I", "deploy/build-pages.py", "--print-build"], { cwd: scribe, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已經結束 */ } }, timeoutMs);
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const v = out.trim().split("\n").pop()?.trim() || "";
      if (code === 0 && /^[0-9a-f]{6,64}$/i.test(v)) resolve(v); else reject(new Error("算不出本機的網頁版本"));
    });
  });
}
