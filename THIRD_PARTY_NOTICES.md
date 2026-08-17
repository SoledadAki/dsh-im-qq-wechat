# Third-party notices

## Feishu Open Platform Device Flow

Feishu QR application onboarding uses the official `registerApp` Device Flow from `@larksuiteoapi/node-sdk`, which creates an app and returns its App ID/App Secret after the user confirms in Feishu.

- Documentation: https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs

## tencent-connect/dsh-qqbot

The model command interaction and context-preserving Agent rebuild approach in this project are informed by `tencent-connect/dsh-qqbot`.

- Source: https://github.com/tencent-connect/dsh-qqbot
- License: MIT

## xmanrui/dsh-im

The Feishu CardKit streaming flow, Telegram Bot API transport patterns, and editable-message throttling in this project are adapted from `xmanrui/dsh-im`.

- Source: https://github.com/xmanrui/dsh-im
- License: MIT
- Copyright (c) 2026 xmanrui

## Lark OpenAPI Node SDK

This project depends on `@larksuiteoapi/node-sdk` 1.73.0.

- Source: https://github.com/larksuite/node-sdk
- License: MIT
- Copyright (c) 2022 Lark Technologies Pte. Ltd.

## Tencent QQ Bot SDK

This project depends on `@tencent-connect/qqbot-connector` 1.2.0 and `@tencent-connect/qqbot-nodejs` 1.0.4.

Their own license terms and notices continue to apply.

## WeCom AI Bot Node SDK

This project depends on `@wecom/aibot-node-sdk` 1.0.7 for the official Enterprise WeChat AI Bot WebSocket transport and streaming replies.

- Source: https://github.com/WecomTeam/aibot-node-sdk
- License: MIT

The WeCom QR authorization endpoints and polling contract follow the documented implementation pattern in `xmanrui/dsh-im` and Tencent Cloud's public Enterprise WeChat channel documentation. The QR service is restricted to `https://work.weixin.qq.com` and returns only temporary authorization data; Bot ID/Secret are stored through Harness credentials.

## MIT license text

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
