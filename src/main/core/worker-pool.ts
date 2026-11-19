import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileOps, HashResult } from './fileops'
import { AbortError, copyWithHashInline, hashFileInline } from './fileops'

interface Pending {
  resolve: (r: HashResult) => void
  reject: (e: Error) => void
  onProgress?: (n: number) => void
  worker: Worker
}

/** Kleiner Worker-Pool mit fester Größe; Aufgaben werden auf den am wenigsten belasteten Worker verteilt. */
export class WorkerFileOps implements FileOps {
  private workers: Worker[] = []
  private load = new Map<Worker, number>()
  private pending = new Map<number, Pending>()
  private seq = 0
  private dead = new Set<Worker>()
  private respawns: number[] = []
  /** true, wenn Worker wiederholt abstürzen: Vorgänge laufen dann im Main-Prozess weiter. */
  broken = false

  constructor(private script: string, size: number) {
    for (let i = 0; i < size; i++) this.spawn()
  }

  private spawn(): Worker {
    const w = new Worker(this.script)
    w.on('message', (msg: { id: number; result?: HashResult; error?: { message: string; code: string | null }; progress?: number }) => {
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.progress !== undefined) {
        p.onProgress?.(msg.progress)
        return
      }
      this.pending.delete(msg.id)
      this.load.set(w, (this.load.get(w) ?? 1) - 1)
      if (msg.error) {
        const e = msg.error.code === 'ABORTED' ? new AbortError() : Object.assign(new Error(msg.error.message), { code: msg.error.code ?? undefined })
        p.reject(e)
      } else p.resolve(msg.result!)
    })
    w.on('error', (err) => this.failWorker(w, err))
    w.on('exit', (code) => {
      if (code !== 0) this.failWorker(w, new Error(`Worker beendet (${code})`))
    })
    this.workers.push(w)
    this.load.set(w, 0)
    return w
  }

  private failWorker(w: Worker, err: Error): void {
    if (this.dead.has(w)) return // 'error' und 'exit' kommen beide – nur einmal behandeln
    this.dead.add(w)
    for (const [id, p] of this.pending) {
      if (p.worker === w) {
        this.pending.delete(id)
        p.reject(err)
      }
    }
    this.workers = this.workers.filter((x) => x !== w)
    this.load.delete(w)
    // Neustart begrenzen (keine Endlosschleife, falls das Worker-Skript nicht ladbar ist)
    const now = Date.now()
    this.respawns = this.respawns.filter((t) => now - t < 60_000)
    if (this.respawns.length >= 5) {
      this.broken = true
      return
    }
    this.respawns.push(now)
    try {
      this.spawn()
    } catch {
      this.broken = true
    }
  }

  /** Prüft beim Start, ob die Worker funktionieren (Hash einer kleinen Testdatei). */
  async selfTest(timeoutMs = 8000): Promise<boolean> {
    const f = path.join(os.tmpdir(), `ppm-selftest-${process.pid}.bin`)
    fs.writeFileSync(f, 'photopack')
    try {
      const r = await Promise.race([this.hashFile(f), new Promise<null>((res) => setTimeout(() => res(null), timeoutMs))])
      return !!r && r.size === 9 && /^[0-9a-f]{64}$/.test(r.sha256)
    } catch {
      return false
    } finally {
      fs.rmSync(f, { force: true })
    }
  }

  private pick(): Worker {
    let best = this.workers[0]
    for (const w of this.workers) if ((this.load.get(w) ?? 0) < (this.load.get(best) ?? 0)) best = w
    return best
  }

  private run(op: 'hash' | 'copy', src: string, dst: string | undefined, signal?: AbortSignal, onProgress?: (n: number) => void): Promise<HashResult> {
    if (signal?.aborted) return Promise.reject(new AbortError())
    if (this.broken || this.workers.length === 0) return op === 'hash' ? hashFileInline(src, signal) : copyWithHashInline(src, dst!, signal, onProgress)
    const id = ++this.seq
    const w = this.pick()
    this.load.set(w, (this.load.get(w) ?? 0) + 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, worker: w })
      signal?.addEventListener('abort', () => w.postMessage({ op: 'abort', target: id }), { once: true })
      w.postMessage({ id, op, src, dst })
    })
  }

  hashFile(file: string, signal?: AbortSignal): Promise<HashResult> {
    return this.run('hash', file, undefined, signal)
  }

  copyWithHash(src: string, dst: string, signal?: AbortSignal, onProgress?: (n: number) => void): Promise<HashResult> {
    return this.run('copy', src, dst, signal, onProgress)
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()))
    this.workers = []
  }
}
