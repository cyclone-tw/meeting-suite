// 測試用的使用者設定檔：寫一份暫存 JSON，CYCLONE_ASR_PROFILE_USER 指過去。
// 子程序會繼承這個環境變數，所以測試啟動的腳本讀到的也是這份，不會讀到跑測試那台的真設定。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAsrProfileCache } from "../../lib/asr-profile.mjs";

export function useTestProfile(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-profile-"));
  const file = path.join(dir, "asr-profile.json");
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  process.env.CYCLONE_ASR_PROFILE_USER = file;
  resetAsrProfileCache();
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}
