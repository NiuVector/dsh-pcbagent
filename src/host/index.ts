/** PCBRouteAgent tools mounted in the real DSH host; no replacement agent loop. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { PcbOwner, checkedPath } from './owner.ts'
import { designCatalog } from './catalog.ts'
import type { Transport } from './owner.ts'
import type { Json, InspectRequest, SchematicRequest, StatusRequest, RouteRequest, ModelRouteRequest, PcbSnapshot, StartResult } from './types.ts'
export type * from './types.ts'

export interface Config { pcbRoot: string; pythonExecutable?: string; runtimePath?: string; allowedRoots: string[] }
declare module '@deepseek-ai/cordis' { interface Context { pcbController: PcbController } }
const require = createRequire(import.meta.url)

/** Remote owner resolves the caller's Agent through the official Gateway. */
export class PcbController extends TypertRemoteService {
  static inject = ['typert', 'remoteAccess', 'tools', 'approval']
  static Config: z<Config> = z.object({
    pcbRoot: z.string().required(), pythonExecutable: z.string(), runtimePath: z.string(),
    allowedRoots: z.array(z.string()).default([]),
  })
  private readonly owners = new Map<string, PcbOwner>()
  private readonly settings: Config
  private readonly engineEnv: Record<string, string> = {}
  constructor(ctx: Context, config: Config) {
    super(ctx, 'pcbController', { namespace: 'pcb' })
    this.settings = PcbController.Config(config)
    // Trusted deployment config is snapshotted once. Never let a tool choose or
    // rewrite a runtime JSON whose python/DLL fields control code execution.
    if (this.settings.runtimePath) {
      const file = resolve(this.settings.runtimePath)
      const runtime: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('Invalid configured PCB runtime')
      const data = runtime as Record<string, unknown>
      const pathValue = (value: unknown): string => {
        if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid configured PCB runtime path')
        return isAbsolute(value) ? value : resolve(dirname(file), value)
      }
      this.engineEnv.PCBWORLD_ENGINE_PYTHON = pathValue(data.python)
      this.engineEnv.PCBWORLD_KICAD_RL_MODULE_DIR = pathValue(data.module_dir)
      if (data.dll_dirs !== undefined && (!Array.isArray(data.dll_dirs) || !data.dll_dirs.every(v => typeof v === 'string'))) throw new Error('Invalid configured DLL directories')
      this.engineEnv.PCBWORLD_ENGINE_DLL_DIRS = ((data.dll_dirs ?? []) as string[]).map(pathValue).join(process.platform === 'win32' ? ';' : ':')
    }
    ctx.effect(() => async () => {
      await Promise.all([...this.owners.values()].map(owner => owner.close()))
      this.owners.clear()
    })
    this.registerTools(ctx)
  }
  private owner(agent: Agent): PcbOwner {
    let owner = this.owners.get(agent.id)
    if (owner) return owner
    if (this.owners.size >= 8) throw new Error('PCB session limit reached; close unused sessions')
    const { BridgeTransport } = require('./transport.cjs') as { BridgeTransport: new (root: string, options: object) => Transport }
    owner = new PcbOwner(new BridgeTransport(resolve(this.settings.pcbRoot), {
      env: this.engineEnv,
      ...(this.settings.pythonExecutable ? { pythonExecutable: this.settings.pythonExecutable } : {}),
    }))
    this.owners.set(agent.id, owner)
    const owned = owner
    agent.ctx.effect(() => async () => {
      await owned.close()
      if (this.owners.get(agent.id) === owned) this.owners.delete(agent.id)
    })
    return owner
  }
  private async runtime(request: StatusRequest): Promise<Record<string, unknown>> {
    if (request.runtime) throw new Error('Runtime is host-configured; tool/UI runtime paths are not accepted')
    return {}
  }
  private async routeArgs(request: ModelRouteRequest): Promise<Record<string, unknown>> {
    const provider = request.provider ?? 'none'
    if (!['none', 'openai', 'anthropic'].includes(provider)) throw new Error('Unsupported PCB model provider')
    const rounds = request.rounds ?? 0
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > 100) throw new Error('PCB rounds must be an integer from 0 to 100')
    if (!request.board.toLowerCase().endsWith('.kicad_pcb')) throw new Error('Select a .kicad_pcb board')
    return {
      ...await this.runtime(request),
      board: await checkedPath(request.board, this.settings.allowedRoots, 'file'),
      output: await checkedPath(request.output, this.settings.allowedRoots, 'output'),
      provider, model: request.model ?? '', rounds,
    }
  }
  /** Real geometry, not a mock board. */
  @Remote
  async inspect(agent: Agent, request: InspectRequest): Promise<Json> {
    const board = await checkedPath(request.board, this.settings.allowedRoots, 'file')
    return this.owner(agent).inspect({ board })
  }
  /** Local schematic hierarchy; paths remain within the configured roots. */
  @Remote
  async schematic(agent: Agent, request: SchematicRequest): Promise<Json> {
    if (!request.schematic.toLowerCase().endsWith('.kicad_sch')) throw new Error('Select a .kicad_sch schematic')
    const schematic = await checkedPath(request.schematic, this.settings.allowedRoots, 'file')
    return this.owner(agent).inspectSchematic({ schematic })
  }
  /** KiCad file picker metadata for this deployment's allowed directories. */
  @Remote
  async files(agent: Agent): Promise<Json> { void agent; return designCatalog(this.settings.allowedRoots) }
  /** Starts read-only runtime diagnostics; poll snapshot for completion. */
  @Remote
  async status(agent: Agent, request: StatusRequest): Promise<StartResult> {
    return this.owner(agent).start('status', await this.runtime(request))
  }
  /** Direct user UI action is deliberately model-free. A caller boolean is never consent. */
  @Remote
  async run(agent: Agent, request: RouteRequest): Promise<StartResult> {
    if (request.provider !== undefined && request.provider !== 'none') throw new Error('Model PCB routing must use the agent tool approval flow')
    return this.owner(agent).start('run', await this.routeArgs({ ...request, provider: 'none' }))
  }
  @Remote
  stop(agent: Agent): Promise<Json> { return this.owner(agent).stop() }
  @Remote
  snapshot(agent: Agent): PcbSnapshot { return this.owners.get(agent.id)?.snapshot() ?? { runId: null, state: 'idle', logs: [], result: null } }

  private registerTools(ctx: Context): void {
    const output = {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: Json) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    const board = { type: 'string' as const, required: true as const, description: 'Absolute .kicad_pcb path inside configured allowedRoots.' }

    ctx.tools.register(defineTool({
      name: 'pcb_inspect', description: 'Read actual PCB geometry and counts. Does not route or verify DRC.',
      parameters: { board }, output,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        if (!exec.agent) throw new Error('PCB tools require an owning agent')
        const result = await this.inspect(exec.agent, args)
        // Keep potentially 100,000 geometry records in the UI carrier only.
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const { shapes, source: _source, ...summary } = result
          return { ...summary, previewShapeCount: Array.isArray(shapes) ? shapes.length : 0 }
        }
        return result
      },
    }))
    ctx.tools.register(defineTool({
      name: 'pcb_status', description: 'Check PCB routing runtime. Exit zero means diagnostics ran, not routing readiness.',
      parameters: {}, output,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('PCB tools require an owning agent')
        const owner = this.owner(exec.agent)
        return owner.runToCompletion('status', await this.runtime(args), exec.signal, true)
      },
    }))
    ctx.tools.register(defineTool({
      name: 'pcb_route', description: 'Route a PCB into a new output run directory. Requires a one-action human approval. External model modes send board planning data and may incur API charges; rounds are NOT a spending cap. Credentials are host environment only.',
      parameters: {
        board, output: { type: 'string', required: true, description: 'Output directory inside configured allowedRoots.' },
        provider: { type: 'string', enum: ['none', 'openai', 'anthropic'] },
        model: { type: 'string' }, rounds: { type: 'integer' },
      }, output,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('PCB tools require an owning agent')
        const params = await this.routeArgs(args as ModelRouteRequest)
        exec.signal.throwIfAborted()
        const outcome = await ctx.approval.request({
          agent: exec.agent, toolName: 'pcb_route', callId: exec.callId, signal: exec.signal,
          reason: `Route board ${params.board} to ${params.output}. Provider: ${params.provider}. Model: ${params.model || '(provider default)'}. Rounds: ${params.rounds}. ${params.provider === 'none' ? 'No external model request.' : 'Board planning data will be sent to this provider and API fees may apply; rounds are not a spending limit.'}`,
        })
        if (outcome !== 'allowed-once') throw new Error(`PCB routing approval ${outcome}`)
        exec.signal.throwIfAborted()
        const owner = this.owner(exec.agent)
        return owner.runToCompletion('run', { ...params, model_consent: true }, exec.signal)
      },
    }))
    ctx.tools.register(defineTool({
      name: 'pcb_stop', description: 'Stop only the current PCB process owned by this agent session.',
      parameters: {}, output,
      execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('PCB tools require an owning agent')
        return this.owner(exec.agent).stop()
      },
    }))
  }
}
export default PcbController
