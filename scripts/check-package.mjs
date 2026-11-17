import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
assert.equal(manifest.name,'dsh-pcbagent');
assert.equal(manifest.dsh.bundle.patch,'./cordis.patch.yml');
assert.equal(manifest.engines.dsh,'0.2.2-rc.1');
for(const name of Object.keys(manifest.scripts)) assert.ok(!['prepare','install','postinstall','preinstall'].includes(name));
const npmCli=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].find(candidate=>candidate && existsSync(candidate));
assert.ok(npmCli,'Cannot locate npm; run this check through npm run check');
const packed=spawnSync(process.execPath,[npmCli,'pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8'});
assert.equal(packed.status,0,packed.stderr);
const files=JSON.parse(packed.stdout)[0].files.map(file=>file.path);
for(const required of ['lib/index.js','lib/client.js','lib/transport.cjs','lib/typert.host.js','lib/typert.remote-client.js','backend/route_agent/kicad_specctra.py','backend/route_agent/desktop_bridge/server.py','licenses/LICENSE.md','licenses/PCBRouteAgent-BSD-3-Clause.txt','licenses/NEWSTROKE-LICENSE.txt','licenses/MATERIAL-SYMBOLS-LICENSE.txt']) assert.ok(files.includes(required),`Missing ${required}`);
for(const name of files) {
  assert.ok(!/(?:^|\/)(?:node_modules|__pycache__|\.venv[^/]*|data|workspace|deployment-logs)\//.test(name),`Unexpected state ${name}`);
  assert.ok(!/\.(?:exe|dll|pyc|map)$/.test(name),`Unexpected native/cache/map artifact ${name}`);
  assert.ok(!/(?:^|\/)(?:\.env|\.credentials|data-service\.pid)/.test(name),`Unexpected config ${name}`);
  const data=readFileSync(join(root,name),'utf8');
  assert.ok(!/C:[\\/]Users[\\/]mjjt|\/Users\/[^/]+\/|sk-proj-[A-Za-z0-9_-]{20,}/.test(data),`Machine path or credential in ${name}`);
}
for(const [key, target] of Object.entries(manifest.exports)) if(!key.includes('*')) assert.ok(existsSync(join(root,target)),`Unresolved export ${key}`);
console.log(`Validated publication payload: ${files.length} files; no machine state, source maps or native binaries.`);
