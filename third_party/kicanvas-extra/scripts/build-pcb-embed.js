import { bundle } from './bundle.js';
const { context } = await bundle({
    entryPoints: ['src/pcb-embed.ts'],
    outfile: 'build/kicanvas-pcb.js',
    minify: true,
    legalComments: 'inline',
});
await context.rebuild();
await context.dispose();
