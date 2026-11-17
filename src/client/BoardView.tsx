import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Board, DocumentKind, Schematic } from './contract.ts'
import { viewerDocument } from './engine/viewer-document.ts'
import css from './Pcb.module.css'

/** A DSH pane around the isolated native KiCanvas document renderer. */
export function DocumentPane({ document: doc, kind, t, onOpen, disabled = false }: {
  document: Board | Schematic | null; kind: DocumentKind; onOpen?: () => void; disabled?: boolean
} & PropsLocale<'pcb'>) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const nonce = useMemo(() => crypto.randomUUID(), [doc?.source, attempt])
  const html = useMemo(() => viewerDocument(nonce), [nonce])
  const label = t(kind === 'board' ? 'pcbPane' : 'schematicPane')
  useEffect(() => {
    if (doc === null) return
    setStatus('loading'); setError('')
    const timeout = setTimeout(() => { setStatus('error'); setError(t('rendererTimeout')) }, 30000)
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.data === null || typeof event.data !== 'object') return
      const data = event.data as Record<string, unknown>
      if (data['nonce'] !== nonce) return
      if (data['type'] === 'kicanvas-ready') {
        if (typeof doc.source !== 'string') { clearTimeout(timeout); setStatus('error'); setError(t('rendererSourceMissing')); return }
        const sources = 'sources' in doc ? doc.sources : [{ name: doc.name, source: doc.source }]
        frame.current?.contentWindow?.postMessage({ type: 'kicanvas-load', nonce, source: doc.source, name: doc.name, kind, sources }, '*')
      } else if (data['type'] === 'kicanvas-loaded') { clearTimeout(timeout); setStatus('ready') }
      else if (data['type'] === 'kicanvas-error') {
        clearTimeout(timeout); setStatus('error'); setError(typeof data['message'] === 'string' ? data['message'].slice(0, 300) : t('rendererFailed'))
      }
    }
    window.addEventListener('message', receive)
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive) }
  }, [doc, kind, nonce, t])
  const command = (value: 'fit' | 'flip'): void => { frame.current?.contentWindow?.postMessage({ type: 'kicanvas-command', nonce, command: value }, '*') }
  return <section className={css.documentPane} aria-label={label}>
    <div className={css.paneHeader}>
      <div className={css.paneIdentity}><span className={css.paneKind}>{label}</span>{doc !== null && <Tooltip label={doc.path} onlyWhenClipped portal side="bottom"><span className={css.fileName}>{doc.name}</span></Tooltip>}</div>
      <div className={css.paneActions}>
        {doc !== null && <Button size="sm" variant="toolbar" disabled={status !== 'ready'} onClick={() => { command('fit') }}>{t('fit')}</Button>}
        {doc !== null && kind === 'board' && <Button size="sm" variant="toolbar" disabled={status !== 'ready'} onClick={() => { command('flip') }}>{t('flip')}</Button>}
        {onOpen && <Button size="sm" variant="toolbar" disabled={disabled} onClick={onOpen}>{t('open')}</Button>}
      </div>
    </div>
    <div className={css.canvas}>
      {doc === null ? <div className={css.viewerPlaceholder}><span className={css.emptyTitle}>{t(kind === 'board' ? 'emptyBoard' : 'emptySchematic')}</span><span>{t(kind === 'board' ? 'boardHint' : 'schematicHint')}</span>{onOpen && <Button variant="outline" disabled={disabled} onClick={onOpen}>{t(kind === 'board' ? 'chooseBoard' : 'chooseSchematic')}</Button>}</div> : <>
        <iframe key={nonce} ref={frame} title={t(kind === 'board' ? 'geometryLabel' : 'schematicLabel')} className={css.viewerFrame} sandbox="allow-scripts" srcDoc={html} />
        {status === 'loading' && <div className={css.viewerOverlay} role="status" aria-label={t('rendererLoading')}><StateDot state="ongoing" size={20} /></div>}
        {status === 'error' && <div className={css.viewerOverlay} role="alert"><span>{t('rendererFailed')}</span><span>{error}</span><Button variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('rendererRetry')}</Button></div>}
      </>}
    </div>
  </section>
}

/** Legacy same-package fixture entry for the board renderer. */
export function BoardView({ board, t }: { board: Board | null } & PropsLocale<'pcb'>) { return <DocumentPane document={board} kind="board" t={t} /> }
