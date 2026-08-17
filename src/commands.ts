export type BridgeCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'new'; name?: string }
  | { kind: 'reset' }
  | { kind: 'model'; selector?: string }
  | { kind: 'work'; path?: string }
  | { kind: 'list' }
  | { kind: 'use'; selector?: string }
  | { kind: 'stop' }
  | { kind: 'think'; effort?: string }
  | { kind: 'safe'; preset?: 'read-only' | 'workspace-write' | 'danger-full-access' }
  | { kind: 'unknown'; name: string }

const aliases: Record<string, BridgeCommand['kind']> = {
  help: 'help', h: 'help', '帮助': 'help',
  status: 'status', st: 'status', '状态': 'status',
  new: 'new', '新建': 'new',
  reset: 'reset', clear: 'reset', '重置': 'reset', '清空': 'reset',
  model: 'model', models: 'model', '模型': 'model',
  work: 'work', cd: 'work', project: 'work', '项目': 'work',
  list: 'list', sessions: 'list', '会话': 'list',
  use: 'use', switch: 'use', '切换': 'use',
  stop: 'stop', cancel: 'stop', '停止': 'stop',
  think: 'think', effort: 'think', '思考': 'think',
  safe: 'safe', permission: 'safe', '安全': 'safe',
}

const safetyAliases: Record<string, 'read-only' | 'workspace-write' | 'danger-full-access'> = {
  read: 'read-only', readonly: 'read-only', 'read-only': 'read-only', '只读': 'read-only',
  write: 'workspace-write', workspace: 'workspace-write', 'workspace-write': 'workspace-write', '写入': 'workspace-write',
  full: 'danger-full-access', danger: 'danger-full-access', 'danger-full-access': 'danger-full-access', '完全': 'danger-full-access',
}

const effortAliases: Record<string, string> = {
  off: 'off', '关': 'off', '关闭': 'off',
  low: 'low', '低': 'low',
  medium: 'medium', mid: 'medium', '中': 'medium',
  high: 'high', '高': 'high',
  max: 'max', '极限': 'max', '最高': 'max',
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of input.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]!)
  return tokens
}

/** Parse only bridge control messages. Ordinary chat returns undefined. */
export function parseBridgeCommand(text: string): BridgeCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const tokens = tokenize(trimmed.slice(1))
  const rawName = (tokens.shift() ?? '').toLowerCase()
  const kind = aliases[rawName]
  if (kind === undefined) return { kind: 'unknown', name: rawName }
  const value = tokens.join(' ').trim() || undefined
  switch (kind) {
    case 'new': return { kind, ...(value === undefined ? {} : { name: value }) }
    case 'work': return { kind, ...(value === undefined ? {} : { path: value }) }
    case 'use': return { kind, ...(value === undefined ? {} : { selector: value }) }
    case 'model': return { kind, ...(value === undefined ? {} : { selector: value }) }
    case 'think': return { kind, ...(value === undefined ? {} : { effort: effortAliases[value.toLowerCase()] ?? value }) }
    case 'safe': return { kind, ...(value === undefined ? {} : { preset: safetyAliases[value.toLowerCase()] }) }
    default: return { kind } as BridgeCommand
  }
}

export const BRIDGE_HELP = [
  '即时通信控制命令（中英均可）',
  '',
  '【会话】',
  '/new | /新建 [名称]       新建会话（当前项目）',
  '/reset | /重置             清空当前会话上下文',
  '/list | /会话              查看会话列表',
  '/use | /切换 <序号或ID>    切换会话',
  '',
  '【项目与模型】',
  '/work | /项目 <路径>       切换项目并新建会话',
  '/model | /模型             查看或切换模型',
  '  切换：/model <编号> 或 /model provider/model',
  '',
  '【运行设置】',
  '/think | /思考 [档位]      调整思考强度',
  '  off(关闭) / low(低) / medium(中) / high(高) / max(极限)',
  '/safe | /安全 [等级]       调整安全等级',
  '  read(只读) / write(写入) / full(完全)',
  '/stop | /停止              停止当前任务',
  '/status | /状态            查看当前状态',
  '',
  '【其他】',
  '/help | /帮助              显示本帮助',
  '',
  '【审核】',
  '/同意 <编号> 或 /approve <编号>',
  '/拒绝 <编号> 或 /reject <编号>',
].join('\n')

export function safetyLabel(value: string): string {
  if (value === 'read-only') return '只读'
  if (value === 'workspace-write') return '工作区写入'
  if (value === 'danger-full-access') return '完全访问'
  return value
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K tokens`
  return `${tokens} tokens`
}
