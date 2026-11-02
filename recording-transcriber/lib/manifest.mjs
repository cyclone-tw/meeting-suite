import fs from "node:fs";
import path from "node:path";

// Shared manifest I/O for the recording-transcriber tool scripts.
// Existing scripts (transcribe-groq/transcribe-package/package-brief) still use
// inline read/write; this lib is for the new transcript-pipeline modules so they
// don't reimplement the same JSON.parse/stringify boilerplate.

export function manifestPath(packagePath) {
  return path.join(packagePath, "manifest.json");
}

export function readManifest(packagePath) {
  const file = manifestPath(packagePath);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing manifest: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeManifest(packagePath, manifest) {
  const file = manifestPath(packagePath);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return file;
}

// manifest.vocabulary is a greenfield field (referenced only in audit comments
// before this). Normalized here to a {from: to} map so postprocess-text can do
// deterministic replacements without each caller parsing the shape.
// Accepted shapes:
//   { "简体词": "正體詞" }            -> kept as-is
//   [{ from: "a", to: "b" }, ...]     -> converted to map
//   ["詞1", "詞2"]                    -> hint-only list; returns {} (LLM-only vocab)
export function readVocabularyMap(manifest) {
  const raw = manifest?.vocabulary;
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const map = {};
    for (const entry of raw) {
      if (entry && typeof entry === "object" && entry.from && entry.to) {
        map[String(entry.from)] = String(entry.to);
      }
      // plain-string entries are hint-only (need LLM context); skipped here.
    }
    return map;
  }
  if (typeof raw === "object") {
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") map[String(k)] = v;
    }
    return map;
  }
  return {};
}
