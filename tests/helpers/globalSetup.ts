import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

// Once per test run: a template database built by the REAL migrations. Each test file copies it.
export default function setup() {
  const tmp = path.resolve('tests/.tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const template = path.join(tmp, 'template.db')
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: `file:${template.replace(/\\/g, '/')}` },
    stdio: 'pipe',
  })
  return () => rmSync(tmp, { recursive: true, force: true })
}
