# dsh-im-qq-wechat

面向 DeepSeek Harness 的即时通信插件：把 QQ、微信、企业微信、飞书和 Telegram 接入同一套持久 Agent 会话。

`dsh-im-qq-wechat` is a DeepSeek Harness Host plugin that brings QQ, WeChat, WeCom, Feishu, and Telegram into persistent Agent sessions. It is designed primarily for mainland-China IM platforms, while Telegram is supported as an international option.

## 项目定位 · Project focus

| 中文 | English |
| --- | --- |
| 主要服务国内 IM 场景：QQ、微信、企业微信、飞书 | Built first for mainland-China IM: QQ, WeChat, WeCom, and Feishu |
| Telegram 作为可选的跨境通道 | Telegram is available as an optional international channel |
| 消息直接进入 DeepSeek Harness Agent，不依赖独立 HTTP 轮询层 | Messages go directly to DeepSeek Harness Agents without a separate HTTP polling layer |
| 多平台共享会话、项目、模型、思考强度和安全审核能力 | Sessions, workspaces, models, reasoning effort, and approvals are managed consistently across platforms |

## 功能矩阵 · Feature matrix

| 通道 / Channel | 接入方式 / Connection | 流式回复 / Streaming | 正在输入 / Typing | 备注 / Notes |
| --- | --- | ---: | ---: | --- |
| QQ | 官方 Gateway 扫码绑定 | ✅ 原生流式 | ✅ | C2C 私聊与群聊 @ |
| 微信 / WeChat | iLink 扫码绑定 | — | ✅ | 不支持原生编辑流时自动发送完整回复 |
| 企业微信 / WeCom | 官方扫码创建机器人，或 Bot ID + Secret | ✅ WebSocket 流式 | ✅ 思考状态 | 支持官方 AI Bot WebSocket |
| 飞书 / Feishu | Device Flow 扫码创建应用，或 App ID + Secret | ✅ CardKit 流式卡片 | ✅ OnIt 状态 | 支持 Feishu 与 Lark 域名 |
| Telegram | Bot Token 配置 | ✅ 编辑消息流式 | ✅ typing | 私聊或 @机器人消息 |

## 核心能力 · Core capabilities

| 能力 | 说明 |
| --- | --- |
| 会话管理 | `/new`、`/reset`、`/list`、`/use`，每个用户可维护独立会话历史 |
| 项目管理 | `/work <路径>` 切换 Agent 工作区；真实路径只用于执行，不默认转发到 IM |
| 模型管理 | `/model` 查看可用模型，支持编号或 `provider/model-id` 切换 |
| 思考强度 | `/think` 查看或调整模型支持的 reasoning effort |
| 安全审核 | `/safe` 查看或切换只读、写入、完全访问等级；审核可在 IM 中确认或拒绝 |
| 工具进度 | 原生流式通道显示正在思考、工具调用和最终回复 |
| 凭据安全 | Token、Secret 仅交给 Harness credentials，插件设置只保存非敏感绑定元数据 |
| 隐私保护 | `redactWorkspacePaths: true` 默认隐藏已知本机绝对路径 |

## 安装 · Installation

要求 Node.js 22+ 与 DeepSeek Harness rc.6 或兼容版本。

Requires Node.js 22+ and DeepSeek Harness rc.6 (or a compatible release).

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-im-qq-wechat-0.4.0.tgz
dsh --profile web
```

## 默认配置 · Default configuration

```yaml
channels: [qq, wechat, wecom, feishu, telegram]
sharedSession: false
preset: ''
cwd: ''
stateDir: ''
sourceKind: user
approvalPolicy: ask
replyTimeoutMs: 0
redactWorkspacePaths: true
```

`redactWorkspacePaths` 保留真实工作目录供 Harness 执行，但会在 QQ、微信、企业微信、飞书和 Telegram 的普通回复、命令卡片及流式回复中隐藏已知绝对路径。只有在受控排障环境中才建议设为 `false`。

`redactWorkspacePaths` keeps the real working directory available to Harness while hiding known absolute paths in outbound messages. Set it to `false` only in a controlled debugging environment.

## 常用命令 · Common commands

| 命令 / Command | 作用 / Purpose |
| --- | --- |
| `/help` | 查看精简帮助 / Show concise help |
| `/new [名称]` | 新建会话 / Create a session |
| `/reset` | 清除当前会话上下文 / Reset current context |
| `/model [编号\|provider/model]` | 查看或切换模型 / List or switch model |
| `/work <路径>` | 切换项目目录 / Switch workspace |
| `/list`、`/use <编号或 ID>` | 查看和切换会话 / List and select sessions |
| `/think [off\|low\|medium\|high\|max]` | 调整思考强度 / Set reasoning effort |
| `/safe [read\|write\|full]` | 调整安全等级 / Set approval policy |
| `/stop` | 停止当前任务 / Stop the current task |

命令名称和参数支持中英文混用，例如 `/think off`、`/思考 关闭`、`/model 2`。

Commands and arguments accept mixed Chinese and English, for example `/think off`, `/思考 关闭`, and `/model 2`.

## 绑定与审核 · Binding and approvals

在 Harness Web 的“接入即时通信”设置中绑定通道。QQ、微信、企业微信和飞书支持扫码流程；Telegram 使用 Bot Token。绑定后，首次私聊发送页面显示的配对码即可成为 owner。

Use the “即时通信 / IM connections” section in Harness Web to connect a channel. QR binding is available for QQ, WeChat, WeCom, and Feishu; Telegram uses a Bot Token. After connecting, send the displayed pairing code in a private chat to become the owner.

当 Agent 需要审核时，机器人会发送编号。直接回复以下任一形式即可：

```text
/同意 <编号>       /approve <编号>
/拒绝 <编号>       /reject <编号>
```

## 开发与发布 · Development and release

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

客户端构建产物必须是 classic-script IIFE，并同步注册 `dsh-im-qq-wechat`；构建脚本会拒绝 ESM 语法或错误模块 ID。

The client bundle must be a classic-script IIFE and synchronously register `dsh-im-qq-wechat`; the build verification rejects ESM syntax and mismatched module IDs.

QQ/微信通道基于已验证的 LiaoData 实现；飞书、Telegram、可编辑流式消息参考 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)；模型查看与切换思路参考 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)。第三方许可证与来源见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

The QQ/WeChat transports are based on the reviewed LiaoData implementation. Feishu, Telegram, and editable streaming patterns were informed by [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im); model discovery and switching were informed by [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution and licenses.

## 许可证 · License

MIT. See [LICENSE](./LICENSE).
