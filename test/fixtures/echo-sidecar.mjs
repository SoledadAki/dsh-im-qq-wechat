import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let token = ''
lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if (!token) token = frame.token
  if (frame.type === 'invalid') { process.stdout.write('null\n'); return }
  if (frame.type === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return }
  if (frame.type === 'silent') return
  if (frame.type === 'bad-token') { process.stdout.write(`${JSON.stringify({ ...frame, token: 'wrong' })}\n`); return }
  const type = frame.type === 'hello'
    ? 'hello.ack'
    : frame.type === 'shutdown'
      ? 'shutdown.ack'
      : frame.type === 'echo'
        ? 'echo.result'
        : 'event.notice'
  process.stdout.write(`${JSON.stringify({ ...frame, token, type, payload: frame.payload ?? {} })}\n`)
  if (frame.type === 'shutdown') setTimeout(() => process.exit(0), 5)
})
