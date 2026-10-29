import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadZipInPieces } from './zipUpload'

// The ZIP goes in pieces; after a lost answer it carries on from where the SERVER says it is, never sending twice.

afterEach(() => vi.unstubAllGlobals())

function server(total: number, chunk: number, misbehave: (url: string, got: number) => 'lose' | Response | null = () => null) {
  const state = { got: 0, deleted: false, pieces: [] as number[] }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
    if (u.endsWith('/files/zip/start')) return json({ id: 'z1', chunkBytes: chunk }, 201)
    if (u.includes('/chunk')) {
      const offset = Number(new URL(u, 'http://x').searchParams.get('offset'))
      state.pieces.push(offset)
      const m = misbehave(u, state.got)
      if (m === 'lose') {
        state.got += (init.body as Blob).size
        throw new TypeError('network')
      }
      if (m) return m
      if (offset !== state.got) return json({ error: { message: 'continue', details: { receivedBytes: state.got } } }, 409)
      state.got += (init.body as Blob).size
      return json({ receivedBytes: state.got })
    }
    if (u.endsWith('/finish')) return json({ id: 'z1', fileName: 'x.zip', sizeBytes: total }, 201)
    if ((init.method ?? 'GET') === 'DELETE') {
      state.deleted = true
      return json({})
    }
    return json({}, 404)
  })
  return state
}

describe('uploading a ZIP in pieces', () => {
  it('sends each piece at the server\'s offset and reports progress', async () => {
    const s = server(2500, 1000)
    const seen: number[] = []
    const r = await uploadZipInPieces(new File([new Uint8Array(2500)], 'x.zip'), (n) => seen.push(n), { pauseMs: 0 })
    expect(r.id).toBe('z1')
    expect(s.pieces).toEqual([0, 1000, 2000])
    expect(seen).toEqual([0, 1000, 2000, 2500])
  })

  it('a lost answer: the piece is not counted twice — the upload continues from the server\'s count', async () => {
    let lost = false
    const s = server(3000, 1000, (u) => (!lost && u.includes('offset=1000') ? ((lost = true), 'lose') : null))
    await uploadZipInPieces(new File([new Uint8Array(3000)], 'x.zip'), () => undefined, { pauseMs: 0 })
    expect(s.got).toBe(3000)
    expect(s.pieces).toEqual([0, 1000, 1000, 2000])
  })

  it('a refusal stops at once and removes the partial upload', async () => {
    const s = server(2000, 1000, (u) => (u.includes('offset=1000') ? new Response(JSON.stringify({ error: { message: 'More data arrived than the size of the ZIP.' } }), { status: 400 }) : null))
    await expect(uploadZipInPieces(new File([new Uint8Array(2000)], 'x.zip'), () => undefined, { pauseMs: 0 })).rejects.toThrow(/More data arrived/)
    expect(s.deleted).toBe(true)
  })
})
