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

/** A picture file as a small data: address (at most 300 px wide, well under the 400 KB limit a signature picture may have). */
async function pictureToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('That picture could not be read.'))
    r.readAsDataURL(file)
  })
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('not a picture'))
      i.src = raw
    })
    const scale = Math.min(1, 300 / img.naturalWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return raw
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = canvas.toDataURL('image/png')
    if (png.length < 300_000) return png
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return raw // no canvas here: the file as it is (the server refuses one that is too large)
  }
}

/**
 * A box to type or paste formatted text (an email body or a signature). Pasted HTML is cleaned before it is shown.
 * With `pictures`, a logo or other picture can be added with the button, pasted (copied picture) or dropped into the box.
 */
export function HtmlEditor({ initialHtml, onChange, label, pictures = false }: { initialHtml: string; onChange: (html: string) => void; label: string; pictures?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (box.current) box.current.innerHTML = safeHtml(initialHtml)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const insert = (html: string) => {
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
  const addPictures = async (files: File[]) => {
    setProblem(null)
    for (const f of files) {
      if (!/^image\/(png|jpe?g|gif|webp)$/i.test(f.type)) {
        setProblem('Only PNG, JPG, GIF or WebP pictures can be added.')
        continue
      }
      try {
        insert(`<img src="${await pictureToDataUrl(f)}" alt="Logo" style="max-width:300px">`)
      } catch (e) {
        setProblem((e as Error).message)
      }
    }
  }
  const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pics = pictures ? imageFiles(e.clipboardData?.files) : []
    const html = e.clipboardData?.getData('text/html') ?? ''
    if (pics.length && !html.toLowerCase().includes('<img')) {
      e.preventDefault()
      void addPictures(pics)
      return
    }
    if (!html.trim()) return // plain text: the browser pastes it
    e.preventDefault()
    insert(html)
  }
  return (
    <div>
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
        onDrop={(e) => {
          const pics = pictures ? imageFiles(e.dataTransfer?.files) : []
          if (!pics.length) return
          e.preventDefault()
          void addPictures(pics)
        }}
      />
      {pictures && (
        <div className="row" style={{ marginTop: 8 }}>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            aria-label={`${label}: add a picture`}
            hidden
            onChange={(e) => {
              void addPictures(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button type="button" className="btn small" onClick={() => file.current?.click()}>
            Add logo / picture
          </button>
          <span className="cell-dim">You can also paste or drop a picture into the box.</span>
        </div>
      )}
      {problem && (
        <p className="note" role="alert" style={{ color: 'var(--bad)' }}>
          {problem}
        </p>
      )}
    </div>
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
