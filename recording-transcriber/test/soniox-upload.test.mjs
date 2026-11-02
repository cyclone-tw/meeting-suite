// Soniox 上傳（#121）：用 node:https／http 邊讀邊送，只照自己的逾時；錯誤講人話、說明沒有花到額度
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { netReason, transcribeFile, uploadFile } from "../lib/soniox-async.mjs";

const tmpFile = (bytes) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt-up-")), "audio.ogg"); fs.writeFileSync(f, bytes); return f; };
function server(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
}

test("the upload streams the file as multipart with the key, and returns Soniox's JSON", async (t) => {
  const seen = {};
  const { s, base } = await server((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], len: Number(req.headers["content-length"]), body: Buffer.concat(chunks) });
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "file-1" }));
    });
  });
  t.after(() => s.close());
  const data = Buffer.from("OggS-fake-audio-".repeat(5000));
  const r = await uploadFile(base, "k123", tmpFile(data), { filename: "a\"b.ogg" });
  assert.deepEqual(r, { id: "file-1" });
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/files");
  assert.equal(seen.auth, "Bearer k123");
  assert.match(seen.type, /^multipart\/form-data; boundary=----soniox[0-9a-f]+$/);
  assert.equal(seen.len, seen.body.length, "Content-Length 和實際送出的一樣");
  assert.ok(seen.body.includes(data), "檔案內容完整");
  assert.match(seen.body.toString("latin1"), /filename="a_b\.ogg"/, "檔名裡的引號換掉");
});

test("an upload that never gets an answer ends at our own timeout, and errors are told in plain words", async (t) => {
  const { s, base } = await server((req) => { req.resume(); /* 永遠不回 */ });
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  const t0 = Date.now();
  await assert.rejects(uploadFile(base, "k", tmpFile(Buffer.alloc(1000)), { timeoutMs: 200 }), (e) => e.code === "ETIMEDOUT");
  assert.ok(Date.now() - t0 < 3000);
  const { s: s2, base: b2 } = await server((req, res) => { req.resume(); req.on("end", () => res.writeHead(401).end("{}")); });
  t.after(() => s2.close());
  await assert.rejects(uploadFile(b2, "bad", tmpFile(Buffer.alloc(10))), (e) => e.status === 401);
  assert.equal(netReason({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }), "太久沒有回應（網路太慢或中斷）");
  assert.equal(netReason({ code: "ENOTFOUND" }), "找不到 Soniox（網路或 DNS 沒通）");
  assert.equal(netReason({ cause: { code: "ECONNRESET" } }), "連線斷了");
  assert.equal(netReason({ message: "fetch failed" }), "連線失敗（fetch failed）");
});

test("a failed upload says which step and that nothing was charged; no transcription is created", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(`${init.method} ${new URL(url).pathname}`); return new Response("{}"); };
  const upload = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }); };
  await assert.rejects(transcribeFile(tmpFile(Buffer.alloc(10)), { key: "k", fetchImpl, upload, leftoversFile: path.join(os.tmpdir(), `rt-left-${process.pid}.json`) }),
    (e) => e.notCharged === true && e.message === "上傳聲音到 Soniox：太久沒有回應（網路太慢或中斷）");
  assert.deepEqual(calls, [], "沒建立轉錄");
});
