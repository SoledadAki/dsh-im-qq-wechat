import assert from "node:assert/strict";
import test from "node:test";

import { QrBindingController } from "../binding.mjs";


function makeHarness() {
  const events = [];
  const connectorRuns = [];
  const controller = new QrBindingController({
    emit: (type, payload, profileId) => events.push({ type, payload, profileId }),
    startQrConnectFn: (callbacks, options) => {
      const run = { callbacks, options, stopCount: 0 };
      connectorRuns.push(run);
      return () => { run.stopCount += 1; };
    },
  });
  return { controller, events, connectorRuns };
}


test("binding forwards QR refresh and clears credentials after handoff", () => {
  const { controller, events, connectorRuns } = makeHarness();
  controller.start({ taskId: "task-1", profileId: "profile-1" });
  const run = connectorRuns[0];
  const credentials = [{ appId: "123456", appSecret: "do-not-log-me", userOpenid: "owner-openid" }];

  run.callbacks.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=connector-task");
  run.callbacks.onQrExpired();
  run.callbacks.onSuccess(credentials);

  assert.deepEqual(events.map((event) => event.type), [
    "binding.started",
    "binding.qr_displayed",
    "binding.qr_expired",
    "binding.credentials",
  ]);
  assert.equal(events.at(-1).payload.app_secret, "do-not-log-me");
  assert.equal(events.at(-1).payload.user_openid, "owner-openid");
  assert.deepEqual(credentials, []);
  assert.equal(controller.active, null);
});


test("starting a replacement cancels the old poller and ignores late callbacks", () => {
  const { controller, events, connectorRuns } = makeHarness();
  controller.start({ taskId: "old-task", profileId: "profile-1" });
  const oldRun = connectorRuns[0];
  controller.start({ taskId: "new-task", profileId: "profile-1" });

  assert.equal(oldRun.stopCount, 1);
  oldRun.callbacks.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=late");
  assert.equal(events.filter((event) => event.type === "binding.qr_displayed").length, 0);
  assert.equal(controller.active.taskId, "new-task");
});


test("explicit cancellation stops once and makes callbacks inert", () => {
  const { controller, events, connectorRuns } = makeHarness();
  controller.start({ taskId: "task-1", profileId: "profile-1" });
  const run = connectorRuns[0];

  assert.equal(controller.cancel("task-1"), true);
  assert.equal(controller.cancel("task-1"), false);
  assert.equal(run.stopCount, 1);
  run.callbacks.onSuccess([{ appId: "123", appSecret: "late-secret" }]);
  assert.equal(events.at(-1).type, "binding.cancelled");
  assert.equal(events.some((event) => event.type === "binding.credentials"), false);
});


test("unexpected credential arrays fail closed", () => {
  const { controller, events, connectorRuns } = makeHarness();
  controller.start({ taskId: "task-1", profileId: "profile-1" });
  connectorRuns[0].callbacks.onSuccess([]);

  assert.equal(events.at(-1).type, "binding.failed");
  assert.equal(events.at(-1).payload.code, "unexpected_credential_count");
  assert.equal(controller.active, null);
});

