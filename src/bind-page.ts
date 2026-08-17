/**
 * 扫码绑定独立页面（agent 无法收发图片 → 生成一个可打开的新网页承载二维码）。
 *
 * 三个平台入口共用同一套 adapter 绑定流程：
 *   - 工具 `qq_weixin_bind`（agent 调用）：`startBinding()` 后返回
 *     `http://127.0.0.1:<port>/qqbot-bind?token=…` 的 URL，人类在浏览器打开即可扫码；
 *   - 页面内"开始绑定"按钮：`POST /qqbot-bind/start?channel=…` 直连。
 *
 * 页面用 fetch 轮询 `/qqbot-bind/status` 直到 bound / 出错；微信渠道额外提供
 * 验证码输入（`POST /qqbot-bind/verify`）。二维码过期自动刷新一次。
 *
 * token 是页面能力凭证（随机 256-bit），绑定会话 30 分钟过期；
 * 路由只挂在 loopback webServer 上，与 `/qqbot` RPC 的 authority 一致。
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ChannelAdapter, ChannelKind } from './channel.js'

/** 一次绑定页面会话：token → 渠道。二维码/状态始终从 adapter 的实时 status 读取。 */
interface BindSession {
  readonly channel: ChannelKind
  readonly createdAt: number
  /** 本会话已自动刷新次数（防止死循环刷 QR）。 */
  refreshCount: number
}

interface WebServerLike {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface BindPageDeps {
  readonly adapters: ReadonlyMap<ChannelKind, ChannelAdapter>
  readonly webServer: WebServerLike
  readonly logger: { warn(msg: string, ...rest: unknown[]): void }
}

export interface BindPage {
  /** 启动一次绑定并创建页面会话，立即返回（QR 由页面轮询 status 获取）。 */
  start(channel: ChannelKind): { token: string; url: string }
  /** 已绑定渠道：只发一个可查看状态的页面链接。 */
  urlFor(token: string): string
  dispose(): void
}

const TOKEN_TTL_MS = 30 * 60_000
const CHANNEL_LABEL: Record<ChannelKind, string> = { qq: 'QQ', wechat: '微信', wecom: '企业微信', feishu: '飞书', telegram: 'Telegram' }

const ok = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value })
const fail = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({
  ok: false,
  error: { code, message },
})

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function installBindPage(deps: BindPageDeps): BindPage {
  const sessions = new Map<string, BindSession>()
  const host = deps.webServer.host === '0.0.0.0' ? '127.0.0.1' : deps.webServer.host
  const origin = `http://${host}:${deps.webServer.port}`

  function pruneExpired(now: number): void {
    for (const [token, session] of sessions) {
      if (now - session.createdAt > TOKEN_TTL_MS) sessions.delete(token)
    }
  }
  function requireSession(token: string | undefined): BindSession | undefined {
    if (token === undefined) return undefined
    pruneExpired(Date.now())
    const session = sessions.get(token)
    if (session !== undefined && Date.now() - session.createdAt > TOKEN_TTL_MS) {
      sessions.delete(token)
      return undefined
    }
    return session
  }

  function statusValue(session: BindSession) {
    const adapter = deps.adapters.get(session.channel)
    const status = adapter?.getStatus() ?? { state: 'idle' as const, connected: false }
    return {
      token: undefined as string | undefined,
      channel: session.channel,
      channelLabel: CHANNEL_LABEL[session.channel],
      state: status.state,
      connected: status.connected,
      boundUserId: status.boundUserId,
      qrDataUrl: status.qrDataUrl,
      error: status.error,
    }
  }

  function startBinding(session: BindSession): void {
    const adapter = deps.adapters.get(session.channel)
    if (adapter === undefined) return
    // 不 await：QR 由 sidecar 异步到达，页面轮询 status 即可看到。失败也由
    // adapter 的 status.error 承载（binding.failed → idle + error）。
    void adapter.startBinding().catch((error: unknown) => {
      deps.logger.warn(`[qq-weixin] bind-page start ${session.channel} failed: ${String(error)}`)
    })
  }

  function createSession(channel: ChannelKind): { token: string; url: string } {
    pruneExpired(Date.now())
    const token = randomBytes(16).toString('hex')
    const session: BindSession = { channel, createdAt: Date.now(), refreshCount: 0 }
    sessions.set(token, session)
    startBinding(session)
    return { token, url: `${origin}/qqbot-bind?token=${token}` }
  }

  /* ------------------------------- HTTP 路由 ------------------------------- */
  const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
    '/qqbot-bind': (_req, res) => html(res, PAGE_HTML),

    '/qqbot-bind/start': (req, res) => {
      const channel = (new URL(req.url ?? '/', origin).searchParams.get('channel') ?? '') as ChannelKind
      if (channel !== 'qq' && channel !== 'wechat' && channel !== 'feishu') {
        json(res, fail('bad-request', 'channel 必须是 qq、微信或飞书'))
        return
      }
      const { token, url } = createSession(channel)
      json(res, ok({ token, url, channel, state: 'awaiting-code' }))
    },

    '/qqbot-bind/status': (req, res) => {
      const token = new URL(req.url ?? '/', origin).searchParams.get('token') ?? undefined
      const session = requireSession(token)
      if (session === undefined) {
        json(res, fail('bad-token', '绑定会话无效或已过期，请重新开始绑定'), 404)
        return
      }
      json(res, ok({ ...statusValue(session), token }))
    },

    '/qqbot-bind/verify': async (req, res) => {
      const params = new URL(req.url ?? '/', origin).searchParams
      const token = params.get('token') ?? undefined
      const code = params.get('code') ?? ''
      const session = requireSession(token)
      if (session === undefined) {
        json(res, fail('bad-token', '绑定会话无效或已过期，请重新开始绑定'), 404)
        return
      }
      const adapter = deps.adapters.get(session.channel)
      if (adapter === undefined) {
        json(res, fail('bad-request', '渠道未配置'))
        return
      }
      const result = await adapter.submitCode('', code)
      if (!result.ok) {
        json(res, fail('bad-code', result.error ?? '验证码无效'))
        return
      }
      json(res, ok({ ok: true }))
    },

    '/qqbot-bind/refresh': (req, res) => {
      const token = new URL(req.url ?? '/', origin).searchParams.get('token') ?? undefined
      const session = requireSession(token)
      if (session === undefined) {
        json(res, fail('bad-token', '绑定会话无效或已过期，请重新开始绑定'), 404)
        return
      }
      session.refreshCount += 1
      startBinding(session)
      json(res, ok({ ok: true, ...statusValue(session), token }))
    },

    '/qqbot-bind/cancel': async (req, res) => {
      const token = new URL(req.url ?? '/', origin).searchParams.get('token') ?? undefined
      const session = requireSession(token)
      if (session === undefined) {
        json(res, fail('bad-token', '绑定会话无效或已过期'), 404)
        return
      }
      const adapter = deps.adapters.get(session.channel)
      await adapter?.cancelBinding().catch(() => undefined)
      json(res, ok({ ok: true }))
    },
  }

  const stopRoute = deps.webServer.register({
    kind: 'prefix',
    path: '/qqbot-bind',
    handler(req, res) {
      const pathname = new URL(req.url ?? '/', origin).pathname
      const handler = handlers[pathname]
      if (handler === undefined) {
        json(res, fail('not-found', `unknown bind-page endpoint ${pathname}`), 404)
        return
      }
      handler(req, res)
    },
  })

  return {
    start(channel) {
      return createSession(channel)
    },
    urlFor(token) {
      return `${origin}/qqbot-bind?token=${token}`
    },
    dispose() {
      stopRoute()
      sessions.clear()
    },
  }
}

/* ------------------------------ 页面 HTML ------------------------------ */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QQ / 微信 / 飞书 扫码绑定</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background:#0f1117; color:#e6e8ee; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#171a23; border:1px solid #262b3a; border-radius:16px; padding:32px 36px;
          width:min(92vw, 420px); box-shadow:0 8px 40px rgba(0,0,0,.45); text-align:center; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8b93a7; font-size:13px; margin-bottom:20px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; margin-top:8px; }
  .badge.idle { background:#232a3a; color:#9aa4bf; }
  .badge.wait { background:#2a2f1e; color:#d7c96a; }
  .badge.bound { background:#17301f; color:#7ddb9c; }
  .badge.err { background:#3a1e1e; color:#f0a3a3; }
  #qr { width:260px; height:260px; margin:20px auto; border-radius:12px; background:#fff;
        display:flex; align-items:center; justify-content:center; overflow:hidden; }
  #qr img { width:100%; height:100%; object-fit:contain; }
  #qr .placeholder { color:#0f1117; font-size:14px; padding:12px; }
  .error { color:#f0a3a3; font-size:13px; margin:10px 0; min-height:18px; word-break:break-all; }
  .verify { display:none; margin:14px 0; gap:8px; }
  .verify.show { display:flex; }
  .verify input { flex:1; padding:9px 12px; border-radius:8px; border:1px solid #333a4d;
                  background:#0f1117; color:#e6e8ee; font-size:14px; }
  .row { display:flex; gap:10px; justify-content:center; margin-top:16px; }
  button { padding:9px 16px; border-radius:8px; border:1px solid #333a4d; background:#232a3a;
           color:#e6e8ee; font-size:13px; cursor:pointer; }
  button:hover { background:#2b3448; }
  button.primary { background:#2f6fed; border-color:#2f6fed; color:#fff; }
  button.primary:hover { background:#4281f8; }
  .start { margin-top:18px; display:flex; gap:10px; justify-content:center; }
  .note { color:#6b7286; font-size:12px; margin-top:18px; line-height:1.6; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">QQ / 微信 / 飞书 扫码绑定</h1>
  <div class="sub" id="sub">DeepSeek Harness 外部通道接入</div>
  <div id="startArea" class="start">
    <button class="primary" data-channel="qq">开始绑定 QQ</button>
    <button class="primary" data-channel="wechat">开始绑定 微信</button>
    <button class="primary" data-channel="feishu">扫码接入 飞书</button>
  </div>
  <div id="panel" style="display:none">
    <div><span class="badge idle" id="badge">准备中…</span></div>
    <div id="qr"><div class="placeholder">等待二维码…</div></div>
    <div class="error" id="error"></div>
    <div class="verify" id="verifyBox">
      <input id="code" placeholder="微信验证码（扫码后手机显示）" inputmode="numeric">
      <button class="primary" id="verifyBtn">提交</button>
    </div>
    <div class="row">
      <button id="refreshBtn">刷新二维码</button>
      <button id="cancelBtn">取消绑定</button>
    </div>
  </div>
  <div class="note" id="note"></div>
</div>
<script>
(() => {
  const params = new URLSearchParams(location.search)
  let token = params.get('token') || ''
  const $ = (id) => document.getElementById(id)
  const title = $('title'), sub = $('sub'), badge = $('badge'), qr = $('qr'),
        error = $('error'), verifyBox = $('verifyBox'), code = $('code'),
        startArea = $('startArea'), panel = $('panel'), note = $('note')
  const LABEL = { qq: 'QQ', wechat: '微信', feishu: '飞书' }
  let autoRefreshed = 0
  let timer = 0

  async function api(path) {
    const res = await fetch(path)
    return res.json()
  }
  function renderStatus(value) {
    title.textContent = LABEL[value.channel] + ' 扫码绑定'
    sub.textContent = 'DeepSeek Harness 外部通道接入'
    note.textContent = value.channel === 'feishu'
      ? '请使用飞书手机客户端扫码并确认创建机器人，绑定会话 30 分钟有效。'
      : '二维码仅在本地可访问，绑定会话 30 分钟有效。'
    if (value.state === 'bound') {
      badge.textContent = '已绑定 ✓'
      badge.className = 'badge bound'
      qr.innerHTML = '<div class="placeholder">绑定成功，可以关闭本页。</div>'
      error.textContent = value.boundUserId ? '平台用户：' + value.boundUserId : ''
      verifyBox.classList.remove('show')
      stopPoll()
      return
    }
    if (value.qrDataUrl) {
      if (value.qrDataUrl.indexOf('data:') === 0) {
        qr.innerHTML = '<img src="' + value.qrDataUrl + '" alt="二维码">'
      } else {
        // QQ OpenClaw 返回的是扫码连接页 URL 而非图片：渲染为可点击链接。
        qr.innerHTML = '<a href="' + value.qrDataUrl + '" target="_blank" rel="noopener" ' +
          'style="color:#2f6fed;font-size:14px;text-decoration:underline">点击打开扫码页面 ↗</a>' +
          '<div style="margin-top:10px;font-size:11px;color:#0f1117;word-break:break-all;padding:0 8px">' +
          value.qrDataUrl + '</div>'
      }
      badge.textContent = value.channel === 'wechat' ? '等待扫码 + 验证码' : value.channel === 'feishu' ? '等待飞书确认…' : '等待扫码…'
      badge.className = 'badge wait'
    } else {
      qr.innerHTML = '<div class="placeholder">等待二维码…</div>'
      badge.textContent = '等待二维码…'
      badge.className = 'badge wait'
    }
    error.textContent = value.error || ''
    if (value.error && /过期|失效/.test(value.error) && autoRefreshed < 3) {
      autoRefreshed++
      setTimeout(() => { api('/qqbot-bind/refresh?token=' + token).then((r) => { if (r.ok) renderStatus(r.value) }) }, 800)
      return
    }
    verifyBox.classList.toggle('show', value.channel === 'wechat' && value.state === 'awaiting-code')
  }
  async function poll() {
    if (!token) return
    const res = await api('/qqbot-bind/status?token=' + token)
    if (!res.ok) {
      error.textContent = res.error.message
      badge.textContent = '会话失效'
      badge.className = 'badge err'
      stopPoll()
      return
    }
    renderStatus(res.value)
  }
  function stopPoll() { if (timer) { clearTimeout(timer); timer = 0 } }
  function loop() { stopPoll(); timer = setTimeout(async () => { await poll(); if (token) loop() }, 2000) }

  document.querySelectorAll('#startArea button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const channel = btn.dataset.channel
      startArea.style.display = 'none'
      panel.style.display = 'block'
      badge.textContent = '正在启动绑定…'
      const res = await api('/qqbot-bind/start?channel=' + channel)
      if (!res.ok) { error.textContent = res.error.message; badge.className = 'badge err'; return }
      token = res.value.token
      history.replaceState(null, '', '/qqbot-bind?token=' + token)
      loop()
    })
  })
  $('refreshBtn').addEventListener('click', async () => {
    if (!token) return
    const res = await api('/qqbot-bind/refresh?token=' + token)
    if (!res.ok) { error.textContent = res.error.message; return }
    renderStatus(res.value)
  })
  $('cancelBtn').addEventListener('click', async () => {
    if (!token) return
    await api('/qqbot-bind/cancel?token=' + token)
    error.textContent = '已取消绑定。'
    badge.textContent = '已取消'
    badge.className = 'badge idle'
    stopPoll()
  })
  $('verifyBtn').addEventListener('click', async () => {
    const value = code.value.trim()
    if (!/^\\d{4,8}$/.test(value)) { error.textContent = '请输入 4-8 位验证码'; return }
    const res = await api('/qqbot-bind/verify?token=' + token + '&code=' + encodeURIComponent(value))
    if (!res.ok) { error.textContent = res.error.message; return }
    error.textContent = '验证码已提交，等待确认…'
    code.value = ''
  })

  if (token) {
    startArea.style.display = 'none'
    panel.style.display = 'block'
    loop()
  }
})()
</script>
</body>
</html>
`
