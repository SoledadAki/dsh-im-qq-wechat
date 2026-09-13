# 开发与维护

使用 Node.js 22.13+ 和 pnpm 11.19.0。Host peer dependencies 固定为 0.1.5-rc.2；不要为消除版本提示直接放宽范围。

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm audit
```

`src/index.ts` 负责插件注册；`agent-bridge.ts` 管理持久会话；`correlation.ts` 把消息、turn 和审批对应起来。QQ / 微信通过 `sidecar-client.ts` 连接 `sidecar/` 下的独立进程，其余平台在 Host 内使用适配器。`channel-interactions.ts` 管理审批和问题，`editable-stream.ts` 管理可编辑回复。

改动消息路由或审批逻辑时，增加错误用户、错误 turn、取消与并发场景的回归测试。不要用真实 Token、二维码或本地会话数据制作测试夹具。SDK 版本变更应先检查协议契约测试，再用专用测试账号联调。

## 发布流程

1. 更新 package.json 版本、README 安装包名称和 CHANGELOG。
2. 执行 `pnpm install --frozen-lockfile` 与 `pnpm audit`。
3. 执行 `pnpm run release:check`，安装包输出到 dist/；prepack 会重新运行类型检查、全部测试、构建与浏览器 IIFE 验证。
4. 在独立 Harness profile 中安装生成的 tgz，按 docs/OPERATIONS.md 验收实际通道。
5. 检查包内容不含凭据、状态目录和 node_modules；确认 CI 与真实通道验收结果后再创建版本标签和发布包。

普通 CI 只做验证。推送与 package.json 版本匹配的 v* 标签会运行 release.yml，验证后发布 tgz 与 SHA256SUMS 到 GitHub Release；不会发布 npm 包。没有真实账号的测试不能证明扫码、平台网络、审批回传和 Host Web 加载全部可用。记录实际测试过的 Harness、Node 与 SDK 版本。

依赖锁文件的修复不会覆盖用户既有 Harness 安装中的 peer dependencies；需要同时维护宿主环境。
