import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { dataDir, env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { sendViaGmail, type SendOutcome } from '../gmail/api.js'
import { sendViaSmtp } from '../gmail/smtp.js'

// WHERE AN EMAIL GOES.
//   SEND_MODE=test (the default) → nothing is sent. The complete message is written to
//                                   DATA_DIR/outbox/<time>-<recipient>.eml (open it in any mail
//                                   program to see exactly what would go) and counted as sent.
//   SEND_MODE=live               → sent through the campaign's Gmail account: the Gmail API for an
//                                   account signed in with Google, Gmail's mail server (SMTP) for one
//                                   added with an app password.

export interface Transport {
  readonly mode: 'test' | 'live'
  /** envelope: the sender and every address the message goes to (To and CC). */
  send(input: { accountId: string; recipientId: string; mime: Buffer; envelope: { from: string; to: string[] } }): Promise<SendOutcome>
}

export const outboxDir = () => path.join(dataDir(), 'outbox')

const testTransport: Transport = {
  mode: 'test',
  async send({ recipientId, mime }) {
    await mkdir(outboxDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(path.join(outboxDir(), `${stamp}-${recipientId}.eml`), mime, { mode: 0o600 })
    return { outcome: 'sent', gmailId: `test-${randomBytes(6).toString('hex')}`, threadId: null }
  },
}

const liveTransport: Transport = {
  mode: 'live',
  async send({ accountId, mime, envelope }) {
    const a = await prisma.senderAccount.findUnique({ where: { id: accountId }, select: { authType: true } })
    return a?.authType === 'app_password' ? sendViaSmtp(accountId, mime, envelope) : sendViaGmail(accountId, mime)
  },
}

let override: Transport | null = null

/** Tests only: replace where emails go. */
export function setTransportForTests(t: Transport | null) {
  override = t
}

export const transport = (): Transport => override ?? (env.SEND_MODE === 'live' ? liveTransport : testTransport)
