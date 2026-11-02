#!/usr/bin/env node
// 字幕工作室存 Drive 的小程序（#105）：從 stdin 讀一行 JSON，把檔案複製到 Drive 的資料夾，
// 印一行 JSON 結果。Drive 卡住時卡的是這個程序，工作室會在逾時後把它結束（lib/studio-drive.mjs）。
//   輸入 {override?, profile, home, existing?, name, stamp, files: [絕對路徑]}
//   輸出 {root, folder, files} 或 {error, root?, folder?}
import { driveRoot, saveToDrive } from "../lib/studio-drive.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
let job, root = "";
try {
  job = JSON.parse(raw);
  root = driveRoot(job.override === undefined ? {} : { CYCLONE_STUDIO_DRIVE_DIR: job.override }, { studio_drive: job.profile }, { home: job.home });
  const r = saveToDrive({ root, existing: job.existing, name: job.name, stamp: job.stamp, files: Array.isArray(job.files) ? job.files : [] });
  process.stdout.write(`${JSON.stringify({ root, ...r })}\n`);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ error: String(e?.message || e).slice(0, 200), root, folder: e?.folder || "" })}\n`);
}
