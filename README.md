# dsh-im-qq-wechat

把 QQ、微信、企业微信、飞书和 Telegram 接入 DeepSeek Harness。装上插件、在 Harness 设置里绑定账号，就能从聊天窗口派任务、收回复、处理工具审批。

## 安装

适用环境：**DeepSeek Harness 0.1.5-rc.2 的 Web profile**、Node.js 22+。请先在 Harness 中配置可用模型。

1. 从 [GitHub Release 下载 dsh-im-qq-wechat-0.5.5.tgz](https://github.com/SoledadAki/dsh-im-qq-wechat/releases/download/v0.5.5/dsh-im-qq-wechat-0.5.5.tgz)。**保留 `.tgz` 原文件，不要解压，也不要下载仓库的 “Source code (zip)” 当作安装包。**
2. 在运行 Harness 的同一个环境中打开终端，安装到你实际使用的 profile。默认 Web profile 为 `web`：

```sh
dsh plugin --profile web add /path/to/dsh-im-qq-wechat-0.5.5.tgz
dsh --profile web --dump-config
dsh --profile web
```

把 `/path/to/` 换成下载文件所在目录；Windows PowerShell 示例：`dsh plugin --profile web add "E:\Download\dsh-im-qq-wechat-0.5.5.tgz"`。如果 Harness 运行在 WSL 中，请在 WSL 终端安装，Windows 的 `E:\Download` 对应 `/mnt/e/Download`。`--dump-config` 输出中出现 `qq-weixin`，表示插件配置层已加入 profile。安装或升级后重启 Harness，并刷新浏览器页面。

首次安装会联网拉取运行依赖，之后无需手动运行 `pnpm install` 或构建。解压后看见的 `package/` 是 npm 安装包的标准内部目录：`lib/`、`sidecar/` 和 `cordis.patch.yml` 是运行内容；`README.md`、`LICENSE` 和 `THIRD_PARTY_NOTICES.md` 是随包文档。

## 首次使用

1. 重启 Harness，打开设置中的 **接入即时通信**。
2. 选择要接入的通道，扫码或填入自己的机器人凭据。
3. 按页面提示完成平台授权，或私聊机器人用配对码绑定。
4. 向机器人发送任务；需要工具审核时，按编号回复 `/同意` 或 `/拒绝`。

| 通道 | 接入方式 | 回复形式 |
| --- | --- | --- |
| QQ | 扫码授权 | 原生流式；失败时自动改发普通消息，完整长回复分段 |
| 微信 | 扫码授权 | 完整回复分段 |
| 企业微信 | 扫码或 Bot ID / Secret | WebSocket 流式 |
| 飞书 | 扫码或 App ID / Secret | 流式卡片 |
| Telegram | Bot Token + 私聊配对码 | 编辑消息流式 |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看帮助 |
| `/new [名称]` | 新建会话 |
| `/list`、`/use <编号>` | 查看、切换会话 |
| `/reset` | 清空当前上下文 |
| `/work <路径>` | 切换工作目录 |
| `/model`、`/think` | 查看或修改模型、思考强度 |
| `/safe` | 查看或修改安全等级 |
| `/stop` | 停止任务 |

## 使用说明

- 提问与工具审批按 Agent 路由回发起任务的 IM 通道；Harness 自身的 Web 会话仍由 Web 回答。
- 当前版本聚焦文本任务链路。
- 工作区路径默认隐藏，工具审批默认开启。

## 升级与卸载

升级时安装新版 `.tgz` 并重启 Harness。绑定关系和会话存放在 Harness settings / credentials 中，0.5.5 沿用原有存储格式，覆盖安装即可。

```sh
dsh plugin --profile web remove dsh-im-qq-wechat
```

## 排障

- 设置页没有插件入口：确认安装的是本插件 `.tgz`，重启 Harness，并核对 Harness 版本为 0.1.5-rc.2。
- 已连接但不响应：检查绑定用户与群聊的 @ / 回复条件，先用绑定账号私聊测试。
- 已连接但只回复“处理失败”：升级到 0.5.2，重启 Harness 后再测试。
- QQ 显示“正在思考…”后无结果，或 Harness 意外退出：升级到 0.5.3；原生流式失败时会自动改用普通消息。
- Telegram 持续重连：检查网络、Token、已有 Webhook 和重复运行的机器人实例。
- 设置页提示 `invalid RPC target`：安装 0.5.1 或更新版本，并重启 Harness、刷新浏览器页面。
- 长回复被截断或分段异常：确认插件版本至少为 0.5.0。

更多资料见 [运维指南](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/docs/OPERATIONS.md)、[安全说明](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/SECURITY.md) 和 [更新记录](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/CHANGELOG.md)。配对码和机器人密钥请自行保管，不要公开分享。

## 开发者

源码、测试与 CI 在 Git 仓库中，不打进安装包。开发需要 Node.js 22.13+、pnpm 11.19.0。

```sh
pnpm install --frozen-lockfile
pnpm run release:check
```

`release:check` 依次执行类型检查、测试、构建，并在独立目录中安装生成的包、启动真实 Harness 0.1.5-rc.2，验证浏览器模块、认证接口与 Agent 生命周期；安装包输出到 `dist/`。发布流程见 [CONTRIBUTING.md](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/CONTRIBUTING.md)，真实通道验收见 [运维指南](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/docs/OPERATIONS.md)。

MIT。第三方来源见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
