import MailComposer from 'nodemailer/lib/mail-composer/index.js'

// ONE EMAIL AS A COMPLETE MESSAGE (RFC 5322 / MIME), ready to hand to Gmail.
// Built by nodemailer's composer (headers encoded correctly, attachments as real
// MIME parts — never links). The Message-ID is chosen here, so the email can be
// found again in the sender's Sent folder if the answer to sending is ever lost.

export interface OutgoingFile {
  filename: string
  contentType: string
  content: Buffer
  /** Set for a picture shown inside the email (signature), referenced as cid:… */
  cid?: string
}

export interface OutgoingEmail {
  from: string
  fromName?: string | null
  to: string
  cc: string[]
  /** Where replies go, when not to the sender. */
  replyTo?: string | null
  subject: string
  html: string
  text: string
  attachments: OutgoingFile[]
  messageId: string
  /** Adds List-Unsubscribe pointing to the mailbox that gets the replies (Reply-To, or the sender). */
  listUnsubscribeMailto?: boolean
}

/** A Message-ID unique to this one email: <yb.RECIPIENT.RANDOM@sender-domain>. */
export function makeMessageId(recipientId: string, from: string, random: string): string {
  const domain = (from.split('@')[1] ?? 'localhost').replace(/[^a-z0-9.-]/gi, '') || 'localhost'
  return `<yb.${recipientId}.${random}@${domain}>`
}

export async function buildMime(e: OutgoingEmail): Promise<Buffer> {
  const headers: Record<string, string> = {}
  if (e.listUnsubscribeMailto) headers['List-Unsubscribe'] = `<mailto:${e.replyTo || e.from}?subject=unsubscribe>`
  const composer = new MailComposer({
    from: e.fromName ? { name: e.fromName, address: e.from } : e.from,
    to: e.to,
    ...(e.cc.length ? { cc: e.cc } : {}),
    ...(e.replyTo ? { replyTo: e.replyTo } : {}),
    subject: e.subject,
    text: e.text,
    html: e.html,
    messageId: e.messageId,
    date: new Date(),
    headers,
    attachments: e.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}) })),
  })
  return new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err: Error | null, message: Buffer) => (err ? reject(err) : resolve(message)))
  })
}
