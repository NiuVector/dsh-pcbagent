import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
function client(){
  let registration;
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>{registration=value}}}});
  assert.equal(registration.id,'dsh-pcbagent');
  const imports=[];
  const exports=registration.factory(name=>{
    imports.push(name);
    if(name==='zod') return require('zod');
    // UI imports are consumed only when the injected view activates.
    return {};
  });
  assert.ok(imports.every(name=>!name.startsWith('.') && !name.includes('/remote')));
  return exports;
}

test('independent client owns its Remote and disposes UI before Remote',async()=>{
  const exported=client();
  assert.deepEqual(Array.from(exported.inject),['remote']);
  const events=[];
  const fiber=Promise.resolve();
  fiber.dispose=async()=>{events.push('ui-disposed')};
  const ctx={remote:{$mount:async contribution=>{assert.equal(contribution.package,'dsh-pcbagent');events.push('remote-mounted');return async()=>{events.push('remote-disposed')}}},inject:requirements=>{assert.ok(requirements.includes('remote.pcb'));events.push('ui-injected');return fiber}};
  const dispose=await exported.apply(ctx);
  assert.deepEqual(events,['remote-mounted','ui-injected']);
  await dispose();
  assert.deepEqual(events,['remote-mounted','ui-injected','ui-disposed','remote-disposed']);
});

test('failed UI activation releases the independently mounted Remote',async()=>{
  const exported=client();
  const events=[];
  const fiber=Promise.reject(new Error('UI unavailable'));
  fiber.dispose=async()=>{events.push('ui-disposed')};
  const ctx={remote:{$mount:async()=>async()=>{events.push('remote-disposed')}},inject:()=>fiber};
  await assert.rejects(exported.apply(ctx),/UI unavailable/);
  assert.deepEqual(events,['ui-disposed','remote-disposed']);
});

test('published client carries the renderer and no host-brand registrations',()=>{
  assert.ok(source.includes('kicanvas-load') && source.includes('connect-src'));
  assert.ok(!source.includes('sidebar.brand.name') && !source.includes('sidebar.brand.mark'));
});
