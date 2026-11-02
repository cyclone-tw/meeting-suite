import { spawnSync } from "node:child_process";

// Speaker diarization scaffold via pyannote (Python).
//
// pyannote env differs across the two machines and needs an HF token + model
// download to be reliable, so this module is a GRACEFUL NO-OP by default: if
// pyannote.audio is not importable, or the rewrite path is not yet wired, it
// returns the segments unchanged with the existing hard-coded "Speaker" labels
// and logs a note. Full segment→speaker mapping is deferred to a later stage
// (see plan §stage-2) once both hosts have a stable pyannote setup.

export function isDiarizationAvailable(opts = {}) {
  const pybin = opts.python || process.env.PYANNOTE_PYTHON || "python3";
  const probe = spawnSync(pybin, ["-c", "import pyannote.audio"], { encoding: "utf8" });
  return probe.status === 0;
}

export function diarizeSegments(segments, audioFile, opts = {}) {
  if (!isDiarizationAvailable(opts)) {
    console.error(
      "[diarize] pyannote.audio not available — keeping default Speaker labels. " +
      "Set PYANNOTE_PYTHON or install pyannote to enable.",
    );
    return { segments, diarized: false };
  }
  // TODO(stage-2): run pyannote pipeline on audioFile, cluster speakers, and
  // rewrite each segment.speaker from "Speaker" to "SPEAKER_00" etc. Until then
  // we detect-but-do-not-rewrite so the timeline of labels stays stable.
  console.error("[diarize] pyannote detected but rewrite not implemented — keeping default Speaker labels.");
  return { segments, diarized: false };
}
