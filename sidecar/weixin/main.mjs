import readline from "node:readline";

import { JsonLineIpc, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./ipc.mjs";
import {
  DEFAULT_BOT_TYPE,
  FIXED_BASE_URL,
  STALE_TOKEN_ERRCODE,
  createQr,
  getUpdates,
  loadCursor,
  materializeInboundImages,
  normalizeInbound,
  notifyStart,
  notifyStop,
  pollQr,
  saveCursor,
  sendImage,
  sendText,
} from "./protocol.mjs";

const ipc = new JsonLineIpc();
let shuttingDown = false;
let frameChain = Promise.resolve();
let binding = null;
let monitor = null;
const replyContexts = new Map();

function emit(type, payload, profileId, requestId = "") {
  ipc.send(type, payload, profileId, requestId);
}

function failClosed() {
  shuttingDown = true;
  binding?.controller.abort();
  monitor?.controller.abort();
  process.stderr.write("Weixin sidecar stopped because its private IPC stream was invalid.\n");
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 10);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function pruneReplyContexts() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, value] of replyContexts) {
    if (value.savedAt < cutoff) replyContexts.delete(key);
  }
  while (replyContexts.size > 500) replyContexts.delete(replyContexts.keys().next().value);
}

async function refreshQr(task) {
  task.refreshCount += 1;
  if (task.refreshCount > 3) throw new Error("二维码多次过期，请重新发起连接");
  emit("binding.qr_expired", { task_id: task.taskId }, task.profileId);
  const result = await createQr([], DEFAULT_BOT_TYPE);
  if (!result?.qrcode || !result?.qrcode_img_content) throw new Error("腾讯未返回完整二维码");
  task.qrcode = result.qrcode;
  task.pollBaseUrl = FIXED_BASE_URL;
  task.verifyCode = "";
  emit("binding.qr_displayed", { task_id: task.taskId, qr_url: result.qrcode_img_content }, task.profileId);
}

async function runBinding(task) {
  try {
    emit("binding.started", { task_id: task.taskId }, task.profileId);
    await refreshQr(task);
    while (!task.controller.signal.aborted) {
      const status = await pollQr(task.pollBaseUrl, task.qrcode, task.verifyCode, task.controller.signal);
      if (task.controller.signal.aborted) break;
      switch (status?.status) {
        case "wait":
          break;
        case "scaned":
          task.verifyCode = "";
          emit("binding.scanned", { task_id: task.taskId }, task.profileId);
          break;
        case "need_verifycode":
          emit("binding.verify_required", { task_id: task.taskId }, task.profileId);
          break;
        case "scaned_but_redirect":
          if (typeof status.redirect_host === "string" && /^[A-Za-z0-9.-]+$/.test(status.redirect_host)) {
            task.pollBaseUrl = `https://${status.redirect_host}`;
          }
          emit("binding.scanned", { task_id: task.taskId }, task.profileId);
          break;
        case "expired":
        case "verify_code_blocked":
          await refreshQr(task);
          break;
        case "binded_redirect":
          throw new Error("该微信机器人已绑定，但腾讯未返回可保存的新凭据，请先断开旧连接后重试");
        case "confirmed": {
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
            throw new Error("腾讯未返回完整的微信机器人绑定信息");
          }
          const credentials = {
            task_id: task.taskId,
            bot_token: status.bot_token,
            account_id: status.ilink_bot_id,
            owner_user_id: status.ilink_user_id,
            base_url: status.baseurl || task.pollBaseUrl || FIXED_BASE_URL,
          };
          emit("binding.credentials", credentials, task.profileId);
          credentials.bot_token = "";
          binding = null;
          return;
        }
        default:
          throw new Error("腾讯返回了当前版本无法识别的扫码状态");
      }
      await sleep(800, task.controller.signal);
    }
    emit("binding.cancelled", { task_id: task.taskId }, task.profileId);
  } catch {
    if (task.controller.signal.aborted) {
      emit("binding.cancelled", { task_id: task.taskId }, task.profileId);
    } else {
      emit("binding.failed", { task_id: task.taskId, message: "微信扫码绑定失败，请稍后重试。" }, task.profileId);
    }
  } finally {
    if (binding === task) binding = null;
  }
}

async function stopMonitor(accountId = "", emitStopped = true) {
  const current = monitor;
  if (!current || (accountId && current.accountId !== accountId)) return;
  current.controller.abort();
  try {
    await current.task;
  } catch {}
  try {
    await notifyStop(current.baseUrl, current.token);
  } catch {}
  current.token = "";
  monitor = null;
  replyContexts.clear();
  if (emitStopped) emit("monitor.stopped", { account_id: current.accountId }, current.profileId);
}

async function runMonitor(state) {
  let cursor = await loadCursor(state.sessionDir);
  let timeoutMs = 35_000;
  let failures = 0;
  let reconnecting = false;
  emit("monitor.starting", { account_id: state.accountId }, state.profileId);
  try {
    const started = await notifyStart(state.baseUrl, state.token);
    if ((started.ret && started.ret !== 0) || (started.errcode && started.errcode !== 0)) {
      throw new Error("notifystart failed");
    }
    emit("monitor.ready", { account_id: state.accountId }, state.profileId);
    while (!state.controller.signal.aborted) {
      try {
        const response = await getUpdates(
          state.baseUrl,
          state.token,
          cursor,
          timeoutMs,
          state.controller.signal,
        );
        if (state.controller.signal.aborted) break;
        if (response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms;
        const failed = (response.ret !== undefined && response.ret !== 0)
          || (response.errcode !== undefined && response.errcode !== 0);
        if (failed) {
          if (response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE) {
            emit("monitor.paused", { account_id: state.accountId }, state.profileId);
            await sleep(60 * 60_000, state.controller.signal);
            continue;
          }
          failures += 1;
          if (!reconnecting) {
            reconnecting = true;
            emit("monitor.reconnecting", { account_id: state.accountId }, state.profileId);
          }
          await sleep(failures >= 3 ? 30_000 : 2_000, state.controller.signal);
          if (failures >= 3) failures = 0;
          continue;
        }
        failures = 0;
        if (reconnecting) {
          reconnecting = false;
          emit("monitor.ready", { account_id: state.accountId }, state.profileId);
        }
        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          await saveCursor(state.sessionDir, cursor);
        }
        for (const raw of Array.isArray(response.msgs) ? response.msgs : []) {
          const message = await materializeInboundImages(
            raw,
            normalizeInbound(raw),
            state.sessionDir,
          );
          if (!message.message_id || !message.sender_id || message.message_type === 2) continue;
          pruneReplyContexts();
          replyContexts.set(message.message_id, {
            contextToken: message.context_token,
            targetId: message.sender_id,
            accountId: state.accountId,
            savedAt: Date.now(),
          });
          delete message.context_token;
          emit("monitor.message", { account_id: state.accountId, ...message }, state.profileId);
        }
      } catch {
        if (state.controller.signal.aborted) break;
        failures += 1;
        if (!reconnecting) {
          reconnecting = true;
          emit("monitor.reconnecting", { account_id: state.accountId }, state.profileId);
        }
        await sleep(failures >= 3 ? 30_000 : 2_000, state.controller.signal);
        if (failures >= 3) failures = 0;
      }
    }
  } catch {
    if (!state.controller.signal.aborted) {
      emit("monitor.failed", { account_id: state.accountId, message: "微信连接失败，请检查网络后重试。" }, state.profileId);
    }
  }
}

async function handleFrame(frame) {
  if (ipc.launchToken === null) {
    ipc.acceptHello(frame);
    ipc.send("hello.ack", {
      protocol_version: PROTOCOL_VERSION,
      sidecar_version: "0.1.0",
      official_protocol_source: "@tencent-weixin/openclaw-weixin@2.4.6",
      capabilities: ["qr_connect", "credential_handoff", "weixin_long_poll", "c2c_text", "verify_code"],
    }, frame.profile_id || "", frame.id || "");
    return;
  }

  ipc.validate(frame);
  switch (frame.type) {
    case "health.ping":
      emit("health.pong", { nonce: frame.payload?.nonce || "" }, frame.profile_id, frame.id);
      break;
    case "binding.start": {
      if (binding) binding.controller.abort();
      binding = {
        taskId: String(frame.payload?.task_id || ""),
        profileId: frame.profile_id,
        controller: new AbortController(),
        refreshCount: 0,
        qrcode: "",
        pollBaseUrl: FIXED_BASE_URL,
        verifyCode: "",
      };
      void runBinding(binding);
      break;
    }
    case "binding.verify":
      if (binding && binding.taskId === frame.payload?.task_id) {
        binding.verifyCode = String(frame.payload?.verify_code || "").trim();
      }
      break;
    case "binding.cancel":
      if (binding && (!frame.payload?.task_id || binding.taskId === frame.payload.task_id)) binding.controller.abort();
      break;
    case "binding.credentials_stored":
      break;
    case "monitor.start": {
      await stopMonitor("", false);
      const payload = frame.payload || {};
      const state = {
        profileId: frame.profile_id,
        accountId: String(payload.account_id || ""),
        baseUrl: String(payload.base_url || FIXED_BASE_URL),
        token: String(payload.bot_token || ""),
        sessionDir: String(payload.session_dir || ""),
        controller: new AbortController(),
        task: null,
      };
      payload.bot_token = "";
      monitor = state;
      state.task = runMonitor(state);
      break;
    }
    case "monitor.stop":
      await stopMonitor(String(frame.payload?.account_id || ""));
      break;
    case "message.send": {
      try {
        if (!monitor || monitor.accountId !== frame.payload?.account_id) throw new Error("monitor not running");
        const reply = replyContexts.get(String(frame.payload?.reply_to_id || ""));
        const proactive = frame.payload?.proactive === true;
        if (!proactive && (!reply || reply.accountId !== monitor.accountId || reply.targetId !== frame.payload?.target_id)) throw new Error("reply context expired");
        const targetId = proactive ? String(frame.payload?.target_id || "") : reply.targetId;
        if (!targetId) throw new Error("target missing");
        const messageId = frame.payload?.image_path
          ? await sendImage(
            monitor.baseUrl,
            monitor.token,
            targetId,
            String(frame.payload.image_path),
            proactive ? undefined : reply.contextToken,
          )
          : await sendText(
            monitor.baseUrl,
            monitor.token,
            targetId,
            String(frame.payload?.text || "").slice(0, 4000),
            proactive ? undefined : reply.contextToken,
          );
        emit("message.sent", { message_id: messageId }, frame.profile_id, frame.id);
      } catch {
        emit("message.send_failed", { message: "微信消息发送失败。" }, frame.profile_id, frame.id);
      }
      break;
    }
    case "shutdown":
      if (shuttingDown) break;
      shuttingDown = true;
      binding?.controller.abort();
      await stopMonitor("", false);
      emit("shutdown.ack", {}, frame.profile_id, frame.id);
      setTimeout(() => process.exit(0), 10);
      break;
    default:
      throw new Error("Unsupported sidecar command");
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (shuttingDown) return;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return failClosed();
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return failClosed();
  }
  frameChain = frameChain.then(() => handleFrame(frame)).catch(failClosed);
});
lines.on("close", async () => {
  binding?.controller.abort();
  await stopMonitor("", false);
  if (!shuttingDown) process.exit(0);
});
process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);

