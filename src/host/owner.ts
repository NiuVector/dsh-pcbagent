import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Json, PcbSnapshot, StartResult } from './types.ts'

export interface Transport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(name: string, listener: (event: Record<string, unknown>) => void): unknown
  close(): Promise<void>
}

/** Realpath-based capability boundary, including output paths not yet created. */
export async function checkedPath(value: unknown, roots: readonly string[], mode: 'file' | 'output'): Promise<string> {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.includes('\0')) throw new Error('Use an absolute PCB path')
  const target = resolve(value)
  let existing = target
  while (true) {
    try { existing = await realpath(existing); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode === 'file') throw new Error('PCB path does not exist or cannot be resolved')
      const parent = dirname(existing)
      if (parent === existing) throw new Error('Invalid output path')
      existing = parent
    }
  }
  // For symlink ancestors, resolve original missing suffix against the real ancestor.
  let originalAncestor = target
  if (mode === 'output') {
    while (true) {
      try { await stat(originalAncestor); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        originalAncestor = dirname(originalAncestor)
      }
    }
  }
  const canonical = mode === 'file' ? existing : resolve(existing, relative(originalAncestor, target))
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root)))
  if (!canonicalRoots.some(root => {
    const rel = relative(root, canonical)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })) throw new Error('PCB path is outside the configured allowedRoots')
  if (mode === 'file' && !(await stat(canonical)).isFile()) throw new Error('PCB input must be a file')
  return canonical
}

/** One transport per agent. Never route cancellation across session ownership. */
export class PcbOwner {
  private current: PcbSnapshot = { runId: null, state: 'idle', logs: [], result: null }
  private busy = false
  private starting = false
  private dead = false
  private finishing: Promise<Json> | undefined
  private finish: ((result: Json) => void) | undefined
  private cancellationRequested = false
  constructor(private readonly bridge: Transport) {
    bridge.on('event', event => this.accept(event))
  }
  snapshot(): PcbSnapshot { return structuredClone(this.current) }
  private accept(event: Record<string, unknown>): void {
    if (this.dead) return
    if (event.event === 'connection') {
      this.dead = true
      if (!this.busy) return
      this.busy = false
      this.current.state = 'failed'
      this.current.result = { error: 'PCB bridge connection lost; operation outcome may be unknown' }
      this.finish?.(this.current.result); this.finish = undefined
      return
    }
    if (!this.busy || typeof event.run_id !== 'string') return
    if (event.event === 'run' && event.state === 'running' && this.busy && this.current.runId === null) {
      this.current.runId = event.run_id
      this.current.state = 'running'
      if (this.cancellationRequested) void this.stop().catch(() => {})
    }
    if (event.run_id !== this.current.runId) return
    if (event.event === 'log' && typeof event.line === 'string') {
      this.current.logs.push(event.line.slice(0, 4096))
      if (this.current.logs.length > 500) this.current.logs.shift()
    } else if (event.event === 'run' && event.state === 'stopping') {
      this.current.state = 'stopping'
    } else if (event.event === 'result') {
      this.busy = false
      this.current.state = typeof event.state === 'string' ? event.state : 'failed'
      this.current.result = JSON.parse(JSON.stringify(event)) as Json
      this.finish?.(this.current.result); this.finish = undefined
    }
  }
  async inspect(params: Record<string, unknown>): Promise<Json> {
    if (this.dead) throw new Error('PCB bridge unavailable')
    return await this.bridge.request('inspect_board', params) as Json
  }
  async inspectSchematic(params: Record<string, unknown>): Promise<Json> {
    if (this.dead) throw new Error('PCB bridge unavailable')
    return await this.bridge.request('inspect_schematic', params) as Json
  }
  async start(method: 'run' | 'status', params: Record<string, unknown>, signal?: AbortSignal): Promise<StartResult> {
    signal?.throwIfAborted()
    if (this.dead) throw new Error('PCB bridge unavailable')
    if (this.busy || this.starting) throw new Error('A PCB operation is already running in this session')
    this.busy = true; this.starting = true; this.cancellationRequested = false
    this.current = { runId: null, state: 'starting', logs: [], result: null }
    this.finishing = new Promise(resolve => { this.finish = resolve })
    const cancel = () => { this.cancellationRequested = true; void this.stop().catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    void this.finishing.finally(() => signal?.removeEventListener('abort', cancel))
    try {
      const result = await this.bridge.request(method, params) as StartResult
      if (!result || typeof result.run_id !== 'string') throw new Error('Invalid PCB start acknowledgement')
      if (this.dead) throw new Error('PCB bridge unavailable')
      if (this.current.runId === null) {
        this.current.runId = result.run_id
        this.current.state = 'running'
      }
      if (this.current.runId !== result.run_id) throw new Error('PCB run identity mismatch')
      if (signal?.aborted) cancel()
      return result
    } catch (error) {
      if (!this.busy) {
        // A terminal event can precede a late or lost start acknowledgement.
        // Keep the settled result rather than changing it to unknown.
      } else if (error instanceof Error && (error as Error & { code?: string }).code === 'PCB_REJECTED'
        && this.current.runId === null) {
        // The backend explicitly refused before announcing a worker. This is
        // not an uncertain transport outcome and must not permanently lock UI.
        this.busy = false
        this.current.state = 'failed'
        this.current.result = { state: 'failed', error: error.message }
        this.finish?.(this.current.result); this.finish = undefined
      } else {
        // An announced worker, timeout, or lost reply has an unknown outcome.
        // Preserve ownership and never retry a mutating request automatically.
        this.current.state = 'unknown'
      }
      throw error
    } finally {
      this.starting = false
    }
  }
  /** Run a tool operation without switching to a subsequent operation's completion.
   * @param method Operation to launch.
   * @param params Validated backend arguments.
   * @param signal Optional cancellation signal; absent means no caller cancellation.
   * @param diagnostics Include this operation's last 100 log lines when true.
   * @returns Backend result, or the result and operation-local diagnostics.
   */
  async runToCompletion(method: 'run' | 'status', params: Record<string, unknown>, signal?: AbortSignal, diagnostics = false): Promise<Json> {
    const started = this.start(method, params, signal)
    const completion = this.finishing
    const operation = this.current
    await started
    if (!completion) throw new Error('PCB operation has no completion')
    const result = await completion
    return diagnostics ? { result, diagnostics: operation.logs.slice(-100) } : result
  }
  async wait(): Promise<Json> {
    if (!this.finishing) throw new Error('No PCB operation was started')
    return this.finishing
  }
  async stop(): Promise<Json> {
    this.cancellationRequested = true
    if (!this.busy) return { stopping: false }
    return await this.bridge.request('stop') as Json
  }
  async close(): Promise<void> {
    this.dead = true
    try { await this.bridge.close() } finally {
      this.dead = true
      if (this.busy) {
        this.busy = false
        this.current.state = 'cancelled'
        this.current.result = { cancelled: true, state: 'cancelled', error: 'PCB owner disposed; no output accepted' }
        this.finish?.(this.current.result); this.finish = undefined
      }
    }
  }
}
