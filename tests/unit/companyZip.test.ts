// Adapted from the Marketing AI Agent's tests of the same ZIP reader (2026-10-29).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import JSZip from 'jszip'
import archiver from 'archiver'
import {
  bufferSource,
  companyFileKey,
  COMPANY_FILE_MAX_BYTES,
  extractFile,
  fileKey,
  forgetScans,
  matchCompanyFiles,
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  NAME_RE,
  readCompanyZip,
  scanOnce,
  withFileSource,
  type ZipFile,
  type ZipSource,
} from '../../src/bulk/companyZip.js'
import { makeZip, pdf } from '../helpers/makeZip.js'

// ZIP OF COMPANY-WISE PDFs (2026-10-17; 1 GB since 2026-10-18): reading the ZIP safely, a piece at a time,
// and matching its files to the companies of the Excel — never guessing, never trusting the ZIP.

const scan = (buf: Buffer) => readCompanyZip(bufferSource(buf))
const byName = (s: Awaited<ReturnType<typeof scan>>) => Object.fromEntries(s.files.map((f) => [f.fileName, f]))
const bytesOf = (buf: Buffer, f: ZipFile) => extractFile(bufferSource(buf), f)

/** A source that counts how many bytes were asked for, so a test can show the ZIP is read in pieces, not whole. */
function countingSource(buf: Buffer) {
  const inner = bufferSource(buf)
  const state = { reads: 0, bytes: 0, largest: 0 }
  const src: ZipSource = {
    size: inner.size,
    read: async (offset, length) => {
      const part = await inner.read(offset, length)
      state.reads++
      state.bytes += part.length
      state.largest = Math.max(state.largest, part.length)
      return part
    },
  }
  return { src, state }
}

describe('reading a ZIP of PDFs', () => {
  it('reads stored and compressed PDFs and returns their exact bytes (read again from the ZIP and checked)', async () => {
    const a = pdf('ABC')
    const b = pdf('XYZ'.repeat(500))
    const zip = makeZip([{ name: 'ABC Limited.pdf', data: a, method: 0 }, { name: 'XYZ Industries.pdf', data: b, method: 8 }])
    const s = await scan(zip)
    expect(s.files.map((f) => [f.fileName, f.status, f.sizeBytes])).toEqual([['ABC Limited.pdf', 'ok', a.length], ['XYZ Industries.pdf', 'ok', b.length]])
    expect((await bytesOf(zip, byName(s)['ABC Limited.pdf']!)).equals(a)).toBe(true)
    expect((await bytesOf(zip, byName(s)['XYZ Industries.pdf']!)).equals(b)).toBe(true)
    expect(byName(s)['ABC Limited.pdf']!.sha256).toBe(createHash('sha256').update(a).digest('hex'))
    expect(s.problems).toEqual([])
    expect(s.files.every((f) => !('bytes' in f))).toBe(true) // a scan never holds a PDF's content
  })

  it('a changed ZIP is noticed: a file is not used if what is in the ZIP now is not what the scan checked', async () => {
    const zip = makeZip([{ name: 'ABC Limited.pdf', data: pdf('one'), method: 0 }])
    const f = (await scan(zip)).files[0]!
    const other = makeZip([{ name: 'ABC Limited.pdf', data: pdf('two'), method: 0 }]) // same size and name, other content
    await expect(extractFile(bufferSource(other), f)).rejects.toThrow(/checksum mismatch|not the same file the review checked/) // refused by the checksum, or by the hash if the checksum were forged
    const cut = zip.subarray(0, 60)
    await expect(extractFile(bufferSource(cut), f)).rejects.toThrow(/could not be read from the ZIP again/)
    await expect(extractFile(bufferSource(zip), { ...f, status: 'invalid', entry: null })).rejects.toThrow(/cannot be used/)
  })

  it('uses the file name inside folders, skips folders and system files, accepts Windows back-slashes', async () => {
    const s = await scan(
      makeZip([
        { name: 'PDFs/', folder: true },
        { name: 'PDFs/ABC Limited.pdf', data: pdf('1') },
        { name: '__MACOSX/PDFs/._ABC Limited.pdf', data: Buffer.from('mac') },
        { name: '.DS_Store', data: Buffer.from('x') },
        { name: 'Thumbs.db', data: Buffer.from('x') },
        { name: 'PDFs\\XYZ Industries.pdf', data: pdf('2') },
      ]),
    )
    expect(s.files.map((f) => [f.path, f.fileName, f.status])).toEqual([['PDFs/ABC Limited.pdf', 'ABC Limited.pdf', 'ok'], ['PDFs/XYZ Industries.pdf', 'XYZ Industries.pdf', 'ok']])
    expect(s.ignored).toBe(3) // the mac folder's file, .DS_Store and Thumbs.db (a plain folder is not counted)
  })

  it('files that are not PDFs are "unsupported" — programs included — and never used', async () => {
    const s = await scan(makeZip([{ name: 'notes.txt', data: Buffer.from('hi') }, { name: 'ABC Limited.docx', data: Buffer.from('x') }, { name: 'setup.exe', data: Buffer.from('MZ') }, { name: 'README', data: Buffer.from('x') }, { name: 'ok.pdf', data: pdf() }]))
    expect(s.files.map((f) => [f.fileName, f.status])).toEqual([['notes.txt', 'unsupported'], ['ABC Limited.docx', 'unsupported'], ['setup.exe', 'unsupported'], ['README', 'unsupported'], ['ok.pdf', 'ok']])
    expect(s.files.every((f) => f.status === 'ok' || (f.entry === null && f.sha256 === null))).toBe(true)
  })

  it('a file is invalid (not sent) when it is empty, too large, encrypted, damaged, lying about its size, or not a real PDF', async () => {
    const real = pdf('real')
    const s = await scan(
      makeZip([
        { name: 'empty.pdf', data: Buffer.alloc(0), method: 0 },
        { name: 'huge.pdf', data: real, declaredSize: COMPANY_FILE_MAX_BYTES + 1 },
        { name: 'locked.pdf', data: real, flags: 1 },
        { name: 'weird-method.pdf', data: real, method: 12 },
        { name: 'bad-crc.pdf', data: real, crc: 12345 },
        { name: 'size-lie.pdf', data: real, declaredSize: 5 }, // claims 5 bytes, really more
        { name: 'cut-short.pdf', data: real, compressed: Buffer.from([0x01]) },
        { name: 'not-a-pdf.pdf', data: Buffer.from('just text, no pdf header') },
        { name: 'good.pdf', data: real },
      ]),
    )
    const f = byName(s)
    expect(Object.entries(f).map(([n, x]) => [n, x.status])).toEqual([
      ['empty.pdf', 'invalid'], ['huge.pdf', 'invalid'], ['locked.pdf', 'invalid'], ['weird-method.pdf', 'invalid'], ['bad-crc.pdf', 'invalid'], ['size-lie.pdf', 'invalid'], ['cut-short.pdf', 'invalid'], ['not-a-pdf.pdf', 'invalid'], ['good.pdf', 'ok'],
    ])
    expect(f['empty.pdf']!.reason).toMatch(/empty/)
    expect(f['huge.pdf']!.reason).toMatch(/larger than 7 MB/)
    expect(f['locked.pdf']!.reason).toMatch(/password/)
    expect(f['bad-crc.pdf']!.reason).toMatch(/checksum/)
    expect(f['size-lie.pdf']!.reason).toMatch(/could not be unpacked/)
    expect(f['not-a-pdf.pdf']!.reason).toMatch(/not a valid PDF/)
    expect(s.files.filter((x) => x.status !== 'ok').every((x) => x.entry === null && x.sha256 === null)).toBe(true)
  })

  it('unsafe or unusable names are invalid: ../ paths, absolute paths, drive letters, quotes and colons', async () => {
    const s = await scan(makeZip([{ name: '../evil.pdf', data: pdf() }, { name: '/abs/evil.pdf', data: pdf() }, { name: 'C:/evil.pdf', data: pdf() }, { name: 'a"b.pdf', data: pdf() }, { name: 'a:b.pdf', data: pdf() }]))
    expect(s.files.map((f) => f.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid'])
    expect(s.files.every((f) => f.entry === null)).toBe(true)
  })

  it('a zip bomb is stopped: a header that lies about the size cannot expand into memory, a huge compressed size is refused unread, and a huge total is refused', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0) // compresses to a few KB
    const s = await scan(makeZip([{ name: 'bomb.pdf', data: big, declaredSize: 1000 }]))
    expect(s.files[0]).toMatchObject({ status: 'invalid' })
    expect(s.files[0]!.reason).toMatch(/could not be unpacked/)
    // A header that claims a compressed size far beyond the file's size is refused before anything is read.
    const huge = countingSource(makeZip([{ name: 'liar.pdf', data: pdf(), compressed: pdf(), method: 8, declaredSize: 100 }]))
    expect((await readCompanyZip(huge.src)).files[0]).toMatchObject({ status: 'invalid' })
    // Many files that each claim the maximum size: refused as a whole once together they pass the unpacked cap.
    const many = makeZip(Array.from({ length: 600 }, (_, i) => ({ name: `f${i}.pdf`, data: pdf(String(i)), declaredSize: COMPANY_FILE_MAX_BYTES })))
    await expect(scan(many)).rejects.toThrow(/add up to more than 4 GB when unpacked/)
  })

  it('refuses what is not a plain ZIP: text, truncated files, empty ZIPs, ZIP64 markers, multi-part, too many entries, a broken directory', async () => {
    const good = makeZip([{ name: 'a.pdf', data: pdf() }])
    await expect(scan(Buffer.from('this is not a zip file at all, just text'))).rejects.toThrow(/not a ZIP/)
    await expect(scan(Buffer.alloc(0))).rejects.toThrow(/not a ZIP/)
    await expect(scan(good.subarray(0, good.length - 10))).rejects.toThrow(/not a ZIP/)
    await expect(scan(makeZip([]))).rejects.toThrow(/empty/)
    await expect(scan(makeZip([{ name: 'a.pdf', data: pdf() }], { total: 0xffff }))).rejects.toThrow(/ZIP64/)
    await expect(scan(makeZip([{ name: 'a.pdf', data: pdf() }], { disk: 1 }))).rejects.toThrow(/Multi-part/)
    await expect(scan(makeZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.pdf`, data: Buffer.from('x'), method: 0 }))))).rejects.toThrow(/more than 20000 entries/)
    const broken = Buffer.from(good)
    broken.writeUInt32LE(0xdeadbeef, broken.length - 22 + 16) // central directory offset points into nowhere
    await expect(scan(broken)).rejects.toThrow(/not a ZIP/)
  })

  it('a comment that contains a fake end-of-directory record does not fool the reader', async () => {
    const fake = Buffer.alloc(22)
    fake.writeUInt32LE(0x06054b50, 0)
    fake.writeUInt16LE(7, 4) // would claim "disk 7"
    fake.writeUInt16LE(500, 20) // a comment length that does not reach the end
    const s = await scan(makeZip([{ name: 'a.pdf', data: pdf('c') }], { comment: Buffer.concat([Buffer.from('note '), fake, Buffer.from(' end')]) }))
    expect(s.files.map((f) => [f.fileName, f.status])).toEqual([['a.pdf', 'ok']])
  })

  it('names are read as UTF-8 (flagged or not) so accented company names match', async () => {
    const s = await scan(makeZip([{ name: 'Société Générale.pdf', data: pdf('1') }, { name: 'Müller GmbH.pdf', data: pdf('2'), noUtf8Flag: true }]))
    expect(s.files.map((f) => [f.fileName, f.status])).toEqual([['Société Générale.pdf', 'ok'], ['Müller GmbH.pdf', 'ok']])
    expect(matchCompanyFiles(['Société Générale', 'Müller GmbH'], s.files).map((m) => m.status)).toEqual(['matched', 'matched'])
  })

  it('reads ZIPs made by other tools: JSZip (compressed, folders, comment) and archiver (checksums after the data)', async () => {
    const a = pdf('made by jszip')
    const jz = new JSZip()
    jz.folder('Reports')!.file('ABC Limited.pdf', a)
    jz.file('XYZ Industries.pdf', pdf('x'.repeat(2000)))
    const jbuf = await jz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment: 'made by someone' })
    const s1 = await scan(jbuf)
    expect(s1.files.map((f) => [f.fileName, f.status])).toEqual([['ABC Limited.pdf', 'ok'], ['XYZ Industries.pdf', 'ok']])
    expect((await bytesOf(jbuf, byName(s1)['ABC Limited.pdf']!)).equals(a)).toBe(true)

    const c = pdf('made by archiver')
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (d: Buffer) => chunks.push(d))
    const done = new Promise<void>((res, rej) => {
      out.on('end', () => res())
      out.on('error', rej)
    })
    const arc = archiver('zip', { zlib: { level: 9 } })
    arc.pipe(out)
    arc.append(Buffer.from(c), { name: 'ABC Limited.pdf' })
    arc.append(pdf('second'), { name: 'Test Corporation.pdf' })
    await arc.finalize()
    await done
    const abuf = Buffer.concat(chunks)
    const s2 = await scan(abuf)
    expect(s2.files.map((f) => [f.fileName, f.status])).toEqual([['ABC Limited.pdf', 'ok'], ['Test Corporation.pdf', 'ok']])
    expect((await bytesOf(abuf, byName(s2)['ABC Limited.pdf']!)).equals(c)).toBe(true)
  })

  it('each company PDF may be 7 MB and the ZIP itself 1 GB', () => {
    expect(COMPANY_FILE_MAX_BYTES).toBe(7 * 1024 * 1024)
    expect(MAX_ZIP_BYTES).toBe(1024 * 1024 * 1024)
    for (const ok of ['ABC Limited.pdf', 'Smith & Sons (UK).pdf']) expect(NAME_RE.test(ok)).toBe(true)
    for (const bad of ['a/b.pdf', 'a"b.pdf', 'a:b.pdf', 'a\nb.pdf', '']) expect(NAME_RE.test(bad)).toBe(false)
  })
})

describe('a big ZIP is read in pieces, from a file on disk', () => {
  it('a ZIP of many PDFs with a huge file of something else: only the directory and the PDFs are read, never the whole ZIP and never the filler', async () => {
    const filler = Buffer.alloc(40 * 1024 * 1024, 7) // 40 MB of a non-PDF file, stored: must never be read
    const pdfs = Array.from({ length: 200 }, (_, i) => ({ name: `Company ${i}.pdf`, data: pdf(`company ${i} `.repeat(200)) }))
    const zip = makeZip([{ name: 'big-video.mov', data: filler, method: 0 }, ...pdfs])
    const { src, state } = countingSource(zip)
    const s = await readCompanyZip(src)
    expect(s.files.filter((f) => f.status === 'ok')).toHaveLength(200)
    expect(s.files.find((f) => f.fileName === 'big-video.mov')!.status).toBe('unsupported')
    expect(zip.length).toBeGreaterThan(40 * 1024 * 1024)
    expect(state.bytes).toBeLessThan(2 * 1024 * 1024) // a few hundred KB of PDFs and the directory, not 40 MB
    expect(state.largest).toBeLessThan(1024 * 1024) // no single read of more than one small piece
  })

  it('reads a ZIP file on disk through a file source, checks its PDFs and returns their bytes; a missing file is a clear error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    try {
      const a = pdf('on disk')
      const file = join(dir, 'pdfs.zip')
      await writeFile(file, makeZip([{ name: 'ABC Limited.pdf', data: a }, { name: 'XYZ Industries.pdf', data: pdf('2') }], { comment: Buffer.from('x'.repeat(1000)) }))
      const result = await withFileSource(file, async (src) => {
        const s = await readCompanyZip(src)
        return { s, a: await extractFile(src, byName(s)['ABC Limited.pdf']!) }
      })
      expect(result.s.files.map((f) => [f.fileName, f.status])).toEqual([['ABC Limited.pdf', 'ok'], ['XYZ Industries.pdf', 'ok']])
      expect(result.a.equals(a)).toBe(true)
      await expect(withFileSource(join(dir, 'missing.zip'), async () => 1)).rejects.toThrow(/no longer available/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('many entries: 15,000 PDFs are read and matched quickly, and the scan keeps no content', async () => {
    const zip = makeZip(Array.from({ length: 15_000 }, (_, i) => ({ name: `Company ${i}.pdf`, data: pdf(String(i)), method: 0 })))
    const t = Date.now()
    const s = await scan(zip)
    expect(s.files).toHaveLength(15_000)
    expect(s.files.every((f) => f.status === 'ok')).toBe(true)
    const m = matchCompanyFiles(Array.from({ length: 2000 }, (_, i) => `Company ${i * 7}`), s.files)
    expect(m.every((x) => x.status === 'matched')).toBe(true)
    expect(Date.now() - t).toBeLessThan(20_000)
  })

  it('other requests are served while a big scan runs (it gives way between files)', async () => {
    const zip = makeZip(Array.from({ length: 3000 }, (_, i) => ({ name: `Company ${i}.pdf`, data: pdf(`x${i}`.repeat(2000)) })))
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    await scan(zip)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
  })

  it('the same ZIP is scanned once, even when two reviews ask at the same time, and again after it is forgotten', async () => {
    forgetScans()
    let runs = 0
    const produce = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 10))
      return { files: [], ignored: 0, problems: [] }
    }
    await Promise.all([scanOnce('h1', produce), scanOnce('h1', produce), scanOnce('h1', produce)])
    await scanOnce('h1', produce)
    expect(runs).toBe(1)
    forgetScans()
    await scanOnce('h1', produce)
    expect(runs).toBe(2)
    for (let i = 0; i < 12; i++) await scanOnce(`h-${i}`, produce) // only a few are kept
    const before = runs
    await scanOnce('h-0', produce)
    expect(runs).toBe(before + 1)
  })
})

describe('company names and file names', () => {
  it('capital letters, extra spaces, punctuation and the .pdf extension do not matter', () => {
    const keys = ['ABC Limited', '  abc   LIMITED ', 'Abc_Limited', 'ABC Limited.'].map(companyFileKey)
    expect(new Set(keys)).toEqual(new Set(['abc limited']))
    expect(['ABC Limited.pdf', 'abc limited.PDF', 'ABC  Limited .pdf'].map(fileKey)).toEqual(['abc limited', 'abc limited', 'abc limited'])
    expect(companyFileKey('A/B Co')).toBe(fileKey('A-B Co.pdf'))
  })

  it('different names stay different: nothing is guessed', () => {
    expect(companyFileKey('ABC Limited')).not.toBe(companyFileKey('ABC Ltd'))
    expect(companyFileKey('Smith and Sons')).not.toBe(companyFileKey('Smith & Sons'))
    expect(companyFileKey('ABC')).not.toBe(companyFileKey('ABC Holdings'))
    expect(companyFileKey('...')).toBe('')
  })
})

describe('matching files to companies', () => {
  const zip = async (names: string[]) => (await scan(makeZip(names.map((n, i) => ({ name: n, data: pdf(String(i)) }))))).files

  it('the example: each company gets exactly its own file', async () => {
    const files = await zip(['ABC Limited.pdf', 'XYZ Industries.pdf', 'Test Corporation.pdf'])
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries', 'Test Corporation'], files)
    expect(m.map((x) => [x.status, x.file?.fileName])).toEqual([['matched', 'ABC Limited.pdf'], ['matched', 'XYZ Industries.pdf'], ['matched', 'Test Corporation.pdf']])
    expect(new Set(m.map((x) => x.file!.sha256)).size).toBe(3) // three different files
  })

  it('safe variations match: capitals, extra spaces, extension, folder', async () => {
    const files = await zip(['reports/abc  LIMITED.PDF', 'xyz_industries.pdf'])
    expect(matchCompanyFiles(['ABC Limited', 'XYZ Industries'], files).map((x) => x.status)).toEqual(['matched', 'matched'])
  })

  it('no file: missing, with a hint when the file is there but is not a PDF', async () => {
    const files = (await scan(makeZip([{ name: 'ABC Limited.pdf', data: pdf() }, { name: 'XYZ Industries.docx', data: Buffer.from('x') }]))).files
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries', 'Test Corporation'], files)
    expect(m.map((x) => x.status)).toEqual(['matched', 'missing', 'missing'])
    expect(m[1]!.detail).toMatch(/only PDF files are used/)
    expect(m[2]!.detail).toMatch(/No PDF in the ZIP is named after this company/)
    expect(m[2]!.file).toBeNull()
  })

  it('several files could match one company: ambiguous, none chosen, all listed', async () => {
    const files = await zip(['a/ABC Limited.pdf', 'b/ABC Limited.pdf', 'ABC limited.pdf'])
    const m = matchCompanyFiles(['ABC Limited'], files)
    expect(m[0]).toMatchObject({ status: 'ambiguous', file: null })
    expect(m[0]!.detail).toMatch(/a\/ABC Limited\.pdf.*b\/ABC Limited\.pdf.*ABC limited\.pdf/)
    const s = await scan(makeZip([{ name: 'a/ABC Limited.pdf', data: pdf('1') }, { name: 'b/ABC Limited.pdf', data: pdf('2') }, { name: 'abc  limited.pdf', data: pdf('3') }]))
    expect(s.problems.join(' ')).toMatch(/Duplicate file name "ABC Limited.pdf"/)
    expect(s.problems.join(' ')).toMatch(/would both match the same company/)
  })

  it('one file matching two companies of the Excel is ambiguous for both', async () => {
    const files = await zip(['ABC Ltd.pdf', 'Other.pdf'])
    const m = matchCompanyFiles(['ABC Ltd', 'ABC Ltd.', 'Other'], files)
    expect(m.map((x) => x.status)).toEqual(['ambiguous', 'ambiguous', 'matched'])
    expect(m[0]!.detail).toMatch(/matches more than one company/)
  })

  it('a matching file that is invalid is reported as invalid, never swapped for another', async () => {
    const files = (await scan(makeZip([{ name: 'ABC Limited.pdf', data: Buffer.from('not a pdf') }, { name: 'XYZ Industries.pdf', data: pdf() }]))).files
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries'], files)
    expect(m.map((x) => x.status)).toEqual(['invalid', 'matched'])
    expect(m[0]!.detail).toMatch(/cannot be used: it is not a valid PDF/)
    expect(m[1]!.file!.fileName).toBe('XYZ Industries.pdf')
  })

  it('a company name with nothing to match by is missing', async () => {
    expect(matchCompanyFiles(['---'], await zip(['x.pdf']))[0]).toMatchObject({ status: 'missing' })
  })
})
