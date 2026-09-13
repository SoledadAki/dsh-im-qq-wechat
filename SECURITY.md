# 安全边界

本插件可把 IM 消息交给具有本机工具权限的 Agent。owner 配对码属于临时凭据；仅在自己的私聊中使用，不应放入日志、截图或公开 issue。

- 保持默认 `approvalPolicy: ask` 与 `redactWorkspacePaths: true`。路径隐藏仅处理已知路径，不是任意敏感内容的过滤器。
- Token / Secret 由 Harness credentials 保存；不要把实际凭据写入配置、测试或仓库。
- IPC 启动 token 用于验证子进程消息，不构成操作系统沙箱。宿主、插件代码与同一账号运行的进程必须可信。
- IM owner 身份校验不能替代主机权限隔离。建议使用专用工作目录和操作系统账号。

## 依赖修复范围

0.4.1 的锁文件更新 qs，并通过 pnpm workspace override 将 js-yaml 4.x 固定到 4.3.2；构建依赖 esbuild 更新到 0.25.x。js-yaml 问题见 [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh)。

这些设置保障本仓库开发和 CI 的依赖解析。用户安装 tgz 时，宿主自行管理的 Harness peer dependencies 不会被插件的 workspace override 更新。管理员应在宿主项目中运行依赖审计，按宿主升级流程更新到修复版本，再验证兼容性。

## 报告问题

若仓库启用了 GitHub 私密漏洞报告，请从 Security 页面提交。否则先通过维护者公开提供的联系渠道请求私密沟通方式。公开 issue 只描述不含利用细节的症状；不要上传 Token、配对码、聊天记录、绝对路径或完整状态文件。
