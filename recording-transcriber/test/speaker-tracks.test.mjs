// Discord 分軌標講者（recording-transcriber#126）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FRAME_MS, MIN_CORR, MIN_PEAK_Z, alignTracks, aligned, fillArgs, missingVoices, pickCraig, startFromName, voiceGain, assignSpeakers, cleanName, createEnvelope, labelCues, parseCraigInfo, trackFiles, trackTime } from "../lib/speaker-tracks.mjs";
import { readProject, validateCues, writeProject } from "../lib/studio-project.mjs";
import { applySpeakers, findCraig, loadNames, namesMap, noteSeen, parseArgs, rememberNames, removeRosterUser, rosterList, setRosterName } from "../scripts/speaker-tracks.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const INFO = `Recording AbCdEf

Guild:\t\tTest Guild (1111111111111111111)
Channel:\tweekly (2222222222222222222)
Requester:\talice#0 (3333333333333333333)
Start time:\t2026-10-30T13:00:49.563Z

Tracks:
\talice#0 (3333333333333333333)
\t.bob#0 (4444444444444444444)
\tcarol.#1234 (5555555555555555555)
`;

test("Craig info.txt: users in track order, start time, no Discord IDs", () => {
  const info = parseCraigInfo(INFO);
  assert.equal(info.start, Date.parse("2026-10-30T13:00:49.563Z"));
  assert.deepEqual(info.tracks, [{ n: 1, user: "alice" }, { n: 2, user: ".bob" }, { n: 3, user: "carol." }]);
  assert.ok(!JSON.stringify(info).includes("3333333333"), "不留 Discord ID");
  assert.throws(() => parseCraigInfo("hello"), /分軌清單/);
});

test("track files: only <n>-<user>.<ext> at the zip root are used", () => {
  const files = trackFiles(["info.txt", "raw.dat", "1-alice.aac", "../2-_bob.aac", "x/2-_bob.aac", "2-_bob.aac", "3-carol_.flac"], parseCraigInfo(INFO).tracks);
  assert.deepEqual(files.map((t) => [t.user, t.file]), [["alice", "1-alice.aac"], [".bob", "2-_bob.aac"], ["carol.", "3-carol_.flac"]]);
});

test("envelope: 10 ms mean squares, buffers may split anywhere", () => {
  const samples = Int16Array.from({ length: 80 * 3 + 7 }, (_, i) => ((i * 37) % 2000) - 1000);
  const buf = Buffer.from(samples.buffer);
  const whole = createEnvelope();
  whole.push(buf);
  const pieces = createEnvelope();
  for (const [a, b] of [[0, 1], [1, 101], [101, 333], [333, buf.length]]) pieces.push(buf.subarray(a, b));
  const w = whole.done(), p = pieces.done();
  assert.equal(w.length, 4, "三格完整的加最後不滿一格的");
  assert.deepEqual(p, w);
  let s = 0;
  for (let i = 0; i < 80; i++) s += samples[i] ** 2;
  assert.ok(Math.abs(w[0] - s / 80) < 1e-3 * w[0]);
});

// 假的講話：每軌輪流說話（一段 1–6 秒），音量隨機
function fakeTracks(minutes, seed = 7) {
  let x = seed >>> 0;
  const rnd = () => {   // mulberry32：不同 seed 的序列彼此無關
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = (minutes * 60 * 1000) / FRAME_MS;
  const tracks = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n;) {
    const k = Math.floor(rnd() * 3), len = Math.floor((1000 + rnd() * 5000) / FRAME_MS);
    // 音量每 0.2 秒變一次、偶爾停頓，比較像真的講話
    for (let j = i; j < Math.min(n, i + len); j += 20) {
      const level = rnd() < 0.8 ? 1e5 + rnd() * 5e6 : 0;
      for (let q = j; q < Math.min(n, i + len, j + 20); q++) tracks[k][q] = level;
    }
    i += len + Math.floor((rnd() * 1500) / FRAME_MS);
  }
  return tracks;
}

// 影片的音訊：影片時間 t 聽到的是分軌時間 trackTime(t)（加一點底噪）
function fakeVideo(tracks, align, minutes) {
  const n = (minutes * 60 * 1000) / FRAME_MS;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.round(trackTime(i * FRAME_MS, align) / FRAME_MS);
    let s = 100;
    for (const t of tracks) if (j >= 0 && j < t.length) s += t[j];
    v[i] = s;
  }
  return v;
}

test("alignment finds the offset and the clock drift between the video and the tracks", () => {
  const tracks = fakeTracks(50);
  const truth = { offset_ms: 88_500, drift: -3.5e-5, ref_ms: 600_000 };
  const a = alignTracks(fakeVideo(tracks, truth, 46), tracks, { maxLagMs: 3 * 60 * 1000 });
  assert.ok(a.corr > 0.8, `相關 ${a.corr}`);
  assert.ok(a.tail_corr > 0.8, `尾段相關 ${a.tail_corr}`);
  for (const t of [0, 20 * 60_000, 45 * 60_000]) {
    assert.ok(Math.abs(trackTime(t, a) - trackTime(t, truth)) <= 30, `影片 ${t / 60_000} 分：差 ${trackTime(t, a) - trackTime(t, truth)} 毫秒`);
  }
});

test("alignment: the video may also start before the tracks; unrelated audio scores low", () => {
  const tracks = fakeTracks(12, 3);
  const a = alignTracks(fakeVideo(tracks, { offset_ms: -40_000, drift: 0, ref_ms: 0 }, 10), tracks, { maxLagMs: 60_000 });
  assert.ok(Math.abs(a.offset_ms + 40_000) <= 10, `offset ${a.offset_ms}`);
  assert.equal(a.tail_corr, null, "影片不到 40 分鐘不估漂移");
  assert.equal(a.drift, 0);
  const other = fakeTracks(12, 99);
  const bad = alignTracks(fakeVideo(other, { offset_ms: 0, drift: 0, ref_ms: 0 }, 10), tracks, { maxLagMs: 60_000 });
  assert.ok(bad.corr < MIN_CORR && bad.peak_z < MIN_PEAK_Z && !aligned(bad), `別場的錄音：相關 ${bad.corr}、突出度 ${bad.peak_z}`);
  assert.ok(aligned(a) && a.peak_z > MIN_PEAK_Z, `同一場：突出度 ${a.peak_z}`);
});

test("alignment: a repeating sound matches at many offsets and is refused as ambiguous", () => {
  const n = 10 * 60 * 100, t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = i % 1000 < 300 ? 1e6 : 0;   // 每 10 秒響 3 秒
  const v = Float32Array.from({ length: n - 3000 }, (_, i) => t[i + 3000] + 100);
  const a = alignTracks(v, [t], { maxLagMs: 120_000 });
  assert.ok(a.corr >= MIN_CORR, "相關很高……");
  assert.ok(a.peak_z < MIN_PEAK_Z && !aligned(a), `……但到處都像，峰值不突出（${a.peak_z}）`);
});

test("speaker per cue: most active time wins, loudness only breaks ties, silence keeps the previous", () => {
  const n = 1000;
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < 300; i++) a[i] = 1e5;               // 0–3 秒 A 小聲講
  for (let i = 100; i < 120; i++) b[i] = 1e8;             // 中間 B 大聲插一句
  for (let i = 400; i < 500; i++) b[i] = 1e6;             // 4–5 秒 B
  const align = { offset_ms: 0, drift: 0, ref_ms: 0 };
  const cues = [{ start: 0, end: 3000 }, { start: 4000, end: 5000 }, { start: 6000, end: 7000 }, { start: 8000, end: 9000 }];
  assert.deepEqual(assignSpeakers(cues, [a, b], align), [0, 1, 1, 1]);
  assert.deepEqual(assignSpeakers([{ start: 6000, end: 7000 }, ...cues], [a, b], align)[0], -1, "最前面沒人聲：還不知道是誰");
  // 時間差：分軌比影片早 1 秒開始 → 影片 3–4 秒是分軌 4–5 秒
  assert.deepEqual(assignSpeakers([{ start: 3000, end: 4000 }], [a, b], { offset_ms: 1000, drift: 0, ref_ms: 0 }), [1]);
});

test("labels: only when the speaker changes; old labels are replaced, other brackets kept", () => {
  const known = new Set(["小明", "小華", "小美"]);
  const cues = [
    { start: 0, end: 1, text: "【小華】大家好" },
    { start: 1, end: 2, text: "今天來聊" },
    { start: 2, end: 3, text: "" },
    { start: 3, end: 4, text: "【備註】這段是補充" },
    { start: 4, end: 5, text: "好啊", spk: "舊的" },
    { start: 5, end: 6, text: "嗯" },
  ];
  const out = labelCues(cues, ["小明", "小明", "小華", "小明", "小美", null], known);
  assert.deepEqual(out.map((c) => c.text), ["【小明】大家好", "今天來聊", "", "【備註】這段是補充", "【小美】好啊", "嗯"]);
  assert.deepEqual(out.map((c) => c.spk), ["小明", "小明", "小華", "小明", "小美", undefined], "沒判斷出來的不留舊的講者");
  assert.equal(out[0].start, 0);
  assert.equal(cleanName(" 小 明【1】"), "小明1");
  assert.equal(cleanName("一二三四五六七八九十壹貳參"), "一二三四五六七八九十壹貳");
});

test("saving from the studio keeps each cue's speaker", () => {
  const [c] = validateCues([{ start: 0, end: 1000, text: "【小明】嗨", spk: " 小明 " }]);
  assert.equal(c.spk, "小明");
  assert.equal(validateCues([{ start: 0, end: 1000, text: "嗨", spk: 3 }])[0].spk, undefined);
});

test("CLI arguments", () => {
  assert.deepEqual(parseArgs(["a.mp4", "c.zip", "--name", ".bob=鮑伯", "--dry-run"]), { target: "a.mp4", zip: "c.zip", names: { ".bob": "鮑伯" }, dryRun: true });
  assert.throws(() => parseArgs(["a.mp4", "c.zip", "--name", "bob"]), /帳號=名字/);
  assert.throws(() => parseArgs(["a.mp4"]), /usage/);
});

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "speakers-test-"));
}

function makeZip(dir, files) {
  const src = path.join(dir, "zipsrc");
  fs.mkdirSync(src);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(src, name), body);
  const zip = path.join(dir, "craig-test.aac.zip");
  const r = spawnSync("zip", ["-q", "-j", zip, ...Object.keys(files).map((n) => path.join(src, n))]);
  assert.equal(r.status, 0);
  return zip;
}

function makeProject(dir, cues) {
  const video = path.join(dir, "meet.mp4");
  fs.writeFileSync(video, "");
  const pdir = path.join(dir, "meet-字幕");
  fs.mkdirSync(pdir);
  writeProject(pdir, { version: 1, video, name: "meet", status: "ready", rev: 3, cues, cuts: [] });
  return { video, pdir };
}

test("apply: labels the project, bumps rev, writes the SRT and remembers names (fake audio)", async () => {
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  const zip = makeZip(dir, { "info.txt": INFO, "1-alice.aac": "x", "2-_bob.aac": "x", "3-carol_.aac": "x", "raw.dat": "x" });
  const tracks = fakeTracks(12, 5);
  const truth = { offset_ms: 30_000, drift: 0, ref_ms: 0 };
  const video = fakeVideo(tracks, truth, 10);
  // 每一段講話各一句字幕
  const cues = [];
  for (let i = 0; i < video.length && cues.length < 40; i += 500) cues.push({ start: i * FRAME_MS, end: (i + 200) * FRAME_MS, text: `第${cues.length}句` });
  const { video: vfile, pdir } = makeProject(dir, cues);
  const envelopeOf = async (f) => (f === vfile ? video : tracks[Number(path.basename(f)[0]) - 1]);

  const s = await applySpeakers({ target: vfile, zip, names: { alice: "愛麗絲", ".bob": "鮑伯" }, dryRun: false }, { env, envelopeOf });
  assert.equal(s.offset_s, 30);
  assert.deepEqual(s.unnamed, ["carol."]);
  const p = readProject(pdir);
  assert.equal(p.rev, 4);
  // 預期值直接看假資料：每句時間裡「有聲音的格數」最多的那一軌（不呼叫 assignSpeakers，#128）
  const expect = cues.map((c) => {
    const a = (c.start + truth.offset_ms) / FRAME_MS, b = (c.end + truth.offset_ms) / FRAME_MS;
    const active = tracks.map((t) => { let n = 0; for (let i = a; i < b; i++) if (t[i] > 150 * 150) n++; return n; });
    return active.some((n) => n) ? ["愛麗絲", "鮑伯", "carol."][active.indexOf(Math.max(...active))] : null;
  });
  for (let i = 1; i < expect.length; i++) expect[i] ??= expect[i - 1];
  assert.deepEqual(p.cues.map((c) => c.spk), expect);
  assert.ok(p.cues[0].text.startsWith(`【${expect[0]}】`));
  assert.match(fs.readFileSync(path.join(pdir, "subtitles.srt"), "utf8"), /【(愛麗絲|鮑伯|carol\.)】第0句/u);
  assert.deepEqual(p.speakers.tracks, [{ user: "alice", name: "愛麗絲" }, { user: ".bob", name: "鮑伯" }, { user: "carol.", name: "carol." }]);
  const saved = fs.readFileSync(path.join(dir, "state", "speakers.json"), "utf8");
  assert.deepEqual(JSON.parse(saved).names, { alice: "愛麗絲", ".bob": "鮑伯" });
  assert.ok(!saved.includes("3333333333") && !JSON.stringify(p).includes("3333333333"), "不存 Discord ID");

  // 重跑：名字從 speakers.json 來，舊標籤換掉，不會疊兩層
  await applySpeakers({ target: pdir, zip, names: {}, dryRun: false }, { env, envelopeOf });
  const again = readProject(pdir);
  assert.equal(again.rev, 5);
  assert.deepEqual(again.cues.map((c) => c.text), p.cues.map((c) => c.text));

  // 試跑不寫入
  await applySpeakers({ target: pdir, zip, names: { alice: "A" }, dryRun: true }, { env, envelopeOf });
  assert.equal(readProject(pdir).rev, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state", "speakers.json"), "utf8")).names.alice, "愛麗絲");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply refuses a zip from another meeting and a project still processing", async () => {
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  const zip = makeZip(dir, { "info.txt": INFO, "1-alice.aac": "x", "2-_bob.aac": "x", "3-carol_.aac": "x" });
  const tracks = fakeTracks(12, 5);
  const other = fakeVideo(fakeTracks(12, 77), { offset_ms: 0, drift: 0, ref_ms: 0 }, 10);
  const { video, pdir } = makeProject(dir, [{ start: 0, end: 1000, text: "嗨" }]);
  const envelopeOf = async (f) => (f === video ? other : tracks[Number(path.basename(f)[0]) - 1]);
  await assert.rejects(applySpeakers({ target: video, zip, names: {}, dryRun: false }, { env, envelopeOf }), /對不起來/);
  assert.equal(readProject(pdir).rev, 3, "沒有寫入");
  assert.equal(readProject(pdir).cues[0].text, "嗨");

  const p = readProject(pdir);
  writeProject(pdir, { ...p, status: "processing" });
  await assert.rejects(applySpeakers({ target: video, zip, names: {}, dryRun: false }, { env, envelopeOf }), /還沒處理完/);
  await assert.rejects(applySpeakers({ target: path.join(dir, "nope.mp4"), zip, names: {}, dryRun: false }, { env, envelopeOf }), /找不到字幕專案/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply end to end with real audio files", { skip: !hasFfmpeg }, async () => {
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  // 三軌 60 秒：A 講 2–8、20–26 秒，B 講 10–16、40–46 秒，C 講 30–36 秒（其他時間是 0）
  const talk = { "1-alice.aac": [[2, 8], [20, 26]], "2-_bob.aac": [[10, 16], [40, 46]], "3-carol_.aac": [[30, 36]] };
  const src = path.join(dir, "zipsrc");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "info.txt"), INFO);
  for (const [name, spans] of Object.entries(talk)) {
    const on = spans.map(([a, b]) => `between(t,${a},${b})`).join("+");
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `anoisesrc=d=60:c=pink:r=48000:a=0.3`, "-af", `volume='if(${on},1,0)':eval=frame`, "-c:a", "aac", path.join(src, name)]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  const zip = path.join(dir, "craig.aac.zip");
  assert.equal(spawnSync("zip", ["-q", "-j", zip, ...fs.readdirSync(src).map((n) => path.join(src, n))]).status, 0);
  // 影片晚 5 秒開始錄：影片時間 t = 分軌時間 t + 5
  const vfile = path.join(dir, "meet.mp4");
  const ins = Object.keys(talk).flatMap((n) => ["-i", path.join(src, n)]);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=55", ...ins,
    "-filter_complex", "[1:a][2:a][3:a]amix=inputs=3:normalize=0,atrim=start=5,asetpts=PTS-STARTPTS[a]", "-map", "0:v", "-map", "[a]", "-shortest", "-c:v", "libx264", "-c:a", "aac", vfile]);
  assert.equal(r.status, 0, String(r.stderr));
  const pdir = path.join(dir, "meet-字幕");
  fs.mkdirSync(pdir);
  // 換成影片時間（減 5 秒）：A 0–3、B 5–11、A 15–21、C 25–31、B 35–41
  const cues = [[0, 3, "甲"], [5, 11, "乙"], [15, 21, "丙"], [25, 31, "丁"], [35, 41, "戊"]].map(([a, b, t]) => ({ start: a * 1000, end: b * 1000, text: t }));
  writeProject(pdir, { version: 1, video: vfile, name: "meet", status: "ready", rev: 1, cues, cuts: [] });
  const s = await applySpeakers({ target: vfile, zip, names: { alice: "A", ".bob": "B", "carol.": "C" }, dryRun: false }, { env });
  assert.ok(Math.abs(s.offset_s - 5) <= 0.05, `時間差 ${s.offset_s}`);
  assert.deepEqual(readProject(pdir).cues.map((c) => c.text), ["【A】甲", "【B】乙", "【A】丙", "【C】丁", "【B】戊"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("drift falls back to 0 when the tail does not match", () => {
  const tracks = fakeTracks(50);
  const truth = { offset_ms: 20_000, drift: 0, ref_ms: 600_000 };
  const video = fakeVideo(tracks, truth, 46);
  const tail = fakeTracks(50, 1234);   // 尾段換成別場的聲音
  for (let i = video.length - 20 * 60 * 100; i < video.length; i++) video[i] = tail[0][i] + tail[1][i] + 100;
  const a = alignTracks(video, tracks, { maxLagMs: 60_000 });
  assert.ok(aligned(a));
  assert.ok(a.tail_corr < MIN_CORR, `尾段相關 ${a.tail_corr}`);
  assert.equal(a.drift, 0);
});

test("missing voices: someone talking while the video is silent; gain from the voices that are there", () => {
  const tracks = fakeTracks(12, 21);
  const align = { offset_ms: 5000, drift: 0, ref_ms: 0 };
  // 影片只錄到第 0、1 軌，而且音量是分軌的 0.5 倍（均方值 0.25 倍）
  const video = fakeVideo([tracks[0], tracks[1]], align, 10).map((v) => (v - 100) * 0.25 + 100);
  const m = missingVoices(video, tracks, align);
  assert.deepEqual(m.map((x) => x.missing), [false, false, true]);
  assert.ok(m[2].ratio < 0.05 && m[0].ratio > 0.5, JSON.stringify(m));
  assert.ok(Math.abs(voiceGain(video, tracks, align, [0, 1]) - 0.5) < 0.02);
  // 獨白不到 3 秒：不判斷
  const short = [tracks[0], Float32Array.from(tracks[1], (v, i) => (i < 200 ? v : 0))];
  assert.equal(missingVoices(video, short, align)[1].ratio, null);
});

test("fill args: trim or pad the head, correct the clock, mix only the given tracks", () => {
  const a = fillArgs({ video: "/v.mp4", tracks: ["/t/4-me.aac"], align: { offset_ms: 88_500, drift: -3.5e-5, ref_ms: 600_000 }, gain: 0.7, out: "/o.mp4" });
  const fc = a[a.indexOf("-filter_complex") + 1];
  assert.match(fc, /^\[1:a\]atrim=start=88\.521,asetpts=PTS-STARTPTS,aresample=192000,asetrate=191993,aresample=48000,volume=0\.7,/);
  assert.match(fc, /\[0:a\]\[t0\]amix=inputs=2:normalize=0:duration=first\[a\]$/);
  assert.deepEqual(a.slice(-13), ["-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "/o.mp4"], "影像直接複製");
  const late = fillArgs({ video: "/v.mp4", tracks: ["/a.aac", "/b.aac"], align: { offset_ms: -2500, drift: 0, ref_ms: 0 }, out: "/o.mp4" });
  const fc2 = late[late.indexOf("-filter_complex") + 1];
  assert.match(fc2, /\[1:a\]adelay=2500:all=1,.*\[2:a\]adelay=2500:all=1,.*\[0:a\]\[t0\]\[t1\]amix=inputs=3/, "分軌比影片晚開始：前面補靜音");
  assert.throws(() => fillArgs({ video: "/v.mp4", tracks: [], align: { offset_ms: 0, drift: 0, ref_ms: 0 }, out: "/o.mp4" }), /沒有要補/);
});

test("matching a Craig zip to a video by its start time", () => {
  const t = startFromName("2026-10-30 21-02-20.mp4");
  assert.equal(t, new Date(2026, 9, 30, 21, 2, 20).getTime(), "OBS 檔名是本機時間");
  assert.equal(startFromName("錄影.mp4"), null);
  const c = (iso, file) => ({ start: Date.parse(iso), file });
  const list = [c("2026-10-30T12:00:00Z", "早"), c("2026-10-30T13:00:49Z", "這場"), c("2026-10-16T13:01:35Z", "上週")];
  const start = Date.parse("2026-10-30T13:02:20Z");
  assert.equal(pickCraig(list, start, 6_346_000).file, "這場");
  assert.equal(pickCraig(list, Date.parse("2026-10-20T13:00:00Z"), 3_600_000), null, "差太多的不算");
  assert.equal(pickCraig(list, NaN, 0), null);
});

test("names: no inherited keys, cleaned, remembered across runs; findCraig reads only Craig zips", () => {
  const n = namesMap({ alice: " 愛 麗絲 ", empty: "【】" }, { constructor: "C" });
  assert.equal(n.toString, undefined, "沒有原型（#128）");
  assert.deepEqual({ ...n }, { alice: "愛麗絲", constructor: "C" });
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  rememberNames({ alice: "A" }, env);
  rememberNames({ ".bob": "B" }, env);
  assert.deepEqual({ ...loadNames(env) }, { alice: "A", ".bob": "B" });
  makeZip(dir, { "info.txt": INFO, "1-alice.aac": "x" });   // craig-test.aac.zip，2026-10-30T13:00:49Z
  fs.writeFileSync(path.join(dir, "craig-broken.zip"), "not a zip");
  const local = new Date(Date.parse("2026-10-30T13:02:20Z"));
  const named = path.join(dir, `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")} ${String(local.getHours()).padStart(2, "0")}-${String(local.getMinutes()).padStart(2, "0")}-20.mp4`);
  fs.writeFileSync(named, "");
  const found = findCraig(named, [dir], 3_600_000, env);
  assert.equal(found.file, "craig-test.aac.zip");
  assert.deepEqual(found.tracks.map((t) => [t.user, t.name]), [["alice", "A"], [".bob", "B"], ["carol.", ""]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("roster (#132): old speakers.json still reads; seen keeps the latest local date; add, rename, remove", () => {
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  fs.mkdirSync(path.join(dir, "state"));
  const file = path.join(dir, "state", "speakers.json");
  fs.writeFileSync(file, JSON.stringify({ names: { alice: "A", ".bob": "B" } }));   // #129 的舊格式
  assert.deepEqual({ ...loadNames(env) }, { alice: "A", ".bob": "B" });
  assert.deepEqual(rosterList(env), [{ user: ".bob", name: "B", seen: "" }, { user: "alice", name: "A", seen: "" }]);

  const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const late = Date.parse("2026-10-30T13:00:49Z"), early = Date.parse("2026-10-16T13:01:35Z");
  noteSeen(["alice", "carol."], late, env);
  noteSeen(["alice", "", 3, " pad"], early, env);   // 比較舊的那場不會蓋掉；不像帳號的略過
  assert.deepEqual(rosterList(env), [
    { user: "alice", name: "A", seen: day(late) },
    { user: "carol.", name: "", seen: day(late) },   // 出現過、還沒取名的也列出來
    { user: ".bob", name: "B", seen: "" },
  ]);
  rememberNames({ alice: "愛麗絲" }, env);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).seen.alice, day(late), "記名字不會弄丟出現日期");

  assert.deepEqual(setRosterName(" carol. ", " 卡 蘿 ", env), { user: "carol.", name: "卡蘿", seen: day(late) });
  assert.deepEqual(setRosterName("dave", "Dave", env), { user: "dave", name: "Dave", seen: "" }, "開會前先加新成員");
  assert.throws(() => setRosterName("eve", "【】 ", env), /名字要填/);
  assert.throws(() => setRosterName("  ", "E", env), /帳號要填/);
  assert.throws(() => setRosterName("x".repeat(65), "E", env), /帳號要填/);
  assert.throws(() => setRosterName({}, "E", env), /帳號要填/);
  assert.equal(removeRosterUser("alice", env), true);
  assert.equal(removeRosterUser("alice", env), false);
  assert.equal(removeRosterUser("constructor", env), false, "沒有原型，不會刪到繼承來的東西");
  assert.equal(removeRosterUser(null, env), false);
  assert.deepEqual(rosterList(env).map((x) => x.user), ["carol.", ".bob", "dave"]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved.seen), ["carol."], "刪掉的人出現日期也清掉");
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply refuses when the project changed or started processing during the run (#128)", async () => {
  const dir = tmpdir();
  const env = { ...process.env, CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  const zip = makeZip(dir, { "info.txt": INFO, "1-alice.aac": "x", "2-_bob.aac": "x", "3-carol_.aac": "x" });
  const tracks = fakeTracks(12, 5);
  const video = fakeVideo(tracks, { offset_ms: 0, drift: 0, ref_ms: 0 }, 10);
  const { video: vfile, pdir } = makeProject(dir, [{ start: 0, end: 1000, text: "嗨" }]);
  for (const change of [(p) => ({ ...p, rev: p.rev + 1 }), (p) => ({ ...p, status: "processing" })]) {
    // 算音量的時候工作室剛好存檔或開始重新處理
    const envelopeOf = async (f) => {
      if (f === vfile) { writeProject(pdir, change(readProject(pdir))); return video; }
      return tracks[Number(path.basename(f)[0]) - 1];
    };
    await assert.rejects(applySpeakers({ target: vfile, zip, names: {}, dryRun: false }, { env, envelopeOf }), /改過/);
    assert.equal(readProject(pdir).cues[0].text, "嗨");
    writeProject(pdir, { ...readProject(pdir), status: "ready" });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
