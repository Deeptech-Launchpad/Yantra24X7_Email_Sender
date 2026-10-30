import sanitizeHtml from 'sanitize-html'
import { BadRequestError } from '../platform/errors.js'

// EMAIL CONTENT: templates, signatures and the email each person receives.
// (Adapted from the Marketing AI Agent's Bulk Email, 2026-10-29.)
//
// A template is a subject and an HTML body pasted or typed by the user. It is
// cleaned here, on the server — the browser's clean-up is never trusted — and
// only [First Name] and [Company Name] are filled for each person (values are
// HTML-escaped). Only what could run code or cannot travel in an email is
// removed, and the screen says what: scripts, event handlers, javascript:
// links, forms, frames, and images that are not on the web.

export const MAX_SUBJECT = 200
export const MAX_TEMPLATE_HTML = 200_000
export const MAX_SIGNATURE_HTML = 1_500_000
/** One picture embedded in a signature. */
export const MAX_SIGNATURE_IMAGE_BYTES = 400_000
export const MAX_TEMPLATES_PER_CAMPAIGN = 3
export const PLACEHOLDERS = ['[First Name]', '[Company Name]'] as const

// [First Name] and [Company Name], or the merge form many mailing tools use: {First name}, {Company name} and
// {First name|there} — the word after the bar is used when the person has no first name ("Dear there,").
// However it was typed or pasted — any capitals, extra spaces, a non-breaking space ("&nbsp;") from Gmail or Word.
const WS = '(?:\\s|&nbsp;)+'
const WS0 = '(?:\\s|&nbsp;)*'
const PLACEHOLDER = new RegExp(`\\[${WS0}(First${WS}Name|Company${WS}Name)${WS0}\\]|\\{${WS0}(First${WS}name|Company${WS}name)${WS0}(?:\\|${WS0}([^{}|\\n]{1,40}?)${WS0})?\\}`, 'gi')
const PLACEHOLDER_ONLY = new RegExp(`^(?:\\[${WS0}(?:First${WS}Name|Company${WS}Name)${WS0}\\]|\\{${WS0}(?:First${WS}name|Company${WS}name)${WS0}(?:\\|${WS0}[^{}|\\n]{1,40}?${WS0})?\\})$`, 'i')
/** Which value a matched placeholder asks for. */
const isFirstName = (bracket: string | undefined, brace: string | undefined) => /^first/i.test(bracket ?? brace ?? '')
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i
// CSS that could load or run something is removed; every other declaration is kept.
const BAD_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import|url\s*\(\s*['"]?\s*(?!https:)/i
const STYLE_ATTRS = ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'title', 'lang']

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function cleanStyle(style: string): string {
  return style
    .split(';')
    .filter((d) => d.trim() && !BAD_CSS.test(d))
    .join(';')
}

/** Cleans email HTML. `signature` also allows small embedded (data:) pictures, sent as inline images. */
export function cleanEmailHtml(input: string, kind: 'template' | 'signature'): { html: string; removed: string[] } {
  const removed = new Set<string>()
  const html = sanitizeHtml(input ?? '', {
    allowedTags: [
      'div', 'p', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'big', 'sub', 'sup', 'font', 'center',
      'a', 'img', 'hr', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ],
    allowedAttributes: {
      '*': STYLE_ATTRS,
      a: [...STYLE_ATTRS, 'href', 'name'],
      img: [...STYLE_ATTRS, 'src', 'alt', 'border'],
      table: [...STYLE_ATTRS, 'border', 'cellpadding', 'cellspacing', 'role'],
      td: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      th: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      col: [...STYLE_ATTRS, 'span'],
      font: [...STYLE_ATTRS, 'color', 'face', 'size'],
      hr: [...STYLE_ATTRS, 'size', 'noshade', 'color'],
      ol: [...STYLE_ATTRS, 'start', 'type'],
      ul: [...STYLE_ATTRS, 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: kind === 'signature' ? ['https', 'data'] : ['https'] },
    allowProtocolRelative: false,
    // Scripts, style blocks and the like go with their contents.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      '*': (tagName, attribs) => {
        if (attribs.style !== undefined) {
          const style = cleanStyle(attribs.style)
          if (style !== attribs.style) removed.add('style rules that load outside content')
          if (style) attribs.style = style
          else delete attribs.style
        }
        return { tagName, attribs }
      },
    },
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false
      const src = (frame.attribs.src ?? '').trim()
      if (/^https:\/\//i.test(src)) return false
      const m = kind === 'signature' ? DATA_IMAGE.exec(src) : null
      if (m) {
        if (Math.floor((m[2]!.replace(/\s/g, '').length * 3) / 4) <= MAX_SIGNATURE_IMAGE_BYTES) return false
        removed.add(`a picture larger than ${Math.round(MAX_SIGNATURE_IMAGE_BYTES / 1000)} KB`)
        return true
      }
      removed.add(kind === 'signature' ? 'an image that is not on the web or embedded' : 'an image that is not a link to the web (add pictures as links to images on the web)')
      return true
    },
  })
  const compact = (input ?? '').replace(/\s+/g, '')
  if (/<script|\son\w+\s*=|javascript:|<iframe|<form|<object|<embed/i.test(compact)) removed.add('scripts and active content')
  return { html: html.trim(), removed: [...removed] }
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** HTML as plain text: its lines, in order, without markup. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|ul|ol|blockquote|table)>/gi, (m) => `${m}<br>`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|pre|center)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\n')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `${alt} ` : ''))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PreparedTemplate {
  subject: string
  /** Cleaned body, still with its placeholders. */
  html: string
  text: string
  removed: string[]
}

/** Validates and cleans a template. Throws a sentence a person can act on. */
/**
 * A placeholder that formatting has cut into pieces — "[First name</span><span style=…>]" or "[First <b>Name</b>]", which
 * Gmail, Word and Outlook do when text is pasted — becomes one piece again. The tags inside it are kept, in the same
 * order, right after it, so the formatting stays balanced and only the placeholder's own letters are joined.
 */
function joinSplitPlaceholders(s: string): string {
  const fix = (m: string, inner: string, brace: boolean) => {
    const tags = inner.match(/<[^>]*>/g)
    if (!tags) return m // nothing split it: the ordinary rule handles it
    const text = inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    const hit = brace ? /^(first name|company name)\s*(?:\|\s*([^{}|]{1,40}?))?$/i.exec(text) : /^(first name|company name)$/i.exec(text)
    if (!hit) return m
    const first = /^first/i.test(hit[1]!)
    const word = brace ? `{${first ? 'First name' : 'Company name'}${hit[2] ? `|${hit[2].trim()}` : ''}}` : first ? '[First Name]' : '[Company Name]'
    return word + tags.join('')
  }
  return s.replace(/\[((?:<[^>]*>|[^[\]<>])*)\]/g, (m, inner: string) => fix(m, inner, false)).replace(/\{((?:<[^>]*>|[^{}<>])*)\}/g, (m, inner: string) => fix(m, inner, true))
}

/**
 * The placeholders of a template, written in the one standard form: [First Name] and [Company Name]
 * ({First name|there} keeps its fallback word). Idempotent: what is stored and previewed is what is filled.
 */
export function normalizePlaceholders(s: string): string {
  return joinSplitPlaceholders(s).replace(PLACEHOLDER, (_token, bracket: string | undefined, brace: string | undefined, fallback: string | undefined) => {
    const first = isFirstName(bracket, brace)
    if (brace && fallback) return `{${first ? 'First name' : 'Company name'}|${fallback.trim()}}`
    return first ? '[First Name]' : '[Company Name]'
  })
}

export function prepareTemplate(input: { subject: string; bodyHtml: string }): PreparedTemplate {
  const subject = normalizePlaceholders(String(input.subject ?? '').trim())
  if (!subject) throw new BadRequestError('Enter the subject.')
  if (/[\r\n]/.test(subject)) throw new BadRequestError('The subject must be one line.')
  if (subject.length > MAX_SUBJECT) throw new BadRequestError(`The subject is longer than ${MAX_SUBJECT} characters.`)
  const raw = String(input.bodyHtml ?? '')
  if (raw.length > MAX_TEMPLATE_HTML) throw new BadRequestError('The email body is too long. Shorten it and try again.')
  const cleaned = cleanEmailHtml(raw, 'template')
  const html = normalizePlaceholders(cleaned.html)
  const text = htmlToText(html)
  if (!text) throw new BadRequestError('Write or paste the email body.')
  return { subject, html, text, removed: cleaned.removed }
}

export function prepareSignature(html: string): { html: string; removed: string[] } {
  if ((html ?? '').length > MAX_SIGNATURE_HTML) throw new BadRequestError('The signature is too large (pictures make it large: use smaller ones).')
  return cleanEmailHtml(html ?? '', 'signature')
}

/** Fills the two placeholders in plain text; a blank value is reported, never sent as a bracket. */
export function fillText(text: string, values: { firstName: string | null; companyName: string | null }): { text: string; unfilled: string[] } {
  const unfilled: string[] = []
  const out = text.replace(PLACEHOLDER, (token, bracket: string | undefined, brace: string | undefined, fallback: string | undefined) => {
    const v = isFirstName(bracket, brace) ? values.firstName : values.companyName
    if (!v || !v.trim()) {
      if (fallback) return fallback.trim()
      unfilled.push(token)
      return token
    }
    return v.trim()
  })
  return { text: out, unfilled: [...new Set(unfilled)] }
}

function fillHtml(html: string, values: { firstName: string | null; companyName: string | null }): string {
  return html.replace(PLACEHOLDER, (token, bracket: string | undefined, brace: string | undefined, fallback: string | undefined) => {
    const v = isFirstName(bracket, brace) ? values.firstName : values.companyName
    if (v && v.trim()) return escapeHtml(v.trim())
    return fallback ? fallback.trim() : token
  })
}

export interface ComposedEmail {
  subject: string
  html: string
  text: string
  unfilled: string[]
  /** Unfinished draft text left in the email: {First name|there}, [Part: e.g. 6 mm wall.] … Such an email must not be sent. */
  draft: string[]
}

/** Text in { } or [ ] that is not one of the two placeholders this app fills — a draft note or another tool's merge tag. */
const DRAFT_TEXT = /\{[^{}\n]{1,80}\}|\[[^[\]\n]{1,120}\]/g

/** The email exactly as one person receives it: the template filled for them, and the signature under it. */
export function composeEmail(input: { template: PreparedTemplate; firstName: string | null; companyName: string | null; signatureHtml?: string }): ComposedEmail {
  const values = { firstName: input.firstName, companyName: input.companyName }
  const subject = fillText(input.template.subject, values)
  const body = fillText(input.template.html, values)
  const html = fillHtml(input.template.html, values)
  const sig = (input.signatureHtml ?? '').trim()
  const sigText = sig ? htmlToText(sig) : ''
  const text = htmlToText(html) + (sigText ? `\n\n${sigText}` : '')
  const unfilled = [...new Set([...subject.unfilled, ...body.unfilled])]
  // A placeholder still in the text is only acceptable when it is reported as unfilled (a blank name). One that was
  // never found by the fill — for example because formatting splits it ("[First <b>Name</b>]") — would be sent as it
  // is, so it counts as draft text and the email is blocked.
  const draft = [...new Set(`${subject.text}\n${text}`.match(DRAFT_TEXT) ?? [])].filter((t) => !(PLACEHOLDER_ONLY.test(t) && unfilled.includes(t))).map((t) => t.slice(0, 70))
  return {
    draft,
    subject: subject.text,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${html}${sig ? `<div><br></div><div>${sig}</div>` : ''}</div>`,
    text,
    unfilled,
  }
}

/** Embedded (data:) pictures of a signature become inline attachments referenced by cid, which mail programs show. */
export function inlineImages(html: string): { html: string; images: Array<{ cid: string; filename: string; content: Buffer; contentType: string }> } {
  const images: Array<{ cid: string; filename: string; content: Buffer; contentType: string }> = []
  const seen = new Map<string, string>()
  const out = html.replace(/(<img\b[^>]*?\bsrc=")(data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+))(")/gi, (_m, pre: string, uri: string, ext: string, b64: string, post: string) => {
    let cid = seen.get(uri)
    if (!cid) {
      cid = `sig${images.length + 1}@yanthara-bulk`
      seen.set(uri, cid)
      const type = ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase()
      images.push({ cid, filename: `signature-${images.length + 1}.${type === 'jpeg' ? 'jpg' : type}`, content: Buffer.from(b64.replace(/\s/g, ''), 'base64'), contentType: `image/${type}` })
    }
    return `${pre}cid:${cid}${post}`
  })
  return { html: out, images }
}

export type TemplateOrder = 'sequential' | 'random'

/** Which template (0-based) the email with this index gets. Random is seeded, so the review and the start agree. Pure. */
export function pickTemplate(order: TemplateOrder, count: number, index: number, seed: number): number {
  if (count <= 1) return 0
  if (order === 'sequential') return index % count
  let t = ((seed >>> 0) + Math.imul(index + 1, 0x9e3779b9)) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * count)
}
