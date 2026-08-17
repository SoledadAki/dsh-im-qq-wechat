export {}

declare global {
  namespace JSX { interface IntrinsicElements { [elementName: string]: any } }
  interface Window { __ModuleLoader__?: { load(input: { id: string; factory(require: (name: string) => any): { apply?: (ctx: any) => void; inject?: string[] } }): void } }
}

type RpcResult = { ok: true; value: any } | { ok: false; error: { message: string } }
interface Rpc { call(channel: string, endpoint: string, payload?: unknown): Promise<RpcResult> }

// rc.6 client-modules requires synchronous registration from a classic IIFE.
window.__ModuleLoader__!.load({
  id: 'dsh-im-qq-wechat',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const controllerOf = (rpc: Rpc) => ({
      status: () => rpc.call('/qqbot', 'status', {}),
      begin: (channel: string) => rpc.call('/qqbot', 'begin', { channel }),
      verify: (channel: string, code: string) => rpc.call('/qqbot', 'verify', { channel, code }),
      configure: (channel: string, values: Record<string, string>) => rpc.call('/qqbot', 'configure', { channel, values }),
      unbind: (channel: string) => rpc.call('/qqbot', 'unbind', { channel }),
      disconnect: (channel: string) => rpc.call('/qqbot', 'disconnect', { channel }),
      connect: (channel: string) => rpc.call('/qqbot', 'connect', { channel }),
    })
    type Controller = ReturnType<typeof controllerOf>

    const labels: Record<string, string> = {
      qq: 'QQ', wechat: '微信', wecom: '企业微信', feishu: '飞书', telegram: 'Telegram',
    }
    const qrChannels = new Set(['qq', 'wechat', 'wecom', 'feishu'])
    const manualChannels = new Set(['telegram'])

    function QrView({ url, channel }: { url: string; channel: string }) {
      return url.startsWith('data:')
        ? <img src={url} width={200} height={200} alt={`${labels[channel] ?? channel}二维码`} style={{ background: '#fff', borderRadius: 8 }} />
        : <a href={url} target="_blank" rel="noopener" style={{ color: '#2f6fed' }}>打开扫码页面 →</a>
    }

    function CredentialForm({ channel, controller, onRefresh }: { channel: string; controller: Controller; onRefresh: () => Promise<void> }) {
      const [token, setToken] = useState('')
      const [appId, setAppId] = useState('')
      const [appSecret, setAppSecret] = useState('')
      const [botId, setBotId] = useState('')
      const [secret, setSecret] = useState('')
      const [busy, setBusy] = useState(false)
      const submit = async () => {
        setBusy(true)
        try {
          const values: Record<string, string> = channel === 'telegram'
            ? { token }
            : channel === 'wecom'
              ? { botId, secret }
              : { appId, appSecret, domain: 'feishu' }
          const result = await controller.configure(channel, values)
          if (!result.ok) window.alert(result.error.message)
          else { setToken(''); setAppSecret(''); setSecret(''); await onRefresh() }
        } finally { setBusy(false) }
      }
      return <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        {channel === 'telegram' && <input type="password" value={token} placeholder="Bot Token" onChange={(e: any) => setToken(e.target.value)} />}
        {channel === 'wecom' && <>
          <input value={botId} placeholder="企业微信 Bot ID" onChange={(e: any) => setBotId(e.target.value)} />
          <input type="password" value={secret} placeholder="企业微信 Bot Secret" onChange={(e: any) => setSecret(e.target.value)} />
          <small style={{ color: '#687386' }}>请先在企业微信创建 API 模式智能机器人并启用长连接。</small>
        </>}
        {channel === 'feishu' && <>
          <input value={appId} placeholder="App ID（cli_...）" onChange={(e: any) => setAppId(e.target.value)} />
          <input type="password" value={appSecret} placeholder="App Secret" onChange={(e: any) => setAppSecret(e.target.value)} />
        </>}
        <button disabled={busy} onClick={() => void submit()}>{busy ? '正在验证…' : '保存并连接'}</button>
      </div>
    }

    function ChannelCard({ channel, row, controller, onRefresh }: { key?: string; channel: string; row: any; controller: Controller; onRefresh: () => Promise<void> }) {
      const cs = row.status ?? { state: 'idle', connected: false }
      const [showManual, setShowManual] = useState(false)
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)
      const act = async (operation: () => Promise<RpcResult | void>) => {
        setBusy(true)
        try {
          const result = await operation()
          if (result && !result.ok) window.alert(result.error.message)
          await onRefresh()
        } finally { setBusy(false) }
      }
      const begin = () => act(() => controller.begin(channel))
      const manual = manualChannels.has(channel)
      const hasQr = qrChannels.has(channel)
      return <section style={{ border: '1px solid #dde1e8', borderRadius: 12, padding: 16, minWidth: 280, background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h4 style={{ margin: 0, fontSize: 16 }}>{labels[channel] ?? channel}</h4>
          <span style={{ color: cs.connected ? '#1e7e34' : '#b42318', fontSize: 13, whiteSpace: 'nowrap' }}>{cs.connected ? '✓ 已连接' : '× 未连接'}</span>
        </div>
        {cs.error && <p style={{ color: '#b42318', fontSize: 12, marginBottom: 4 }}>{cs.error}</p>}
        {cs.state === 'idle' && hasQr && <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <button disabled={busy} style={{ background: '#2f6fed', color: '#fff' }} onClick={() => void begin()}>扫码接入机器人</button>
          {(channel === 'feishu' || channel === 'wecom') && <><button disabled={busy} onClick={() => setShowManual((value: boolean) => !value)}>{showManual ? '收起手动接入' : '已有机器人？手动接入'}</button>{showManual && <CredentialForm channel={channel} controller={controller} onRefresh={onRefresh} />}</>}
        </div>}
        {cs.state === 'idle' && manual && <CredentialForm channel={channel} controller={controller} onRefresh={onRefresh} />}
        {cs.state === 'awaiting-code' && cs.code && <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#f6f8fb' }}><b>配对码：{cs.code}</b><p style={{ fontSize: 12, color: '#687386', marginBottom: 0 }}>请用你的账号私聊机器人发送此配对码。绑定后只有该账号能控制 Harness。</p></div>}
        {cs.state === 'awaiting-code' && !manual && cs.qrDataUrl && <div style={{ marginTop: 12, display: 'grid', gap: 8 }}><QrView url={cs.qrDataUrl} channel={channel} />{channel === 'wechat' && <div style={{ display: 'flex', gap: 8 }}><input value={code} placeholder="微信验证码" onChange={(e: any) => setCode(e.target.value)} /><button disabled={busy} onClick={() => void act(() => controller.verify(channel, code))}>提交</button></div>}</div>}
        {cs.state === 'bound' && <p style={{ fontSize: 13, color: '#475467' }}>已绑定用户：{cs.boundUserId ?? '平台授权范围'}</p>}
        {cs.state !== 'idle' && <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><button disabled={busy} onClick={() => void act(() => controller.unbind(channel))}>解绑</button>{cs.connected ? <button disabled={busy} onClick={() => void act(() => controller.disconnect(channel))}>断开</button> : <button disabled={busy} onClick={() => void act(() => controller.connect(channel))}>重连</button>}</div>}
      </section>
    }

    function Panel({ controller }: { controller: Controller }) {
      const [status, setStatus] = useState(null as any)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const refresh = useCallback(async () => {
        const result = await controller.status()
        if (result.ok) { setStatus(result.value); setError('') } else setError(result.error.message)
        setLoading(false)
      }, [controller])
      useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => clearInterval(timer) }, [refresh])
      const channels = Object.entries(status?.channels ?? {})
      return <div style={{ padding: 16, maxWidth: 960 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><div><h3 style={{ margin: 0 }}>接入即时通信</h3><p style={{ color: '#687386', fontSize: 13, margin: '7px 0 0' }}>统一管理 QQ、微信、企业微信、飞书和 Telegram。消息、项目、会话、审核与流式回复共用同一套 Harness 能力。</p></div><button disabled={loading} onClick={() => void refresh()}>刷新</button></div>
        {error && <p style={{ color: '#b42318', fontSize: 12 }}>{error}</p>}
        {loading && channels.length === 0 ? <p style={{ color: '#687386' }}>正在读取渠道状态…</p> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginTop: 16 }}>{channels.map(([channel, row]) => <ChannelCard key={channel} channel={channel} row={row} controller={controller} onRefresh={refresh} />)}</div>}
      </div>
    }

    const apply = (ctx: any) => {
      const rpc = ctx.get('connection')?.rpc as Rpc | undefined
      if (!rpc) return
      const controller = controllerOf(rpc)
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'qq-weixin', order: 30, label: () => '接入即时通信', inject: () => ({ controller }) }, Panel))
    }
    return { apply, inject: ['slots', 'connection'] }
  },
})
