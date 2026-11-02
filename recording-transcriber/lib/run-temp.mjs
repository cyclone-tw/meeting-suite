import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Engine scratch space: wav conversions, Groq chunks, VAD output and raw ASR
// JSON. Each dir is removed on every exit path:
// normal end, thrown error, process.exit() and SIGINT／SIGTERM／SIGHUP. Callers
// may still remove a dir early; removal here is idempotent.
//
// The signal listeners also keep Node from dying mid-spawnSync: Ctrl-C reaches
// the ASR child first, the engine's own finally blocks run once it returns,
// and the process then exits with the usual 128+signal code.

const dirs = new Set();
let hooked = false;

export function makeRunTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.add(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", removeRunTempDirs);
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
      process.once(signal, () => process.exit(code));
    }
  }
  return dir;
}

export function removeRunTempDirs() {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    dirs.delete(dir);
  }
}
