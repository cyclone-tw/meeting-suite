// 時間軸用的縮圖與聲音波形（recording-transcriber#4）。
// 只在記憶體裡產生、交給瀏覽器，不寫任何檔案（預覽用完即丟，不留衍生檔）。

import { spawn } from "node:child_process";

export const THUMB_W = 128, THUMB_H = 72;

function collect(bin, args, { signal, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    const chunks = [];
    let size = 0, err = "";
    p.stdout.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) { p.kill("SIGKILL"); return; }
      chunks.push(d);
    });
    p.stderr.on("data", (d) => { err = (err + d).slice(-1000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 && size <= maxBytes ? resolve(Buffer.concat(chunks)) : reject(new Error(`${bin} failed: ${err.trim().split("\n").pop() || code}`))));
  });
}

// 縮圖的時間點：平均分佈、每張至少隔 2 秒，最多 max 張；取每格中間
export function thumbTimes(durationMs, max = 120) {
  const n = Math.max(1, Math.min(max, Math.ceil(durationMs / 2000)));
  const step = durationMs / n;
  return Array.from({ length: n }, (_, i) => Math.round(step * (i + 0.5)));
}

// 一張一張用快速跳轉（-ss 放在 -i 前面、不精準對格）抓，同時跑 concurrency 張；每張好了就呼叫 onTile。
export async function thumbnails(video, durationMs, { onTile, signal, concurrency = 4, max = 120 } = {}) {
  const times = thumbTimes(durationMs, max);
  let next = 0;
  const worker = async () => {
    while (next < times.length && !signal?.aborted) {
      const i = next++;
      const jpg = await collect("ffmpeg", ["-v", "error", "-noaccurate_seek", "-ss", (times[i] / 1000).toFixed(3), "-i", video, "-frames:v", "1",
        "-vf", `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2`,
        "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "6", "-"], { signal, maxBytes: 1024 * 1024 }).catch(() => null);
      if (jpg?.length) onTile?.({ i, t_ms: times[i], jpg });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker));
  return times.length;
}

// 首頁的影片縮圖（recording-transcriber#18）：先讀片長，再取 10% 處（最多 2 分鐘）的一格，避開開頭的黑畫面。
// 一樣只在記憶體裡。讀不到片長時取第一格、duration_ms 回 0。
export const POSTER_W = 320, POSTER_H = 180;

export async function poster(video, { signal } = {}) {
  const probe = await collect("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { signal, maxBytes: 4096 }).catch(() => null);
  const sec = Number(String(probe || "").trim());
  const durationMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
  const at = Math.min(durationMs * 0.1, 120_000);
  const jpg = await collect("ffmpeg", ["-v", "error", "-noaccurate_seek", "-ss", (at / 1000).toFixed(3), "-i", video, "-frames:v", "1",
    "-vf", `scale=${POSTER_W}:${POSTER_H}:force_original_aspect_ratio=decrease,pad=${POSTER_W}:${POSTER_H}:(ow-iw)/2:(oh-ih)/2`,
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "-"], { signal, maxBytes: 1024 * 1024 }).catch(() => null);
  return { jpg: jpg?.length ? jpg : null, duration_ms: durationMs };
}

// 波形：聲音降到 2000 Hz 單聲道，每個區間取最大振幅，壓成 0–255。最多 maxBuckets 格，每格至少 20 ms。
export function peaksFromPcm(pcm, sampleRate, durationMs, maxBuckets = 20000) {
  const buckets = Math.max(1, Math.min(maxBuckets, Math.ceil(durationMs / 20)));
  const bucketMs = durationMs / buckets;
  const out = new Uint8Array(buckets);
  const samples = Math.floor(pcm.length / 2);
  for (let k = 0; k < samples; k++) {
    const v = Math.abs(pcm.readInt16LE(k * 2));
    const b = Math.min(buckets - 1, Math.floor(((k / sampleRate) * 1000) / bucketMs));
    const scaled = Math.min(255, Math.round(Math.sqrt(v / 32768) * 255));   // 開根號：小聲的段落也看得到
    if (scaled > out[b]) out[b] = scaled;
  }
  return { bucket_ms: bucketMs, peaks: out };
}

export async function waveform(video, durationMs, { signal } = {}) {
  const rate = 2000;
  const pcm = await collect("ffmpeg", ["-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { signal, maxBytes: 48 * 3600 * rate * 2 });
  return peaksFromPcm(pcm, rate, durationMs);
}
