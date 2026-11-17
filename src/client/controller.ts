import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Board, DesignFile, PcbFace, PcbRemote, PcbState, RunSnapshot, Schematic, SourceFile } from './contract.ts'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid PCB response')
  return value as Record<string, unknown>
}
function unwrap(value: unknown): unknown {
  const envelope = record(value)
  if (envelope['ok'] === false) { const error = record(envelope['error']); throw new Error(String(error['message'] ?? 'PCB request failed')) }
  return envelope['ok'] === true ? envelope['value'] ?? envelope['data'] : value
}
function text(data: Record<string, unknown>, key: string): string {
  if (typeof data[key] !== 'string') throw new Error('Invalid document field: ' + key)
  return data[key]
}
function count(data: Record<string, unknown>, key: string): number {
  if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < 0) throw new Error('Invalid document count: ' + key)
  return data[key]
}
function boardDocument(value: unknown): Board {
  const data = record(unwrap(value))
  if (!Array.isArray(data['shapes'])) throw new Error('Invalid board geometry')
  return { name: text(data, 'name'), path: text(data, 'path'), footprints: count(data, 'footprints'), pads: count(data, 'pads'),
    tracks: count(data, 'tracks'), vias: count(data, 'vias'), nets: count(data, 'nets'), shapes: [],
    limitations: typeof data['limitations'] === 'string' ? data['limitations'] : '',
    ...(typeof data['source'] === 'string' ? { source: data['source'] } : {}) }
}
function schematicDocument(value: unknown): Schematic {
  const data = record(unwrap(value))
  if (!Array.isArray(data['sources'])) throw new Error('Invalid schematic hierarchy')
  const sources: SourceFile[] = data['sources'].map(value => { const item = record(value); return { name: text(item, 'name'), source: text(item, 'source') } })
  return { kind: 'schematic', name: text(data, 'name'), path: text(data, 'path'), source: text(data, 'source'), sources, symbols: count(data, 'symbols'), sheets: count(data, 'sheets') }
}
function designFile(value: unknown): DesignFile {
  const data = record(value)
  const kind = data['kind']
  if (kind !== 'project' && kind !== 'board' && kind !== 'schematic') throw new Error('Invalid KiCad file kind')
  return { path: text(data, 'path'), name: text(data, 'name'), directory: text(data, 'directory'), relativePath: text(data, 'relativePath'), kind }
}
const stem = (name: string): string => name.replace(/\.kicad_(?:pro|pcb|sch)$/iu, '')

/** Session-local documents and host operations, independent from the pane layout. */
export class PcbController {
  readonly state = createSnapshotStore<PcbState>({ board: null, schematic: null, files: [], projectName: '', paths: { board: '', schematic: '', output: '' }, pending: false, error: null, pollError: null, refreshState: 'idle', run: { runId: null, state: 'idle', logs: [], result: null } })
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private operation = 0
  private refreshing = false
  private viewers = 0
  private failures = 0
  constructor(private readonly remote: PcbRemote | undefined) { this.face.available = remote !== undefined }
  readonly face: PcbFace = {
    hooks: { pcb: this.state }, available: false,
    activate: () => this.activate(),
    setPath: (field, value) => {
      if (this.state.getSnapshot().pending || this.running) return
      this.operation++
      this.state.update(state => { state.paths[field] = value; if (field === 'board') state.board = null; if (field === 'schematic') state.schematic = null; state.run = { runId: null, state: 'idle', logs: [], result: null } })
    },
    inspect: async () => { await this.perform(async remote => {
      const board = boardDocument(await remote.inspect({ board: this.state.getSnapshot().paths.board }))
      this.state.update(state => { state.board = board })
    }, true) },
    inspectSchematic: async () => { await this.perform(async remote => {
      const schematic = schematicDocument(await remote.schematic({ schematic: this.state.getSnapshot().paths.schematic }))
      this.state.update(state => { state.schematic = schematic })
    }) },
    refreshFiles: async () => { await this.perform(async remote => {
      const catalog = record(unwrap(await remote.files()))
      if (!Array.isArray(catalog['files'])) throw new Error('Invalid design catalog')
      const files = catalog['files'].map(designFile)
      this.state.update(state => { state.files = files; if (state.paths.output === '' && typeof catalog['defaultOutput'] === 'string') state.paths.output = catalog['defaultOutput'] })
    }) },
    openDesign: async (file, only) => this.perform(async remote => {
      const files = this.state.getSnapshot().files
      const companions = files.filter(item => item.directory.toLowerCase() === file.directory.toLowerCase() && stem(item.name).toLowerCase() === stem(file.name).toLowerCase())
      const boardFile = only === 'schematic' ? undefined : file.kind === 'board' ? file : companions.find(item => item.kind === 'board')
      const schematicFile = only === 'board' ? undefined : file.kind === 'schematic' ? file : companions.find(item => item.kind === 'schematic')
      if (boardFile === undefined && schematicFile === undefined) throw new Error('Project contains no matching KiCad schematic or PCB')
      const [board, schematic] = await Promise.all([
        boardFile ? remote.inspect({ board: boardFile.path }).then(boardDocument) : null,
        schematicFile ? remote.schematic({ schematic: schematicFile.path }).then(schematicDocument) : null,
      ])
      if (this.disposed) return
      this.state.update(state => {
        if (only !== 'schematic') { state.board = board; state.paths.board = board?.path ?? '' }
        if (only !== 'board') { state.schematic = schematic; state.paths.schematic = schematic?.path ?? '' }
        state.projectName = state.board && state.schematic && stem(state.board.name) !== stem(state.schematic.name) ? '' : stem(file.name)
        state.run = { runId: null, state: 'idle', logs: [], result: null }
      })
    }),
    status: async () => { await this.perform(async remote => { this.markStarting(); unwrap(await remote.status({})); await this.refreshCycle(true) }) },
    route: async () => { await this.perform(async remote => { const paths = this.state.getSnapshot().paths; this.markStarting(); unwrap(await remote.run({ board: paths.board, output: paths.output, provider: 'none' })); await this.refreshCycle(true) }) },
    stop: async () => { await this.perform(async remote => { unwrap(await remote.stop()); await this.refreshCycle(true) }, false, true) },
    refresh: async () => { await this.perform(async () => { await this.refreshCycle(true) }, false, true) },
    dismissError: () => { this.state.update(state => { state.error = null }) },
  }

  private get running(): boolean { return ['starting', 'running', 'stopping', 'unknown'].includes(this.state.getSnapshot().run.state) }
  private markStarting(): void { this.state.update(state => { state.run = { runId: null, state: 'starting', logs: [], result: null } }) }
  private async perform(action: (remote: PcbRemote) => Promise<void>, clearBoard = false, allowRunning = false): Promise<boolean> {
    if (this.disposed || this.remote === undefined || this.state.getSnapshot().pending || (this.running && !allowRunning)) return false
    const token = ++this.operation
    this.state.update(state => { state.pending = true; state.error = null; if (clearBoard) state.board = null })
    try { await action(this.remote); return !this.disposed && token === this.operation }
    catch (error) { if (!this.disposed && token === this.operation) { this.state.update(state => { state.error = error instanceof Error ? error.message : String(error); if (state.run.state === 'starting') state.run.state = 'unknown' }); this.schedule() }; return false }
    finally { if (!this.disposed && token === this.operation) this.state.update(state => { state.pending = false }) }
  }
  private async poll(): Promise<void> {
    if (this.disposed || this.remote === undefined || this.refreshing) return
    this.refreshing = true
    try {
      const raw = record(unwrap(await this.remote.snapshot()))
      if (typeof raw['state'] !== 'string' || !Array.isArray(raw['logs'])) throw new Error('Invalid PCB state')
      const run: RunSnapshot = { runId: typeof raw['runId'] === 'string' ? raw['runId'] : null, state: raw['state'], logs: raw['logs'].filter((line): line is string => typeof line === 'string'), result: raw['result'] == null ? null : record(raw['result']) }
      if (!this.disposed) this.state.update(state => { state.run = run })
    } finally { this.refreshing = false }
  }
  /** Visible views share one poll loop; hidden historic sessions consume no timer. */
  private activate(): () => void {
    if (this.disposed || this.remote === undefined) return () => {}
    this.viewers++
    if (this.viewers === 1) void this.refreshCycle(true)
    let released = false
    return () => {
      if (released) return
      released = true
      this.viewers--
      if (this.viewers === 0) clearTimeout(this.timer)
    }
  }
  private async refreshCycle(resetFailures = false): Promise<void> {
    if (this.disposed) return
    if (resetFailures) this.failures = 0
    try {
      await this.poll()
      if (this.disposed) return
      this.failures = 0
      this.state.update(state => { state.pollError = null; state.refreshState = 'idle' })
    } catch (error) {
      if (this.disposed) return
      this.failures++
      this.state.update(state => {
        state.pollError = error instanceof Error ? error.message : String(error)
        state.refreshState = this.failures > 3 ? 'paused' : 'retrying'
      })
    }
    this.schedule()
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (this.disposed || this.viewers === 0 || this.failures > 3) return
    // At most three automatic retries: 1.5, 3, and 6 seconds. Manual Refresh
    // or a newly visible view starts a new bounded retry budget.
    const delay = this.failures > 0 ? 750 * 2 ** this.failures : this.running ? 750 : 2500
    this.timer = setTimeout(() => { void this.refreshCycle() }, delay)
  }
  dispose(): void { this.disposed = true; this.operation++; clearTimeout(this.timer) }
}
