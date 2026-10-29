import { deflateRawSync } from 'node:zlib'

// A tiny ZIP writer for tests: stored or deflated entries, and the knobs needed to
// craft the malformed archives a hostile upload could be (lying sizes, bad checksums,
// encrypted flag, ZIP64 markers, a fake end-of-directory record in the comment).

export function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) {
    c ^= b[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A minimal but real PDF (starts with %PDF-), different for each text. */
export const pdf = (text = 'x') => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Note (${text}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`)

export interface ZipEntry {
  name: string
  data?: Buffer
  /** 0 = stored, 8 = deflate (default). Any other number is written as is. */
  method?: number
  flags?: number
  /** Written instead of the real CRC-32 / sizes / compressed bytes, to craft a lie. */
  crc?: number
  declaredSize?: number
  compressed?: Buffer
  /** Do not set the UTF-8 name flag (the name is still written as UTF-8 bytes). */
  noUtf8Flag?: boolean
  /** A folder entry (name should end with /). */
  folder?: boolean
}

export function makeZip(entries: ZipEntry[], opts: { comment?: Buffer; total?: number; disk?: number } = {}): Buffer {
  const parts: Buffer[] = []
  const dir: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = e.folder ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0))
    const method = e.folder ? 0 : (e.method ?? 8)
    const compressed = e.compressed ?? (method === 8 ? deflateRawSync(data) : data)
    const crc = e.crc ?? crc32(data)
    const size = e.declaredSize ?? data.length
    const flags = (e.flags ?? 0) | (e.noUtf8Flag ? 0 : 0x800)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, compressed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    dir.push(cd, name)
    offset += 30 + name.length + compressed.length
  }
  const cdBuf = Buffer.concat(dir)
  const comment = opts.comment ?? Buffer.alloc(0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(opts.disk ?? 0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(opts.total ?? entries.length, 8)
  eocd.writeUInt16LE(opts.total ?? entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...parts, cdBuf, eocd, comment])
}

/**
 * Writes a big ZIP of stored (not compressed) files straight to disk, one file at a time, so a ZIP of a gigabyte never
 * sits in memory. `make(i)` returns file i's content.
 */
export async function writeStoredZip(file: string, names: string[], make: (i: number) => Buffer): Promise<void> {
  const { createWriteStream } = await import('node:fs')
  const zlib = await import('node:zlib')
  const nativeCrc = (zlib as unknown as { crc32?: (d: Buffer) => number }).crc32
  const out = createWriteStream(file)
  const write = (b: Buffer) => new Promise<void>((res, rej) => out.write(b, (e) => (e ? rej(e) : res())))
  const dir: Buffer[] = []
  let offset = 0
  for (const [i, n] of names.entries()) {
    const data = make(i)
    const name = Buffer.from(n, 'utf8')
    const crc = nativeCrc ? nativeCrc(data) >>> 0 : crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    await write(local)
    await write(name)
    await write(data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    dir.push(cd, name)
    offset += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(dir)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  await write(cdBuf)
  await write(eocd)
  await new Promise<void>((res) => out.end(() => res()))
}
