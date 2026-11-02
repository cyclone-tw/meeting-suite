// Discord 分軌標講者（recording-transcriber#126）：Craig 錄音機器人每人一個音檔，螢幕錄影另外錄。
//
// 辨識不變（整支影片一次）。字幕做好之後：
//   1. 影片音訊與分軌各轉成每 10 毫秒的音量（均方值），互相關找出時間差；頭尾各對一次算時鐘漂移。
//   2. 每句字幕在對應時間裡「有聲音的格數」最多的那一軌就是講者（音量只拿來打平手，這樣麥克風大聲的人
//      插一句「嗯」不會搶走別人的整句）；整句都沒有人聲就沿用前一句。
//   3. 換人講話時，那句前面加「【名字】」寫進字幕文字，SRT、燒字幕、YouTube CC、會後總結都會帶到。
// 時間一律是毫秒；「分軌時間」從 Craig 開始錄的那一刻算起，每一軌都對齊這個起點。

export const FRAME_MS = 10;
export const SAMPLE_RATE = 8000;                       // 只看音量，8 kHz 就夠
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
export const ACTIVE_LEVEL = 150 * 150;                 // 均方值超過這個（約 -47 dBFS）才算有人在講；Craig 沒聲音的地方是 0
export const MIN_CORR = 0.4;                           // 對齊的相關係數低於這個、或峰值不夠突出就不寫入：多半是拿錯 zip
export const MIN_PEAK_Z = 6;                          // 實測：同一場 12.7，別場 2–4
const COARSE = 5;                                      // 粗對齊用 50 毫秒一格
const WINDOW_MS = 20 * 60 * 1000;                      // 頭尾各拿 20 分鐘來對
const MAX_DRIFT = 1e-3;                                // 每秒漂超過 1 毫秒不合理，當成沒漂
const MAX_NAME = 12;
const LABEL = /^【([^】\s]{1,12})】\s*/u;

// info.txt 的 Tracks 段：「\talice#0 (123456789012345678)」，順序就是音檔前面的編號（1-alice.aac）。
// 只留帳號名稱；Discord ID 不留。
export function parseCraigInfo(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const startLine = lines.find((l) => /^Start time:/i.test(l));
  const start = startLine ? Date.parse(startLine.replace(/^Start time:\s*/i, "").trim()) : NaN;
  const at = lines.findIndex((l) => /^Tracks:\s*$/i.test(l.trim()));
  const tracks = [];
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      if (!l.trim()) break;
      const m = /^\s*(.+?)(?:#\d+)?\s*(?:\(\d+\))?\s*$/u.exec(l);
      if (m) tracks.push({ n: tracks.length + 1, user: m[1] });
    }
  }
  if (!tracks.length) throw new Error("info.txt 裡沒有分軌清單，這不像 Craig 的錄音檔");
  return { start: Number.isFinite(start) ? start : null, tracks };
}

// zip 裡的音檔：「<編號>-<帳號>.<副檔名>」。只收這種名字（不會解到別的路徑去）；
// 不收 * ? [ ]：unzip 會把參數當萬用字元（#128）
export const TRACK_FILE = /^(\d{1,3})-[^/\\*?[\]]+\.(?:aac|flac|ogg|opus|m4a|wav|mp3)$/iu;

export function trackFiles(entries, tracks) {
  const byN = new Map();
  for (const e of entries) {
    const m = TRACK_FILE.exec(e);
    if (m && !byN.has(Number(m[1]))) byN.set(Number(m[1]), e);
  }
  return tracks.map((t) => ({ ...t, file: byN.get(t.n) || "" })).filter((t) => t.file);
}

// 16-bit 單聲道 PCM 串流 → 每 10 毫秒的均方值。push 收的 Buffer 可以在任何位元組切開
export function createEnvelope() {
  const out = [];
  let carry = null, sum = 0, n = 0;
  return {
    push(buf) {
      let b = carry ? Buffer.concat([carry, buf]) : buf;
      const even = b.length - (b.length % 2);
      carry = even < b.length ? b.subarray(even) : null;
      for (let i = 0; i < even; i += 2) {
        const s = b.readInt16LE(i);
        sum += s * s;
        if (++n === FRAME_SAMPLES) { out.push(sum / n); sum = 0; n = 0; }
      }
    },
    done() {
      if (n) out.push(sum / n);
      return Float32Array.from(out);
    },
  };
}

export function mixEnvelopes(envs) {
  const len = Math.max(0, ...envs.map((e) => e.length));
  const mix = new Float32Array(len);
  for (const e of envs) for (let i = 0; i < e.length; i++) mix[i] += e[i];
  return mix;
}

// 對齊用的特徵：降採樣 → log(1+RMS) → 標準化。回傳特徵與「完全沒聲音」對應的值（超出分軌範圍時補這個）
function feature(env, factor) {
  const n = Math.floor(env.length / factor);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += env[i * factor + k];
    f[i] = Math.log1p(Math.sqrt(s / factor));
  }
  let mean = 0;
  for (const x of f) mean += x;
  mean /= n || 1;
  let v = 0;
  for (const x of f) v += (x - mean) ** 2;
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) f[i] = (f[i] - mean) / sd;
  return { f, silent: -mean / sd };
}

// v 的 [from, from+len) 對 m 從 from+lag 開始的同長度，算相關（兩邊各自在這段重新標準化）
function corrAt(v, from, len, m, mSilent, lag) {
  let sv = 0, sm = 0, svv = 0, smm = 0, svm = 0;
  for (let i = from; i < from + len; i++) {
    const a = v[i], j = i + lag, b = j >= 0 && j < m.length ? m[j] : mSilent;
    sv += a; sm += b; svv += a * a; smm += b * b; svm += a * b;
  }
  const cov = svm - (sv * sm) / len, va = svv - (sv * sv) / len, vb = smm - (sm * sm) / len;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// 也回傳峰值有多突出（比所有位置的平均高幾個標準差）：拿錯場的錄音也會在某個位置「剛好」有點像
function bestLag(v, from, len, m, mSilent, lo, hi) {
  let best = { lag: lo, corr: -Infinity }, s = 0, ss = 0;
  for (let lag = lo; lag <= hi; lag++) {
    const c = corrAt(v, from, len, m, mSilent, lag);
    s += c; ss += c * c;
    if (c > best.corr) best = { lag, corr: c };
  }
  const n = hi - lo + 1, mean = s / n, sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
  return { ...best, z: sd > 0 ? (best.corr - mean) / sd : 0 };
}

// 回傳 { offset_ms, drift, ref_ms, corr, tail_corr }：影片時間 t 對應分軌時間 t + offset_ms + drift × (t − ref_ms)
export function alignTracks(videoEnv, trackEnvs, { maxLagMs = 10 * 60 * 1000 } = {}) {
  const mix = mixEnvelopes(trackEnvs);
  const cv = feature(videoEnv, COARSE), cm = feature(mix, COARSE);
  const win = Math.min(cv.f.length, Math.round(WINDOW_MS / (FRAME_MS * COARSE)));
  if (win < 100) throw new Error("影片太短，沒辦法對齊");
  const maxLag = Math.round(maxLagMs / (FRAME_MS * COARSE));
  const coarse = bestLag(cv.f, 0, win, cm.f, cm.silent, -maxLag, maxLag);

  // 頭、尾各用 10 毫秒一格細對
  const fv = feature(videoEnv, 1), fm = feature(mix, 1);
  const fineWin = Math.min(fv.f.length, Math.round(WINDOW_MS / FRAME_MS));
  const guess = coarse.lag * COARSE;
  const head = bestLag(fv.f, 0, fineWin, fm.f, fm.silent, guess - 2 * COARSE, guess + 2 * COARSE);
  const out = { offset_ms: head.lag * FRAME_MS, drift: 0, ref_ms: (fineWin / 2) * FRAME_MS, corr: round(head.corr), peak_z: round(coarse.z), tail_corr: null };
  if (!aligned(out)) return out;
  if (fv.f.length >= 2 * fineWin) {
    const from = fv.f.length - fineWin;
    const tail = bestLag(fv.f, from, fineWin, fm.f, fm.silent, head.lag - 300, head.lag + 300);   // 頭尾差 ±3 秒內
    out.tail_corr = round(tail.corr);
    const dt = (from + fineWin / 2) * FRAME_MS - out.ref_ms;
    const drift = ((tail.lag - head.lag) * FRAME_MS) / dt;
    if (tail.corr >= MIN_CORR && Math.abs(drift) < MAX_DRIFT) out.drift = drift;
  }
  return out;
}

const round = (x) => Math.round(x * 1000) / 1000;
export const aligned = (a) => a.corr >= MIN_CORR && a.peak_z >= MIN_PEAK_Z;
export const trackTime = (t, a) => t + a.offset_ms + a.drift * (t - a.ref_ms);

// 每句字幕的講者（trackEnvs 的索引）；整句沒人聲沿用前一句，最前面沒人聲的是 -1
export function assignSpeakers(cues, trackEnvs, align, { level = ACTIVE_LEVEL } = {}) {
  let prev = -1;
  return cues.map((c) => {
    const a = Math.max(0, Math.floor(trackTime(c.start, align) / FRAME_MS));
    const b = Math.max(a + 1, Math.ceil(trackTime(c.end, align) / FRAME_MS));
    let best = -1, bestActive = 0, bestEnergy = 0;
    trackEnvs.forEach((env, k) => {
      let active = 0, energy = 0;
      for (let i = a; i < b && i < env.length; i++) {
        if (env[i] > level) active++;
        energy += env[i];
      }
      if (active > bestActive || (active === bestActive && active > 0 && energy > bestEnergy)) { best = k; bestActive = active; bestEnergy = energy; }
    });
    if (best >= 0) prev = best;
    return best >= 0 ? best : prev;
  });
}

// 顯示名稱：不能有【】與空白，最多 12 個字
export function cleanName(name) {
  const s = String(name ?? "").replace(/[【】\s]/gu, "").trim();
  return [...s].slice(0, MAX_NAME).join("");
}

// 拿掉字幕開頭之前加的講者標籤（只拿掉認得的名字，字幕本來就有的【】不動）
export function stripLabel(text, known) {
  const m = LABEL.exec(text);
  return m && known.has(m[1]) ? text.slice(m[0].length) : text;
}

// speakers[i] 是第 i 句的名字（或 null）。換人才加標籤；沒文字的句子不算換人
export function labelCues(cues, speakers, known) {
  let last = null;
  return cues.map((c, i) => {
    const text = stripLabel(c.text, known);
    const spk = speakers[i] || null;
    const { spk: _old, ...rest } = c;
    if (!spk) return { ...rest, text };
    const show = text.trim() && spk !== last;
    if (text.trim()) last = spk;
    return { ...rest, text: show ? `【${spk}】${text}` : text, spk };
  });
}

// ── 補回沒錄到的聲音（#129）──────────────────────────────────────────────
// 「獨白格」：只有這一軌有聲音、其他軌都沒有的 10 毫秒。看這些格子裡影片有沒有聲音：
// 有人講話、影片卻幾乎無聲 → 這個人沒錄進影片（例如 OBS 沒收到某個人的麥克風）。
const MISSING_RATIO = 0.2;     // 影片在他獨白時的音量，不到別人獨白時的兩成就算沒錄到（實測漏錄約 0.08）
const MIN_SOLO_FRAMES = 300;   // 至少要有 3 秒獨白才判斷

function median(xs) {
  if (!xs.length) return 0;
  const s = Float64Array.from(xs).sort();
  return s[Math.floor(s.length / 2)];
}

// 每一軌獨白時，影片與分軌的音量（RMS）
function soloLevels(videoEnv, trackEnvs, align, level) {
  const out = trackEnvs.map(() => ({ video: [], track: [] }));
  for (let i = 0; i < videoEnv.length; i++) {
    const j = Math.round(trackTime(i * FRAME_MS, align) / FRAME_MS);
    if (j < 0) continue;
    let who = -1;
    for (let k = 0; k < trackEnvs.length; k++) {
      if (j < trackEnvs[k].length && trackEnvs[k][j] > level) {
        if (who >= 0) { who = -2; break; }
        who = k;
      }
    }
    if (who >= 0) { out[who].video.push(Math.sqrt(videoEnv[i])); out[who].track.push(Math.sqrt(trackEnvs[who][j])); }
  }
  return out;
}

// 回傳每一軌 { solo_s, ratio, missing }；ratio 是影片在他獨白時的音量 ÷ 別人獨白時的音量
export function missingVoices(videoEnv, trackEnvs, align, { level = ACTIVE_LEVEL } = {}) {
  const solo = soloLevels(videoEnv, trackEnvs, align, level);
  return solo.map((s, k) => {
    const others = solo.flatMap((o, q) => (q === k ? [] : o.video));
    const enough = s.video.length >= MIN_SOLO_FRAMES && others.length >= MIN_SOLO_FRAMES;
    const ratio = enough ? median(s.video) / (median(others) || 1) : null;
    return { solo_s: s.video.length / 100, ratio: ratio === null ? null : round(ratio), missing: ratio !== null && ratio < MISSING_RATIO };
  });
}

// 補進去的聲音要和影片裡其他人一樣大聲：有錄到的那幾軌，獨白時「影片音量 ÷ 分軌音量」的中位數
export function voiceGain(videoEnv, trackEnvs, align, present, { level = ACTIVE_LEVEL } = {}) {
  const solo = soloLevels(videoEnv, trackEnvs, align, level);
  const ratios = present.flatMap((k) => solo[k].video.map((v, i) => v / (solo[k].track[i] || 1)));
  if (ratios.length < MIN_SOLO_FRAMES) return 1;
  return Math.min(4, Math.max(0.05, round(median(ratios))));
}

// ffmpeg 參數：影像直接複製，把 tracks（檔案路徑）對齊到影片時間後混進原本的聲音。
// 分軌時間 = (offset − drift·ref) + t·(1 + drift)：先切掉（或補上）開頭，再把速度調成影片的時鐘
// （先升到 192 kHz 再改取樣率，誤差每小時約 9 毫秒，比直接在 48 kHz 改準）。
export function fillArgs({ video, tracks, align, gain = 1, out, sampleRate = 48000 }) {
  if (!tracks.length) throw new Error("沒有要補的分軌");
  const start = (align.offset_ms - align.drift * align.ref_ms) / 1000;
  const hi = 192000, rate = Math.round(hi * (1 + align.drift));
  const head = start >= 0 ? `atrim=start=${start.toFixed(3)},asetpts=PTS-STARTPTS` : `adelay=${Math.round(-start * 1000)}:all=1`;
  const parts = tracks.map((_, i) => `[${i + 1}:a]${head},aresample=${hi},asetrate=${rate},aresample=${sampleRate},volume=${gain},aformat=channel_layouts=stereo[t${i}]`);
  const mix = `[0:a]${tracks.map((_, i) => `[t${i}]`).join("")}amix=inputs=${tracks.length + 1}:normalize=0:duration=first[a]`;
  return ["-v", "error", "-y", "-i", video, ...tracks.flatMap((t) => ["-i", t]),
    "-filter_complex", [...parts, mix].join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out];
}

// ── 找對得上的 zip（#129）──────────────────────────────────────────────
// OBS 預設的檔名就是開始錄影的時間（本機時區）：「2026-10-30 21-02-20.mp4」
export function startFromName(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:.](\d{2})[-:.](\d{2})/u.exec(String(name));
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

// Craig 開始錄的時間要落在「影片開始前 30 分鐘」到「影片結束」之間；有好幾個就挑開始時間最接近的
export function pickCraig(candidates, videoStart, durationMs) {
  if (!Number.isFinite(videoStart)) return null;
  const ok = candidates.filter((c) => Number.isFinite(c.start) && c.start >= videoStart - 30 * 60_000 && c.start <= videoStart + Math.max(0, durationMs || 0));
  ok.sort((a, b) => Math.abs(a.start - videoStart) - Math.abs(b.start - videoStart));
  return ok[0] || null;
}
