import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** The project's own folder (this file is src/config/env.ts, or dist/config/env.js when built). */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The .env of THIS project, wherever the process was started from.
loadDotenv({ path: path.join(projectRoot, '.env') })

// THIS APPLICATION'S CONFIGURATION. Every value is read from this app's own
// environment (.env). Nothing is read from, or shared with, any other app.

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1' || v === 'yes')

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4300),
  APP_BASE_URL: z.string().url().default('http://localhost:4300'),
  COMPANY_NAME: z.string().min(1).max(80).default('Yantra 24x7'),

  DATABASE_URL: z.string().min(1).default('file:../data/yanthara.db'),
  DATA_DIR: z.string().min(1).default('./data'),

  SESSION_SECRET: z.string().default(''),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().default(''),
  GMAIL_READONLY_CHECK: bool,
  // Gmail's mail server, for accounts that send with an app password.
  SMTP_HOST: z.string().min(1).default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: bool.default('true'),

  SEND_MODE: z.enum(['test', 'live']).default('test'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(240).default(1),
  DEFAULT_DAILY_LIMIT: z.coerce.number().int().min(1).max(2000).default(400),
  DISPATCH_TICK_SECONDS: z.coerce.number().int().min(5).max(600).default(20),
  REPEAT_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(365).default(0),
  EXCEL_SKIP_STATUS_WORDS: z.string().default('outreach'),
  LIST_UNSUBSCRIBE_MAILTO: bool.default('true'),

  TRACKING_ENABLED: bool,
  TRACKING_BASE_URL: z.string().default(''),

  GOOGLE_AUTH_URL: z.string().url().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_REVOKE_URL: z.string().url().default('https://oauth2.googleapis.com/revoke'),
  GMAIL_API_BASE: z.string().url().default('https://gmail.googleapis.com'),
})

export type AppEnv = z.infer<typeof Env>

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // Names only — never values.
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
}

/** Mutable only so tests can switch a setting; the app itself never writes to it. */
export const env: AppEnv = parsed.data

/** The address Google sends the person back to after they allow access. */
export const oauthRedirectUrl = () => env.GOOGLE_OAUTH_REDIRECT_URL || `${env.APP_BASE_URL.replace(/\/+$/, '')}/api/oauth/google/callback`

/** What is missing for the app to run safely (names only). Checked at start-up. */
export function configProblems(): string[] {
  const out: string[] = []
  if (env.SESSION_SECRET.length < 32) out.push('SESSION_SECRET must be at least 32 characters')
  if (Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) out.push('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 (npm run key:generate)')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: env.APP_TIMEZONE })
  } catch {
    out.push('APP_TIMEZONE is not a valid time zone')
  }
  if (env.TRACKING_ENABLED && !/^https:\/\/[^/]+/.test(env.TRACKING_BASE_URL)) out.push('TRACKING_ENABLED needs TRACKING_BASE_URL to be a public https:// address')
  return out
}

/** DATA_DIR as an absolute path (a relative one is relative to the project folder, not to where the process started). */
export const dataDir = () => path.resolve(projectRoot, env.DATA_DIR)

/** The built screens. */
export const webDistDir = () => path.join(projectRoot, 'web', 'dist')

/** Whether Gmail accounts can be connected at all (the OAuth client is configured). */
export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

/** Words that, in the Excel's Status column, mean "do not email this company". */
export const skipStatusWords = () =>
  env.EXCEL_SKIP_STATUS_WORDS.split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
