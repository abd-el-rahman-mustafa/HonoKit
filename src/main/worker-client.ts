import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { BRAND } from '@shared/brand'
import type { ApiError, Progress, Result } from '@shared/ipc'

/**
 * The main process's handle on the worker. Calls are queued in order and answered
 * by id. If the worker dies (a MuPDF crash on a malicious file, say) it is started
 * again and the calls in flight fail with a clear error; the documents it held are
 * gone, and the interface is told so it can close their tabs.
 */
export class WorkerClient {
  private child: UtilityProcess | null = null
  private ready: Promise<void> | null = null
  private next = 1
  private readonly pending = new Map<number, { resolve: (r: Result<unknown>) => void }>()

  constructor(
    private readonly resources: string,
    private readonly onProgress: (p: Progress | null) => void,
    private readonly onCrash: () => void
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve) => {
      const child = utilityProcess.fork(join(import.meta.dirname, 'worker.js'), [], {
        serviceName: `${BRAND.name} worker`,
        env: { ...process.env, POWERPDF_RESOURCES: this.resources },
        stdio: 'inherit',
        // MuPDF's object handles are freed by finalizers; the worker collects garbage after each request (decisions §59).
        execArgv: ['--expose-gc']
      })
      this.child = child
      child.on('message', (message: { id?: number; ok?: boolean; value?: unknown; error?: ApiError; progress?: Progress | null; ready?: boolean }) => {
        if (message.ready) return resolve()
        if ('progress' in message) return this.onProgress(message.progress ?? null)
        if (message.id === undefined) return
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        waiting.resolve(message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error! })
      })
      child.on('exit', (code) => {
        this.child = null
        this.ready = null
        const lost = [...this.pending.values()]
        this.pending.clear()
        for (const p of lost) p.resolve({ ok: false, error: { code: 'internal', message: `The document engine stopped unexpectedly (${code}).` } })
        this.onProgress(null)
        if (code !== 0) this.onCrash()
      })
    })
    return this.ready
  }

  async call<T>(method: string, ...args: unknown[]): Promise<Result<T>> {
    await this.start()
    const id = this.next++
    return new Promise<Result<T>>((resolve) => {
      this.pending.set(id, { resolve: resolve as (r: Result<unknown>) => void })
      this.child!.postMessage({ id, method, args })
    })
  }

  stop(): void {
    this.child?.kill()
  }
}
