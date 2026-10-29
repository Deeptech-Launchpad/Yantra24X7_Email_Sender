import { existsSync } from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { env, webDistDir } from './config/env.js'
import { AppError } from './platform/errors.js'
import { log } from './platform/log.js'
import { api } from './routes/api.js'
import { GIF, recordOpen } from './bulk/tracking.js'

// THE WEB APPLICATION: the API under /api, the open-tracking image under /t (inactive
// until tracking is configured), and the built screens (web/dist) for everything else.

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Email previews show pictures from the web and embedded signature pictures.
          imgSrc: ["'self'", 'https:', 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", 'https://accounts.google.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  )
  app.use('/api', rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: 'draft-7', legacyHeaders: false }))
  app.use('/api', express.json({ limit: '3mb' }))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sendMode: env.SEND_MODE })
  })

  // Open tracking: always answers the image; counts only when tracking is set up.
  app.get('/t/:token.gif', (req, res) => {
    void recordOpen(String(req.params.token))
    res.setHeader('Content-Type', 'image/gif')
    res.setHeader('Cache-Control', 'no-store, private')
    res.send(GIF)
  })

  app.use('/api', api)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } })
  })

  // The screens (built by `npm run build` in web/).
  const webDist = webDistDir()
  if (!existsSync(webDist) && env.NODE_ENV === 'production') log.warn('the screens are not built (web/dist is missing): run `npm run build` in web/')
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }))
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
      return
    }
    log.error('unhandled error', { path: req.path, err: String((err as Error)?.message ?? err).slice(0, 500) })
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Try again; if it keeps happening, tell an administrator.' } })
  })
  return app
}
