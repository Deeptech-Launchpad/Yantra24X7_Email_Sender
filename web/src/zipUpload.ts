import { api, ApiError, getToken } from './api'

// UPLOADING A ZIP OF COMPANY-WISE PDFs (up to 1 GB), IN PIECES. (Adapted from the Marketing AI Agent.)
// The file goes in pieces the server names (16 MB), each at the offset where the server's copy ends. A failed
// piece is tried again on its own (about two minutes of trouble); after any doubt the upload carries on from where
// the SERVER says it is. Finally the server checks the whole file and reads it as a ZIP.

export interface UploadedZip {
  id: string
  fileName: string
  sizeBytes: number
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const MAX_FAILURES = 8
const backoff = (pause: number, failures: number) => Math.min(pause * 1.25 * 2 ** (failures - 1), pause * 37.5)
const worthRetrying = (err: unknown) => err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500)

function serverHas(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const n = (err.details as { receivedBytes?: unknown } | null)?.receivedBytes
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

async function sendPiece(id: string, offset: number, piece: Blob) {
  const res = await fetch(`/api/files/zip/${encodeURIComponent(id)}/chunk?offset=${offset}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${getToken() ?? ''}` },
    body: piece,
  }).catch(() => null)
  if (!res) throw new ApiError(0, 'The connection was lost.')
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: { message?: string; details?: unknown } } | null
    throw new ApiError(res.status, e?.error?.message ?? `HTTP ${res.status}`, e?.error?.details)
  }
}

export async function uploadZipInPieces(file: File, onProgress: (sent: number) => void, opts: { pauseMs?: number } = {}): Promise<UploadedZip> {
  const pause = opts.pauseMs ?? 800
  const started = await api.post<{ id: string; chunkBytes: number }>('/files/zip/start', { fileName: file.name, sizeBytes: file.size })
  try {
    let offset = 0
    let failures = 0
    let redirects = 0
    onProgress(0)
    while (offset < file.size) {
      const piece = file.slice(offset, Math.min(file.size, offset + started.chunkBytes))
      if (piece.size === 0) throw new Error(`"${file.name}" could not be read.`)
      try {
        await sendPiece(started.id, offset, piece)
        offset += piece.size
        failures = 0
        redirects = 0
      } catch (err) {
        const have = serverHas(err)
        if (have !== null && have <= file.size) {
          if (have === offset && ++redirects > 3) throw err
          offset = have
          continue
        }
        if (!worthRetrying(err) || ++failures > MAX_FAILURES) throw err
        await wait(backoff(pause, failures))
      }
      onProgress(offset)
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await api.post<UploadedZip>(`/files/zip/${encodeURIComponent(started.id)}/finish`)
      } catch (err) {
        if (!worthRetrying(err) || attempt >= 4) throw err
        await wait(pause * attempt)
      }
    }
  } catch (err) {
    void api.del(`/files/${encodeURIComponent(started.id)}`).catch(() => undefined)
    throw err
  }
}
