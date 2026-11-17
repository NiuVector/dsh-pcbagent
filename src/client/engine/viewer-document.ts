import { KICANVAS_ENGINE } from './kicanvas-engine.ts'
import { MATERIAL_SYMBOLS } from './kicanvas-font.ts'

/** Opaque-origin viewer: board text arrives only through a window-bound handshake. */
export function viewerDocument(nonce: string): string {
  const token = JSON.stringify(nonce).replaceAll('<', '\\u003c')
  const engine = KICANVAS_ENGINE.replaceAll('</script', '<\\/script')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><style>@font-face{font-family:"Material Symbols Outlined";font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${MATERIAL_SYMBOLS}) format("woff2")}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101010}kicanvas-embed{display:block;width:100%;height:100%;aspect-ratio:auto}</style></head><body><script type="module">
${engine}
const nonce = ${token};
const send = (type, message) => parent.postMessage({type, nonce, message}, '*');
window.addEventListener('error', event => send('kicanvas-error', event.message));
window.addEventListener('unhandledrejection', event => send('kicanvas-error', String(event.reason)));
let activeViewer = null;
window.addEventListener('message', event => {
  if (event.source !== parent || !event.data || event.data.nonce !== nonce) return;
  if (event.data.type === 'kicanvas-command' && activeViewer) {
    if (event.data.command === 'fit') activeViewer.zoom_to_page();
    else if (event.data.command === 'flip' && typeof activeViewer.flip_view === 'function') activeViewer.flip_view();
    return;
  }
  if (event.source !== parent || !event.data || event.data.type !== 'kicanvas-load' || event.data.nonce !== nonce || typeof event.data.source !== 'string' || typeof event.data.name !== 'string') return;
  if (event.data.kind !== 'board' && event.data.kind !== 'schematic') return;
  const viewer = document.createElement('kicanvas-embed');
  viewer.setAttribute('controls', 'full');
  viewer.setAttribute('controlslist', 'nooverlay nodownload nohelp nopreferences nofullscreen noflipview nobottomtoolbar');
  const files = Array.isArray(event.data.sources) ? event.data.sources : [{name:event.data.name,source:event.data.source}];
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || typeof file.source !== 'string') return;
    const source = document.createElement('kicanvas-source');
    source.setAttribute('name', file.name);
    source.setAttribute('type', event.data.kind);
    source.textContent = file.source;
    viewer.append(source);
  }
  const kind = event.data.kind;
  viewer.addEventListener('kicanvas:load', async () => {
    try {
      const app = viewer.shadowRoot?.querySelector(kind === 'board' ? 'kc-board-app' : 'kc-schematic-app');
      if (!app) throw new Error('Document renderer was not initialized');
      await app.viewerReady;
      await app.viewer.loaded;
      activeViewer = app.viewer;
      send('kicanvas-loaded');
    } catch (error) { send('kicanvas-error', String(error)); }
  });
  viewer.addEventListener('kicanvas:error', event => send('kicanvas-error', event.detail?.message));
  document.body.replaceChildren(viewer);
});
send('kicanvas-ready');
</script></body></html>`
}
