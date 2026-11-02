import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function expandHome(value) {
  if (!value || !value.startsWith("~/")) return value;
  return path.join(process.env.HOME || "", value.slice(2));
}

// Groq key resolution (ported from transcribe-groq.mjs):
//   1. GROQ_API_KEY env
//   2. macOS Keychain item with service groq-api-key (any account)
//   3. groq-config.json at GROQ_CONFIG_JSON (OpenClaw default paths retired, #637)
export function getGroqApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  const result = spawnSync("security", [
    "find-generic-password",
    "-s", "groq-api-key",
    "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  if (result.status === 0) return result.stdout.trim();
  return getGroqKeyValueFromConfig();
}

function getGroqKeyValueFromConfig() {
  const candidates = [
    process.env.GROQ_CONFIG_JSON,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const filePath = expandHome(candidate);
    if (!fs.existsSync(filePath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const value = config.apiKey || config.api_key || config.GROQ_API_KEY;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Ignore malformed config and continue to the next source.
    }
  }
  return "";
}

// Apify token resolution (for the YouTube no-caption fast-path).
//   1. APIFY_TOKEN env
//   2. apify-config.json .apiToken at APIFY_CONFIG_JSON
// The retired OpenClaw workspace no longer ships a default config (#637), so
// callers must treat "" as "engine unavailable, fall back".
export function getApifyToken() {
  if (process.env.APIFY_TOKEN) return process.env.APIFY_TOKEN;

  const candidates = [
    process.env.APIFY_CONFIG_JSON,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const filePath = expandHome(candidate);
    if (!fs.existsSync(filePath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const value = config.apiToken || config.api_token || config.APIFY_TOKEN;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Ignore malformed config and continue to the next source.
    }
  }
  return "";
}
