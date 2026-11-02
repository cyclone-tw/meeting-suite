// YouTube 設定（recording-transcriber#40）：每個使用者自己的，不進 repo。
//   一般設定：工作室 state 目錄的 youtube.json（OAuth 用戶端 ID、連結的頻道與各自的預設值）
//   機密：macOS 鑰匙圈（client secret、每個頻道的 refresh token），服務名稱 cyclone-subtitle-studio-youtube
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir, writePrivate } from "./studio-project.mjs";
import { checkDefaults } from "./youtube.mjs";

export const KEYCHAIN_SERVICE = "cyclone-subtitle-studio-youtube";
const SAFE = /^[\w\-./~+=:]{1,4096}$/;   // Google 的 token 與 secret 都只有這些字元；其他的不寫進鑰匙圈指令

// 鑰匙圈：寫入走 security -i 的標準輸入，值不會出現在程序清單上
export function keychainSecrets(service = KEYCHAIN_SERVICE) {
  return {
    get(account) {
      const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return r.status === 0 ? r.stdout.trim() : "";
    },
    set(account, value) {
      if (!SAFE.test(account) || !SAFE.test(value)) throw new Error("這個值含有不認得的字元，沒有存進鑰匙圈");
      const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] });
      if (r.status !== 0 || /error|denied/i.test(r.stderr || "")) throw new Error("沒辦法存進鑰匙圈（鑰匙圈可能被鎖住）");
    },
    delete(account) {
      spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" });
    },
  };
}

export const settingsFile = (env = process.env) => path.join(stateDir(env), "youtube.json");

export function loadSettings(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile(env), "utf8"));
    const channels = Array.isArray(j.channels) ? j.channels.filter((c) => typeof c?.id === "string").map((c) => ({
      id: c.id, title: String(c.title || c.id), thumb: typeof c.thumb === "string" ? c.thumb : "", connected: c.connected !== false,
      added: c.added || "", defaults: checkDefaults(c.defaults),
    })) : [];
    const client = typeof j.client?.client_id === "string" ? { client_id: j.client.client_id, project_id: String(j.client.project_id || "") } : null;
    const def = channels.some((c) => c.id === j.default_channel) ? j.default_channel : channels[0]?.id || "";
    return { client, channels, default_channel: def };
  } catch {
    return { client: null, channels: [], default_channel: "" };
  }
}

export function saveSettings(settings, env = process.env) {
  const dir = stateDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(settingsFile(env), JSON.stringify(settings, null, 1) + "\n");
}

export const secretAccount = { client: "client-secret", channel: (id) => `refresh:${id}` };
