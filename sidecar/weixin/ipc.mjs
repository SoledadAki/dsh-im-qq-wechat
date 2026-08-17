import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

export class JsonLineIpc {
  constructor() {
    this.launchToken = null;
  }

  acceptHello(frame) {
    if (this.launchToken !== null) throw new Error("Sidecar handshake already completed");
    if (frame?.v !== PROTOCOL_VERSION || frame?.type !== "hello") {
      throw new Error("First sidecar frame must be a compatible hello message");
    }
    if (typeof frame.token !== "string" || frame.token.length < 32) {
      throw new Error("Sidecar hello message is missing its launch token");
    }
    this.launchToken = frame.token;
  }

  validate(frame) {
    if (this.launchToken === null) throw new Error("Sidecar handshake is incomplete");
    if (frame?.v !== PROTOCOL_VERSION) throw new Error("Unsupported sidecar protocol version");
    if (frame?.token !== this.launchToken) throw new Error("Invalid sidecar launch token");
    if (typeof frame.type !== "string" || !frame.type) throw new Error("Invalid sidecar frame type");
  }

  send(type, payload = {}, profileId = "", requestId = "") {
    if (this.launchToken === null) throw new Error("Cannot send before sidecar handshake");
    const frame = {
      v: PROTOCOL_VERSION,
      id: requestId || randomUUID(),
      token: this.launchToken,
      type,
      profile_id: profileId,
      timestamp: new Date().toISOString(),
      payload,
    };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("Sidecar output frame exceeds the size limit");
    }
    process.stdout.write(encoded);
  }
}

