import { copyFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

// Before each test file: its own copy of the migrated database, its own data folder, test secrets.
// Nothing here is a real secret and nothing reaches Google: Google's addresses point at a fake server.
const tmp = path.resolve('tests/.tmp')
const run = `${process.pid}-${randomBytes(4).toString('hex')}`
const db = path.join(tmp, `db-${run}.db`)
copyFileSync(path.join(tmp, 'template.db'), db)
const data = path.join(tmp, `data-${run}`)
mkdirSync(data, { recursive: true })

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: `file:${db.replace(/\\/g, '/')}`,
  DATA_DIR: data,
  SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_BASE_URL: 'http://localhost:4300',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SEND_MODE: 'test',
  APP_TIMEZONE: 'Asia/Kolkata',
  TRACKING_ENABLED: 'false',
  TRACKING_BASE_URL: '',
  // Never Google: these are replaced by each test's fake server; an unreachable address otherwise.
  GOOGLE_AUTH_URL: 'http://127.0.0.1:9/auth',
  GOOGLE_TOKEN_URL: 'http://127.0.0.1:9/token',
  GOOGLE_REVOKE_URL: 'http://127.0.0.1:9/revoke',
  GMAIL_API_BASE: 'http://127.0.0.1:9',
})
