// Worker-Thread für CPU-/IO-intensive Hash- und Kopiervorgänge.
import { parentPort } from 'node:worker_threads'
import { copyWithHashInline, hashFileInline } from './fileops'

interface Req {
  id: number
  op: 'hash' | 'copy' | 'abort'
  src?: string
  dst?: string
  target?: number
}

const controllers = new Map<number, AbortController>()

parentPort!.on('message', async (msg: Req) => {
  if (msg.op === 'abort') {
    controllers.get(msg.target!)?.abort()
    return
  }
  const ac = new AbortController()
  controllers.set(msg.id, ac)
  try {
    const result =
      msg.op === 'hash'
        ? await hashFileInline(msg.src!, ac.signal)
        : await copyWithHashInline(msg.src!, msg.dst!, ac.signal, (bytes) => parentPort!.postMessage({ id: msg.id, progress: bytes }))
    parentPort!.postMessage({ id: msg.id, result })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    parentPort!.postMessage({ id: msg.id, error: { message: err.message, code: err.code ?? null } })
  } finally {
    controllers.delete(msg.id)
  }
})
