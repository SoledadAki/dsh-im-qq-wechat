import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let token = ''
lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if (!token) token = frame.token
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
