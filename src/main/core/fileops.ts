// Dateioperationen mit Hash-Verifikation. Diese Datei verwendet ausschließlich Node-Builtins,
// damit sie sowohl im Worker-Thread (file-worker.ts) als auch inline (Tests) laufen kann.
import crypto from 'node:crypto'
import fs from 'node:fs'

export interface HashResult {
  sha256: string
  size: number
}

export interface FileOps {
  hashFile(file: string, signal?: AbortSignal): Promise<HashResult>
  /** Kopiert src nach dst (dst darf nicht existieren), berechnet SHA-256 der gelesenen Bytes, fsync. */
  copyWithHash(src: string, dst: string, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<HashResult>
  close?(): Promise<void>
}

const CHUNK = 1024 * 1024 * 4

export class AbortError extends Error {
  code = 'ABORTED'
  constructor() {
    super('Vorgang abgebrochen')
  }
}

export async function hashFileInline(file: string, signal?: AbortSignal): Promise<HashResult> {
  const h = crypto.createHash('sha256')
  const fh = await fs.promises.open(file, 'r')
  const buf = Buffer.allocUnsafe(CHUNK)
  let size = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new AbortError()
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null)
      if (!bytesRead) break
      h.update(buf.subarray(0, bytesRead))
      size += bytesRead
    }
  } finally {
    await fh.close()
  }
  return { sha256: h.digest('hex'), size }
}

export async function copyWithHashInline(
  src: string,
  dst: string,
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void
): Promise<HashResult> {
  const h = crypto.createHash('sha256')
  const rf = await fs.promises.open(src, 'r')
  let wf: fs.promises.FileHandle | null = null
  let size = 0
  try {
    // 'wx': schlägt fehl, falls dst existiert – niemals still überschreiben
    wf = await fs.promises.open(dst, 'wx')
    const buf = Buffer.allocUnsafe(CHUNK)
    let lastReport = 0
    for (;;) {
      if (signal?.aborted) throw new AbortError()
      const { bytesRead } = await rf.read(buf, 0, CHUNK, null)
      if (!bytesRead) break
      const chunk = buf.subarray(0, bytesRead)
      h.update(chunk)
      let off = 0
      while (off < bytesRead) {
        const { bytesWritten } = await wf.write(chunk, off, bytesRead - off)
        off += bytesWritten
      }
      size += bytesRead
      if (onProgress && size - lastReport >= 16 * 1024 * 1024) {
        lastReport = size
        onProgress(size)
      }
    }
    await wf.sync()
  } finally {
    await rf.close()
    if (wf) await wf.close()
  }
  onProgress?.(size)
  return { sha256: h.digest('hex'), size }
}

export const inlineFileOps: FileOps = {
  hashFile: hashFileInline,
  copyWithHash: copyWithHashInline
}
