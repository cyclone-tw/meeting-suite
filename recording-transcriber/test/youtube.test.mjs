// YouTube 上傳（recording-transcriber#40）：假的 Google，不連網
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CHUNK, SCOPE, authUrl, checkDefaults, googleError, parseClient, pkce, uploadCaption, uploadVideo, videoMeta,
} from "../lib/youtube.mjs";
import { keychainSecrets } from "../lib/youtube-settings.mjs";

const CLIENT_JSON = JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test", project_id: "my-studio" } });

test("the OAuth client must be a desktop client downloaded from Google", () => {
  assert.deepEqual(parseClient(CLIENT_JSON), { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test", project_id: "my-studio" });
  assert.throws(() => parseClient(JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } })), /電腦版應用程式/);
  assert.throws(() => parseClient("not json"), /JSON/);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: "evil.example.com", client_secret: "s" } })), /格式不對/);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: "1.apps.googleusercontent.com" } })), /client_secret/);
});

test("the consent URL asks for one YouTube scope with PKCE and lets the user pick a channel", () => {
  const { verifier, challenge } = pkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  const u = new URL(authUrl({ clientId: "c.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:8766", state: "s1", challenge }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.scope, SCOPE);
  assert.equal(q.redirect_uri, "http://127.0.0.1:8766");
  assert.equal(q.code_challenge_method, "S256");
  assert.equal(q.access_type, "offline");
  assert.match(q.prompt, /consent/);
  assert.match(q.prompt, /select_account/);
});

test("video details are checked against YouTube's limits", () => {
  const m = videoMeta({ title: "  分數<教學>  第一課 ", description: "a<b>", tags: "特教，數學、 分數,", privacy: "unlisted", categoryId: "27", language: "zh-TW" });
  assert.equal(m.snippet.title, "分數＜教學＞ 第一課", "角括號換成全形、空白收斂");
  assert.equal(m.snippet.description, "a＜b＞");
  assert.deepEqual(m.snippet.tags, ["特教", "數學", "分數"]);
  assert.deepEqual(m.status, { privacyStatus: "unlisted", selfDeclaredMadeForKids: false });
  assert.equal(m.snippet.defaultAudioLanguage, "zh-TW");
  assert.throws(() => videoMeta({ title: " " }), /請填標題/);
  assert.throws(() => videoMeta({ title: "字".repeat(101) }), /最多 100 個字/);
  assert.throws(() => videoMeta({ title: "t", description: "字".repeat(1700) }), /5000 位元組/, "中文一個字 3 位元組");
  assert.ok(videoMeta({ title: "t", description: "字".repeat(1666) }));
  assert.throws(() => videoMeta({ title: "t", tags: Array(60).fill("十個字的標籤啊啊啊啊") }), /500/);
  const later = new Date(Date.now() + 86_400_000).toISOString();
  assert.deepEqual(videoMeta({ title: "t", privacy: "public", publishAt: later }).status, { privacyStatus: "private", selfDeclaredMadeForKids: false, publishAt: later }, "排程一定先是私人");
  assert.throws(() => videoMeta({ title: "t", publishAt: "2020-01-01T00:00:00Z" }), /現在之後/);
  const odd = videoMeta({ title: "t", privacy: "everyone", categoryId: "999", language: "中文", madeForKids: "yes" });
  assert.deepEqual([odd.status.privacyStatus, odd.snippet.categoryId, odd.snippet.defaultLanguage, odd.status.selfDeclaredMadeForKids], ["private", "27", "zh-TW", false], "看不懂的值用安全的預設");
});

test("Google errors become plain messages with a code", () => {
  assert.equal(googleError(400, { error: "invalid_grant" }).code, "reauth");
  assert.match(googleError(403, { error: { errors: [{ reason: "quotaExceeded" }] } }).message, /額度用完/);
  assert.equal(googleError(400, { error: { errors: [{ reason: "uploadLimitExceeded" }] } }).code, "quota");
  assert.match(googleError(403, { error: { errors: [{ reason: "youtubeSignupRequired" }] } }).message, /還沒有 YouTube 頻道/);
  assert.match(googleError(500, { error: { message: "backend" } }).message, /500：backend/);
});

test("channel defaults keep only known values", () => {
  assert.deepEqual(checkDefaults({ privacy: "public", subtitles: "burned", playlistId: "PL_x-1", categoryId: 22, language: "en", madeForKids: true, notify: false, tags: "a, b", extra: 1 }),
    { privacy: "public", subtitles: "burned", playlistId: "PL_x-1", categoryId: "22", language: "en", madeForKids: true, tags: ["a", "b"], notify: false });
  assert.deepEqual(checkDefaults({ privacy: "all", playlistId: "../x", categoryId: "0", language: "x y" }), checkDefaults());
});

// 假的上傳端：照 Content-Range 收資料，回 308 告訴收到哪裡；可以設定某一塊網路斷掉、某一次 401
function fakeUploader({ dropAt = -1, unauthorizedAt = -1, size }) {
  const got = [];
  let received = 0, puts = 0;
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers });
    if (init.method === "POST") {
      assert.match(url, /uploadType=resumable/);
      assert.equal(init.headers["X-Upload-Content-Length"], String(size));
      return new Response("", { status: 200, headers: { Location: "https://upload.example/s1" } });
    }
    const range = init.headers["Content-Range"];
    if (range.startsWith("bytes */")) return received >= size ? Response.json({ id: "VID" }, { status: 201 }) : new Response("", { status: 308, headers: received ? { Range: `bytes=0-${received - 1}` } : {} });
    puts += 1;
    if (puts === unauthorizedAt) return new Response("{}", { status: 401 });
    if (puts === dropAt) throw new TypeError("fetch failed");
    const [, a, b] = /bytes (\d+)-(\d+)\//.exec(range).map(Number);
    assert.equal(a, received, "從收到的地方接著送");
    got.push(Buffer.from(init.body));
    received = b + 1;
    return received >= size ? Response.json({ id: "VID", snippet: {} }, { status: 201 }) : new Response("", { status: 308, headers: { Range: `bytes=0-${b}` } });
  };
  return { fetch, got: () => Buffer.concat(got), calls };
}

test("a resumable upload continues from where Google says it stopped after a dropped connection and an expired token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-yt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "v.mp4");
  const data = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  fs.writeFileSync(file, data);
  const up = fakeUploader({ dropAt: 3, unauthorizedAt: 5, size: data.length });
  const forced = [];
  const progress = [];
  const video = await uploadVideo({
    fetch: up.fetch, getToken: async (force) => { forced.push(force); return force ? "fresh" : "old"; }, file, meta: { snippet: { title: "t" } },
    chunk: 8, backoffMs: 1, onProgress: (x) => progress.push(x),
  });
  assert.equal(video.id, "VID");
  assert.deepEqual(up.got(), data, "每個位元組剛好送一次");
  assert.ok(up.calls.some((c) => c.headers["Content-Range"] === `bytes */${data.length}`), "斷線後問進度");
  assert.ok(forced.includes(true), "401 之後換新的 token");
  assert.equal(progress.at(-1), 1);
  assert.equal(up.calls[0].url.includes("notifySubscribers=true"), true);
  assert.equal(CHUNK % (256 * 1024), 0, "續傳每一塊要是 256 KiB 的倍數");
});

test("an upload stops when cancelled and gives up after repeated failures", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-yt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "v.mp4");
  fs.writeFileSync(file, Buffer.alloc(40, 1));
  const down = async (url, init) => (init.method === "POST" ? new Response("", { status: 200, headers: { Location: "https://upload.example/s" } }) : new Response("busy", { status: 503 }));
  await assert.rejects(uploadVideo({ fetch: down, getToken: async () => "t", file, meta: {}, chunk: 8, backoffMs: 1 }), /網路一直斷/);
  const ac = new AbortController();
  const slow = async (url, init) => {
    if (init.method === "POST") return new Response("", { status: 200, headers: { Location: "https://upload.example/s" } });
    ac.abort();
    return new Response("", { status: 308, headers: { Range: "bytes=0-7" } });
  };
  await assert.rejects(uploadVideo({ fetch: slow, getToken: async () => "t", file, meta: {}, chunk: 8, signal: ac.signal }), /cancelled/);
  // 一直回 401：要自己放棄；超過 100 次還在試就當成沒放棄（停掉它，測試會看到 cancelled）
  const guard = new AbortController();
  let n401 = 0;
  const locked = async (url, init) => {
    if (init.method === "POST") return new Response("", { status: 200, headers: { Location: "https://upload.example/s" } });
    if (++n401 > 100) guard.abort();
    return new Response("{}", { status: 401 });
  };
  await assert.rejects(uploadVideo({ fetch: locked, getToken: async () => "t", file, meta: {}, chunk: 8, signal: guard.signal }), /授權失效/, "一直 401 不會無限重試");
  const bad = async (url, init) => (init.method === "POST" ? new Response("", { status: 200, headers: { Location: "https://upload.example/s" } }) : Response.json({ error: { errors: [{ reason: "uploadLimitExceeded" }] } }, { status: 400 }));
  await assert.rejects(uploadVideo({ fetch: bad, getToken: async () => "t", file, meta: {}, chunk: 8 }), /上傳的數量到上限/);
});

test("captions go up as multipart: metadata first, then the SRT", async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url, init }; return Response.json({ id: "CAP" }); };
  const srt = "1\n00:00:00,000 --> 00:00:01,000\n今天<上課>\n";
  const r = await uploadCaption({ fetch, getToken: async () => "tok", videoId: "VID", srt, language: "zh-TW" });
  assert.equal(r.id, "CAP");
  assert.match(sent.url, /\/upload\/youtube\/v3\/captions\?uploadType=multipart&part=snippet$/);
  const boundary = /boundary=(.+)$/.exec(sent.init.headers["Content-Type"])[1];
  const body = sent.init.body.toString("utf8");
  const parts = body.split(`--${boundary}`);
  assert.deepEqual(JSON.parse(parts[1].split("\r\n\r\n")[1]), { snippet: { videoId: "VID", language: "zh-TW", name: "中文（台灣）", isDraft: false } });
  assert.ok(parts[2].includes(srt), "SRT 原封不動");
  assert.equal(sent.init.headers.Authorization, "Bearer tok");
});

test("values with characters outside the token alphabet never reach the keychain command", () => {
  const k = keychainSecrets("cyclone-studio-test-never-written");
  assert.throws(() => k.set("refresh:UC1", 'x" -s other'), /不認得的字元/);
  assert.throws(() => k.set("refresh:UC1", "a\nadd-generic-password"), /不認得的字元/);
  assert.throws(() => k.set('a" b', "token"), /不認得的字元/);
});
