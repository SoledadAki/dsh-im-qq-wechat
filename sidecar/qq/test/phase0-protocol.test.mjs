import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FULL_INTENTS,
  GatewayCloseCode,
  GatewayEvent,
  RECONNECT_DELAYS,
  ReconnectState,
  dispatchEvent,
} from "@tencent-connect/qqbot-nodejs/protocol";

const C2C_INTENT = 1 << 25;

async function findPackageRoot(name) {
  let current = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    try {
      const payload = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (payload.name === name) return current;
    } catch {
      // Continue walking.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot find package root for ${name}`);
    current = parent;
  }
}

test("pinned packages match the reviewed versions", async () => {
  for (const [name, expected] of [
    ["@tencent-connect/qqbot-connector", "1.2.0"],
    ["@tencent-connect/qqbot-nodejs", "1.0.4"],
  ]) {
    const root = await findPackageRoot(name);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.version, expected);
  }
});

test("SDK normalizes the documented C2C event fields", () => {
  const result = dispatchEvent(
    GatewayEvent.C2C_MESSAGE_CREATE,
    {
      author: { user_openid: "user-openid" },
      content: "hello",
      id: "message-id",
      timestamp: "2026-07-18T12:00:00+08:00",
      attachments: [{ content_type: "image/png", url: "https://temporary.invalid/image" }],
    },
    "account-id",
  );

  assert.equal(result.action, "message");
  assert.equal(result.msg.kind, "c2c");
  assert.equal(result.msg.senderId, "user-openid");
  assert.equal(result.msg.messageId, "message-id");
  assert.equal(result.msg.content, "hello");
  assert.equal(result.msg.attachments?.length, 1);
});

test("SDK default intents are broader than the first-phase C2C scope", () => {
  assert.equal(FULL_INTENTS & C2C_INTENT, C2C_INTENT);
  assert.notEqual(FULL_INTENTS, C2C_INTENT);
});

test("SDK 1.0.4 currently clears the session for close code 4009", () => {
  const action = new ReconnectState("phase0").handleClose(
    GatewayCloseCode.SESSION_TIMEOUT,
    false,
  );
  assert.equal(action.shouldReconnect, true);
  assert.equal(action.clearSession, true);
  assert.equal(action.refreshToken, true);
});

test("SDK 1.0.4 reconnect schedule is fixed and requires an application jitter patch", () => {
  assert.deepEqual([...RECONNECT_DELAYS], [1000, 2000, 5000, 10000, 30000, 60000]);
});

test("SDK 1.0.4 heartbeat ACK branch has no liveness tracking", async () => {
  const root = await findPackageRoot("@tencent-connect/qqbot-nodejs");
  const source = await readFile(join(root, "src", "protocol", "gateway", "gateway-connection.ts"), "utf8");
  assert.match(source, /case GatewayOp\.HEARTBEAT_ACK:\s*break;/);
});

