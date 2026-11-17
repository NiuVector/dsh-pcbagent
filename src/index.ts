/** Independent DSH bundle entry; paths remain host configuration. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { PcbController } from './host/index.ts'
import type { Config as PcbConfig } from './host/index.ts'

export const inject = PcbController.inject
export const Config = z.object({
  pcbRoot: z.string().default(fileURLToPath(new URL('../backend/', import.meta.url))),
  pythonExecutable: z.string(),
  runtimePath: z.string(),
  allowedRoots: z.array(z.string()).default([]),
})

export function apply(ctx: Context, config: PcbConfig): void {
  ctx.plugin(PcbController, config)
}
