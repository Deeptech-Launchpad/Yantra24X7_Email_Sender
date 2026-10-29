import express, { Router, type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env, googleConfigured } from '../config/env.js'
import { adminOnly, authenticate, canSend, createUser, listUsers, login, ROLES, updateUser, type Principal } from '../auth/users.js'
import { finishConnect, startConnect, disconnect } from '../gmail/oauth.js'
import { BadRequestError } from '../platform/errors.js'
import { log } from '../platform/log.js'
import { campaignReportCsv, campaignView, listCampaigns, reconcileCampaign, recipientEmail, resolveUnknown, retryFailed, setCampaignState, startCampaign } from '../bulk/campaigns.js'
import { MAX_SUBJECT, MAX_TEMPLATE_HTML, MAX_SIGNATURE_HTML, MAX_TEMPLATES_PER_CAMPAIGN } from '../bulk/content.js'
import { MAX_ZIP_BYTES } from '../bulk/companyZip.js'
import { MAX_UPLOAD_BYTES } from '../bulk/excel.js'
import { appendZipChunk, finishZipUpload, MAX_COMMON_FILES, MAX_EMAIL_ATTACHMENT_BYTES, MAX_FILE_BYTES, removeStaged, startZipUpload, storeCommon, storeExcel, ZIP_CHUNK_BYTES } from '../bulk/files.js'
import { analyzeExcel, MAX_CC, reviewCampaign } from '../bulk/review.js'
import { connectAppPassword, listAccounts, readiness, updateAccount, usableAccount } from '../bulk/senders.js'
import { addSuppressions, listSuppressions, removeSuppression } from '../bulk/suppression.js'
import { archiveTemplate, listTemplates, previewTemplate, saveTemplate } from '../bulk/templates.js'
import { trackingStatus } from '../bulk/tracking.js'

// THE API, under /api. Everything except signing in and Google's callback needs a session;
// changes need the member or admin role; users need admin. Every body is checked here.

export const api = Router()

const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next)
  }
const who = (req: Request): Principal => req.principal!
function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body ?? {})
  if (!r.success) {
    const i = r.error.issues[0]
    throw new BadRequestError(`The request is not valid${i ? ` (${i.path.join('.') || 'body'}: ${i.message})` : ''}.`)
  }
  return r.data
}
const id = z.string().min(1).max(64)

// ── Signing in ─────────────────────────────────────────────────────────────

const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'too_many', message: 'Too many sign-in attempts. Wait 15 minutes.' } } })

api.post(
  '/auth/login',
  loginLimit,
  h(async (req, res) => {
    const b = body(z.object({ email: z.string().max(254), password: z.string().max(200) }).strict(), req)
    res.json(await login(b.email, b.password))
  }),
)

// The cookie that ties a Gmail sign-in to the browser that started it (sent only to the callback).
const OAUTH_COOKIE = 'yb_oauth'
const oauthCookie = (value: string, maxAge: number) =>
  `${OAUTH_COOKIE}=${value}; Path=/api/oauth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${env.APP_BASE_URL.startsWith('https://') ? '; Secure' : ''}`
const cookieValue = (header: string | undefined, name: string) =>
  header?.split(';').map((p) => p.trim().split('=')).find(([k]) => k === name)?.[1]

// Google sends the browser back here (no session header on a redirect: the single-use state says who started it,
// the cookie says which browser).
api.get(
  '/oauth/google/callback',
  h(async (req, res) => {
    const base = env.APP_BASE_URL.replace(/\/+$/, '')
    res.setHeader('Set-Cookie', oauthCookie('', 0))
    try {
      const r = await finishConnect({
        code: String(req.query.code ?? ''),
        state: String(req.query.state ?? ''),
        error: req.query.error ? String(req.query.error) : undefined,
        browserNonce: cookieValue(req.headers.cookie, OAUTH_COOKIE),
      })
      res.redirect(303, `${base}/senders?connected=${encodeURIComponent(r.account.email)}`)
    } catch (err) {
      log.warn('Gmail connection not completed', { reason: String((err as Error).message).slice(0, 200) })
      res.redirect(303, `${base}/senders?error=${encodeURIComponent(String((err as Error).message).slice(0, 300))}`)
    }
  }),
)

api.use(authenticate)

api.get('/auth/me', (req, res) => {
  res.json({ user: who(req) })
})

api.get('/config', (_req, res) => {
  res.json({
    companyName: env.COMPANY_NAME,
    sendMode: env.SEND_MODE,
    timezone: env.APP_TIMEZONE,
    minIntervalMinutes: env.MIN_INTERVAL_MINUTES,
    googleConfigured: googleConfigured(),
    tracking: trackingStatus(),
    readonlyCheck: env.GMAIL_READONLY_CHECK,
    limits: { maxCommonFiles: MAX_COMMON_FILES, maxFileBytes: MAX_FILE_BYTES, maxEmailAttachmentBytes: MAX_EMAIL_ATTACHMENT_BYTES, maxZipBytes: MAX_ZIP_BYTES, maxExcelBytes: MAX_UPLOAD_BYTES, maxCc: MAX_CC, maxTemplates: MAX_TEMPLATES_PER_CAMPAIGN },
  })
})

// ── Users (admin) ──────────────────────────────────────────────────────────

const Role = z.enum(ROLES as [string, ...string[]])
api.get('/users', adminOnly, h(async (_req, res) => res.json({ users: await listUsers() })))
api.post(
  '/users',
  adminOnly,
  h(async (req, res) => {
    const b = body(z.object({ email: z.string().max(254), name: z.string().max(120), role: Role, password: z.string().max(200) }).strict(), req)
    res.status(201).json(await createUser(b as Parameters<typeof createUser>[0]))
  }),
)
api.patch(
  '/users/:id',
  adminOnly,
  h(async (req, res) => {
    const b = body(z.object({ role: Role.optional(), status: z.enum(['active', 'disabled']).optional(), name: z.string().max(120).optional(), password: z.string().max(200).optional() }).strict(), req)
    res.json(await updateUser(who(req), String(req.params.id), b as Parameters<typeof updateUser>[2]))
  }),
)

// ── Sender accounts ────────────────────────────────────────────────────────

api.get('/senders', h(async (req, res) => res.json(await listAccounts(who(req)))))
api.post(
  '/senders/connect',
  canSend,
  h(async (req, res) => {
    const r = await startConnect(who(req))
    res.setHeader('Set-Cookie', oauthCookie(r.browserNonce, 600))
    res.json({ url: r.url })
  }),
)
// A Gmail account that sends with an app password (checked with Gmail's mail server, stored encrypted).
api.post(
  '/senders/app-password',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ email: z.string().max(254), appPassword: z.string().max(64), displayName: z.string().max(80).optional() }).strict(), req)
    res.status(201).json(await connectAppPassword(who(req), b))
  }),
)
api.post(
  '/senders/:id/check',
  h(async (req, res) => {
    const a = await usableAccount(who(req), String(req.params.id))
    res.json(await readiness(a.id))
  }),
)
api.patch(
  '/senders/:id',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ signatureHtml: z.string().max(MAX_SIGNATURE_HTML + 10_000).optional(), dailyLimit: z.number().int().optional(), shared: z.boolean().optional(), displayName: z.string().max(80).optional() }).strict(), req)
    res.json(await updateAccount(who(req), String(req.params.id), b))
  }),
)
api.post('/senders/:id/disconnect', canSend, h(async (req, res) => res.json(await disconnect(who(req), String(req.params.id)))))

// ── Templates ──────────────────────────────────────────────────────────────

const TemplateBody = z.object({ name: z.string().max(100), subject: z.string().max(MAX_SUBJECT + 50), bodyHtml: z.string().max(MAX_TEMPLATE_HTML + 5000) }).strict()
api.get('/templates', h(async (_req, res) => res.json({ templates: await listTemplates() })))
api.post('/templates', canSend, h(async (req, res) => res.status(201).json(await saveTemplate(who(req), body(TemplateBody, req)))))
api.put('/templates/:id', canSend, h(async (req, res) => res.json(await saveTemplate(who(req), { ...body(TemplateBody, req), id: String(req.params.id) }))))
api.delete('/templates/:id', canSend, h(async (req, res) => res.json(await archiveTemplate(who(req), String(req.params.id)))))
api.post(
  '/templates/preview',
  h(async (req, res) => {
    const b = body(z.object({ subject: z.string().max(MAX_SUBJECT + 50), bodyHtml: z.string().max(MAX_TEMPLATE_HTML + 5000), firstName: z.string().max(80).optional(), companyName: z.string().max(120).optional() }).strict(), req)
    res.json(previewTemplate(b))
  }),
)

// ── Files (raw bytes, the name in X-File-Name) ─────────────────────────────

const raw = (limit: number, what: string) => (req: Request, res: Response, next: NextFunction) =>
  express.raw({ type: 'application/octet-stream', limit: limit + 64 * 1024 })(req, res, (err?: unknown) => {
    if (!err) return next()
    next(new BadRequestError((err as { type?: string }).type === 'entity.too.large' ? `${what} is larger than ${Math.round(limit / 1024 / 1024)} MB.` : `${what} could not be read. Upload it again.`))
  })
function fileOf(req: Request): { name: string; bytes: Buffer } {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequestError('Send the file itself (Content-Type: application/octet-stream).')
  let name = ''
  try {
    name = decodeURIComponent(String(req.header('x-file-name') ?? ''))
  } catch {
    throw new BadRequestError('The file name could not be read.')
  }
  return { name, bytes: req.body }
}

api.post('/files/excel', canSend, raw(MAX_UPLOAD_BYTES, 'The Excel file'), h(async (req, res) => {
  const f = fileOf(req)
  res.status(201).json(await storeExcel(who(req), f.name, f.bytes))
}))
api.post('/files/attachments', canSend, raw(MAX_FILE_BYTES, 'The file'), h(async (req, res) => {
  const f = fileOf(req)
  res.status(201).json(await storeCommon(who(req), f.name, f.bytes))
}))
api.delete('/files/:id', canSend, h(async (req, res) => res.json(await removeStaged(who(req), String(req.params.id)))))
api.post(
  '/files/zip/start',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ fileName: z.string().min(1).max(200), sizeBytes: z.number().int().min(1).max(MAX_ZIP_BYTES) }).strict(), req)
    res.status(201).json(await startZipUpload(who(req), b))
  }),
)
api.post('/files/zip/:id/chunk', canSend, raw(ZIP_CHUNK_BYTES, 'A piece of the ZIP'), h(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BadRequestError('Send the piece of the ZIP itself (Content-Type: application/octet-stream).')
  const offset = Number(req.query.offset)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new BadRequestError('The position of this piece is missing.')
  res.json(await appendZipChunk(who(req), String(req.params.id), offset, req.body))
}))
api.post('/files/zip/:id/finish', canSend, h(async (req, res) => res.status(201).json(await finishZipUpload(who(req), String(req.params.id)))))

// ── Campaigns ──────────────────────────────────────────────────────────────

const Setup = z
  .object({
    excelFileId: id,
    allowWebmail: z.boolean().optional(),
    sheet: z.string().min(1).max(100).optional(),
    sheets: z.array(z.string().min(1).max(100)).min(1).max(3).optional(),
    onePer: z.enum(['company', 'person']).optional(),
    replyTo: z.string().max(254).optional(),
    senderAccountId: id,
    templates: z.array(z.object({ templateId: id.optional(), subject: z.string().max(MAX_SUBJECT + 50).optional(), bodyHtml: z.string().max(MAX_TEMPLATE_HTML + 5000).optional() }).strict()).min(1).max(MAX_TEMPLATES_PER_CAMPAIGN),
    templateOrder: z.enum(['sequential', 'random']).optional(),
    shuffleSeed: z.number().int().min(0).max(0x7fffffff).optional(),
    cc: z.array(z.string().max(254)).max(MAX_CC).optional(),
    copyColleagues: z.boolean().optional(),
    attachmentIds: z.array(id).max(MAX_COMMON_FILES).optional(),
    companyZipId: id.optional(),
    excludeUnmatched: z.boolean().optional(),
    excludePositions: z.array(z.number().int().min(0).max(100_000)).max(5000).optional(),
    startDate: z.string().max(10),
    startTime: z.string().max(5),
    intervalMinutes: z.number().int().min(1).max(240),
    name: z.string().max(120).optional(),
  })
  .strict()

api.get('/campaigns', h(async (_req, res) => res.json(await listCampaigns())))
api.post(
  '/campaigns/analyze',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ excelFileId: id, allowWebmail: z.boolean().optional(), sheet: z.string().min(1).max(100).optional(), onePer: z.enum(['company', 'person']).optional() }).strict(), req)
    res.json(await analyzeExcel(who(req), b.excelFileId, b))
  }),
)
api.post('/campaigns/review', canSend, h(async (req, res) => res.json(await reviewCampaign(who(req), body(Setup, req)))))
api.post('/campaigns/start', canSend, h(async (req, res) => res.status(201).json(await startCampaign(who(req), body(Setup.extend({ confirm: z.boolean(), reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }), req)))))
api.get('/campaigns/:id', h(async (req, res) => res.json(await campaignView(String(req.params.id)))))
api.get('/campaigns/:id/recipients/:rid', h(async (req, res) => res.json(await recipientEmail(String(req.params.id), String(req.params.rid)))))
for (const to of ['pause', 'resume', 'cancel'] as const) {
  api.post(`/campaigns/:id/${to}`, canSend, h(async (req, res) => res.json(await setCampaignState(who(req), String(req.params.id), to))))
}
api.post(
  '/campaigns/:id/retry',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ recipientIds: z.array(id).max(5000).optional() }).strict(), req)
    res.json(await retryFailed(who(req), String(req.params.id), b.recipientIds))
  }),
)
api.post(
  '/campaigns/:id/recipients/:rid/resolve',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ outcome: z.enum(['sent', 'not_sent']) }).strict(), req)
    res.json(await resolveUnknown(who(req), String(req.params.id), String(req.params.rid), b.outcome))
  }),
)
api.post('/campaigns/:id/reconcile', canSend, h(async (req, res) => res.json(await reconcileCampaign(who(req), String(req.params.id)))))
api.get(
  '/campaigns/:id/report.csv',
  h(async (req, res) => {
    const r = await campaignReportCsv(String(req.params.id))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${r.fileName.replace(/"/g, '')}"`)
    res.send(r.csv)
  }),
)

// ── Do-not-email list ──────────────────────────────────────────────────────

api.get('/suppressions', h(async (_req, res) => res.json({ suppressions: await listSuppressions() })))
api.post(
  '/suppressions',
  canSend,
  h(async (req, res) => {
    const b = body(z.object({ values: z.array(z.string().max(254)).min(1).max(1000), reason: z.string().max(200).optional() }).strict(), req)
    res.status(201).json(await addSuppressions(who(req), b.values, b.reason ?? ''))
  }),
)
api.delete('/suppressions/:id', adminOnly, h(async (req, res) => res.json(await removeSuppression(who(req), String(req.params.id)))))
