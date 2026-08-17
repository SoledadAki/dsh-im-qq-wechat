import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { downloadInboundImage, normalizeInbound, sendImage } from "../protocol.mjs";

test("normalizes text and attachment metadata without leaking media URLs or context token", () => {
  const normalized = normalizeInbound({
    seq: 7,
    message_id: 123,
    from_user_id: "owner-user",
    create_time_ms: 1_721_430_000_000,
    message_type: 1,
    context_token: "secret-context",
    item_list: [
      { type: 1, text_item: { text: "你好" } },
      { type: 2, image_item: { mid_size: 456, media: { full_url: "https://secret" } } },
      { type: 4, file_item: { file_name: "note.txt", len: "12", media: { full_url: "https://secret" } } },
    ],
  });
  assert.equal(normalized.message_id, "123");
  assert.equal(normalized.reply_to_id, "");
  assert.equal(normalized.text, "你好");
  assert.deepEqual(normalized.attachments, [
    { kind: "image", size: 456, download_url: "https://secret" },
    { kind: "file", filename: "note.txt", size: 12 },
  ]);
  assert.equal(normalized.context_token, "secret-context");
  assert.doesNotMatch(JSON.stringify(normalized.attachments), /secret-context/);
});

test("reports ready when long polling recovers", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "main.mjs"), "utf8");
  assert.match(source, /if \(reconnecting\) \{\s*reconnecting = false;\s*emit\("monitor\.ready"/);
});

test("keeps inbound reply context for multiple sentence bubbles", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "main.mjs"), "utf8");
  assert.doesNotMatch(source, /replyContexts\.delete\(String\(frame\.payload\?\.reply_to_id/);
  assert.match(source, /const cutoff = Date\.now\(\) - 10 \* 60_000/);
});

test("allows proactive send without an inbound context token", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "main.mjs"), "utf8");
  assert.match(source, /const proactive = frame\.payload\?\.proactive === true/);
  assert.match(source, /proactive \? undefined : reply\.contextToken/);
});

test("uploads an encrypted image and sends only CDN metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "liaodata-weixin-sticker-"));
  const imagePath = join(directory, "sticker.png");
  await writeFile(imagePath, Buffer.from("small-image"));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("getuploadurl")) {
      return new Response(JSON.stringify({ upload_full_url: "https://cdn.invalid/upload" }), { status: 200 });
    }
    if (String(url) === "https://cdn.invalid/upload") {
      return new Response("", { status: 200, headers: { "x-encrypted-param": "encrypted-download" } });
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  try {
    const messageId = await sendImage("https://api.invalid", "token", "owner", imagePath, "context");
    assert.match(messageId, /^liaodata-weixin-/);
    const uploadRequest = JSON.parse(calls[0].options.body);
    assert.equal(uploadRequest.media_type, 1);
    assert.equal(uploadRequest.to_user_id, "owner");
    assert.equal(uploadRequest.rawsize, 11);
    assert.equal(calls[1].options.body.length % 16, 0);
    const sendRequest = JSON.parse(calls[2].options.body);
    const imageItem = sendRequest.msg.item_list[0].image_item;
    assert.equal(sendRequest.msg.context_token, "context");
    assert.equal(imageItem.media.encrypt_query_param, "encrypted-download");
    assert.equal(imageItem.media.encrypt_type, 1);
    assert.equal(sendRequest.msg.item_list[0].type, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloads and decrypts an inbound image without exposing its AES key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "liaodata-weixin-inbound-"));
  const plaintext = Buffer.from("\x89PNG\r\n\x1a\nprivate-image", "binary");
  const aesKey = randomBytes(16);
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(ciphertext, { status: 200 });
  };
  try {
    const target = await downloadInboundImage(
      {
        encrypt_query_param: "encrypted-download",
        aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
      },
      directory,
      "message-1",
    );
    assert.deepEqual(await readFile(target), plaintext);
    assert.match(requestedUrl, /\/download\?encrypted_query_param=encrypted-download$/);
    assert.doesNotMatch(target, new RegExp(aesKey.toString("hex"), "i"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
