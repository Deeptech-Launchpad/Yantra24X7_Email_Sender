// Talking to this app's own API (/api). The session token lives in sessionStorage (gone when the tab closes).

const KEY = 'yanthara.session'

export const getToken = () => {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}
export const setToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(KEY, t)
    else sessionStorage.removeItem(KEY)
  } catch {
    // storage unavailable: the session lasts for this page only
  }
}

export const SESSION_EXPIRED = 'yanthara:session-expired'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface Options {
  method?: string
  body?: unknown
  bytes?: Blob
  headers?: Record<string, string>
}

async function request<T>(path: string, o: Options = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (o.bytes) {
    headers['Content-Type'] = 'application/octet-stream'
    body = o.bytes
  } else if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(o.body)
  }
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method: o.method ?? 'GET', headers, body })
  } catch {
    throw new ApiError(0, 'The connection to the server was lost. Check your internet connection and try again.')
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; details?: unknown } } | null)?.error
    if (res.status === 401 && token) {
      setToken(null)
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED))
    }
    throw new ApiError(res.status, err?.message ?? `The request failed (${res.status}).`, err?.details)
  }
  return data as T
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body: unknown = {}) => request<T>(p, { method: 'POST', body }),
  put: <T>(p: string, body: unknown) => request<T>(p, { method: 'PUT', body }),
  patch: <T>(p: string, body: unknown) => request<T>(p, { method: 'PATCH', body }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
  /** A file's own bytes, its name in X-File-Name. */
  upload: <T>(p: string, file: Blob, name: string) => request<T>(p, { method: 'POST', bytes: file, headers: { 'X-File-Name': encodeURIComponent(name) } }),
  /** Downloads a file (with the session) and saves it under its name. */
  async download(p: string, fallbackName: string) {
    const res = await fetch(`/api${p}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) throw new ApiError(res.status, 'The file could not be downloaded.')
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}

// ── Shapes the screens use ─────────────────────────────────────────────────

export type Role = 'admin' | 'member' | 'viewer'
export interface User {
  id: string
  email: string
  name: string
  role: Role
  status?: string
}
export interface AppConfig {
  companyName: string
  sendMode: 'test' | 'live'
  timezone: string
  minIntervalMinutes: number
  googleConfigured: boolean
  tracking: { enabled: boolean; reason: string | null }
  readonlyCheck: boolean
  limits: { maxCommonFiles: number; maxFileBytes: number; maxEmailAttachmentBytes: number; maxZipBytes: number; maxExcelBytes: number; maxCc: number; maxTemplates: number }
}
export interface Account {
  id: string
  email: string
  displayName: string | null
  status: 'connected' | 'needs_reconnect' | 'disconnected'
  statusReason: string | null
  signatureHtml: string
  dailyLimit: number
  sentLast24h: number
  remainingToday: number
  shared: boolean
  connectedByUserId: string
  usable: boolean
  canSend: boolean
  canCheckSent: boolean
}
export interface Template {
  id: string
  name: string
  subject: string
  bodyHtml: string
  createdByUserId: string
  updatedAt: string
}
export interface FileInfo {
  id: string
  fileName: string
  mimeType?: string
  sizeBytes: number
}
