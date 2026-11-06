#!/usr/bin/env node
// Remote transcription on another Mac (optional; set remote_host and
// icloud_inbox in the user profile).
//
//   pnpm run remote <youtube-url | file in iCloud <icloud_inbox>/transcribe> \
//     [--language auto|en|zh] [--keep-media]
//     [--host <ssh-host>] [--timeout-minutes 90] [--out <dir>] [--local-only] [--no-handoff]
//
// Flow: ping the remote Mac -> start a detached job -> poll with short ssh calls ->
// pull back manifest/transcripts/receipt -> delete the remote job dir and
// verify. Without a remote host the job runs locally. Any failure on the way (ssh, download, iCloud sync, ASR, harvest)
// falls back to running the same job locally with this tool, and the report
// says why.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isYouTubeUrl } from "./download-yt.mjs";
import { icloudInboxDir, normalizeLanguage, remoteHost, remoteToolDirShell, toolFingerprint } from "../lib/asr-profile.mjs";
import { parseLastJson } from "../lib/json-tail.mjs";
import { handoffEnabled, handoffFromPackage, handoffSubdir } from "../lib/wiki-handoff.mjs";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(TOOL_ROOT, "scripts", "transcript-cli.mjs");

function icloudInbox() {
  return process.env.CYCLONE_TRANSCRIBE_ICLOUD_INBOX || icloudInboxDir("transcribe");
}

function parseArgs(argv) {
  const opts = {
    source: "",
    language: "",
    keepMedia: false,
    host: remoteHost(),
    timeoutMinutes: Number(process.env.CYCLONE_TRANSCRIBE_TIMEOUT_MINUTES || 90),
    out: "",
    localOnly: false,
    handoff: true,
  };
  const args = argv.slice(2).filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--language") opts.language = args[++i] || "";
    else if (a === "--keep-media") opts.keepMedia = true;
    else if (a === "--privacy") i++; // 舊參數：已無作用，接受但忽略
    else if (a.startsWith("--privacy=")) continue;
    else if (a === "--host") opts.host = args[++i] || "";
    else if (a === "--timeout-minutes") opts.timeoutMinutes = Number(args[++i]);
    else if (a === "--out") opts.out = args[++i] || "";
    else if (a === "--local-only") opts.localOnly = true;
    else if (a === "--no-handoff") opts.handoff = false;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else if (!opts.source) opts.source = a;
    else throw new Error("only one source is allowed");
  }
  if (!opts.source) throw new Error("usage: transcribe-remote.mjs <youtube-url | file> [options]");
  if (opts.host && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.host)) throw new Error("invalid host alias");
  if (!(opts.timeoutMinutes > 0)) throw new Error("invalid --timeout-minutes");
  normalizeLanguage(opts.language || "auto");
  return opts;
}

// --- source classification ---

function classify(opts) {
  if (isYouTubeUrl(opts.source)) return { kind: "youtube", url: opts.source };
  const abs = path.resolve(opts.source);
  if (!fs.existsSync(abs)) throw new Error("source file not found");
  const real = fs.realpathSync(abs);
  let inbox = "";
  try {
    inbox = icloudInbox() ? fs.realpathSync(icloudInbox()) : "";
  } catch {
    inbox = "";
  }
  if (inbox && real.startsWith(inbox + path.sep)) {
    return { kind: "icloud", file: real, rel: path.relative(inbox, real) };
  }
  return { kind: "local", file: real };
}

// --- ssh helpers ---

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteCommand(args) {
  const toolDir = remoteToolDirShell();
  return `cd ${toolDir} && PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" `
    + `node scripts/transcript-job.mjs ${args.map(shellQuote).join(" ")}`;
}

function ssh(host, args, { binary = false, timeoutSeconds = 60 } = {}) {
  const bin = process.env.CYCLONE_TRANSCRIBE_SSH || "ssh";
  return spawnSync(bin, [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "--", host, remoteCommand(args),
  ], {
    encoding: binary ? undefined : "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutSeconds * 1000,
  });
}

function sshJson(host, args, opts) {
  const r = ssh(host, args, opts);
  const text = String(r.stdout || "").trim().split("\n").pop() || "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (r.status !== 0 || !json) {
    const why = json?.error || String(r.stderr || r.error?.message || "").trim().split("\n").pop()
      || `exit ${r.status}`;
    throw new Error(`${args[0]} failed: ${why}`);
  }
  return json;
}

// Best effort: reap job dirs abandoned by earlier timeouts or crashed clients.
function collectGarbage(opts, report) {
  if (!report.remote?.ping) return;
  try {
    const hours = Number(process.env.CYCLONE_TRANSCRIBE_GC_HOURS);
    const result = sshJson(opts.host, ["gc", "--hours", String(Number.isFinite(hours) && hours > 0 ? hours : 48)]);
    report.remote.gc_removed = (result.removed || []).length;
  } catch (error) {
    report.remote.gc_error = error.message;
  }
}

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// --- remote attempt ---

function runRemote(opts, source, jobId, localPackage, report) {
  report.remote = { host: opts.host, job_id: jobId };
  const ping = sshJson(opts.host, ["ping"]);
  report.remote.ping = ping;
  if (!ping.mlx_whisper) throw new Error("ping failed: mlx_whisper missing on remote host");
  if (source.kind === "icloud" && !ping.icloud_inbox) throw new Error("ping failed: remote iCloud inbox missing");
  const staleSetting = Number(process.env.CYCLONE_ICLOUD_STALE_HOURS);
  const staleHours = Number.isFinite(staleSetting) && staleSetting > 0 ? staleSetting : 6;
  const age = ping.icloud_last_sync_age_hours;
  if (source.kind === "icloud" && (age === null || age === undefined || age > staleHours)) {
    report.remote.icloud_warning = (age === null || age === undefined
      ? `remote iCloud sync state unknown (state ${ping.icloud_state ?? "unknown"}, no last-sync time); `
      : `remote iCloud last synced ${age} h ago (${ping.icloud_state}); `)
      + "new inbox files may not be there yet (see agent-config #626)";
    console.error(`[remote] WARNING: ${report.remote.icloud_warning}`);
  }
  const localFingerprint = toolFingerprint();
  report.consistency = {
    match: ping.tool_fingerprint === localFingerprint,
    local_tool_fingerprint: localFingerprint,
    remote_tool_fingerprint: ping.tool_fingerprint,
    remote_asr_profile_sha256: ping.asr_profile_sha256,
  };
  if (!report.consistency.match) {
    console.error("[remote] WARNING: tool fingerprint differs between this Mac and the remote; results may differ");
  }

  const startArgs = ["start", jobId];
  if (source.kind === "youtube") startArgs.push("--url", source.url);
  else startArgs.push("--icloud", source.rel);
  if (opts.language) startArgs.push("--language", opts.language);
  if (opts.keepMedia) startArgs.push("--keep-media");
  // Mark before the call: if the reply is lost the job dir may still exist,
  // so finish must run anyway.
  report.remote.started = true;
  sshJson(opts.host, startArgs);
  console.error(`[remote] job ${jobId} started on ${opts.host}`);

  const pollSeconds = Number(process.env.CYCLONE_TRANSCRIBE_POLL_SECONDS || 10);
  const deadline = Date.now() + opts.timeoutMinutes * 60 * 1000;
  let sshFailures = 0;
  let status = null;
  while (Date.now() < deadline) {
    sleep(pollSeconds);
    try {
      status = sshJson(opts.host, ["status", jobId]);
      sshFailures = 0;
    } catch (error) {
      sshFailures += 1;
      if (sshFailures >= 3) throw new Error(`status polling lost the remote host: ${error.message}`);
      continue;
    }
    if (status.state === "succeeded" || status.state === "failed" || status.state === "missing") break;
  }
  report.remote.status = status;
  if (status?.state === "missing") throw new Error("remote job disappeared before it finished");
  if (!status || (status.state !== "succeeded" && status.state !== "failed")) {
    throw new Error(`remote job timed out after ${opts.timeoutMinutes} min (state ${status?.state || "unknown"})`);
  }
  if (status.state === "failed") throw new Error(`remote transcription failed: ${status.error}`);

  const pack = ssh(opts.host, ["pack", jobId], { binary: true, timeoutSeconds: 600 });
  if (pack.status !== 0 || !pack.stdout?.length) throw new Error("harvest failed: could not pack the remote package");
  fs.mkdirSync(localPackage, { recursive: true });
  const untar = spawnSync("/usr/bin/tar", ["-xf", "-", "--no-same-owner", "-C", localPackage], { input: pack.stdout });
  if (untar.status !== 0) throw new Error("harvest failed: could not unpack the remote package");
  if (!fs.existsSync(path.join(localPackage, "manifest.json")) || !hasTranscript(localPackage)) {
    throw new Error("harvest failed: pulled package has no transcript");
  }
  report.executed_on = opts.host;
  report.engine = status.engine;
  report.fallbacks = status.fallbacks || [];
  report.remote.cleanup = status.cleanup;
}

function hasTranscript(dir) {
  const transcripts = path.join(dir, "transcripts");
  if (!fs.existsSync(transcripts)) return false;
  return fs.readdirSync(transcripts, { recursive: true })
    .some((name) => /(transcript\.md|segments\.json)$/.test(String(name)));
}

// Always try to delete the remote job dir, even after a failure, so nothing
// is left behind on the remote. Reports instead of throwing.
function finishRemote(opts, jobId, report) {
  if (!report.remote?.started) return;
  try {
    const result = sshJson(opts.host, ["finish", jobId]);
    report.remote.job_dir_removed = Boolean(result.removed);
    report.remote.job_dir_bytes = result.bytes || 0;
  } catch (error) {
    report.remote.job_dir_removed = false;
    report.remote.finish_error = error.message;
  }
}

// --- local fallback ---

function runLocal(opts, source, localPackage, report) {
  const input = source.url || source.file;
  // Same job as the remote: iCloud inbox files stay on local MLX (no cloud
  // engine), and a placeholder is fully downloaded before ASR starts.
  if (source.kind === "icloud") materializeLocal(source.file);
  const engine = source.kind === "icloud" ? "mlx" : "auto";
  const args = [CLI, input, "--engine", engine, "--out", localPackage, "--no-handoff"];
  if (opts.language) args.push("--language", opts.language);
  if (opts.keepMedia) args.push("--keep-media");
  const r = spawnSync(process.execPath, args, { cwd: TOOL_ROOT, encoding: "utf8" });
  if (r.stderr) process.stderr.write(r.stderr);
  const summary = parseLastJson(r.stdout);
  if (r.status !== 0 || !summary) throw new Error("local transcription failed too");
  report.executed_on = "local";
  report.engine = summary.engine;
  report.fallbacks = summary.fallbacks || [];
  report.local_cleanup = summary.cleanup;
}

function isDataless(file) {
  const r = spawnSync("/usr/bin/stat", ["-f", "%Sf", file], { encoding: "utf8" });
  return r.status === 0 && /dataless/.test(r.stdout);
}

function materializeLocal(file) {
  if (!isDataless(file)) return;
  spawnSync("/usr/bin/brctl", ["download", file], { stdio: "ignore" });
  const deadline = Date.now() + Number(process.env.CYCLONE_ICLOUD_DOWNLOAD_TIMEOUT_SECONDS || 1800) * 1000;
  while (isDataless(file)) {
    if (Date.now() > deadline) throw new Error("iCloud download timed out on this Mac too");
    sleep(2);
  }
}

function cleanupLine(prefix, cleanup) {
  if (!cleanup) return `${prefix}: no receipt`;
  if (cleanup.keep_media) return `${prefix}: --keep-media, media kept`;
  const mb = (b) => ((b || 0) / 1024 / 1024).toFixed(1);
  let line = `${prefix}: deleted ${cleanup.deleted} file(s) (${mb(cleanup.bytes_deleted)} MB)`;
  if (cleanup.trashed) line += `; trashed ${cleanup.trashed} (${mb(cleanup.bytes_trashed)} MB, still on disk)`;
  line += cleanup.leftovers ? `; LEFTOVERS ${cleanup.leftovers}` : "; no leftovers";
  return line;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(2);
  }
  const source = classify(opts);
  const jobId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(3).toString("hex")}`;
  const localPackage = opts.out
    ? path.resolve(opts.out)
    : path.join(os.homedir(), ".local", "state", "cyclone-transcript-packages", `remote-${jobId}`);
  // The fallback path deletes a half-harvested package, so it must never be a
  // directory that already holds someone's files.
  if (fs.existsSync(localPackage) && fs.readdirSync(localPackage).length > 0) {
    console.error("--out must be a new or empty directory");
    process.exit(2);
  }
  const report = { job_id: jobId, source_kind: source.kind, executed_on: "", fallback_reason: "" };

  const remoteAllowed = !opts.localOnly && source.kind !== "local" && Boolean(opts.host);
  if (!opts.host) {
    report.fallback_reason = "no remote host (set remote_host in the user profile or --host)";
  } else if (source.kind === "local") {
    report.fallback_reason = "file is not in the iCloud inbox, so the remote host cannot see it";
  } else if (opts.localOnly) {
    report.fallback_reason = "--local-only";
  }

  if (remoteAllowed) {
    try {
      runRemote(opts, source, jobId, localPackage, report);
    } catch (error) {
      report.fallback_reason = error.message;
      console.error(`[remote] falling back to local: ${error.message}`);
      fs.rmSync(localPackage, { recursive: true, force: true });
    } finally {
      try {
        finishRemote(opts, jobId, report);
      } finally {
        collectGarbage(opts, report); // independent of finish succeeding
      }
    }
  }
  if (!report.executed_on) {
    try {
      runLocal(opts, source, localPackage, report);
    } catch (error) {
      report.error = error.message;
    }
  }

  if (!report.package) report.package = localPackage;
  // 不論在遠端還是本機轉，交接單都只在這裡寫一份（有設定 icloud_inbox 才寫）
  if (report.executed_on && opts.handoff && handoffEnabled()) {
    try {
      report.handoff = { ok: true, name: handoffFromPackage(localPackage, { source: source.url || source.file }).name };
      console.error(`[handoff] wrote iCloud Drive/${handoffSubdir()}/${report.handoff.name}`);
    } catch (error) {
      report.handoff = { ok: false, error: String(error?.message || error).split("\n")[0] };
      console.error(`[handoff] FAILED, no wiki handoff written: ${report.handoff.error}`);
    }
  }
  if (fs.existsSync(localPackage)) {
    fs.writeFileSync(path.join(localPackage, "remote-run.json"), JSON.stringify(report, null, 2) + "\n");
    report.transcript = findTranscript(localPackage);
  }
  console.error(`[remote] executed_on=${report.executed_on || "none"}${report.fallback_reason ? ` (fallback: ${report.fallback_reason})` : ""}`);
  if (report.remote?.started) {
    console.error(cleanupLine("[cleanup] remote media", report.remote.cleanup));
    console.error(report.remote.job_dir_removed
      ? `[cleanup] remote job dir removed (${((report.remote.job_dir_bytes || 0) / 1024 / 1024).toFixed(1)} MB)`
      : `[cleanup] REMOTE JOB DIR LEFT on ${opts.host}: ${report.job_id} (${report.remote.finish_error || "unknown"})`);
  }
  if (report.executed_on === "local") console.error(cleanupLine("[cleanup] local media", report.local_cleanup));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.executed_on ? 0 : 1);
}

function findTranscript(dir) {
  const transcripts = path.join(dir, "transcripts");
  if (!fs.existsSync(transcripts)) return "";
  const hit = fs.readdirSync(transcripts, { recursive: true }).map(String).find((n) => n.endsWith("transcript.md"));
  return hit ? path.join(transcripts, hit) : "";
}

main();
