import { useEffect, useState } from 'react'
import { Button, Input, Modal, SegmentedControl, StateDot, IconFolderOpenOutlineRegular, IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PcbKey } from './locales.ts'
import type { DesignFile, DocumentKind, PcbFace, PcbProps } from './contract.ts'
import { DocumentPane } from './BoardView.tsx'
import css from './Pcb.module.css'

export function PcbPanel({ renderSlot }: PropsRuntime<'main'> & PropsRenderSlots<'pcb.workbench'>) { return renderSlot('pcb.workbench', {}) }
export function PcbIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconLayersOutlineRegular size={size} /> }
export function PcbBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>) { return <IconLayersOutlineRegular size={size} /> }
export function PcbBrandName({ t }: PropsLocale<'pcb'>) { return <span>{t('brand')}</span> }

type ViewMode = 'both' | 'schematic' | 'board'
type Picker = 'project' | DocumentKind

/** DSH document workspace: original schematic and board share one compact operation bar. */
export function PcbWorkbench({ usePcb, t, available, setPath, inspect, inspectSchematic, refreshFiles, openDesign, status, route, stop, refresh, dismissError, activate }: PcbProps) {
  const state = usePcb(snapshot => snapshot)
  const [view, setView] = useState<ViewMode>('both')
  const [picker, setPicker] = useState<Picker | null>(null)
  const [settings, setSettings] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let release: (() => void) | undefined
    const sync = (): void => { if (document.visibilityState === 'hidden') { release?.(); release = undefined } else release ??= activate() }
    sync(); document.addEventListener('visibilitychange', sync)
    return () => { document.removeEventListener('visibilitychange', sync); release?.() }
  }, [activate])
  const running = ['starting', 'running', 'stopping', 'unknown'].includes(state.run.state)
  const locked = state.pending || running || !available
  // Readiness belongs to the workspace; validation belongs to its saved run report.
  const stateKey: PcbKey = state.pending ? 'pending' : state.run.state === 'unknown' ? 'uncertain' : running ? 'running' : ({ failed: 'failed', verified: 'idle', checked: 'checked', cancelled: 'cancelled', unverified: 'unverified', completed: 'done' } as Record<string, PcbKey>)[state.run.state] ?? 'idle'
  const showPicker = (kind: Picker): void => { setPicker(kind); setQuery(''); void refreshFiles() }
  const choose = async (file: DesignFile): Promise<void> => { if (await openDesign(file, picker === 'project' || picker === null ? undefined : picker)) setPicker(null) }
  const candidates = state.files.filter(file => file.kind === picker && (file.name + file.relativePath).toLowerCase().includes(query.toLowerCase()))
  const modes = [{ value: 'both' as const, label: t('dualView') }, { value: 'schematic' as const, label: t('schematicPane') }, { value: 'board' as const, label: t('pcbPane') }]
  return <div className={css.page}>
    <header className={css.workbenchHeader}>
      <div className={css.titleGroup}><h1>{state.projectName || t('panel')}</h1><span className={css.projectContext}>{t('designWorkspace')}</span></div>
      <div className={css.headerActions}><Button size="sm" variant="outline" disabled={locked} icon={<IconFolderOpenOutlineRegular size={16} />} onClick={() => { showPicker('project') }}>{t('openProject')}</Button><Button size="sm" variant="toolbar" disabled={!available} onClick={() => { setResultsOpen(true) }}>{t('results')}</Button></div>
    </header>
    <div className={css.workspaceBar}>
      <SegmentedControl id="eda-view" label={t('viewMode')} value={view} options={modes} onChange={setView} />
      <div className={css.commandActions}>
        <span className={css.runState} role="status"><StateDot state={running || state.pending ? 'ongoing' : state.run.state === 'failed' ? 'error' : 'idle'} />{t(stateKey)}</span>
        <Button size="sm" variant="toolbar" disabled={locked} onClick={() => { setSettings(true) }}>{t('routingSettings')}</Button>
        {running ? <Button size="sm" variant="primary" disabled={state.pending || state.run.state === 'stopping'} onClick={() => { void stop() }}>{t('stop')}</Button> : <Button size="sm" variant="primary" disabled={locked || state.board === null || state.paths.output === ''} onClick={() => { void route() }}>{t('route')}</Button>}
      </div>
    </div>
    {!available && <p className={css.notice} role="status">{t('unavailable')}</p>}
    {state.error !== null && picker === null && <div className={css.error} role="alert"><span>{state.error}</span><Button size="sm" onClick={dismissError}>{t('close')}</Button></div>}
    {state.pollError !== null && picker === null && <div className={css.error} role="alert"><span>{t(state.refreshState === 'paused' ? 'refreshPaused' : 'refreshRetrying')} · {state.pollError}</span><Button size="sm" disabled={!available || state.pending} onClick={() => { void refresh() }}>{t('refresh')}</Button></div>}
    <div id={`eda-view-${view}-panel`} role="tabpanel" aria-labelledby={`eda-view-${view}`} className={`${css.views} ${view === 'both' ? css.dualViews : css.singleView}`}>
      <div className={css.paneSlot} hidden={view === 'board'}><DocumentPane document={state.schematic} kind="schematic" t={t} disabled={locked} onOpen={() => { showPicker('schematic') }} /></div>
      <div className={css.paneSlot} hidden={view === 'schematic'}><DocumentPane document={state.board} kind="board" t={t} disabled={locked} onOpen={() => { showPicker('board') }} /></div>
    </div>
    <footer className={css.statusBar}>
      <span>{state.schematic ? `${t('schematicPane')} · ${state.schematic.symbols} ${t('symbols')} · ${state.schematic.sheets} ${t('sheets')}` : t('schematicNotLoaded')}</span>
      <span>{state.board ? `${t('pcbPane')} · ${state.board.footprints} ${t('footprints')} · ${state.board.pads} ${t('pads')} · ${state.board.vias} ${t('vias')}` : t('boardNotLoaded')}</span>
    </footer>
    <Modal open={picker !== null} onClose={() => { setPicker(null) }} title={t(picker === 'board' ? 'chooseBoard' : picker === 'schematic' ? 'chooseSchematic' : 'openProject')} closeLabel={t('close')} description={t('catalogHint')} className={css.projectModal!}>
      <Input aria-label={t('searchDesigns')} placeholder={t('searchDesigns')} value={query} onChange={event => { setQuery(event.target.value) }} data-modal-autofocus />
      {state.error !== null && <p role="alert" className={css.modalError}>{state.error}</p>}
      <div className={css.fileList}>
        {state.pending ? <div className={css.catalogState} role="status" aria-label={t('pending')}><StateDot state="ongoing" size={20} /></div> : candidates.length === 0 ? <p className={css.catalogState}>{t('noDesignFiles')}</p> : candidates.map(file => <Button key={file.path} className={css.projectRow} disabled={locked} onClick={() => { void choose(file) }}><IconFolderOpenOutlineRegular size={18} /><span><strong>{file.name}</strong><small>{file.relativePath}</small></span><span className={css.fileKind}>{t(file.kind === 'project' ? 'projectFile' : file.kind === 'schematic' ? 'schematicPane' : 'pcbPane')}</span></Button>)}
      </div>
      <details className={css.manualPaths}><summary>{t('openByPath')}</summary><div className={css.settingsFields}>
        <label htmlFor="eda-schematic-path">{t('schematicPane')}</label><div className={css.pathField}><Input id="eda-schematic-path" value={state.paths.schematic} disabled={locked} placeholder={t('schematicPlaceholder')} onChange={event => { setPath('schematic', event.target.value) }} /><Button disabled={locked || state.paths.schematic === ''} onClick={() => { void inspectSchematic().then(() => { setPicker(null) }) }}>{t('inspect')}</Button></div>
        <label htmlFor="eda-board-path">{t('pcbPane')}</label><div className={css.pathField}><Input id="eda-board-path" value={state.paths.board} disabled={locked} placeholder={t('boardPlaceholder')} onChange={event => { setPath('board', event.target.value) }} /><Button disabled={locked || state.paths.board === ''} onClick={() => { void inspect().then(() => { setPicker(null) }) }}>{t('inspect')}</Button></div>
      </div></details>
    </Modal>
    <Modal open={settings} onClose={() => { setSettings(false) }} title={t('routingSettings')} closeLabel={t('close')} description={t('outputHint')} footer={<Button variant="primary" onClick={() => { setSettings(false) }}>{t('doneSettings')}</Button>}>
      <div className={css.settingsFields}><label htmlFor="pcb-output">{t('output')}</label><Input id="pcb-output" value={state.paths.output} disabled={locked} onChange={event => { setPath('output', event.target.value) }} /><Button variant="outline" disabled={locked} onClick={() => { void status() }}>{t('status')}</Button></div>
    </Modal>
    <Modal open={resultsOpen} onClose={() => { setResultsOpen(false) }} title={t('results')} closeLabel={t('close')} className={css.projectModal!}>
      <PcbResults usePcb={usePcb} t={t} activate={activate} refresh={refresh} available={available} compact />
    </Modal>
  </div>
}

type PcbResultsProps = Pick<InjectFace<PcbFace>, 'usePcb' | 'activate' | 'refresh' | 'available'> & PropsLocale<'pcb'>
function resultMetric(field: 'drcErrors' | 'drcWarnings' | 'length' | 'vias', data: Record<string, unknown>, t: PcbResultsProps['t']): string {
  let value: unknown = field === 'drcErrors' ? data['drc_errors'] : data[field]
  if (field === 'drcWarnings') value = typeof data['drc'] === 'number' && typeof data['drc_errors'] === 'number' && data['drc'] >= data['drc_errors'] ? data['drc'] - data['drc_errors'] : undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return t('unknown')
  return field === 'length' ? t('millimeters').replace('{value}', value.toFixed(2)) : String(value)
}
export function PcbResultsTab({ useTabInfo, ...props }: PropsRuntime<'sidebar.right.pane.tab'> & PcbResultsProps) {
  const { tab } = useTabInfo()
  return <PcbResults {...props} visible={tab.visible} />
}
export function PcbResults({ usePcb, t, activate, refresh, available, visible = true, compact = false }: PcbResultsProps & { visible?: boolean; compact?: boolean }) {
  useEffect(() => {
    if (!visible) return
    let release: (() => void) | undefined
    const sync = (): void => {
      if (document.visibilityState === 'hidden') { release?.(); release = undefined }
      else release ??= activate()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { document.removeEventListener('visibilitychange', sync); release?.() }
  }, [activate, visible])
  const { run, pending, refreshState, pollError } = usePcb(state => state)
  const result = run.result
  const summary = result?.['summary']
  const data = typeof summary === 'object' && summary !== null ? summary as Record<string, unknown> : null
  return <section className={css.results}>
    <div className={css.header}>{!compact && <h2>{t('results')}</h2>}<Button size="sm" disabled={!available || pending} onClick={() => { void refresh() }}>{t('refresh')}</Button></div>
    {pollError !== null && <p role="alert">{t(refreshState === 'paused' ? 'refreshPaused' : 'refreshRetrying')} · {pollError}</p>}
    {data === null ? <p>{t('none')}</p> : <dl>{(['drcErrors', 'drcWarnings', 'length', 'vias'] as const).map(field => <div key={field}><dt>{t(field)}</dt><dd>{resultMetric(field, data, t)}</dd></div>)}<div><dt>{t('verification')}</dt><dd>{t(data['verified'] === true && data['clean'] === true ? 'verified' : 'unverified')}</dd></div></dl>}
    {typeof result?.['output_dir'] === 'string' && <p className={css.path}>{result['output_dir']}</p>}
    {run.logs.length > 0 && <details><summary>{t('logs')}</summary><pre>{run.logs.join('\n')}</pre></details>}
  </section>
}

/** Opens a result tab through the official docking service for this Session. */
export function PcbResultsAction({ openResults, t }: { openResults(): void } & PropsLocale<'pcb'>) {
  return <Button variant="toolbar" onClick={openResults}>{t('results')}</Button>
}
