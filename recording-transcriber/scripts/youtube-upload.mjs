#!/usr/bin/env node
// 不開字幕工作室，直接把做好的影片傳到 YouTube（recording-transcriber#159）。說明見 lib/youtube-cli.mjs 或 --help。
//   pnpm run youtube-upload <影片> --title "標題" [--desc-file 說明.md] [--privacy private|unlisted|public] [--channel <id>] [--playlist <id>]
import { fileURLToPath } from "node:url";
import path from "node:path";
import { USAGE, UsageError, channelsText, parseArgs, runUpload } from "../lib/youtube-cli.mjs";
import { keychainSecrets } from "../lib/youtube-settings.mjs";

async function main() {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n\n${USAGE}`); return 2; }
    throw e;
  }
  if (opts.channels) { console.log(channelsText()); return 0; }
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  try {
    await runUpload(opts, { fetch: (...a) => fetch(...a), secrets: keychainSecrets(), out: (s) => console.log(s), err: (s) => console.error(s), signal: ac.signal });
    return 0;
  } catch (e) {
    console.error(ac.signal.aborted ? "已停止上傳" : `沒有上傳成功：${String(e?.message || e).slice(0, 300)}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c));
