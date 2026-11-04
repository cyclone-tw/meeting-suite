// youtube-upload 指令（recording-transcriber#159）：假的 Google、記憶體裡的鑰匙圈、暫存的設定資料夾，不連網
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError, channelsText, parseArgs, runUpload } from "../lib/youtube-cli.mjs";
import { saveSettings } from "../lib/youtube-settings.mjs";

function setup(t, { defaults = {}, connected = true, client = true, token = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { CYCLONE_STUDIO_STATE: path.join(dir, "state") };
  saveSettings({
    client: client ? { client_id: "123-abc.apps.googleusercontent.com", project_id: "p" } : null,
    channels: [{ id: "UC123", title: "Cyclone 的頻道", connected, defaults }, { id: "UC999", title: "備用頻道", connected: true, defaults: {} }],
    default_channel: "UC123",
  }, env);
  const m = new Map();
  if (client) m.set("client-secret", "GOCSPX-test");
  if (token) m.set("refresh:UC123", "1//rt-good");
  const secrets = { get: (a) => m.get(a) || "", set: (a, v) => m.set(a, v), delete: (a) => m.delete(a) };
  const video = path.join(dir, "demo.mp4");
  fs.writeFileSync(video, Buffer.from("not really a video but bytes"));
  const g = { meta: null, notify: null, received: [], playlistItems: [], refreshed: 0 };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.href === "https://oauth2.googleapis.com/token") {
      const f = new URLSearchParams(init.body);
      if (f.get("refresh_token") !== "1//rt-good") return Response.json({ error: "invalid_grant" }, { status: 400 });
      g.refreshed += 1;
      return Response.json({ access_token: "at-secret-1", expires_in: 3600 });
    }
    if (u.pathname === "/upload/youtube/v3/videos") {
      g.meta = JSON.parse(init.body);
      g.notify = u.searchParams.get("notifySubscribers");
      return new Response("", { status: 200, headers: { Location: "https://upload.example/session" } });
    }
    if (u.href === "https://upload.example/session") { g.received.push(Buffer.from(init.body)); return Response.json({ id: "VID777" }, { status: 201 }); }
    if (u.pathname === "/youtube/v3/playlistItems") { g.playlistItems.push(JSON.parse(init.body)); return Response.json({ id: "PI1" }); }
    throw new Error(`unexpected ${url}`);
  };
  const lines = { out: [], err: [] };
  const io = { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
  return { dir, env, secrets, video, g, lines, run: (opts) => runUpload(opts, { env, fetch: g.fetch, secrets, ...io }) };
}

test("arguments: private by default, bad values refused before anything is sent", () => {
  const o = parseArgs(["/a/b.mp4", "--title", "示範影片"]);
  assert.equal(o.video, "/a/b.mp4");
  assert.equal(o.title, "示範影片");
  assert.equal(o.privacy, "private", "沒有明確說公開就是私人");
  assert.equal(o.notify, false);
  assert.equal(parseArgs(["v.mp4", "--title", "t", "--privacy", "unlisted", "--kids", "--notify", "--tags", "a,b", "--json"]).privacy, "unlisted");
  const bad = (argv, re) => assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message), argv.join(" "));
  bad(["v.mp4", "--title", "t", "--privacy", "everyone"], /private、unlisted 或 public/);
  bad(["v.mp4", "--title", "t", "--nope"], /不認得的選項/);
  bad(["v.mp4", "--title"], /需要一個值/);
  bad(["v.mp4", "--title", "t", "--desc", "x", "--desc-file", "y"], /不能同時/);
  bad(["--title", "t"], /影片/);
  bad(["v.mp4"], /標題/);
  bad(["a.mp4", "b.mp4", "--title", "t"], /只能傳一支/);
  bad(["v.mp4", "--title", "t", "--category", "999"], /分類/);
  assert.deepEqual(parseArgs(["--channels"]), { channels: true });
});

test("uploads the file as is: private, no notification, description from a file, playlist; tokens never printed", async (t) => {
  const s = setup(t, { defaults: { privacy: "public", tags: ["特教"], categoryId: "27", language: "zh-TW", notify: true } });
  const desc = path.join(s.dir, "desc.md");
  fs.writeFileSync(desc, "這是說明欄\n第二行 <b>");
  const r = await s.run(parseArgs([s.video, "--title", "示範", "--desc-file", desc, "--playlist", "PL1"]));
  assert.deepEqual(Buffer.concat(s.g.received), fs.readFileSync(s.video), "原檔直接上傳，沒有重新編碼");
  assert.equal(s.g.meta.status.privacyStatus, "private", "頻道預設公開也一樣：指令沒說公開就是私人");
  assert.equal(s.g.notify, "false");
  assert.equal(s.g.meta.snippet.title, "示範");
  assert.equal(s.g.meta.snippet.description, "這是說明欄\n第二行 ＜b＞");
  assert.deepEqual(s.g.meta.snippet.tags, ["特教"], "標籤、分類、語言用頻道的預設值");
  assert.deepEqual(s.g.playlistItems[0].snippet, { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "VID777" } });
  assert.equal(r.url, "https://youtu.be/VID777");
  assert.equal(r.studio_url, "https://studio.youtube.com/video/VID777/edit");
  assert.equal(r.privacy, "private");
  assert.equal(r.channel, "Cyclone 的頻道");
  const printed = [...s.lines.out, ...s.lines.err].join("\n");
  assert.doesNotMatch(printed, /at-secret|1\/\/rt|GOCSPX/, "token 與 secret 不印出來");
  assert.match(printed, /https:\/\/youtu\.be\/VID777/);
});

test("public only when asked; another channel by title or id", async (t) => {
  const s = setup(t);
  const r = await s.run(parseArgs([s.video, "--title", "t", "--privacy", "public", "--notify", "--channel", "UC123"]));
  assert.equal(s.g.meta.status.privacyStatus, "public");
  assert.equal(s.g.notify, "true");
  assert.equal(r.privacy, "public");
  await assert.rejects(s.run(parseArgs([s.video, "--title", "t", "--channel", "沒有這個"])), /找不到頻道/);
});

test("clear errors, nothing sent: no setup, bad file, bad title, lost authorization (settings untouched)", async (t) => {
  const none = setup(t, { client: false });
  await assert.rejects(none.run(parseArgs([none.video, "--title", "t"])), /還沒設定 YouTube/);
  const s = setup(t);
  const txt = path.join(s.dir, "notes.txt");
  fs.writeFileSync(txt, "x");
  await assert.rejects(s.run(parseArgs([txt, "--title", "t"])), /不支援這種檔案/);
  await assert.rejects(s.run(parseArgs([path.join(s.dir, "nope.mp4"), "--title", "t"])), /找不到這支影片/);
  await assert.rejects(s.run(parseArgs([s.video, "--title", "字".repeat(101)])), /最多 100 個字/);
  await assert.rejects(s.run(parseArgs([s.video, "--title", "t", "--desc-file", path.join(s.dir, "nope.md")])), /說明欄檔/);
  assert.equal(s.g.meta, null, "上面任何一個錯都沒有碰 YouTube");
  const off = setup(t, { connected: false });
  await assert.rejects(off.run(parseArgs([off.video, "--title", "t"])), /授權失效/);
  const lost = setup(t, { token: false });
  await assert.rejects(lost.run(parseArgs([lost.video, "--title", "t"])), /授權不見了/);
  const before = fs.readFileSync(path.join(lost.env.CYCLONE_STUDIO_STATE, "youtube.json"), "utf8");
  lost.secrets.set("refresh:UC123", "1//rt-revoked");
  await assert.rejects(lost.run(parseArgs([lost.video, "--title", "t"])), /授權過期或被取消/);
  assert.equal(fs.readFileSync(path.join(lost.env.CYCLONE_STUDIO_STATE, "youtube.json"), "utf8"), before, "指令不改工作室的設定檔");
});

test("--channels lists channels without any secret", (t) => {
  const s = setup(t);
  const text = channelsText(s.env);
  assert.match(text, /UC123/);
  assert.match(text, /Cyclone 的頻道/);
  assert.match(text, /預設/);
  assert.doesNotMatch(text, /GOCSPX|1\/\/rt/);
});
