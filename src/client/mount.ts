/** PCB plugin seats inside the unmodified, complete Harness application. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@pcbrouteagent/dsh-pcb-tools/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PcbFace } from './contract.ts'
import { PcbController } from './controller.ts'
import { PcbPanel, PcbWorkbench, PcbIcon, PcbResultsTab, PcbResultsAction } from './PcbPanel.tsx'
import { en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'remote', 'remote.pcb']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('pcb', { en, zh }), 'ui-pcb: dictionaries')
  const t = ctx.locale.bind('pcb')
  const controllers = new Map<string, PcbController>()
  const empty = new PcbController(undefined)
  const controller = (sessionId: Parameters<typeof ctx.remote.pcb.snapshot>[0] | undefined): PcbController => {
    if (sessionId === undefined) return empty
    let instance = controllers.get(sessionId)
    if (instance !== undefined) return instance
    instance = new PcbController({
      inspect: request => ctx.remote.pcb.inspect(sessionId, request),
      schematic: request => ctx.remote.pcb.schematic(sessionId, request),
      files: () => ctx.remote.pcb.files(sessionId),
      status: request => ctx.remote.pcb.status(sessionId, request),
      run: request => ctx.remote.pcb.run(sessionId, request),
      stop: () => ctx.remote.pcb.stop(sessionId),
      snapshot: () => ctx.remote.pcb.snapshot(sessionId),
    })
    controllers.set(sessionId, instance)
    return instance
  }
  ctx.effect(() => () => { empty.dispose(); controllers.forEach(instance => { instance.dispose() }); controllers.clear() }, 'ui-pcb: session projections')
  const panelId = 'pcb' as MainPanelId
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: panelId, children: { 'pcb.workbench': { kind: 'single', scope: 'session-maybe' } } }, PcbPanel)
    yield ctx.slots.register({ name: 'pcb.workbench', locale: 'pcb', inject: (sessionId): PcbFace => controller(sessionId).face }, PcbWorkbench)
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: -10, label: () => t('panel'), locale: 'pcb' }, PcbIcon))
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
    const id = 'dsh-pcbagent'
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind: 'pcb-results', multiple: false, priority: 'builtin', title: () => t('results') }), 'ui-pcb: result tab')
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({ name: 'conversation.session.header.actions', id: 'pcb-results', locale: 'pcb', inject: sessionId => ({ openResults: () => { scope.sidebarRight.openTabIn(sessionId, 'pcb-results') } }) }, PcbResultsAction))
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale: 'pcb', inject: (sessionId) => controller(sessionId).face }, PcbResultsTab))
  })
}
