import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const OFFICIAL_PLUGIN_VERSION = "2.4.6";
export const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
export const STALE_TOKEN_ERRCODE = -14;
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const BASE_INFO = { channel_version: OFFICIAL_PLUGIN_VERSION, bot_agent: "LiaoDa/0.1.0" };

function headers(token = "", json = true) {
  const result = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
  if (json) {
    result["Content-Type"] = "application/json";
    result.AuthorizationType = "ilink_bot_token";
    result["X-WECHAT-UIN"] = Buffer.from(
      String(randomBytes(4).readUInt32BE(0)),
      "utf8",
    ).toString("base64");
  }
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(baseUrl, endpoint, { method = "POST", token = "", body, timeoutMs = 15_000, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`), {
      method,
      headers: headers(token, method !== "GET"),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${method} ${endpoint} failed with HTTP ${response.status}`);
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function createQr(localTokenList = [], botType = DEFAULT_BOT_TYPE) {
  return request(FIXED_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
    body: { local_token_list: localTokenList.slice(0, 10) },
  });
}

export async function pollQr(baseUrl, qrcode, verifyCode = "", signal) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await request(baseUrl, endpoint, { method: "GET", timeoutMs: 35_000, signal });
  } catch (error) {
    if (error?.name === "AbortError" && !signal?.aborted) return { status: "wait" };
    throw error;
  }
}

export async function notifyStart(baseUrl, token) {
  return request(baseUrl, "ilink/bot/msg/notifystart", { token, body: { base_info: BASE_INFO }, timeoutMs: 10_000 });
}

export async function notifyStop(baseUrl, token) {
  return request(baseUrl, "ilink/bot/msg/notifystop", { token, body: { base_info: BASE_INFO }, timeoutMs: 10_000 });
}

export async function getUpdates(baseUrl, token, cursor, timeoutMs, signal) {
  try {
    return await request(baseUrl, "ilink/bot/getupdates", {
      token,
      body: { get_updates_buf: cursor || "", base_info: BASE_INFO },
      timeoutMs: timeoutMs || 35_000,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: cursor || "" };
    }
    throw error;
  }
}

export async function sendText(baseUrl, token, toUserId, text, contextToken) {
  const clientId = `liaodata-weixin-${randomUUID()}`;
  const response = await request(baseUrl, "ilink/bot/sendmessage", {
    token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken || undefined,
      },
      base_info: BASE_INFO,
    },
  });
  if (response.ret && response.ret !== 0) throw new Error("Weixin sendmessage returned a failure");
  return clientId;
}

export async function sendImage(baseUrl, token, toUserId, filePath, contextToken) {
  if (!contextToken) throw new Error("Weixin image reply requires a context token");
  const plaintext = await readFile(filePath);
  if (!plaintext.length || plaintext.length > 5 * 1024 * 1024) throw new Error("Invalid sticker image size");
  const fileKey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const upload = await request(baseUrl, "ilink/bot/getuploadurl", {
    token,
    body: {
      filekey: fileKey,
      media_type: 1,
      to_user_id: toUserId,
      rawsize: plaintext.length,
      rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: BASE_INFO,
    },
  });
  const uploadUrl = upload.upload_full_url || (
    upload.upload_param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(fileKey)}`
      : ""
  );
  if (!uploadUrl) throw new Error("Weixin upload URL is missing");
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  if (!uploadResponse.ok) throw new Error("Weixin CDN upload failed");
  const encryptedParam = uploadResponse.headers.get("x-encrypted-param") || "";
  if (!encryptedParam) throw new Error("Weixin CDN response is incomplete");
  const clientId = `liaodata-weixin-${randomUUID()}`;
  const response = await request(baseUrl, "ilink/bot/sendmessage", {
    token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: encryptedParam,
              aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
              encrypt_type: 1,
            },
            mid_size: ciphertext.length,
          },
        }],
        context_token: contextToken,
      },
      base_info: BASE_INFO,
    },
  });
  if (response.ret && response.ret !== 0) throw new Error("Weixin sendmessage returned a failure");
  return clientId;
}

function decodeAesKey(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Weixin image AES key is missing");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  const hex = decoded.toString("utf8");
  if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, "hex");
  if (/^[0-9a-f]{32}$/i.test(raw)) return Buffer.from(raw, "hex");
  throw new Error("Weixin image AES key is invalid");
}

export async function downloadInboundImage(media, sessionDir, messageId, index = 0) {
  const encryptedParam = String(media?.encrypt_query_param || "");
  const sourceUrl = String(media?.full_url || "") || (
    encryptedParam
      ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedParam)}`
      : ""
  );
  if (!sourceUrl) throw new Error("Weixin image download URL is missing");
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error("Weixin image download failed");
  const ciphertext = Buffer.from(await response.arrayBuffer());
  if (!ciphertext.length || ciphertext.length > MAX_IMAGE_BYTES + 16) {
    throw new Error("Weixin encrypted image size is invalid");
  }
  const decipher = createDecipheriv("aes-128-ecb", decodeAesKey(media?.aes_key), null);
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (!plaintext.length || plaintext.length > MAX_IMAGE_BYTES) {
    throw new Error("Weixin image size is invalid");
  }
  const directory = path.join(sessionDir, "inbound-media");
  await mkdir(directory, { recursive: true });
  const filename = createHash("sha256")
    .update(`${messageId}:${index}:${randomUUID()}`)
    .digest("hex");
  const target = path.join(directory, `${filename}.bin`);
  await writeFile(target, plaintext, { mode: 0o600 });
  return target;
}

export async function materializeInboundImages(raw, normalized, sessionDir) {
  const items = Array.isArray(raw?.item_list) ? raw.item_list : [];
  let attachmentIndex = 0;
  for (const [itemIndex, item] of items.entries()) {
    if (![2, 3, 4, 5].includes(item?.type)) continue;
    const attachment = normalized.attachments?.[attachmentIndex++];
    const media = item?.image_item?.media;
    if (item.type !== 2 || !attachment || !media?.aes_key) continue;
    try {
      attachment.local_path = await downloadInboundImage(
        media,
        sessionDir,
        normalized.message_id,
        itemIndex,
      );
      attachment.download_url = "";
    } catch {
      attachment.download_url = "";
    }
  }
  return normalized;
}

export async function loadCursor(sessionDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(sessionDir, "sync.json"), "utf8"));
    return typeof parsed.get_updates_buf === "string" ? parsed.get_updates_buf : "";
  } catch {
    return "";
  }
}

export async function saveCursor(sessionDir, cursor) {
  await mkdir(sessionDir, { recursive: true });
  const target = path.join(sessionDir, "sync.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ get_updates_buf: cursor }), { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

export function normalizeInbound(raw) {
  const items = Array.isArray(raw?.item_list) ? raw.item_list : [];
  const textItem = items.find((item) => item?.type === 1 && item?.text_item?.text != null);
  const attachments = items
    .filter((item) => [2, 3, 4, 5].includes(item?.type))
    .slice(0, 8)
    .map((item) => {
      if (item.type === 2) {
        return {
          kind: "image",
          size: item.image_item?.mid_size ?? item.image_item?.hd_size ?? null,
          download_url: String(item.image_item?.media?.full_url || "").slice(0, 4096),
        };
      }
      if (item.type === 3) {
        return { kind: "voice", size: null, metadata: { duration_ms: item.voice_item?.playtime ?? null } };
      }
      if (item.type === 4) {
        const size = Number(item.file_item?.len);
        return {
          kind: "file",
          filename: String(item.file_item?.file_name || "").slice(0, 255),
          size: Number.isSafeInteger(size) && size >= 0 ? size : null,
        };
      }
      return { kind: "video", size: item.video_item?.video_size ?? null };
    });
  const messageId = String(raw?.message_id ?? "");
  return {
    message_id: messageId,
    reply_to_id: "",
    sender_id: String(raw?.from_user_id || ""),
    text: String(textItem?.text_item?.text || ""),
    attachments,
    timestamp: Number.isFinite(raw?.create_time_ms)
      ? new Date(raw.create_time_ms).toISOString()
      : new Date().toISOString(),
    seq: Number.isSafeInteger(raw?.seq) ? raw.seq : null,
    session_id: String(raw?.session_id || ""),
    context_token: String(raw?.context_token || ""),
    message_type: raw?.message_type,
  };
}

