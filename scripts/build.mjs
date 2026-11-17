/** Build against the pinned DSH toolchain; shipped lib needs no install scripts. */
import { readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--dsh-source');
const dsh = resolve(arg >= 0 ? process.argv[arg + 1] : process.env.DSH_SOURCE || '');
const manifest = JSON.parse(await readFile(join(dsh, 'package.json'), 'utf8'));
if (manifest.name !== '@deepseek-ai/dsh-root' || manifest.version !== '0.2.2-rc.1') throw new Error('Use the pinned DeepSeek Harness 0.2.2-rc.1 source toolchain; see docs/development.md');
const require = createRequire(join(dsh, 'package.json'));
const hostRequire = createRequire(join(dsh, 'packages/api/remotes/package.json'));
const config = join(root, 'scripts/.build-config.mts');
const source = `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(dsh, 'package.json'))});
const { clientBundle } = await import(${JSON.stringify(pathToFileURL(join(dsh, 'packages/client/tsdown.client.ts')).href)});
const { decoratorPlugin } = await import(${JSON.stringify(pathToFileURL(join(dsh, 'packages/typert/generator/lib/types/tsdown-plugin.js')).href)});
const client = clientBundle(${JSON.stringify(root)}, [])({});
const browser = client.find(config => config.name.endsWith('/client'));
browser.cwd = ${JSON.stringify(root)};
browser.plugins.unshift({name:'standalone-wire-resolution',resolveId(specifier){
  if(specifier==='@deepseek-ai/dsh-typert-protocol/remote-info') return ${JSON.stringify(hostRequire.resolve('@deepseek-ai/dsh-typert-protocol/remote-info'))};
}});
const peers = new Set(${JSON.stringify(Object.keys(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).peerDependencies))});
export default [browser, {
  cwd:${JSON.stringify(root)},
  entry: {index:'src/index.ts'}, outDir:'lib', format:'esm', platform:'node', target:'es2024', fixedExtension:false, clean:false, dts:false,
  plugins:[decoratorPlugin()], deps:{neverBundle:specifier=>peers.has(specifier) || specifier==='@deepseek-ai/schemastery'}
}];
`;
await mkdir(join(root, 'lib'), { recursive:true });
await writeFile(config, source);
try {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, join(dsh, 'node_modules/tsdown/dist/run.mjs'), '--config', config], {cwd:root, stdio:'inherit', env:{...process.env,NODE_ENV:'production'}});
  if (result.status !== 0) throw new Error('Plugin build failed');
  for (const name of ['typert.host.js','typert.remote-client.js']) await copyFile(join(root,'src/generated',name), join(root,'lib',name));
  await copyFile(join(root,'src/host/transport.cjs'), join(root,'lib/transport.cjs'));
  const client = join(root,'lib/client.js');
  await writeFile(client, (await readFile(client,'utf8')).replace(/\n?\/\/# sourceMappingURL=.*$/mu,'').replace(/^\s*\/\/#(?:region|endregion).*$/gmu,''));
  await rm(join(root,'lib/client.js.map'), {force:true});
  console.log('Built independent host, client, Remote and transport artifacts.');
} finally { await rm(config, {force:true}); }
