import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { BadRequestError } from '../platform/errors.js'

// ZIP OF COMPANY-WISE PDFs (adapted from the Marketing AI Agent's Bulk Email, 2026-10-29).
//
// The user uploads ONE ZIP holding one PDF per company, each file named after
// its company ("ABC Limited.pdf"). Each recipient's email gets only the PDF
// whose name matches that recipient's company. This file reads the ZIP and
// matches files to companies; it touches no database and sends nothing.
//
// A ZIP of up to 1 GB is never held in memory: it is read through a
// "source" that returns any part of it on request (a file on disk, or a
// Buffer in tests). The directory at the end of the ZIP is read first; then
// each PDF is unpacked, checked and forgotten, one at a time, in small steps
// that let the server carry on with other requests. A scan keeps each file's
// name, size and SHA-256 but never its content: the content of a matched PDF
// is read again, and checked against the scan, only when a send starts.
//
// The ZIP is untrusted input, so it is read with hard limits and never written
// anywhere else: a ZIP is refused whole when it is not a plain ZIP, is
// encrypted, needs ZIP64, has too many entries, or would expand past a size
// cap; a single file is marked invalid when it is empty, too large, damaged
// (its size or CRC-32 does not match), not a real PDF, or has an unsafe name.
// Only PDFs are used. Nothing is guessed: a company with no matching file, or
// with several, is reported and must be fixed or excluded before anything is
// sent.

/** The ZIP itself: 1 GB (uploaded in pieces, kept on disk). */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024
/** Entries in the ZIP's directory (files, folders and junk together). */
export const MAX_ZIP_ENTRIES = 20_000
/** All PDFs of one ZIP together, unpacked — stops a small ZIP expanding into a huge one. */
export const MAX_ZIP_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024
/** The directory at the end of the ZIP (names and sizes), read in one piece. */
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024
/** One company's PDF. Same as the limit for any attachment. */
export const COMPANY_FILE_MAX_BYTES = 7 * 1024 * 1024

// No control characters, quotes, slashes or other header/path-significant characters.
// eslint-disable-next-line no-control-regex
export const NAME_RE = /^[^\x00-\x1f\x7f"\\/<>:*?|]{1,150}$/

const NOT_A_ZIP = 'This is not a ZIP file (or it is damaged). Make the ZIP again and upload it.'
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

// ── Where the bytes come from ──────────────────────────────────────────────

/** Any part of a ZIP on request. `read` returns at most `length` bytes (fewer only at the end). */
export interface ZipSource {
  size: number
  read(offset: number, length: number): Promise<Buffer>
}

/** A ZIP that is already in memory (tests, and small files). */
export const bufferSource = (buf: Buffer): ZipSource => ({
  size: buf.length,
  read: async (offset, length) => buf.subarray(offset, offset + length),
})

/** Opens a ZIP file on disk for reading, runs `fn` with it, and always closes it. */
export async function withFileSource<T>(path: string, fn: (src: ZipSource) => Promise<T>): Promise<T> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  }
  try {
    const size = (await handle.stat()).size
    return await fn({
      size,
      read: async (offset, length) => {
        const want = Math.max(0, Math.min(length, size - offset))
        const buf = Buffer.alloc(want)
        let got = 0
        while (got < want) {
          const r = await handle.read(buf, got, want - got, offset + got)
          if (r.bytesRead === 0) break
          got += r.bytesRead
        }
        return got === want ? buf : buf.subarray(0, got)
      },
    })
  } finally {
    await handle.close()
  }
}

// ── What a scan returns ────────────────────────────────────────────────────

export type ZipFileStatus = 'ok' | 'invalid' | 'unsupported'

interface DirEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

export interface ZipFile {
  /** As stored in the ZIP, folders included (forward slashes). */
  path: string
  /** The file's own name: what is attached to the email. */
  fileName: string
  /** The normalised name used to match a company. */
  key: string
  sizeBytes: number
  status: ZipFileStatus
  /** Why it cannot be used (null for a usable PDF). */
  reason: string | null
  /** SHA-256 of the unpacked PDF (a usable PDF only). Its content is read again, and checked against this, when a send starts. */
  sha256: string | null
  /** Where the file is in the ZIP (a usable PDF only), for extractFile. */
  entry: DirEntry | null
}

export interface ZipScan {
  files: ZipFile[]
  /** System files (for example __MACOSX, .DS_Store, Thumbs.db) skipped without comment; folders are not counted. */
  ignored: number
  /** Problems that concern the ZIP as a whole: duplicate or colliding names. */
  problems: string[]
}

/**
 * The name a company is matched by: letters and digits only, lower case, single
 * spaces (letters keep their accents and marks). So "ABC Ltd.", "abc  ltd" and
 * "ABC_Ltd" are the same name — and "ABC Limited" is not "ABC Ltd" (nothing is
 * guessed).
 */
export function companyFileKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
}

/** A file's matching name: its own name without the .pdf extension. */
export const fileKey = (fileName: string) => companyFileKey(fileName.replace(/\.pdf$/i, ''))

// ── The ZIP container ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

// Node's own CRC-32 (fast, native) when this Node has it; otherwise the same sum in plain code.
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32

function crc32(b: Buffer): number {
  if (nativeCrc32) return nativeCrc32(b) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return raw.toString('latin1')
  }
}

/** The directory of a ZIP: every entry's name, sizes, CRC and position. Throws BadRequestError when it is not a plain, readable ZIP. */
async function readDirectory(src: ZipSource): Promise<DirEntry[]> {
  if (src.size < 22) throw new BadRequestError(NOT_A_ZIP)
  // The end-of-directory record: the LAST one whose comment length reaches exactly the end of the file.
  const tailStart = Math.max(0, src.size - 22 - 0xffff)
  const tail = await src.read(tailStart, src.size - tailStart)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new BadRequestError(NOT_A_ZIP)
  const eocdAt = tailStart + eocd
  const disk = tail.readUInt16LE(eocd + 4)
  const dirDisk = tail.readUInt16LE(eocd + 6)
  const onDisk = tail.readUInt16LE(eocd + 8)
  const total = tail.readUInt16LE(eocd + 10)
  const dirSize = tail.readUInt32LE(eocd + 12)
  const dirOffset = tail.readUInt32LE(eocd + 16)
  if (disk !== 0 || dirDisk !== 0 || onDisk !== total) throw new BadRequestError('Multi-part ZIP files are not supported. Make a single ZIP file.')
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw new BadRequestError('ZIP64 archives are not supported. Make a normal ZIP file (it should stay under 1 GB).')
  }
  if (total === 0) throw new BadRequestError('The ZIP is empty.')
  if (total > MAX_ZIP_ENTRIES) throw new BadRequestError(`The ZIP has more than ${MAX_ZIP_ENTRIES} entries.`)
  const dirEnd = dirOffset + dirSize
  if (dirEnd > eocdAt || dirSize > MAX_DIRECTORY_BYTES) throw new BadRequestError(NOT_A_ZIP)

  const dir = await src.read(dirOffset, dirSize)
  if (dir.length !== dirSize) throw new BadRequestError(NOT_A_ZIP)
  const out: DirEntry[] = []
  let p = 0
  for (let i = 0; i < total; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new BadRequestError(NOT_A_ZIP)
    const flags = dir.readUInt16LE(p + 8)
    const method = dir.readUInt16LE(p + 10)
    const crc = dir.readUInt32LE(p + 16)
    const compressedSize = dir.readUInt32LE(p + 20)
    const size = dir.readUInt32LE(p + 24)
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    const offset = dir.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new BadRequestError('ZIP64 archives are not supported. Make a normal ZIP file (it should stay under 1 GB).')
    }
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > dir.length) throw new BadRequestError(NOT_A_ZIP)
    out.push({ name: decodeName(dir.subarray(p + 46, p + 46 + nameLen), flags), flags, method, crc, compressedSize, size, offset })
    p = next
  }
  return out
}

/** One entry's content, checked against its declared size and CRC-32. Throws Error with a short reason. */
async function unpack(src: ZipSource, e: DirEntry): Promise<Buffer> {
  // The compressed bytes can never be much larger than the file itself; a header that says otherwise is lying.
  if (e.method === 0 ? e.compressedSize !== e.size : e.compressedSize > e.size + (e.size >> 4) + 1024) throw new Error('its size is inconsistent')
  const head = await src.read(e.offset, 30)
  if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new Error('its position in the ZIP is damaged')
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  if (start + e.compressedSize > src.size) throw new Error('the ZIP is cut short')
  const data = await src.read(start, e.compressedSize)
  if (data.length !== e.compressedSize) throw new Error('the ZIP is cut short')
  // Never inflates beyond the declared size, so a lying header cannot expand into memory.
  const out = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: e.size })
  if (out.length !== e.size) throw new Error('its size does not match')
  if (crc32(out) !== e.crc) throw new Error('its content is damaged (checksum mismatch)')
  return out
}

/** Lets the server carry on with other requests between files. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve))

// ── Reading and checking the files ─────────────────────────────────────────

const isUnsafePath = (path: string) => path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')

/** Reads the ZIP and checks every file in it. Throws BadRequestError when the ZIP as a whole cannot be used. */
export async function readCompanyZip(src: ZipSource): Promise<ZipScan> {
  const entries = await readDirectory(src)
  const files: ZipFile[] = []
  let ignored = 0
  let unpacked = 0
  let lastBreath = Date.now()

  for (const e of entries) {
    if (Date.now() - lastBreath > 20) {
      await breathe()
      lastBreath = Date.now()
    }
    const path = e.name.replace(/\\/g, '/')
    if (path.endsWith('/')) continue // a folder
    const segments = path.split('/')
    const fileName = segments[segments.length - 1] ?? ''
    if (segments.includes('__MACOSX') || fileName.startsWith('._') || JUNK_NAMES.has(fileName.toLowerCase())) {
      ignored++
      continue
    }
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
    // A PDF is matched by its name without .pdf; any other file by its name without its own extension (to hint "found a .docx").
    const key = ext === 'pdf' ? fileKey(fileName) : companyFileKey(fileName.replace(/\.[^./]*$/, ''))
    const file: ZipFile = { path, fileName, key, sizeBytes: e.size, status: 'invalid', reason: null, sha256: null, entry: null }
    const reject = (status: ZipFileStatus, reason: string) => {
      files.push({ ...file, status, reason })
    }

    if (isUnsafePath(path)) {
      reject('invalid', 'its path in the ZIP is not allowed')
      continue
    }
    if (!NAME_RE.test(fileName)) {
      reject('invalid', 'its file name cannot be used (rename it: letters, digits, spaces, - _ . ( ) are fine)')
      continue
    }
    if (ext !== 'pdf') {
      reject('unsupported', ext ? `only PDF files are used (this is .${ext})` : 'only PDF files are used')
      continue
    }
    if (e.flags & 1) {
      reject('invalid', 'it is password-protected inside the ZIP')
      continue
    }
    if (e.method !== 0 && e.method !== 8) {
      reject('invalid', 'it uses a ZIP compression this tool cannot read')
      continue
    }
    if (e.size === 0) {
      reject('invalid', 'the file is empty')
      continue
    }
    if (e.size > COMPANY_FILE_MAX_BYTES) {
      reject('invalid', `it is larger than ${COMPANY_FILE_MAX_BYTES / 1024 / 1024} MB`)
      continue
    }
    unpacked += e.size
    if (unpacked > MAX_ZIP_UNPACKED_BYTES) {
      throw new BadRequestError(`The PDFs in this ZIP add up to more than ${MAX_ZIP_UNPACKED_BYTES / 1024 / 1024 / 1024} GB when unpacked. Split them into smaller ZIPs.`)
    }
    let bytes: Buffer
    try {
      bytes = await unpack(src, e)
    } catch (err) {
      reject('invalid', `it could not be unpacked — ${String((err as Error).message ?? err).slice(0, 120)}`)
      continue
    }
    if (!bytes.subarray(0, 1024).includes('%PDF-')) {
      reject('invalid', 'it is not a valid PDF file')
      continue
    }
    files.push({ ...file, status: 'ok', reason: null, sha256: createHash('sha256').update(bytes).digest('hex'), entry: e })
  }

  return { files, ignored, problems: nameProblems(files) }
}

/**
 * One usable PDF's content, read from the ZIP again and checked against its scan:
 * the same size, the same CRC-32 and the same SHA-256. If the ZIP changed since
 * the scan, this throws and the file is not used.
 */
export async function extractFile(src: ZipSource, f: ZipFile): Promise<Buffer> {
  if (f.status !== 'ok' || !f.entry || !f.sha256) throw new BadRequestError(`"${f.fileName}" cannot be used.`)
  let bytes: Buffer
  try {
    bytes = await unpack(src, f.entry)
  } catch (err) {
    throw new BadRequestError(`"${f.fileName}" could not be read from the ZIP again (${String((err as Error).message ?? err).slice(0, 100)}). Upload the ZIP again.`)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new BadRequestError(`"${f.fileName}" is not the same file the review checked. Upload the ZIP again.`)
  return bytes
}

/** The matched PDFs of one send are all kept with it (in the database): together they stay within the size of one ZIP. */
export function checkMatchedTotal(files: ZipFile[]): void {
  const total = files.reduce((n, f) => n + f.sizeBytes, 0)
  if (total > MAX_ZIP_BYTES) {
    throw new BadRequestError(`The matched PDFs add up to ${(total / 1024 / 1024 / 1024).toFixed(1)} GB; at most ${MAX_ZIP_BYTES / 1024 / 1024 / 1024} GB can go in one send. Send the list in parts.`)
  }
}

/** Duplicate file names, and different names that would match the same company. */
function nameProblems(files: ZipFile[]): string[] {
  const out: string[] = []
  const pdfs = files.filter((f) => f.status !== 'unsupported' && f.key)
  const byName = new Map<string, ZipFile[]>()
  for (const f of pdfs) byName.set(f.fileName.toLowerCase(), [...(byName.get(f.fileName.toLowerCase()) ?? []), f])
  for (const group of byName.values()) {
    if (group.length > 1) out.push(`Duplicate file name "${group[0]!.fileName}" (${group.map((f) => f.path).join(' and ')}). Keep one.`)
  }
  const byKey = new Map<string, ZipFile[]>()
  for (const f of pdfs) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f])
  for (const group of byKey.values()) {
    const names = new Set(group.map((f) => f.fileName.toLowerCase()))
    if (names.size > 1) out.push(`${[...new Set(group.map((f) => `"${f.fileName}"`))].join(' and ')} would both match the same company. Keep one.`)
  }
  return out
}

// ── A remembered scan ──────────────────────────────────────────────────────
//
// Checking a ZIP of up to 1 GB takes a while, and the screen reviews again on every change. A scan is remembered by the
// hash of the whole ZIP, so a review of an unchanged ZIP does not read it again; two reviews at once share one scan.
// (Only names, sizes and hashes are kept — never PDF content.)

const SCAN_CACHE = new Map<string, ZipScan>()
const SCAN_CACHE_MAX = 8
const SCANS_RUNNING = new Map<string, Promise<ZipScan>>()

export function rememberScan(sha256: string, scan: ZipScan): void {
  SCAN_CACHE.delete(sha256)
  SCAN_CACHE.set(sha256, scan)
  while (SCAN_CACHE.size > SCAN_CACHE_MAX) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value as string)
}

export function recallScan(sha256: string): ZipScan | undefined {
  const scan = SCAN_CACHE.get(sha256)
  if (scan) {
    SCAN_CACHE.delete(sha256)
    SCAN_CACHE.set(sha256, scan)
  }
  return scan
}

/** The scan of the ZIP with this hash: remembered, or being made right now, or made by `produce` (once). */
export function scanOnce(sha256: string, produce: () => Promise<ZipScan>): Promise<ZipScan> {
  const known = recallScan(sha256)
  if (known) return Promise.resolve(known)
  const running = SCANS_RUNNING.get(sha256)
  if (running) return running
  const p = produce()
    .then((scan) => {
      rememberScan(sha256, scan)
      return scan
    })
    .finally(() => SCANS_RUNNING.delete(sha256))
  SCANS_RUNNING.set(sha256, p)
  return p
}

/** For tests. */
export function forgetScans(): void {
  SCAN_CACHE.clear()
  SCANS_RUNNING.clear()
}

// ── Matching files to companies ────────────────────────────────────────────

export type MatchStatus = 'matched' | 'missing' | 'ambiguous' | 'invalid'

export interface CompanyMatch {
  status: MatchStatus
  /** The one file that matches (for 'matched' and 'invalid'); null otherwise. */
  file: ZipFile | null
  /** In words: why it is not matched. */
  detail: string | null
}

/**
 * For each company name, the PDF that belongs to it. A company matches only
 * when exactly one file carries its name; no file → "missing", several →
 * "ambiguous", and a file that matches more than one company of the Excel is
 * ambiguous for all of them. Never picks one of several.
 */
export function matchCompanyFiles(companyNames: string[], files: ZipFile[], eligible?: boolean[]): CompanyMatch[] {
  const pdfs = new Map<string, ZipFile[]>()
  const unsupported = new Map<string, ZipFile[]>()
  for (const f of files) {
    if (!f.key) continue
    const target = f.status === 'unsupported' ? unsupported : pdfs
    target.set(f.key, [...(target.get(f.key) ?? []), f])
  }
  const keys = companyNames.map(companyFileKey)
  // A file that matches several companies is ambiguous for them all — but only companies that can actually be emailed count
  // (one skipped for another reason, such as its Status, does not need a file).
  const companiesPerKey = new Map<string, number[]>()
  keys.forEach((k, i) => {
    if (eligible?.[i] !== false) companiesPerKey.set(k, [...(companiesPerKey.get(k) ?? []), i])
  })

  return keys.map((key, i): CompanyMatch => {
    if (!key) return { status: 'missing', file: null, detail: 'The company name has no letters or digits to match a file by.' }
    const found = pdfs.get(key) ?? []
    if (found.length === 0) {
      const other = unsupported.get(key)?.[0]
      return { status: 'missing', file: null, detail: other ? `Found "${other.fileName}", but only PDF files are used.` : 'No PDF in the ZIP is named after this company.' }
    }
    if (found.length > 1) {
      return { status: 'ambiguous', file: null, detail: `Several files match: ${found.map((f) => `"${f.path}"`).join(', ')}. Keep only one.` }
    }
    const same = companiesPerKey.get(key) ?? []
    if (same.length > 1) {
      const others = same.filter((j) => j !== i).map((j) => `"${companyNames[j]}"`)
      return { status: 'ambiguous', file: null, detail: `"${found[0]!.fileName}" matches more than one company in your Excel (also ${others.join(', ')}).` }
    }
    const f = found[0]!
    return f.status === 'ok' ? { status: 'matched', file: f, detail: null } : { status: 'invalid', file: f, detail: `"${f.fileName}" cannot be used: ${f.reason}.` }
  })
}
