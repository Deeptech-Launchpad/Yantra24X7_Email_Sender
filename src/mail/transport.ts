import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { dataDir, env } from '../config/env.js'
import { sendViaGmail, type SendOutcome } from '../gmail/api.js'

// WHERE AN EMAIL GOES.
//   SEND_MODE=test (the default) → nothing is sent. The complete message is written to
//                                   DATA_DIR/outbox/<time>-<recipient>.eml (open it in any mail
//                                   program to see exactly what would go) and counted as sent.
//   SEND_MODE=live               → sent through the campaign's Gmail account.

export interface Transport {
  readonly mode: 'test' | 'live'
  send(input: { accountId: string; recipientId: string; mime: Buffer }): Promise<SendOutcome>
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
  send: ({ accountId, mime }) => sendViaGmail(accountId, mime),
}

let override: Transport | null = null

/** Tests only: replace where emails go. */
export function setTransportForTests(t: Transport | null) {
  override = t
}

export const transport = (): Transport => override ?? (env.SEND_MODE === 'live' ? liveTransport : testTransport)
