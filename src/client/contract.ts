import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PcbKey } from './locales.ts'

/** JSON geometry returned by the PCB backend; no illustrative shapes are added. */
export interface Shape { type: string; layer: string; start?: number[]; end?: number[]; mid?: number[]; at?: number[]; size?: number | number[]; width?: number; angle?: number; shape?: string }
export interface Board { name: string; path: string; footprints: number; pads: number; tracks: number; vias: number; nets: number; shapes: Shape[]; limitations: string; source?: string }
export type DocumentKind = 'board' | 'schematic'
export interface SourceFile { name: string; source: string }
export interface Schematic { kind: 'schematic'; name: string; path: string; source: string; sources: SourceFile[]; symbols: number; sheets: number }
export interface DesignFile { path: string; name: string; directory: string; relativePath: string; kind: 'project' | DocumentKind }
export interface RunSnapshot { runId: string | null; state: string; logs: string[]; result: Record<string, unknown> | null }
export interface PcbState { board: Board | null; schematic: Schematic | null; files: DesignFile[]; projectName: string; paths: { board: string; schematic: string; output: string }; pending: boolean; error: string | null; pollError: string | null; refreshState: 'idle' | 'retrying' | 'paused'; run: RunSnapshot }
export interface PcbRemote {
  inspect(params: { board: string }): Promise<unknown>
  schematic(params: { schematic: string }): Promise<unknown>
  files(): Promise<unknown>
  status(params: { runtime?: string }): Promise<unknown>
  run(params: { board: string; output: string; runtime?: string; provider: 'none' }): Promise<unknown>
  stop(): Promise<unknown>
  snapshot(): Promise<unknown>
}
export interface PcbFace {
  hooks: { pcb: HostObservable<PcbState> }
  available: boolean
  activate(): () => void
  setPath(field: 'board' | 'schematic' | 'output', value: string): void
  inspect(): Promise<void>
  inspectSchematic(): Promise<void>
  refreshFiles(): Promise<void>
  openDesign(file: DesignFile, only?: DocumentKind): Promise<boolean>
  status(): Promise<void>
  route(): Promise<void>
  stop(): Promise<void>
  refresh(): Promise<void>
  dismissError(): void
}
export type PcbProps = PropsRuntime<'pcb.workbench'> & InjectFace<PcbFace> & PropsLocale<'pcb'>
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { pcb: PcbKey }
  interface SlotMap { 'pcb.workbench': { kind: 'single'; scope: 'session-maybe' } }
}
