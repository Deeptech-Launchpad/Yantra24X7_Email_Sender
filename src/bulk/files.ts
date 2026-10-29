import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../config/env.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import type { Principal } from '../auth/users.js'
import { COMPANY_FILE_MAX_BYTES, MAX_ZIP_BYTES, NAME_RE, readCompanyZip, scanOnce, withFileSource, type ZipFile, type ZipScan, type ZipSource } from './companyZip.js'
import { MAX_UPLOAD_BYTES } from './excel.js'

// FILES: the uploaded Excel, the attachments that go on every email ("common"), the
// ZIP of company-wise PDFs and each company's own PDF. (Adapted from the Marketing AI
// Agent's Bulk Email, 2026-10-29.)
//
// Every file is kept on disk under DATA_DIR (never in the database, never all in memory)
// with a row that holds its name, size and SHA-256. A file is "staged" until a campaign
// starts with it; then it is tied to the campaign and kept with it, so every email carries
// exactly what was approved. Before a file is attached, its content is checked against its
// SHA-256 again. Staged files belong to the person who uploaded them (admins may use any).

export const MAX_COMMON_FILES = 5
/** One attachment. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** All attachments of one email together (the common files and the company PDF). Gmail's limit is 25 MB after encoding. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024
/** One piece of a ZIP upload. */
export const ZIP_CHUNK_BYTES = 16 * 1024 * 1024
const STAGED_KEEP_MS = 24 * 60 * 60 * 1000
/** ZIPs waiting to be used, all users together. */
const MAX_STAGED_ZIP_TOTAL_BYTES = 2 * MAX_ZIP_BYTES
/** Free disk space that must remain after a ZIP is stored. */
const DISK_MARGIN_BYTES = 5 * 1024 * 1024 * 1024
const ORPHAN_KEEP_MS = 36 * 60 * 60 * 1000
const UPLOAD_IDLE_MS = 60 * 60 * 1000

const BLOCKED = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp', 'dll', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'reg', 'lnk', 'hta', 'cpl', 'app', 'apk', 'sh', 'bin', 'iso', 'dmg', 'html', 'htm', 'svg',
])
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
}

export interface FileInfo {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

/** One file as it travels with an email. */
export interface AttachmentFile {
  filename: string
  contentType: string
  content: Buffer
}

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const info = (r: { id: string; fileName: string; mimeType: string; sizeBytes: number }): FileInfo => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes })

const filesDir = () => path.join(dataDir(), 'files')
const zipDir = () => path.join(dataDir(), 'zips')
/** The id is checked, so a path can never point outside the folder. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new NotFoundError('File not found.')
  return id
}
const filePath = (id: string) => path.join(filesDir(), safeId(id))
const zipPath = (id: string) => path.join(zipDir(), `${safeId(id)}.zip`)
const rmFile = (p: string) => rm(p, { force: true }).catch(() => undefined)

function checkName(fileName: string): string {
  const name = String(fileName ?? '').trim()
  if (!NAME_RE.test(name) || name === '.' || name === '..') throw new BadRequestError('This file name cannot be used. Rename the file (letters, digits, spaces, - _ . ( ) are fine) and upload it again.')
  return name
}

/** Validates an attachment. Pure; throws a sentence a person can act on. */
export function checkAttachment(fileName: string, bytes: Buffer) {
  const name = checkName(fileName)
  const ext = extOf(name)
  if (BLOCKED.has(ext)) throw new BadRequestError(`.${ext} files cannot be attached (programs, scripts and web pages are blocked).`)
  if (bytes.length === 0) throw new BadRequestError('The file is empty.')
  if (bytes.length > MAX_FILE_BYTES) throw new BadRequestError(`"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  return { fileName: name, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
}

async function writeNew(kind: 'excel' | 'common' | 'company_file', user: Principal, campaignId: string | null, fileName: string, mimeType: string, bytes: Buffer, position = 0) {
  await mkdir(filesDir(), { recursive: true, mode: 0o700 })
  const id = newId()
  await writeFile(filePath(id), bytes, { flag: 'wx', mode: 0o600 })
  try {
    return await prisma.storedFile.create({ data: { id, kind, campaignId, position, fileName, mimeType, sizeBytes: bytes.length, sha256: sha256(bytes), createdByUserId: user.id } })
  } catch (err) {
    await rmFile(filePath(id))
    throw err
  }
}

/** Removes staged files (Excel and attachments) nobody used for a day, and their content. */
async function sweepStaged(now: Date) {
  const old = await prisma.storedFile.findMany({ where: { campaignId: null, kind: { in: ['excel', 'common', 'company_file'] }, createdAt: { lt: new Date(now.getTime() - STAGED_KEEP_MS) } }, select: { id: true } })
  for (const r of old) await rmFile(filePath(r.id))
  if (old.length) await prisma.storedFile.deleteMany({ where: { id: { in: old.map((r) => r.id) }, campaignId: null } })
}

/** Stores an uploaded Excel file (.xlsx) until a campaign is started from it. */
export async function storeExcel(user: Principal, fileName: string, bytes: Buffer, now = new Date()): Promise<FileInfo> {
  const name = checkName(fileName)
  if (!/\.xlsx$/i.test(name)) throw new BadRequestError('Upload an Excel workbook (.xlsx). In Excel: File → Save As → Excel Workbook.')
  if (!bytes.length) throw new BadRequestError('The file is empty.')
  if (bytes.length > MAX_UPLOAD_BYTES) throw new BadRequestError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new BadRequestError('This is not an .xlsx file. In Excel, use File → Save As → Excel Workbook (.xlsx).')
  await sweepStaged(now)
  return info(await writeNew('excel', user, null, name, MIME_BY_EXT.xlsx!, bytes))
}

/** Stores one attachment that will go on every email of a campaign. */
export async function storeCommon(user: Principal, fileName: string, bytes: Buffer, now = new Date()): Promise<FileInfo> {
  const f = checkAttachment(fileName, bytes)
  await sweepStaged(now)
  return info(await writeNew('common', user, null, f.fileName, f.mimeType, bytes))
}

async function ownStaged(user: Principal, id: string, kinds: string[]) {
  const row = await prisma.storedFile.findFirst({ where: { id: safeId(id), campaignId: null, kind: { in: kinds } } })
  if (!row) return null
  if (row.createdByUserId !== user.id && user.role !== 'admin') throw new ForbiddenError('This file was uploaded by someone else.')
  return row
}

/** A staged file's content, checked against its SHA-256. */
export async function readStaged(user: Principal, id: string, kind: 'excel' | 'common'): Promise<{ info: FileInfo; bytes: Buffer }> {
  const row = await ownStaged(user, id, [kind])
  if (!row) throw new BadRequestError(kind === 'excel' ? 'The Excel file is no longer available. Upload it again.' : 'An attachment is no longer available. Remove it and upload it again.')
  const bytes = await readFile(filePath(row.id)).catch(() => null)
  if (!bytes || sha256(bytes) !== row.sha256) throw new BadRequestError(`"${row.fileName}" can no longer be read. Upload it again.`)
  return { info: info(row), bytes }
}

/** The staged attachments a review or start names, in the order given — checked against every limit. */
export async function stagedCommon(user: Principal, ids: string[] | undefined): Promise<FileInfo[]> {
  const list = ids ?? []
  if (!list.length) return []
  if (new Set(list).size !== list.length) throw new BadRequestError('The same attachment is listed twice.')
  if (list.length > MAX_COMMON_FILES) throw new BadRequestError(`At most ${MAX_COMMON_FILES} attachments.`)
  const out: FileInfo[] = []
  for (const id of list) {
    const row = await ownStaged(user, id, ['common'])
    if (!row) throw new BadRequestError('An attachment is no longer available. Remove it and upload it again.')
    out.push(info(row))
  }
  if (out.reduce((n, f) => n + f.sizeBytes, 0) > MAX_EMAIL_ATTACHMENT_BYTES) throw new BadRequestError(`The attachments are larger than ${MAX_EMAIL_ATTACHMENT_BYTES / 1024 / 1024} MB together.`)
  return out
}

/** Removes a staged file (one already tied to a campaign stays with it). */
export async function removeStaged(user: Principal, id: string): Promise<{ id: string; removed: true }> {
  const row = await ownStaged(user, id, ['excel', 'common', 'company_zip'])
  if (!row) throw new NotFoundError('File not found.')
  if (row.kind === 'company_zip') {
    return locked(row.id, async () => {
      await prisma.storedFile.deleteMany({ where: { id: row.id, campaignId: null } })
      await rmFile(zipPath(row.id))
      return { id: row.id, removed: true as const }
    })
  }
  await prisma.storedFile.deleteMany({ where: { id: row.id, campaignId: null } })
  await rmFile(filePath(row.id))
  return { id: row.id, removed: true }
}

/** Ties staged files to a campaign that has just been created; every one must still be staged. */
export async function linkFiles(ids: string[], campaignId: string): Promise<void> {
  for (const [position, id] of ids.entries()) {
    const r = await prisma.storedFile.updateMany({ where: { id, campaignId: null, kind: { in: ['common', 'company_file', 'excel'] } }, data: { campaignId, position } })
    if (r.count !== 1) throw new ConflictError('A file is no longer available. Nothing was sent; upload it again and start again.')
  }
}

/** A campaign's file as it travels with an email; null when it is missing or its content changed. */
async function campaignFile(row: { id: string; fileName: string; mimeType: string; sha256: string }): Promise<AttachmentFile | null> {
  const bytes = await readFile(filePath(row.id)).catch(() => null)
  if (!bytes || sha256(bytes) !== row.sha256) return null
  return { filename: row.fileName, contentType: row.mimeType, content: bytes }
}

/** The common attachments of a campaign, in order; null when any of them is missing or changed. */
export async function campaignCommonFiles(campaignId: string): Promise<AttachmentFile[] | null> {
  const rows = await prisma.storedFile.findMany({ where: { campaignId, kind: 'common' }, orderBy: { position: 'asc' } })
  const out: AttachmentFile[] = []
  for (const r of rows) {
    const f = await campaignFile(r)
    if (!f) return null
    out.push(f)
  }
  return out
}

/** One recipient's own company PDF; null when it is missing or changed. */
export async function companyFileForSend(campaignId: string, id: string): Promise<AttachmentFile | null> {
  const row = await prisma.storedFile.findFirst({ where: { id, campaignId, kind: 'company_file' } })
  return row ? campaignFile(row) : null
}

export async function campaignFileInfos(campaignId: string) {
  const rows = await prisma.storedFile.findMany({ where: { campaignId }, orderBy: [{ kind: 'asc' }, { position: 'asc' }] })
  return {
    common: rows.filter((r) => r.kind === 'common').map(info),
    companyFiles: new Map(rows.filter((r) => r.kind === 'company_file').map((r) => [r.id, info(r)])),
  }
}

// ── ZIP of company-wise PDFs (up to 1 GB, uploaded in pieces) ─────────────
//
// start → the name and size (checked, and the free disk space); chunk → the next piece at the offset where the
// server's copy ends (a piece already received, or one that skips ahead, is answered 409 with the real count);
// finish → the whole file is hashed and read as a ZIP, and refused (and removed) when it is not usable.

export interface StagedZip {
  id: string
  fileName: string
  sizeBytes: number
}

/** Pieces of one upload are taken one at a time. The stored tail never rejects (an unhandled rejection would stop the server). */
const LOCKS = new Map<string, Promise<void>>()
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (LOCKS.get(id) ?? Promise.resolve()).then(fn)
  const tail: Promise<void> = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (LOCKS.get(id) === tail) LOCKS.delete(id)
    })
  LOCKS.set(id, tail)
  return run
}

/** Removes ZIPs nobody will use: staged more than a day, uploads quiet for an hour, and old files of ours no row points at. */
async function sweepZips(now: Date): Promise<void> {
  try {
    const rows = await prisma.storedFile.findMany({ where: { campaignId: null, kind: 'company_zip' }, select: { id: true, sha256: true, createdAt: true } })
    const live = new Set<string>()
    const gone: string[] = []
    for (const r of rows) {
      const st = await stat(zipPath(r.id)).catch(() => null)
      const old = now.getTime() - r.createdAt.getTime() > STAGED_KEEP_MS
      const abandoned = r.sha256 === '' && (!st || now.getTime() - st.mtimeMs > UPLOAD_IDLE_MS)
      if (old || abandoned) {
        gone.push(r.id)
        await rmFile(zipPath(r.id))
      } else live.add(r.id)
    }
    if (gone.length) await prisma.storedFile.deleteMany({ where: { id: { in: gone }, campaignId: null, kind: 'company_zip' } })
    for (const name of await readdir(zipDir()).catch(() => [] as string[])) {
      const mine = /^([A-Za-z0-9_-]{1,64})\.zip$/.exec(name)
      if (!mine || live.has(mine[1]!)) continue
      const st = await stat(path.join(zipDir(), name)).catch(() => null)
      if (st && now.getTime() - st.mtimeMs > ORPHAN_KEEP_MS) await rmFile(path.join(zipDir(), name))
    }
  } catch {
    // Clearing old files must never stop a new upload.
  }
}

export async function startZipUpload(user: Principal, input: { fileName: string; sizeBytes: number }, now = new Date()): Promise<StagedZip & { chunkBytes: number }> {
  const fileName = checkName(input.fileName)
  if (!/\.zip$/i.test(fileName)) throw new BadRequestError('Upload a file whose name ends in .zip.')
  const sizeBytes = Number(input.sizeBytes)
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new BadRequestError('The ZIP is empty.')
  if (sizeBytes > MAX_ZIP_BYTES) throw new BadRequestError(`The ZIP is larger than ${MAX_ZIP_BYTES / 1024 / 1024 / 1024} GB. Split the PDFs into two ZIPs and send them in two campaigns.`)
  await sweepZips(now)
  const staged = await prisma.storedFile.findMany({ where: { campaignId: null, kind: 'company_zip' }, select: { sizeBytes: true } })
  if (staged.reduce((n, r) => n + r.sizeBytes, 0) + sizeBytes > MAX_STAGED_ZIP_TOTAL_BYTES) {
    throw new ConflictError('Too many ZIP files are waiting to be used. Remove an earlier ZIP (or start its campaign) and try again.')
  }
  await mkdir(zipDir(), { recursive: true, mode: 0o700 })
  const free = await statfs(zipDir()).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => Number.POSITIVE_INFINITY)
  if (free < sizeBytes + DISK_MARGIN_BYTES) throw new ConflictError('The server does not have enough free disk space for this ZIP. Ask an administrator.')
  const id = newId()
  await writeFile(zipPath(id), Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
  try {
    await prisma.storedFile.create({ data: { id, kind: 'company_zip', campaignId: null, fileName, mimeType: 'application/zip', sizeBytes, sha256: '', createdByUserId: user.id } })
  } catch (err) {
    await rmFile(zipPath(id))
    throw err
  }
  return { id, fileName, sizeBytes, chunkBytes: ZIP_CHUNK_BYTES }
}

async function pendingZip(user: Principal, id: string) {
  const row = await ownStaged(user, id, ['company_zip'])
  if (!row) throw new NotFoundError('Upload not found. Choose the ZIP again.')
  return row
}

export function appendZipChunk(user: Principal, id: string, offset: number, bytes: Buffer): Promise<{ receivedBytes: number }> {
  return locked(safeId(id), async () => {
    const row = await pendingZip(user, id)
    if (row.sha256 !== '') throw new ConflictError('This ZIP is already complete.', { receivedBytes: row.sizeBytes })
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestError('The position of this piece is missing.')
    if (!bytes.length) throw new BadRequestError('This piece is empty.')
    const have = (await stat(zipPath(id)).catch(() => null))?.size
    if (have === undefined) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    if (offset !== have) throw new ConflictError(`The server has ${have} bytes of this ZIP; continue from there.`, { receivedBytes: have })
    if (have + bytes.length > row.sizeBytes) throw new BadRequestError('More data arrived than the size of the ZIP.')
    // Written into the file that must already exist: a removed upload is never recreated.
    const handle = await open(zipPath(id), 'r+').catch(() => null)
    if (!handle) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    try {
      let written = 0
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, have + written)).bytesWritten
    } finally {
      await handle.close()
    }
    return { receivedBytes: have + bytes.length }
  })
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const part of createReadStream(file)) h.update(part as Buffer)
  return h.digest('hex')
}

export function scanStagedZip(zip: { id: string; sha256: string }): Promise<ZipScan> {
  return scanOnce(zip.sha256, () => withFileSource(zipPath(zip.id), readCompanyZip))
}

export function finishZipUpload(user: Principal, id: string): Promise<StagedZip> {
  return locked(safeId(id), async () => {
    const row = await pendingZip(user, id)
    if (row.sha256 !== '') return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes }
    const have = (await stat(zipPath(id)).catch(() => null))?.size
    if (have === undefined) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    if (have !== row.sizeBytes) throw new ConflictError(`Only ${have} of ${row.sizeBytes} bytes arrived. Continue the upload.`, { receivedBytes: have })
    let digest: string
    try {
      digest = await hashFile(zipPath(id))
      const scan = await scanOnce(digest, () => withFileSource(zipPath(id), readCompanyZip))
      if (!scan.files.some((f) => f.status === 'ok')) {
        const why = scan.files.slice(0, 3).map((f) => `${f.fileName}: ${f.reason}`).join('; ')
        throw new BadRequestError(`The ZIP has no usable PDF files${why ? ` (${why})` : ''}. It should hold one PDF per company, named after the company.`)
      }
    } catch (err) {
      // Only a ZIP that is itself unusable is thrown away; a server hiccup keeps the upload so finishing can be repeated.
      if (err instanceof BadRequestError) {
        await rmFile(zipPath(id))
        await prisma.storedFile.deleteMany({ where: { id, campaignId: null, kind: 'company_zip' } })
      } else if ((err as { code?: string })?.code === 'ENOENT') {
        throw new NotFoundError('Upload not found. Choose the ZIP again.')
      }
      throw err
    }
    await prisma.storedFile.updateMany({ where: { id, campaignId: null, kind: 'company_zip' }, data: { sha256: digest } })
    return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes }
  })
}

/** Stages a complete ZIP that is already in memory (the same steps as an upload in pieces). */
export async function stageZip(user: Principal, fileName: string, bytes: Buffer, now = new Date()): Promise<StagedZip> {
  const { id, chunkBytes } = await startZipUpload(user, { fileName, sizeBytes: bytes.length }, now)
  try {
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await appendZipChunk(user, id, offset, bytes.subarray(offset, offset + chunkBytes))
    return await finishZipUpload(user, id)
  } catch (err) {
    await removeStaged(user, id).catch(() => undefined)
    throw err
  }
}

/** A completed staged ZIP: name, size and the hash of its content. */
export async function stagedZipInfo(user: Principal, id: string): Promise<StagedZip & { sha256: string }> {
  const row = await ownStaged(user, id, ['company_zip'])
  if (!row || row.sha256 === '') throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 }
}

export const withStagedZip = <T>(id: string, fn: (src: ZipSource) => Promise<T>) => withFileSource(zipPath(id), fn)

export async function dropStagedZip(id: string): Promise<void> {
  await prisma.storedFile.deleteMany({ where: { id, campaignId: null, kind: 'company_zip' } })
  await rmFile(zipPath(id))
}

/** Keeps one company's PDF (checked against the review's scan), not yet tied to a campaign. */
export async function storeCompanyFile(user: Principal, f: ZipFile, bytes: Buffer): Promise<string> {
  if (f.status !== 'ok' || !f.sha256 || sha256(bytes) !== f.sha256 || bytes.length > COMPANY_FILE_MAX_BYTES) throw new BadRequestError(`"${f.fileName}" cannot be used.`)
  const row = await writeNew('company_file', user, null, f.fileName, 'application/pdf', bytes)
  return row.id
}

/** Removes stored company PDFs (and their content) of a campaign that did not start. */
export async function discardFiles(ids: string[]): Promise<void> {
  if (!ids.length) return
  for (const id of ids) await rmFile(filePath(id))
  await prisma.storedFile.deleteMany({ where: { id: { in: ids }, campaignId: null } })
}

/** Removes every file kept with a campaign (when it is cancelled before anything is scheduled). */
export async function discardCampaignFiles(campaignId: string): Promise<void> {
  const rows = await prisma.storedFile.findMany({ where: { campaignId }, select: { id: true } })
  for (const r of rows) await rmFile(filePath(r.id))
  await prisma.storedFile.deleteMany({ where: { campaignId } })
}
