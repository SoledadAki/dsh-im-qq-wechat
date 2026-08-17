import {
  FileKVStore,
  QQBot,
  kvSessionPersistence,
} from "@tencent-connect/qqbot-nodejs";
import { GatewayOp } from "@tencent-connect/qqbot-nodejs/protocol";


// Confirmed from @tencent-connect/qqbot-nodejs 1.0.4
// src/protocol/gateway/constants.ts: GROUP_AND_C2C = 1 << 25.
export const C2C_INTENT = 1 << 25;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const GATEWAY_START_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 15_000;


const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
});


function attachmentKind(contentType) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "file";
}


function safeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 8).map((item) => {
    const contentType = typeof item?.content_type === "string" ? item.content_type.slice(0, 120) : "";
    const filename = typeof item?.filename === "string"
      ? item.filename.slice(0, 180)
      : typeof item?.name === "string" ? item.name.slice(0, 180) : "";
    const size = Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : null;
    return {
      kind: attachmentKind(contentType),
      content_type: contentType,
      filename,
      size,
      download_url: typeof item?.url === "string" ? item.url.slice(0, 4096) : "",
    };
  });
}


export class GatewayController {
  constructor({
    emit,
    QQBotCtor = QQBot,
    createSessionPersistence = (sessionDir, accountId) => kvSessionPersistence({
      store: new FileKVStore({ dir: sessionDir, fileName: "gateway-session.json" }),
      accountId,
    }),
    now = Date.now,
    watchdogIntervalMs = WATCHDOG_INTERVAL_MS,
  }) {
    this.emit = emit;
    this.QQBotCtor = QQBotCtor;
    this.createSessionPersistence = createSessionPersistence;
    this.now = now;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.active = null;
  }

  async start({ profileId, accountId, appId, appSecret, sessionDir }) {
    if (!profileId || !accountId || !appId || !appSecret || !sessionDir) {
      throw new Error("Gateway start requires profile, account, credentials, and session directory");
    }
    await this.stop("", false);

    const bot = new this.QQBotCtor({
      appId,
      appSecret,
      accountId,
      intents: C2C_INTENT,
      tokenPrefetch: "sync",
      transport: "websocket",
      sessionPersistence: this.createSessionPersistence(sessionDir, accountId),
      logger: silentLogger,
    });
    const run = {
      profileId,
      accountId,
      bot,
      stopping: false,
      failed: false,
      ready: false,
      startedAt: this.now(),
      lastHeartbeatAckAt: 0,
      observedSocket: null,
      socketMessageHandler: null,
      watchdog: null,
      startPromise: null,
      streams: new Map(),
    };
    this.active = run;

    bot.on("ready", () => {
      if (this.active !== run) return;
      run.ready = true;
      run.lastHeartbeatAckAt = this.now();
      this.observeSocket(run);
      this.emit("gateway.ready", { account_id: accountId }, profileId);
    });
    bot.on("resumed", () => {
      if (this.active !== run) return;
      run.ready = true;
      run.lastHeartbeatAckAt = this.now();
      this.observeSocket(run);
      this.emit("gateway.resumed", { account_id: accountId }, profileId);
    });
    bot.on("error", () => {
      if (this.active !== run || run.stopping) return;
      this.fail(run, "QQ 连接暂时中断，正在自动恢复。");
    });
    bot.on("message", (_ctx, message) => {
      if (this.active !== run || message?.kind !== "c2c") return;
      const senderId = typeof message.senderId === "string" ? message.senderId : "";
      const messageId = typeof message.messageId === "string" ? message.messageId : "";
      if (!senderId || !messageId) return;
      this.emit(
        "gateway.message",
        {
          account_id: accountId,
          sender_id: senderId,
          message_id: messageId,
          reply_to_id: "",
          text: typeof message.content === "string" ? message.content.slice(0, 12000) : "",
          timestamp: String(message.timestamp || new Date().toISOString()),
          attachments: safeAttachments(message.attachments),
        },
        profileId,
      );
    });

    this.emit("gateway.starting", { account_id: accountId }, profileId);
    run.watchdog = setInterval(() => this.checkHealth(), this.watchdogIntervalMs);
    run.watchdog.unref?.();
    run.startPromise = Promise.resolve(bot.start())
      .then(() => {
        if (this.active !== run || run.stopping) return;
        this.fail(run, "QQ Gateway 已停止，正在自动恢复。");
      })
      .catch(() => {
        if (this.active !== run || run.stopping) return;
        this.fail(run, "QQ Gateway 连接失败，正在自动恢复。");
      });
  }

  observeSocket(run) {
    const socket = run.bot?.gateway?.currentWs;
    if (!socket || socket === run.observedSocket || typeof socket.on !== "function") return;
    if (run.observedSocket && run.socketMessageHandler) {
      run.observedSocket.off?.("message", run.socketMessageHandler);
    }
    run.observedSocket = socket;
    run.lastHeartbeatAckAt = this.now();
    const sdkHeartbeatInterval = Number(run.bot?.gateway?.heartbeatInterval?._repeat);
    run.heartbeatTimeoutMs = Number.isFinite(sdkHeartbeatInterval)
      ? Math.max(HEARTBEAT_TIMEOUT_MS, sdkHeartbeatInterval * 2.5)
      : HEARTBEAT_TIMEOUT_MS;
    run.socketMessageHandler = (data) => {
      try {
        const payload = JSON.parse(
          typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
        );
        if (payload?.op === GatewayOp.HEARTBEAT_ACK) run.lastHeartbeatAckAt = this.now();
      } catch {
        // The SDK owns decoding; this listener only observes plain JSON ACKs.
      }
    };
    socket.on("message", run.socketMessageHandler);
  }

  checkHealth(now = this.now()) {
    const run = this.active;
    if (!run || run.stopping || run.failed) return false;
    this.observeSocket(run);
    if (!run.ready) {
      if (now - run.startedAt <= GATEWAY_START_TIMEOUT_MS) return true;
      return this.fail(run, "QQ Gateway 连接超时，正在自动恢复。");
    }
    if (!run.observedSocket || now - run.lastHeartbeatAckAt <= run.heartbeatTimeoutMs) return true;
    return this.fail(run, "QQ Gateway 心跳超时，正在自动恢复。");
  }

  health() {
    const healthy = this.checkHealth();
    const run = this.active;
    return {
      healthy,
      status: !run ? "stopped" : run.ready ? "connected" : "starting",
      heartbeat_age_ms: run?.lastHeartbeatAckAt
        ? Math.max(0, this.now() - run.lastHeartbeatAckAt)
        : null,
    };
  }

  fail(run, message) {
    if (this.active !== run || run.stopping || run.failed) return false;
    run.failed = true;
    this.active = null;
    this.cleanup(run);
    Promise.resolve(run.bot.stop()).catch(() => {});
    this.emit(
      "gateway.failed",
      { account_id: run.accountId, message },
      run.profileId,
    );
    return false;
  }

  cleanup(run) {
    if (run.watchdog) clearInterval(run.watchdog);
    run.watchdog = null;
    if (run.observedSocket && run.socketMessageHandler) {
      run.observedSocket.off?.("message", run.socketMessageHandler);
    }
    run.observedSocket = null;
    run.socketMessageHandler = null;
    for (const stream of run.streams.values()) Promise.resolve(stream.cancel()).catch(() => {});
    run.streams.clear();
  }

  async stop(accountId = "", emitStopped = true) {
    const run = this.active;
    if (!run || (accountId && accountId !== run.accountId)) return false;
    run.stopping = true;
    this.active = null;
    this.cleanup(run);
    try {
      await run.bot.stop();
    } finally {
      if (emitStopped) {
        this.emit("gateway.stopped", { account_id: run.accountId }, run.profileId);
      }
    }
    return true;
  }

  async sendText({ accountId, targetId, replyToId, text }) {
    const run = this.active;
    if (!run || run.accountId !== accountId) throw new Error("Gateway is not running for this account");
    if (!targetId || !text) throw new Error("C2C message requires target and text");
    const result = await run.bot.sendText(
      replyToId ? { scope: "c2c", targetId, msgId: replyToId } : { scope: "c2c", targetId },
      text.slice(0, 5000),
    );
    return {
      message_id: typeof result?.id === "string" ? result.id : "",
      timestamp: String(result?.timestamp || new Date().toISOString()),
    };
  }

  async startStream({ accountId, streamId, targetId, replyToId }) {
    const run = this.active;
    if (!run || run.accountId !== accountId) throw new Error("Gateway is not running for this account");
    if (!streamId || !targetId || !replyToId) throw new Error("C2C stream requires id, target, and source message");
    const stream = await run.bot.openStream({
      target: { scope: "c2c", targetId, msgId: replyToId },
      throttleMs: 600,
    });
    run.streams.set(streamId, stream);
    await stream.update("正在思考…");
  }

  async updateStream({ accountId, streamId, text }) {
    const run = this.active;
    const stream = run?.streams.get(streamId);
    if (!run || run.accountId !== accountId || !stream) throw new Error("QQ stream is not active");
    await stream.update(String(text || "").slice(0, 5000));
  }

  async finishStream({ accountId, streamId, text }) {
    const run = this.active;
    const stream = run?.streams.get(streamId);
    if (!run || run.accountId !== accountId || !stream) throw new Error("QQ stream is not active");
    try {
      await stream.update(String(text || "处理完成。").slice(0, 5000));
      await stream.complete();
    }
    finally { run.streams.delete(streamId); }
  }

  async cancelStream({ accountId, streamId }) {
    const run = this.active;
    const stream = run?.streams.get(streamId);
    if (!run || run.accountId !== accountId || !stream) return;
    try { await stream.cancel(); } finally { run.streams.delete(streamId); }
  }

  async sendImage({ accountId, targetId, replyToId, imagePath }) {
    const run = this.active;
    if (!run || run.accountId !== accountId) throw new Error("Gateway is not running for this account");
    if (!targetId || !imagePath) throw new Error("C2C image requires target and local path");
    const result = await run.bot.sendImage(
      replyToId ? { scope: "c2c", targetId, msgId: replyToId } : { scope: "c2c", targetId },
      { localPath: imagePath },
    );
    return {
      message_id: typeof result?.message?.id === "string" ? result.message.id : "",
      timestamp: String(result?.message?.timestamp || new Date().toISOString()),
    };
  }
}
