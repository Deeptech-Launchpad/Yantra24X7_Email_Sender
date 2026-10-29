import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import DOMPurify from 'dompurify'

// Small shared pieces of the screens.

const PURIFY = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'object', 'embed', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
  FORBID_ATTR: ['class', 'id'],
}

/** HTML made safe to show on this page (the server cleans it again before it is ever sent). */
export const safeHtml = (html: string) => DOMPurify.sanitize(html ?? '', PURIFY) as unknown as string

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function Html({ html, label }: { html: string; label?: string }) {
  return <div className="preview" aria-label={label} dangerouslySetInnerHTML={{ __html: safeHtml(html) }} />
}

/** A titled block with its actions on the right — the building block of every screen. */
export function Panel({ title, subtitle, actions, children }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__titles">
            {title && <h2 className="panel__title">{title}</h2>}
            {subtitle && <p className="panel__sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  )
}

/** A short status word in a coloured pill. */
export function Chip({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'; children: ReactNode; title?: string }) {
  const cls = { neutral: '', ok: 'ok', warn: 'warn', danger: 'bad', info: 'info', accent: 'brand' }[tone]
  return (
    <span className={`badge ${cls}`} title={title}>
      {children}
    </span>
  )
}

export function Banner({ kind, children }: { kind: 'test' | 'err' | 'ok' | 'warn'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  running: 'brand',
  paused: 'warn',
  completed: 'ok',
  cancelled: '',
  sent: 'ok',
  scheduled: 'brand',
  sending: 'brand',
  failed: 'bad',
  unknown: 'warn',
  skipped: '',
  blocked: 'bad',
  ready: 'ok',
  connected: 'ok',
  needs_reconnect: 'bad',
}
const STATUS_WORD: Record<string, string> = { unknown: 'outcome unknown', needs_reconnect: 'reconnect needed' }
export function Status({ value }: { value: string }) {
  return <span className={`badge ${STATUS_TONE[value] ?? ''}`}>{STATUS_WORD[value] ?? value}</span>
}

export function Tile({ n, label, brand = false }: { n: number | string; label: string; brand?: boolean }) {
  return (
    <div className={`tile${brand ? ' brand' : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  )
}

/** Loads data, with loading / error states and a refresh. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const refresh = useCallback(() => {
    const n = ++seq.current
    setLoading(true)
    load()
      .then((d) => {
        if (n === seq.current) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (n === seq.current) setError(e.message)
      })
      .finally(() => {
        if (n === seq.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    refresh()
  }, [refresh])
  return { data, error, loading, refresh, setData }
}

/** Runs one action at a time, keeping its error in words. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setBusy(null)
    }
  }, [])
  return { busy, error, setError, run }
}

/** A box to type or paste formatted text (an email body or a signature). Pasted HTML is cleaned before it is shown. */
export function HtmlEditor({ initialHtml, onChange, label }: { initialHtml: string; onChange: (html: string) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.innerHTML = safeHtml(initialHtml)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData?.getData('text/html') ?? ''
    if (!html.trim()) return // plain text: the browser pastes it
    e.preventDefault()
    const el = box.current
    if (!el) return
    const fragment = document.createRange().createContextualFragment(safeHtml(html))
    const sel = window.getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    if (range && el.contains(range.commonAncestorContainer)) {
      range.deleteContents()
      range.insertNode(fragment)
      range.collapse(false)
    } else el.appendChild(fragment)
    onChange(el.innerHTML)
  }
  return (
    <div
      ref={box}
      className="editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      onInput={() => onChange(box.current?.innerHTML ?? '')}
      onPaste={onPaste}
    />
  )
}

/** The text a piece of HTML contains. */
export const visibleText = (html: string) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent?.trim() ?? ''

/** A list of email addresses typed one by one (CC). */
export function EmailList({ value, onChange, max, label }: { value: string[]; onChange: (v: string[]) => void; max: number; label: string }) {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = () => {
    const parts = draft.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    const bad = parts.find((p) => !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(p))
    if (bad) return setErr(`"${bad}" is not a valid email address.`)
    const next = [...new Set([...value, ...parts])]
    if (next.length > max) return setErr(`At most ${max} addresses.`)
    setErr(null)
    setDraft('')
    onChange(next)
  }
  return (
    <div>
      <div className="row">
        <input type="email" aria-label={label} value={draft} placeholder="name@company.com" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? (e.preventDefault(), add()) : undefined)} />
        <button type="button" className="btn small" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {err && <p className="note" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      {value.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {value.map((e) => (
            <span className="chip" key={e}>
              {e}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== e))}>
                ×<span className="sr-only"> remove {e}</span>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
