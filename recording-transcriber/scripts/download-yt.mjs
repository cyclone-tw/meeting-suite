import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// YouTube source handling, ported from the Mac mini yt-monitor / audio-summary
// SKILL.md snippets into a reusable, vault-independent module.
// Captures metadata, lists/loads captions, and downloads audio (MP3).
// Pure yt-dlp wrapper — no Obsidian/Draco coupling.

export function isYouTubeUrl(value) {
  return /youtu\.be\/|youtube\.com\/(watch|shorts|embed)/.test(value || "");
}

export function getVideoMetadata(url) {
  const result = spawnSync("yt-dlp", [
    "--no-warnings", "--skip-download",
    "--print", "%(id)s|%(title)s|%(uploader)s|%(upload_date>%Y-%m-%d)s|%(duration_string)s|%(webpage_url)s",
    url,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("yt-dlp metadata failed: " + (result.stderr || result.stdout));
  }
  const [id, title, uploader, upload_date, duration, webpage_url] = result.stdout.trim().split("|");
  return { id, title: title || id, uploader, upload_date, duration, webpage_url: webpage_url || url };
}

export function listSubs(url) {
  const result = spawnSync("yt-dlp", ["--list-subs", url], { encoding: "utf8" });
  const raw = result.stdout || "";
  if (result.status !== 0) return { available: false, raw: "" };
  // yt-dlp prints a language table when captions exist; absence of language
  // rows means no captions. Detect only the languages downloadCaptions() will
  // actually fetch (en/zh/ja/ko) so auto doesn't pick captions then fail to
  // download anything.
  const hasLangRows = /(^|\n)\s*(en|zh|ja|ko)\b/i.test(raw) && /caption|subtitle/i.test(raw);
  return { available: hasLangRows, raw };
}

export function downloadCaptions(url, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const subLangs = opts.subLangs || process.env.YT_SUB_LANGS || "en-orig,en,zh-Hant,zh-Hans,ja,ko";
  const result = spawnSync("yt-dlp", [
    "--skip-download",
    "--write-subs", "--write-auto-subs",
    "--sub-langs", subLangs,
    "--sub-format", "vtt",
    "-o", path.join(outDir, "%(id)s.%(ext)s"),
    url,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, files: [], error: (result.stderr || result.stdout) };
  }
  const files = fs.readdirSync(outDir)
    .filter((f) => f.endsWith(".vtt") || f.endsWith(".srt"))
    .map((f) => path.join(outDir, f));
  return { ok: files.length > 0, files, error: files.length ? "" : "no caption files produced" };
}

export function downloadAudio(url, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const outTpl = opts.outTemplate || path.join(outDir, "%(upload_date>%Y-%m-%d)s-%(title)s.%(ext)s");
  const result = spawnSync("yt-dlp", [
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "-o", outTpl,
    url,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, files: [], error: (result.stderr || result.stdout) };
  }
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".mp3")).map((f) => path.join(outDir, f));
  return { ok: files.length > 0, files, error: files.length ? "" : "no mp3 produced" };
}

// --- CLI entry (also importable by transcript-cli) ---
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const positional = args.filter((a) => !a.startsWith("--"));
  const url = positional[0];
  const outEq = args.find((a) => a.startsWith("--out="));
  const outIdx = args.indexOf("--out");
  const outDir = outEq?.slice(6) || (outIdx >= 0 ? args[outIdx + 1] : "") || ".";
  const wantAudio = args.includes("--audio");
  const wantCaptions = args.includes("--captions");

  if (!url) {
    console.error("Usage: node download-yt.mjs <youtube-url> [--out <dir>] [--audio | --captions] [--meta]");
    process.exit(2);
  }
  const meta = getVideoMetadata(url);
  if (args.includes("--meta")) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }
  if (wantCaptions) {
    console.log(JSON.stringify({ meta, ...downloadCaptions(url, outDir) }, null, 2));
    return;
  }
  // default: audio (captions are normally driven by the orchestrator after listSubs)
  if (!wantAudio) console.error("[download-yt] no mode flag given, defaulting to --audio");
  console.log(JSON.stringify({ meta, ...downloadAudio(url, outDir) }, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(String(err?.stack || err));
    process.exit(1);
  });
}
