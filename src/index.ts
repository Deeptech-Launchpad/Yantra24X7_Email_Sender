import { configProblems, env } from './config/env.js'
import { createApp } from './app.js'
import { startDispatcher, stopDispatcher } from './bulk/dispatcher.js'
import { prisma } from './platform/db.js'
import { log } from './platform/log.js'

// Starts the web application and the sender loop (one process).

const problems = configProblems()
if (problems.length) {
  console.error(`Configuration is incomplete — fix .env and start again:\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}

const server = createApp().listen(env.PORT, () => {
  log.info('Yantra 24x7 Bulk Email started', { port: env.PORT, sendMode: env.SEND_MODE, tracking: env.TRACKING_ENABLED })
  if (env.SEND_MODE === 'test') log.info('TEST MODE: no email is sent; every email is written to DATA_DIR/outbox as an .eml file')
  startDispatcher()
})

async function shutdown(signal: string) {
  log.info('stopping', { signal })
  stopDispatcher()
  server.close()
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: String((err as Error)?.message ?? err).slice(0, 500) }))
