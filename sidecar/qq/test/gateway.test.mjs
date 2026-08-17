import assert from "node:assert/strict";
import test from "node:test";

import {
  C2C_INTENT,
  GatewayController,
  HEARTBEAT_TIMEOUT_MS,
} from "../gateway.mjs";


class FakeBot {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.started = false;
    this.stopped = false;
    this.resolveStart = null;
    FakeBot.instances.push(this);
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  emit(type, ...args) {
    for (const handler of this.handlers.get(type) || []) handler(...args);
  }

  start() {
    this.started = true;
    return new Promise((resolve) => { this.resolveStart = resolve; });
  }

  stop() {
    this.stopped = true;
    this.resolveStart?.();
  }

  async sendText(target, text) {
    this.lastSend = { target, text };
    return { id: "outbound-1", timestamp: "2026-07-19T12:00:00Z" };
  }

  async sendImage(target, source) {
    this.lastImage = { target, source };
    return { message: { id: "image-outbound-1", timestamp: "2026-07-19T12:00:01Z" } };
  }

  async openStream(options) {
    this.lastStreamTarget = options;
    const updates = [];
    this.stream = {
      updates,
      completed: false,
      cancelled: false,
      async update(text) { updates.push(text); },
      async complete() { this.completed = true; },
      async cancel() { this.cancelled = true; },
    };
    return this.stream;
  }
}


class FakeSocket {
  constructor() {
    this.handlers = new Map();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }

  off(type, handler) {
    this.handlers.get(type)?.delete(handler);
  }

  emit(type, payload) {
    for (const handler of this.handlers.get(type) || []) handler(payload);
  }
}


function makeHarness(options = {}) {
  FakeBot.instances = [];
  const events = [];
  const controller = new GatewayController({
    emit: (type, payload, profileId) => events.push({ type, payload, profileId }),
    QQBotCtor: FakeBot,
    createSessionPersistence: (sessionDir, accountId) => ({ sessionDir, accountId }),
    ...options,
  });
  return { controller, events };
}


test("heartbeat watchdog fails a stale live gateway and accepts fresh ACKs", async () => {
  let now = 10_000;
  const { controller, events } = makeHarness({ now: () => now, watchdogIntervalMs: 60_000 });
  await controller.start({
    profileId: "profile-1",
    accountId: "account-1",
    appId: "app-1",
    appSecret: "secret-1",
    sessionDir: "C:/temp/qq-session",
  });
  const bot = FakeBot.instances[0];
  const socket = new FakeSocket();
  bot.gateway = { currentWs: socket };
  bot.emit("ready");

  now += HEARTBEAT_TIMEOUT_MS - 1;
  socket.emit("message", JSON.stringify({ op: 11 }));
  assert.equal(controller.checkHealth(), true);

  now += HEARTBEAT_TIMEOUT_MS + 1;
  assert.equal(controller.checkHealth(), false);
  assert.equal(bot.stopped, true);
  assert.equal(events.at(-1).type, "gateway.failed");
  assert.match(events.at(-1).payload.message, /心跳超时/);
});


test("gateway starts with only the reviewed group-and-c2c intent", async () => {
  const { controller, events } = makeHarness();
  await controller.start({
    profileId: "profile-1",
    accountId: "account-1",
    appId: "app-1",
    appSecret: "secret-1",
    sessionDir: "C:/temp/qq-session",
  });

  const bot = FakeBot.instances[0];
  assert.equal(bot.started, true);
  assert.equal(bot.options.intents, C2C_INTENT);
  assert.equal(bot.options.intents, 1 << 25);
  assert.equal(bot.options.tokenPrefetch, "sync");
  assert.equal(bot.options.transport, "websocket");
  assert.deepEqual(bot.options.sessionPersistence, {
    sessionDir: "C:/temp/qq-session",
    accountId: "account-1",
  });
  assert.equal(events[0].type, "gateway.starting");

  bot.emit("ready");
  bot.emit("resumed");
  bot.emit("error", new Error("temporary"));
  assert.deepEqual(events.map((event) => event.type), [
    "gateway.starting",
    "gateway.ready",
    "gateway.resumed",
    "gateway.failed",
  ]);
  assert.equal(bot.stopped, true);
  assert.match(events.at(-1).payload.message, /自动恢复/);
});


test("starting another account stops the previous gateway first", async () => {
  const { controller } = makeHarness();
  await controller.start({
    profileId: "profile-1",
    accountId: "account-1",
    appId: "app-1",
    appSecret: "secret-1",
    sessionDir: "C:/temp/one",
  });
  const first = FakeBot.instances[0];

  await controller.start({
    profileId: "profile-1",
    accountId: "account-2",
    appId: "app-2",
    appSecret: "secret-2",
    sessionDir: "C:/temp/two",
  });

  assert.equal(first.stopped, true);
  assert.equal(FakeBot.instances.length, 2);
  assert.equal(controller.active.accountId, "account-2");
  await controller.stop();
});


test("gateway emits only normalized C2C metadata and sends an associated reply", async () => {
  const { controller, events } = makeHarness();
  await controller.start({
    profileId: "profile-1",
    accountId: "account-1",
    appId: "app-1",
    appSecret: "secret-1",
    sessionDir: "C:/temp/qq-session",
  });
  const bot = FakeBot.instances[0];
  bot.emit("message", {}, {
    kind: "c2c",
    senderId: "openid-1",
    content: "hello",
    messageId: "inbound-1",
    timestamp: "2026-07-19T12:00:00+08:00",
    replyTarget: { scope: "c2c", targetId: "openid-1", msgId: "inbound-1" },
    attachments: [{ content_type: "image/png", filename: "image.png", size: 42, url: "https://secret.invalid" }],
    raw: { should_not_escape: true },
  });

  const inbound = events.find((event) => event.type === "gateway.message");
  assert.equal(inbound.payload.sender_id, "openid-1");
  assert.equal(inbound.payload.message_id, "inbound-1");
  assert.equal(inbound.payload.reply_to_id, "");
  assert.deepEqual(inbound.payload.attachments, [{
    kind: "image",
    content_type: "image/png",
    filename: "image.png",
    size: 42,
    download_url: "https://secret.invalid",
  }]);
  assert.equal(JSON.stringify(inbound).includes("should_not_escape"), false);

  const sent = await controller.sendText({
    accountId: "account-1",
    targetId: "openid-1",
    replyToId: "inbound-1",
    text: "world",
  });
  assert.deepEqual(bot.lastSend, {
    target: { scope: "c2c", targetId: "openid-1", msgId: "inbound-1" },
    text: "world",
  });
  assert.equal(sent.message_id, "outbound-1");

  await controller.sendText({
    accountId: "account-1",
    targetId: "openid-1",
    replyToId: "",
    text: "proactive",
  });
  assert.deepEqual(bot.lastSend, {
    target: { scope: "c2c", targetId: "openid-1" },
    text: "proactive",
  });
  const image = await controller.sendImage({
    accountId: "account-1",
    targetId: "openid-1",
    replyToId: "inbound-1",
    imagePath: "C:/stickers/happy.png",
  });
  assert.deepEqual(bot.lastImage, {
    target: { scope: "c2c", targetId: "openid-1", msgId: "inbound-1" },
    source: { localPath: "C:/stickers/happy.png" },
  });
  assert.equal(image.message_id, "image-outbound-1");
  await controller.stop();
});

test("gateway uses the QQ SDK native C2C stream lifecycle", async () => {
  const { controller } = makeHarness();
  await controller.start({ profileId: "profile-1", accountId: "account-1", appId: "app-1", appSecret: "secret-1", sessionDir: "C:/temp/qq-session" });
  const bot = FakeBot.instances[0];
  await controller.startStream({ accountId: "account-1", streamId: "stream-1", targetId: "owner-1", replyToId: "message-1" });
  await controller.updateStream({ accountId: "account-1", streamId: "stream-1", text: "你好" });
  await controller.finishStream({ accountId: "account-1", streamId: "stream-1", text: "你好，完成" });
  assert.deepEqual(bot.lastStreamTarget, { target: { scope: "c2c", targetId: "owner-1", msgId: "message-1" }, throttleMs: 600 });
  assert.deepEqual(bot.stream.updates, ["正在思考…", "你好", "你好，完成"]);
  assert.equal(bot.stream.completed, true);
  assert.equal(controller.active.streams.size, 0);
  await controller.stop();
});
