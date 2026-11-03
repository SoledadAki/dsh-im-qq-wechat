# 安装、验收与故障排查

## 安装与升级

运行环境：Node.js 22.19+，DeepSeek Harness Web 0.2.1-rc.5。源码开发与打包另需 pnpm 11.19.0。

从 GitHub Release 下载预构建安装包，在下载目录运行：

```sh
dsh plugin --profile web add ./dsh-im-qq-wechat-0.6.0.tgz
dsh --profile web
```

首次安装会联网拉取运行依赖，之后不需要再执行 pnpm install / build。源码开发与发布流程见 CONTRIBUTING.md。

升级前先停掉插件，备份正在使用的 Harness profile（含 `$DSH_HOME/settings.yaml`）、credentials 存储，并留一份旧版 tgz 用于回滚。

0.6.0 起要求 Harness 0.2：插件状态（绑定、owner、会话、工作区等）不再写入 `settings.yaml`，而是作为插件配置条目 `qq-weixin` 的实时字段保存在 profile 配置里（旧的 `channels` 状态字段改名为 `channelState`，避免与通道列表冲突）。首次启动时插件会自动导入旧 `settings.yaml`（或宿主改名后的 `settings.yaml.imported`）中的 `qq-weixin` 段；已有状态时不会覆盖。回滚到 0.5.x 需同时回退 Harness 到 0.1.5-rc.2，并把 `settings.yaml.imported` 改回 `settings.yaml`；升级后新增的绑定不会带回旧版。

## 真实通道验收

每个实际使用的通道都应独立验证以下流程：

1. 在 Harness Web 配置凭据或扫码，用本人私聊配对码成为 owner。
2. 发送简单文本，确认回复回到发起会话；用另一个测试用户验证无法触发任务。
3. 执行 `/new`、`/list`、`/use`，检查会话切换；发送长文本回复任务，检查分段和 emoji。
4. 在临时测试目录中触发需要审核的工具，验证同意、拒绝和 `/stop` 三条路径。
5. 重启 Host，再次发送文本，确认绑定和会话持久化；短暂断网后检查恢复。

QQ / 微信还应检查扫码取消和重新绑定。飞书、企业微信及 Telegram 检查流式回复结束后内容完整。Telegram 需确认没有冲突的 Webhook 或另一个长轮询实例。

## 排查表

| 现象 | 检查与处理 |
| --- | --- |
| 设置页没有插件入口 | 确认安装了包含 lib/client.js 的 tgz；源码构建应输出 client_bundle_ok；核对 Host 0.2.1-rc.5 兼容性。 |
| 已连接但不执行消息 | 检查 owner 是否完成私聊配对、群聊是否满足 @ / 回复条件，以及通道是否仅支持当前消息类型。 |
| sidecar handshake / request timed out | 检查 Node 可执行文件、sidecar 路径与 SDK 依赖完整性；重启后检查已脱敏的错误日志。 |
| sidecar protocol failure | 输出不符合认证 JSON-lines 协议；检查是否误将调试日志写入 stdout。调试日志应使用 stderr。 |
| Telegram 不断重连 | 检查网络、Token、Webhook 与重复轮询实例。停止多余实例后重试。 |
| 审批或问题没有生效 | 回复中保留准确编号；超时或取消后的旧编号不会继续生效。确认当前 owner 和触发任务的通道一致。 |
| 审计仍提示 js-yaml | 检查告警是否来自宿主安装；插件锁文件不能升级用户宿主的 peer dependencies，参见 SECURITY.md。 |

反馈问题时请提供操作系统、Node / Harness / 插件版本、通道名称、复现步骤与脱敏错误摘要。
