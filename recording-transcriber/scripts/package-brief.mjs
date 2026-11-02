import fs from "node:fs";
import path from "node:path";
import { loadPackageForLocalTool } from "../lib/package-security.mjs";

const packagePath = process.argv.slice(2).find((arg) => arg !== "--");
if (!packagePath) {
  console.error("Usage: pnpm run brief -- /path/to/transcript-package");
  process.exit(2);
}

let loadedPackage;
try {
  loadedPackage = loadPackageForLocalTool(packagePath);
} catch (error) {
  console.error(String(error?.message || "Invalid transcript package."));
  process.exit(2);
}
const root = loadedPackage.root;
const manifest = loadedPackage.manifest;
const candidates = collectCandidates(manifest).map((candidate) =>
  auditCandidate(candidate, { includeSamples: true })
);
const outputsDir = path.join(root, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });

const briefPath = path.join(outputsDir, "package-brief.md");
fs.writeFileSync(briefPath, renderBrief(manifest, candidates), "utf8");

console.log(JSON.stringify({
  output: briefPath,
  candidates: candidates.length,
  contentMode: "samples-allowed",
}, null, 2));

function collectCandidates(data) {
  const result = [];
  const primarySegments = data.transcripts?.segments_json;
  if (primarySegments) {
    result.push({
      name: "primary",
      segmentsPath: resolvePackagePath(primarySegments, data),
      transcriptPath: data.transcripts?.raw_md ? resolvePackagePath(data.transcripts.raw_md, data) : "",
    });
  }

  for (const candidate of data.transcription_candidates || []) {
    if (!candidate.output_segments_json) continue;
    result.push({
      name: candidate.model || candidate.engine || "candidate",
      engine: candidate.engine || "",
      promptUsed: Boolean(candidate.prompt_used),
      qualityWarnings: Array.isArray(candidate.quality_warnings) ? candidate.quality_warnings : [],
      segmentsPath: resolvePackagePath(candidate.output_segments_json, data),
      transcriptPath: candidate.output_md ? resolvePackagePath(candidate.output_md, data) : "",
    });
  }

  return result;
}

function auditCandidate(candidate, { includeSamples }) {
  const report = {
    ...candidate,
    exists: fs.existsSync(candidate.segmentsPath),
    segmentCount: 0,
    textLength: 0,
    durationEnd: 0,
    avgCharsPerSegment: 0,
    promptLeaks: [],
    qualityWarnings: candidate.qualityWarnings || [],
    lowConfidenceCount: 0,
    samples: [],
  };

  if (!report.exists) return report;

  const data = JSON.parse(fs.readFileSync(candidate.segmentsPath, "utf8"));
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const text = segments.map((segment) => String(segment.text || "")).join("\n");
  const ends = segments.map((segment) => Number(segment.end || 0));

  report.segmentCount = segments.length;
  report.textLength = text.length;
  report.durationEnd = ends.length ? Math.max(...ends) : 0;
  report.avgCharsPerSegment = segments.length ? Math.round((text.length / segments.length) * 10) / 10 : 0;
  report.promptLeaks = leakPatterns().filter((pattern) => text.includes(pattern));
  report.lowConfidenceCount = segments.filter((segment) =>
    segment.avg_logprob !== undefined && Number(segment.avg_logprob) < -0.8
  ).length;
  report.samples = includeSamples ? sampleSegments(segments) : [];
  return report;
}

function renderBrief(data, candidates) {
  const lines = [
    "# Transcript Package Brief",
    "",
    "This brief is intentionally small. Read full transcript files only when verifying exact wording, decisions, dates, names, or unclear sections.",
    "",
    "## Package",
    "",
    `- Recording kind: \`${safeInline(data.recording_kind || "unknown")}\``,
    `- Updated: \`${safeInline(data.updated_at || "unknown")}\``,
  ];

  lines.push("", `- Package path: \`${safeInline(root)}\``, "", "## Source Files", "");
  for (const source of data.source_files || []) {
    lines.push(`- \`${safeInline(source.drive_path || source.path || "source")}\``);
  }
  if (!Array.isArray(data.source_files) || data.source_files.length === 0) {
    lines.push("- none recorded");
  }

  lines.push("", "## Candidate Quality", "");
  lines.push("| Candidate | Segments | Text chars | End time | Avg chars/segment | Prompt leak | Quality warning | Low confidence |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |");
  candidates.forEach((candidate) => {
    lines.push([
      `| ${safeCell(candidate.name)}`,
      candidate.segmentCount,
      candidate.textLength,
      formatTime(candidate.durationEnd),
      candidate.avgCharsPerSegment,
      candidate.promptLeaks.length ? candidate.promptLeaks.map(safeCell).join(", ") : "no",
      candidate.qualityWarnings.length ? candidate.qualityWarnings.map(safeCell).join(", ") : "no",
      `${candidate.lowConfidenceCount} |`,
    ].join(" | "));
  });

  const recommended = candidates.find((candidate) =>
    candidate.exists && candidate.textLength > 0 && candidate.promptLeaks.length === 0
  );
  lines.push(
    "",
    "## Recommended Next Read",
    "",
    recommended
      ? `- Start with \`${safeInline(relativeToPackage(recommended.transcriptPath || recommended.segmentsPath))}\` only for targeted verification.`
      : "- No summary-ready transcript candidate found. Re-run ASR or inspect audit output first.",
    "",
    "## Samples",
    "",
  );

  for (const candidate of candidates) {
    lines.push(`### ${safeInline(candidate.name)}`, "");
    if (!candidate.samples.length) {
      lines.push("- no samples", "");
      continue;
    }
    for (const sample of candidate.samples) {
      lines.push(`- [${formatTime(sample.start)}-${formatTime(sample.end)}] ${safeInline(sample.text)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function sampleSegments(segments) {
  const indexes = new Set();
  for (let index = 0; index < Math.min(2, segments.length); index += 1) indexes.add(index);
  const middle = Math.floor(segments.length / 2);
  for (let index = Math.max(0, middle - 1); index <= Math.min(segments.length - 1, middle); index += 1) {
    indexes.add(index);
  }
  for (let index = Math.max(0, segments.length - 2); index < segments.length; index += 1) indexes.add(index);

  return [...indexes].sort((a, b) => a - b).map((index) => {
    const segment = segments[index] || {};
    return {
      start: Number(segment.start || 0),
      end: Number(segment.end || segment.start || 0),
      text: clip(String(segment.text || "").trim().replace(/\s+/g, " ")),
    };
  }).filter((segment) => segment.text);
}

function resolvePackagePath(value, data) {
  if (!value) return "";
  const portable = resolvePortablePackagePath(value, data);
  if (portable) return portable;
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function resolvePortablePackagePath(value, data) {
  const packageId = data.package_id;
  const drivePath = data.drive_path || data.asset_package?.drive_path;
  const markers = [drivePath, packageId].filter(Boolean);

  for (const marker of markers) {
    const markerWithSlash = `${marker}/`;
    const index = value.indexOf(markerWithSlash);
    if (index === -1) continue;
    const relative = value.slice(index + markerWithSlash.length);
    return path.join(root, relative);
  }

  return "";
}

function relativeToPackage(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? path.relative(root, value) : value;
}

function leakPatterns() {
  return [
    "請保留繁體中文",
    "台灣語境",
    "專有名詞可能包含",
    "南開科技大學、AI、教學、研習",
  ];
}

function clip(value) {
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

function safeInline(value) {
  return clip(String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/`/g, "'")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;"));
}

function safeCell(value) {
  return safeInline(value).replace(/\|/g, "\\|");
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
