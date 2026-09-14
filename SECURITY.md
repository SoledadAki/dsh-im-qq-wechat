# 安全边界

插件把 IM 消息交给具有本机工具权限的 Agent 执行，所以：

- 保持默认 `approvalPolicy: ask` 与 `redactWorkspacePaths: true`。路径隐藏只覆盖已知路径。
- Token / Secret 交给 Harness credentials 保管，不要写进配置、测试或仓库。
- IPC 启动 token 用于校验子进程消息，不等于操作系统沙箱。插件与 Host 共享同一账号权限，建议配上专用工作目录或独立系统账号。
- owner 配对码是临时凭据，只在自己的私聊里使用，不要贴进日志、截图或公开 issue。

## 依赖修复范围

0.5.3 使用 Harness 0.1.5-rc.2 的共享认证路由，不再额外开放独立扫码网页。Web 与 IM 的审批和问题按 Agent 路由。

0.4.1 更新锁文件中的 qs，并通过 pnpm workspace override 将 js-yaml 4.x 固定到 4.3.2；构建依赖 esbuild 更新到 0.25.x。js-yaml 问题见 [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh)。

这些设置只作用于本仓库的开发与 CI 依赖解析。用户安装 tgz 时，宿主自行管理的 Harness peer dependencies 不会被插件的 workspace override 更新，需要在宿主项目中运行依赖审计、按宿主的升级流程处理，再验证兼容性。

## 报告问题

安全漏洞请走仓库 Security 页面的私密漏洞报告入口；若该入口不可用，先通过维护者的公开渠道请求私密沟通方式。公开 issue 只描述症状，不要附 Token、配对码、聊天记录、绝对路径或完整状态文件。
