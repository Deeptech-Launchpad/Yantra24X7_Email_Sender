import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { env } from '../../src/config/env.js'

// A FAKE GMAIL MAIL SERVER (SMTP), on 127.0.0.1, for tests of accounts that send with an
// app password. Nothing ever reaches Gmail and nothing is ever sent. It checks the address
// and app password, records every message, and a test can script the answer to each one:
//   'ok'  → 250 accepted
//   'drop' → the connection is closed after the message, before any answer (outcome unknown)
//   'NNN text' → that answer (for example '550 5.4.5 Daily user sending limit exceeded')

export type SmtpScript = 'ok' | 'drop' | string

export interface FakeSmtp {
  port: number
  accounts: Map<string, string>
  logins: Array<{ user: string; ok: boolean }>
  sent: Array<{ from: string; to: string[]; data: string }>
  script: SmtpScript[]
  close: () => Promise<void>
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const fake: FakeSmtp = { port: 0, accounts: new Map(), logins: [], sent: [], script: [], close: async () => undefined }
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    const say = (line: string) => sock.write(`${line}\r\n`)
    let buf = ''
    let inData = false
    let data = ''
    let authed = false
    let from = ''
    let to: string[] = []
    say('220 fake.smtp ready')
    const login = (b64: string) => {
      const [, user = '', pass = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\0')
      const ok = fake.accounts.get(user) === pass
      fake.logins.push({ user, ok })
      authed = ok
      say(ok ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted')
    }
    let waitingAuth = false
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          data += buf.slice(0, end)
          buf = buf.slice(end + 5)
          inData = false
          fake.sent.push({ from, to, data: data.replace(/^\.\./gm, '.') })
          const answer = fake.script.shift() ?? 'ok'
          if (answer === 'drop') {
            sock.destroy()
            return
          }
          say(answer === 'ok' ? '250 2.0.0 OK fake-id - gsmtp' : answer)
          data = ''
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        const cmd = line.toUpperCase()
        if (waitingAuth) {
          waitingAuth = false
          login(line.trim())
        } else if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          sock.write('250-fake.smtp\r\n250-SIZE 35882577\r\n250 AUTH PLAIN\r\n')
        } else if (cmd.startsWith('AUTH PLAIN')) {
          const inline = line.slice(10).trim()
          if (inline) login(inline)
          else {
            waitingAuth = true
            say('334 ')
          }
        } else if (cmd.startsWith('MAIL FROM:')) {
          if (!authed) say('530 5.7.0 Authentication Required')
          else {
            from = /<([^>]*)>/.exec(line)?.[1] ?? ''
            to = []
            say('250 2.1.0 OK')
          }
        } else if (cmd.startsWith('RCPT TO:')) {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
          say('250 2.1.5 OK')
        } else if (cmd === 'DATA') {
          inData = true
          data = ''
          say('354 Go ahead')
        } else if (cmd === 'RSET' || cmd === 'NOOP') say('250 OK')
        else if (cmd === 'QUIT') {
          say('221 2.0.0 closing')
          sock.end()
        } else say('502 5.5.1 Unrecognized command')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  fake.port = (server.address() as AddressInfo).port
  Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: fake.port, SMTP_SECURE: false })
  fake.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    })
  return fake
}
