// 網址匯入的影片來源（#173）：只收認得的 YouTube、Facebook、X 網址，組出標準網址才交給 yt-dlp
import { test } from "node:test";
import assert from "node:assert/strict";
import { videoSource } from "../lib/video-source.mjs";

test("YouTube links keep working", () => {
  assert.deepEqual(videoSource("https://youtu.be/dQw4w9WgXcQ?t=3"), { site: "youtube", id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", key: "youtube:dQw4w9WgXcQ" });
});

test("Facebook links: share, reel, watch, page videos and fb.watch", () => {
  const cases = [
    ["https://www.facebook.com/share/v/1HT2wpcnyZ/", "1HT2wpcnyZ", "https://www.facebook.com/share/v/1HT2wpcnyZ/"],
    ["https://m.facebook.com/share/r/AbC_d-123/?mibextid=xyz", "AbC_d-123", "https://www.facebook.com/share/r/AbC_d-123/"],
    ["https://www.facebook.com/reel/1538098994747394?s=1", "1538098994747394", "https://www.facebook.com/reel/1538098994747394"],
    ["https://web.facebook.com/watch/?v=1538098994747394&ref=x", "1538098994747394", "https://www.facebook.com/watch/?v=1538098994747394"],
    ["https://www.facebook.com/SomePage/videos/1538098994747394/", "1538098994747394", "https://www.facebook.com/watch/?v=1538098994747394"],
    ["https://www.facebook.com/SomePage/videos/a-title/1538098994747394", "1538098994747394", "https://www.facebook.com/watch/?v=1538098994747394"],
    ["https://fb.watch/abCD12_ef/", "abCD12_ef", "https://fb.watch/abCD12_ef/"],
  ];
  for (const [input, id, url] of cases) assert.deepEqual(videoSource(input), { site: "facebook", id, url, key: `facebook:${id}` }, input);
});

test("X links: x.com and twitter.com status links become one standard url", () => {
  for (const input of ["https://x.com/captainamerica/status/719944021058060289", "https://twitter.com/captainamerica/status/719944021058060289?s=20",
    "https://mobile.twitter.com/i/web/status/719944021058060289", "https://x.com/someone/status/719944021058060289/video/1"]) {
    assert.deepEqual(videoSource(input), { site: "x", id: "719944021058060289", url: "https://x.com/i/status/719944021058060289", key: "x:719944021058060289" }, input);
  }
});

test("anything else is refused, including tricks that try to reach yt-dlp options or other hosts", () => {
  for (const bad of [
    "", "not a url", "--exec=touch /tmp/x", "file:///etc/passwd", "ftp://www.facebook.com/reel/1538098994747394",
    "https://www.threads.net/@someone/post/abc", "https://www.instagram.com/reel/abc/",
    "https://evil.example/www.facebook.com/reel/1538098994747394", "https://facebook.com.evil.example/reel/1538098994747394",
    "https://user:pw@www.facebook.com/reel/1538098994747394", "https://www.facebook.com:8443/reel/1538098994747394",
    "https://www.facebook.com/share/v/--exec/", "https://www.facebook.com/share/v/a b/", "https://www.facebook.com/reel/123",
    "https://www.facebook.com/watch/?v=--exec", "https://www.facebook.com/somepage/", "https://x.com/someone", "https://x.com/someone/status/abc",
    "https://x.com/status/719944021058060289",
  ]) assert.equal(videoSource(bad), null, bad);
});

test("every standard url this module builds is accepted by the yt-dlp guard, and raw strings are not", async () => {
  const { ytTarget, fetchInfo } = await import("../lib/youtube-source.mjs");
  for (const input of ["https://www.facebook.com/share/v/1HT2wpcnyZ/", "https://m.facebook.com/share/r/AbC_d-123/", "https://www.facebook.com/reel/1538098994747394",
    "https://web.facebook.com/watch/?v=1538098994747394", "https://www.facebook.com/SomePage/videos/1538098994747394/", "https://fb.watch/abCD12_ef/",
    "https://twitter.com/captainamerica/status/719944021058060289"]) {
    const src = videoSource(input);
    assert.equal(ytTarget(src.url), src.url, input);
  }
  assert.equal(ytTarget("dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  for (const raw of ["https://www.facebook.com/share/v/1HT2wpcnyZ/?x=1", "https://evil.example/", "--exec=x", "https://x.com/someone/status/719944021058060289"]) {
    assert.throws(() => ytTarget(raw), /影片網址的格式不對/, raw);
  }
  // 真的交給 yt-dlp 的參數：網址一律在 -- 後面
  let args = null;
  await fetchInfo("https://x.com/i/status/719944021058060289", { run: async (a) => { args = a; return { code: 0, stdout: JSON.stringify({ id: "719944021058060289", title: "t" }), stderr: "" }; } });
  assert.deepEqual(args.slice(-2), ["--", "https://x.com/i/status/719944021058060289"]);
  await assert.rejects(fetchInfo("--exec=x", { run: async () => { throw new Error("不該跑到 yt-dlp"); } }), /影片網址的格式不對/);
});

test("Facebook titles lose the changing views and reactions prefix, in the project name and the file name", async () => {
  const { cleanTitle, pickInfo, fetchVideo } = await import("../lib/youtube-source.mjs");
  assert.equal(cleanTitle("7.4K views · 71 reactions | AI 用程式，能做出一整座古希臘城市？"), "AI 用程式，能做出一整座古希臘城市？");
  assert.equal(cleanTitle("1,203 views · 5 reactions |  標題"), "標題");
  assert.equal(cleanTitle("A Talk | about views"), "A Talk | about views", "一般標題不動");
  assert.equal(pickInfo({ id: "1", title: "7.4K views · 71 reactions | 古希臘" }).title, "古希臘");
  const argsFor = async (target) => {
    let args = null;
    await fetchVideo(target, "/tmp/x", { run: async (a) => { args = a; return { code: 0, stdout: "FILE /tmp/x/v [1].mp4\n", stderr: "" }; } }).catch(() => {});
    return args;
  };
  const fb = await argsFor("https://www.facebook.com/share/v/1HT2wpcnyZ/");
  const i = fb.indexOf("--replace-in-metadata");
  assert.ok(i > 0 && fb[i + 1] === "title" && fb[i + 3] === "", "Facebook 的檔名也拿掉前綴");
  assert.ok(i < fb.indexOf("--"), "選項都在 -- 前面");
  assert.equal((await argsFor("dQw4w9WgXcQ")).indexOf("--replace-in-metadata"), -1, "YouTube 不動");
});

test("pickInfo only rebuilds a YouTube url when yt-dlp gives no webpage_url (#175)", async () => {
  const { pickInfo } = await import("../lib/youtube-source.mjs");
  assert.equal(pickInfo({ id: "dQw4w9WgXcQ" }).url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(pickInfo({ id: "1538098994747394", extractor_key: "Facebook" }).url, "", "Facebook 不會變成 YouTube 網址");
  assert.equal(pickInfo({ id: "719944021058060289", extractor: "twitter" }).url, "");
  assert.equal(pickInfo({ id: "1", extractor_key: "Facebook", webpage_url: "https://www.facebook.com/reel/1" }).url, "https://www.facebook.com/reel/1");
});
