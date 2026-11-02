import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRunTempDir } from "../lib/run-temp.mjs";

// VAD (voice activity detection) pre-processing via ffmpeg silenceremove.
//
// IMPORTANT: silenceremove DELETES silent stretches, which COMPRESSES the
// timeline. Segment timestamps produced from the trimmed audio are relative to
// the trimmed file, not the original recording. This is fine for summary-focused
// runs but breaks exact-to-original timestamp alignment. Only enable via --vad
// (or GROQ_VAD/VAD_ENABLED) when the consumer doesn't need original timings.
//
// Output is a fresh file in a run scratch dir that is removed when the process
// exits (#747); the original is never overwritten. On any ffmpeg failure we
// return the original path with vadApplied:false so callers proceed.

export function applyVad(inputFile, opts = {}) {
  const stopDuration = String(opts.stopDuration ?? process.env.VAD_STOP_DURATION ?? "0.5");
  const stopThreshold = String(opts.stopThreshold ?? process.env.VAD_STOP_THRESHOLD ?? "-40dB");

  const ext = path.extname(inputFile) || ".m4a";
  const outFile = path.join(makeRunTempDir("vad-"), `vad${ext}`);
  const filter = `silenceremove=stop_periods=-1:stop_duration=${stopDuration}:stop_threshold=${stopThreshold}`;

  const result = spawnSync("ffmpeg", [
    "-y", "-i", inputFile,
    "-af", filter,
    "-vn",
    outFile,
  ], { encoding: "utf8" });

  if (result.status !== 0 || !fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    const tail = (result.stderr || "").split("\n").filter(Boolean).slice(-2).join(" ");
    console.error(`[vad] ffmpeg silenceremove failed — keeping original. ${tail}`);
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    return { path: inputFile, vadApplied: false };
  }
  return { path: outFile, vadApplied: true, originalPath: inputFile };
}
