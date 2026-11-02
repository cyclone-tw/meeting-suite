import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApifyToken } from "../lib/keys.mjs";

// YouTube no-caption fast-path via Apify `pintostudio/youtube-transcript-scraper`.
//
// Token resolution is Mac-mini-only today (MacBook has no Apify source — see
// lib/keys.mjs getApifyToken). When unavailable we return ok:false with a clear
// reason so the orchestrator falls back to audio + Groq.
//
// The exact Apify dataset item shape is not pinned by any captured sample in
// the codebase, so assembly is defensive: it tolerates transcript/captions/
// subtitles arrays of {start,dur,text} and bare {text} items. Verify against a
// real run on the Mac mini and tighten if needed (see plan PR1 verification).

const APIFY_ACTOR_URL_FORM = "pintostudio~youtube-transcript-scraper";

export function isApifyAvailable() {
  return Boolean(getApifyToken());
}

export async function fetchApifyTranscript(url, opts = {}) {
  const token = getApifyToken();
  if (!token) {
    return { ok: false, reason: "no Apify token (Mac mini only)", segments: [], text: "" };
  }
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_URL_FORM}/run-sync-get-dataset-items`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ urls: [url] }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    return { ok: false, reason: `Apify HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`, segments: [], text: "" };
  }
  const items = await resp.json();
  const { segments, text } = assembleApifyItems(items);
  return {
    ok: segments.length > 0,
    reason: segments.length ? "" : "Apify returned no usable segments",
    segments,
    text,
    rawItems: items,
  };
}

function assembleApifyItems(items) {
  const segments = [];
  const arr = Array.isArray(items) ? items : [];
  for (const item of arr) {
    const caps = item?.transcript || item?.captions || item?.subtitles || item?.segments;
    if (Array.isArray(caps)) {
      for (const c of caps) {
        const t = String(c?.text || "").replace(/<[^>]+>/g, "").trim();
        if (!t) continue;
        const start = Number(c?.start ?? c?.startTime ?? 0);
        const dur = Number(c?.dur ?? c?.duration ?? 0);
        const end = c?.end != null ? Number(c.end) : start + dur;
        segments.push({
          speaker: "Speaker",
          start: round(start),
          end: round(end),
          text: t,
        });
      }
    } else if (typeof item?.text === "string" && item.text.trim()) {
      segments.push({ speaker: "Speaker", start: 0, end: 0, text: item.text.trim() });
    }
  }
  const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return { segments, text };
}

function round(v) {
  return Math.round(Number(v || 0) * 1000) / 1000;
}

// --- CLI entry ---
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const url = args.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("Usage: node transcribe-apify.mjs <youtube-url>");
    process.exit(2);
  }
  const result = await fetchApifyTranscript(url);
  if (!result.ok) {
    console.error(`[apify] unavailable: ${result.reason}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    segmentCount: result.segments.length,
    textLength: result.text.length,
    text: result.text,
  }, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(String(err?.stack || err));
    process.exit(1);
  });
}
