import readline from "node:readline";

import { QrBindingController } from "./binding.mjs";
import { GatewayController } from "./gateway.mjs";
import { JsonLineIpc, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./ipc.mjs";


const ipc = new JsonLineIpc();
const binding = new QrBindingController({
  emit: (type, payload, profileId) => ipc.send(type, payload, profileId),
});
const gateway = new GatewayController({
  emit: (type, payload, profileId) => ipc.send(type, payload, profileId),
});
let shuttingDown = false;
let frameChain = Promise.resolve();


function failClosed() {
  shuttingDown = true;
  binding.cancel("", false);
  void gateway.stop("", false);
  process.stderr.write("QQ sidecar stopped because its private IPC stream was invalid.\n");
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 10);
}


async function handleFrame(frame) {
  if (ipc.launchToken === null) {
    ipc.acceptHello(frame);
    ipc.send(
      "hello.ack",
      {
        protocol_version: PROTOCOL_VERSION,
        sidecar_version: "0.1.0",
        connector_version: "1.2.0",
        sdk_version: "1.0.4",
        capabilities: ["qr_connect", "credential_handoff", "gateway_c2c", "c2c_text", "c2c_stream"],
      },
      frame.profile_id || "",
      frame.id || "",
    );
    return;
  }

  ipc.validate(frame);
  switch (frame.type) {
    case "health.ping":
      ipc.send(
        "health.pong",
        { nonce: frame.payload?.nonce || "", gateway: gateway.health() },
        frame.profile_id,
        frame.id,
      );
      break;
    case "binding.start":
      binding.start({ taskId: frame.payload?.task_id, profileId: frame.profile_id });
      break;
    case "binding.cancel":
      binding.cancel(frame.payload?.task_id || "");
      break;
    case "binding.credentials_stored":
      break;
    case "gateway.start": {
      const payload = frame.payload || {};
      try {
        await gateway.start({
          profileId: frame.profile_id,
          accountId: payload.account_id,
          appId: payload.app_id,
          appSecret: payload.app_secret,
          sessionDir: payload.session_dir,
        });
      } finally {
        payload.app_secret = "";
      }
      break;
    }
    case "gateway.stop":
      await gateway.stop(frame.payload?.account_id || "");
      break;
    case "message.send":
      try {
        ipc.send(
          "message.sent",
          frame.payload?.image_path
            ? await gateway.sendImage({
              accountId: frame.payload?.account_id,
              targetId: frame.payload?.target_id,
              replyToId: frame.payload?.reply_to_id,
              imagePath: frame.payload?.image_path,
            })
            : await gateway.sendText({
              accountId: frame.payload?.account_id,
              targetId: frame.payload?.target_id,
              replyToId: frame.payload?.reply_to_id,
              text: frame.payload?.text,
            }),
          frame.profile_id,
          frame.id,
        );
      } catch {
        ipc.send(
          "message.send_failed",
          { message: "QQ 消息发送失败。" },
          frame.profile_id,
          frame.id,
        );
      }
      break;
    case "stream.start":
    case "stream.update":
    case "stream.finish":
    case "stream.cancel":
      try {
        const method = frame.type === "stream.start" ? "startStream"
          : frame.type === "stream.update" ? "updateStream"
            : frame.type === "stream.finish" ? "finishStream" : "cancelStream";
        await gateway[method]({
          accountId: frame.payload?.account_id,
          streamId: frame.payload?.stream_id,
          targetId: frame.payload?.target_id,
          replyToId: frame.payload?.reply_to_id,
          text: frame.payload?.text,
        });
        ipc.send("stream.ok", {}, frame.profile_id, frame.id);
      } catch {
        ipc.send("stream.failed", { message: "QQ 流式回复失败。" }, frame.profile_id, frame.id);
      }
      break;
    case "shutdown":
      if (shuttingDown) break;
      shuttingDown = true;
      binding.cancel("", false);
      await gateway.stop("", false);
      ipc.send("shutdown.ack", {}, frame.profile_id, frame.id);
      setTimeout(() => process.exit(0), 10);
      break;
    default:
      throw new Error("Unsupported sidecar command");
  }
}


const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (shuttingDown) return;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    failClosed();
    return;
  }
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    failClosed();
    return;
  }
  frameChain = frameChain.then(() => handleFrame(frame)).catch(failClosed);
});
lines.on("close", async () => {
  binding.cancel("", false);
  await gateway.stop("", false);
  if (!shuttingDown) process.exit(0);
});

process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);
