import { readVocabularyMap } from "../lib/manifest.mjs";
import { privateVocabulary, profileVocabulary, shouldApplyOpencc } from "../lib/asr-profile.mjs";
import { applyVocabulary } from "../lib/vocabulary.mjs";

// Post-processing for transcript text: OpenCC 簡→繁 (cn->twp: Taiwan wording
// with phrase conversion, e.g. 软件→軟體、人工智能→人工智慧) plus deterministic
// vocabulary replacement: shared ASR profile, then the private Wiki vocabulary
// when this host has it, then manifest.vocabulary (later layers win). OpenCC
// only runs for Chinese: pass the transcript language in opts.language; with
// no language a script heuristic decides.
//
// This is the non-LLM layer. OpenCC is a pure-JS dictionary converter
// (opencc-js); vocabulary is a {from: to} map applied as literal string
// replacement with the guards in lib/vocabulary.mjs. Context-sensitive
// proper-noun correction stays an LLM task and is left to the SKILL.md
// guidance, not this engine.

let converterCache = null;
let converterState = "untried"; // "untried" | "ok" | "missing"

async function getCnToTwConverter() {
  if (converterState !== "untried") return converterState === "ok" ? converterCache : null;
  converterState = "loading";
  try {
    const imported = await import("opencc-js");
    const OpenCC = imported.default || imported;
    converterCache = OpenCC.Converter({ from: "cn", to: "twp" });
    converterState = "ok";
  } catch (err) {
    converterState = "missing";
    console.error(
      "[postprocess] opencc-js unavailable — skipping 簡→繁. " +
      "Run `pnpm install` in the tool dir. " + (err?.message || err),
    );
  }
  return converterState === "ok" ? converterCache : null;
}

function vocabularyFor(manifest) {
  return { ...profileVocabulary(), ...privateVocabulary().vocabulary, ...readVocabularyMap(manifest) };
}

export async function postprocessText(text, manifest, opts = {}) {
  let out = String(text || "");
  const converter = shouldApplyOpencc(opts.language, out) ? await getCnToTwConverter() : null;
  if (converter) out = converter(out);
  return applyVocabulary(out, vocabularyFor(manifest));
}

export async function postprocessSegments(segments, manifest, opts = {}) {
  const sample = segments.map((seg) => seg.text || "").join(" ");
  const converter = shouldApplyOpencc(opts.language, sample) ? await getCnToTwConverter() : null;
  const vocabMap = vocabularyFor(manifest);
  if (!converter && Object.keys(vocabMap).length === 0) return segments;
  return segments.map((seg) => {
    let text = String(seg.text || "");
    if (converter) text = converter(text);
    text = applyVocabulary(text, vocabMap);
    return { ...seg, text };
  });
}

export function isOpenCCAvailable() {
  return converterState === "ok";
}
