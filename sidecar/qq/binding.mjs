import { startQrConnect } from "@tencent-connect/qqbot-connector";


const RELEASE_QR_PROTOCOL = "https:";
const RELEASE_QR_HOST = "q.qq.com";
const RELEASE_QR_PATH = "/qqbot/openclaw/connect.html";


export function inspectQrUrl(qrUrl) {
  const url = new URL(qrUrl);
  if (url.protocol !== RELEASE_QR_PROTOCOL) throw new Error("Unexpected QR URL protocol");
  if (url.hostname !== RELEASE_QR_HOST) throw new Error("Unexpected QR URL host");
  if (url.pathname !== RELEASE_QR_PATH) throw new Error("Unexpected QR URL path");
  if (!url.searchParams.get("task_id")) throw new Error("QR URL is missing task_id");
  return url;
}


export class QrBindingController {
  constructor({ emit, startQrConnectFn = startQrConnect }) {
    this.emit = emit;
    this.startQrConnectFn = startQrConnectFn;
    this.active = null;
  }

  start({ taskId, profileId }) {
    if (!taskId || !profileId) throw new Error("Binding task requires taskId and profileId");
    this.cancel();

    const task = { taskId, profileId, stop: null };
    this.active = task;
    task.stop = this.startQrConnectFn(
      {
        onQrDisplayed: (qrUrl) => {
          if (!this.#isActive(task)) return;
          try {
            inspectQrUrl(qrUrl);
            this.emit("binding.qr_displayed", { task_id: taskId, qr_url: qrUrl }, profileId);
          } catch {
            this.emit(
              "binding.failed",
              { task_id: taskId, code: "invalid_qr_url", message: "腾讯返回了无法识别的二维码地址。" },
              profileId,
            );
            this.cancel(taskId, false);
          }
        },
        onQrExpired: () => {
          if (!this.#isActive(task)) return;
          this.emit("binding.qr_expired", { task_id: taskId }, profileId);
        },
        onSuccess: (credentials) => {
          if (!this.#isActive(task)) return;
          if (!Array.isArray(credentials) || credentials.length !== 1) {
            this.emit(
              "binding.failed",
              {
                task_id: taskId,
                code: "unexpected_credential_count",
                message: "当前版本一次只能绑定一个 QQ 机器人。",
              },
              profileId,
            );
            this.active = null;
            return;
          }

          const credential = credentials[0];
          const appId = typeof credential?.appId === "string" ? credential.appId.trim() : "";
          const appSecret = typeof credential?.appSecret === "string" ? credential.appSecret : "";
          const userOpenid = typeof credential?.userOpenid === "string" ? credential.userOpenid.trim() : "";
          if (!appId || !appSecret) {
            this.emit(
              "binding.failed",
              { task_id: taskId, code: "invalid_credentials", message: "腾讯没有返回完整的机器人凭据。" },
              profileId,
            );
            this.active = null;
            return;
          }

          this.emit(
            "binding.credentials",
            { task_id: taskId, app_id: appId, app_secret: appSecret, user_openid: userOpenid },
            profileId,
          );
          credential.appSecret = "";
          credentials.splice(0, credentials.length);
          this.active = null;
        },
        onFailure: (error) => {
          if (!this.#isActive(task)) return;
          this.emit(
            "binding.failed",
            {
              task_id: taskId,
              code: "connector_failure",
              message: error?.name === "AbortError" ? "扫码任务已取消。" : "QQ 扫码绑定失败，请重试。",
            },
            profileId,
          );
          this.active = null;
        },
      },
      {
        displayQrCodeToConsole: false,
        source: "",
      },
    );

    this.emit("binding.started", { task_id: taskId }, profileId);
  }

  cancel(taskId = "", emitCancelled = true) {
    const task = this.active;
    if (!task || (taskId && task.taskId !== taskId)) return false;
    this.active = null;
    try {
      task.stop?.();
    } finally {
      if (emitCancelled) {
        this.emit("binding.cancelled", { task_id: task.taskId }, task.profileId);
      }
    }
    return true;
  }

  #isActive(task) {
    return this.active === task;
  }
}

