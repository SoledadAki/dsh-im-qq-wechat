# 开发与维护

需要 Node.js 22.19+ 和 pnpm 11.19.0。Host peer dependencies 固定为 0.1.5-rc.2。

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm audit
```

模块划分：`src/index.ts` 注册插件；`agent-bridge.ts` 管理持久会话；`correlation.ts` 把消息、turn 和审批对应起来；QQ / 微信通过 `sidecar-client.ts` 连接 `sidecar/` 下的独立进程，其余平台在 Host 内使用适配器；`channel-interactions.ts` 管理审批和问题，`editable-stream.ts` 管理可编辑回复。

改动消息路由或审批逻辑时，补齐错误用户、错误 turn、取消与并发场景的回归测试，测试夹具用专用测试账号而非真实 Token、二维码或本地会话数据。SDK 版本变更先跑协议契约测试，再用测试账号联调。

## 发布流程

1. 更新 package.json 版本、README 安装包名称和 CHANGELOG。
2. 执行 `pnpm install --frozen-lockfile` 与 `pnpm audit`。
3. 执行 `pnpm run release:check`，安装包输出到 dist/；prepack 会重新运行类型检查、全部测试、构建与浏览器 IIFE 验证。
4. 在独立 Harness profile 中安装生成的 tgz，按 docs/OPERATIONS.md 验收实际通道。
5. 确认包内容不含凭据、状态目录和 node_modules，然后创建版本标签并发布。

CI 只做验证；推送与 package.json 版本匹配的 v* 标签会触发 release.yml，验证通过后把 tgz 与 SHA256SUMS 发布到 GitHub Release（不发布 npm 包）。发布说明中记录实测过的 Harness、Node 与 SDK 版本。依赖锁文件的修复不会覆盖用户既有 Harness 安装中的 peer dependencies，宿主环境需同步维护。
