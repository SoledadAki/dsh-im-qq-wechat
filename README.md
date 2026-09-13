# dsh-im-qq-wechat

把 QQ、微信、企业微信、飞书和 Telegram 接入 DeepSeek Harness。安装预构建插件，在 Harness 设置中绑定账号，即可通过聊天发送任务、接收回复和处理工具审批。

## 安装

需要已能正常使用的 **DeepSeek Harness Web 0.1.5-rc.2** 和 Node.js 22+。请先在 Harness 中配置模型。本项目当前不声明兼容所有后续预览版。

从 [GitHub Releases](https://github.com/SoledadAki/dsh-im-qq-wechat/releases) 下载对应版本的 `.tgz` 安装包，然后在下载目录执行：

```sh
dsh plugin --profile web add ./dsh-im-qq-wechat-0.5.0.tgz
dsh --profile web
```

`.tgz` 是正式安装文件，不是历史数据备份。安装时由 Harness 的插件管理器解析运行依赖；用户无需克隆源码、运行构建、修改 YAML 或手动启动 QQ / 微信子进程。首次安装依赖需要联网。

**发布状态：0.5.0 是待发布版本。只有维护者将安装包上传到 Release 后，上面的下载入口才会出现该版本。** 不要用 GitHub 自动生成的 Source code 压缩包替代插件安装包，也不要直接安装当前源码分支：源码不包含预构建入口。

## 首次使用

1. 重启 Harness，打开设置中的 **接入即时通信**。
2. 选择需要的通道，扫码或填写自己的机器人凭据。
3. 按页面提示完成平台授权或私聊配对码绑定。
4. 向机器人发送任务；需要工具审核时，根据编号回复 `/同意` 或 `/拒绝`。

账号授权是必要配置，插件不能代替你创建平台账号或提供模型密钥。没有绑定的通道不需要配置凭据。

| 通道 | 接入方式 | 回复形式 |
| --- | --- | --- |
| QQ | 扫码授权 | 原生流式、完整长回复分段 |
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

## 升级与卸载

升级时安装新版本 `.tgz` 并重启 Harness；绑定和会话使用 Harness settings / credentials 持久化，0.5.0 不修改存储格式。卸载前可在设置页解绑账号。

```sh
dsh plugin --profile web remove dsh-im-qq-wechat
```

## 使用边界与排障

- 当前保证的是文本任务链路，不能把平台媒体下载能力理解为完整多模态 Agent 支持。
- 用户问题和工具审批按 Agent 路由到发起任务的 IM 通道；Harness 自身的 Web 会话仍由 Web 回答。
- 设置页无法加载：确认安装的是本插件 `.tgz`、已重启 Web，并检查 Harness 版本。
- Telegram 持续重连：检查网络、Token、已有 Webhook 和重复运行的机器人实例。
- 已连接但不响应：检查绑定用户与群聊 @ / 回复条件；先用绑定账号私聊测试。
- 默认隐藏已知工作区路径并保留工具审批。配对码和机器人密钥不要公开分享。插件使用 Harness 的执行权限，不是独立沙箱。

更多资料见仓库中的 [运维指南](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/docs/OPERATIONS.md)、[安全说明](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/SECURITY.md) 和 [更新记录](https://github.com/SoledadAki/dsh-im-qq-wechat/blob/main/CHANGELOG.md)。

## 开发者

源码、测试、CI 和维护文档保留在 Git 仓库中，不进入用户安装包。开发需要 Node.js 22.13+、pnpm 11.19.0。

```sh
pnpm install --frozen-lockfile
pnpm run release:check
```

该命令运行类型检查、测试、构建，并在独立目录中以禁用安装脚本的方式安装和验证生成的包，再启动真实 Harness 0.1.5-rc.2，验证浏览器模块、认证接口和 Agent 创建/分叉/释放。安装文件位于 `dist/`。真实账号扫码、收发及 Host Web 联调仍需按运维指南验收。

MIT。第三方来源见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
