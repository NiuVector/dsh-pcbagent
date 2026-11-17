/** PCB plugin's own contracts, not upstream DSH session wire types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface InspectRequest { board: string }
export interface SchematicRequest { schematic: string }
export interface StatusRequest { runtime?: string }
export interface RouteRequest { board: string; output: string; runtime?: string; provider?: 'none'; rounds?: number }
export interface ModelRouteRequest { board: string; output: string; runtime?: string; provider?: 'none' | 'openai' | 'anthropic'; model?: string; rounds?: number }
export interface PcbSnapshot { runId: string | null; state: string; logs: string[]; result: Json }
export interface StartResult { run_id: string; output_dir: string | null }
