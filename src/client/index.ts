/** Mount the plugin's own Remote before its document workspace. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '../generated/typert.remote-client.js'
import { apply as registerUi, inject as uiInject } from './mount.ts'

export const inject = ['remote']
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  const ui = ctx.inject(uiInject, registerUi)
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
