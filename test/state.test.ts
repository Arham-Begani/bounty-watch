import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.ts';
test('state survives reopening and rejects overlapping owners', async () => {
  const directory = await mkdtemp(join(tmpdir(),'bounty-test-'));
  const first = await StateStore.open(directory);
  try {
    await assert.rejects(StateStore.open(directory), /lock/);
    first.state.discoveredThrough = '2026-11-14T00:00:00Z';
    await first.save();
    await first.close();
    const second = await StateStore.open(directory);
    assert.equal(second.state.discoveredThrough,'2026-11-14T00:00:00Z');
    await second.close();
    assert.equal(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).version,1);
    await writeFile(join(directory,'state.json'),'{bad json');
    await assert.rejects(StateStore.open(directory));
  } finally { await first.close(); await rm(directory,{recursive:true,force:true}); }
});
test('kernel releases the state lock after SIGKILL without manual cleanup', {timeout:10000}, async () => {
  const {spawn}=await import('node:child_process');
  const directory=await mkdtemp(join(tmpdir(),'bounty-crash-'));
  const moduleUrl=new URL('../src/state.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',
    `import {StateStore} from ${JSON.stringify(moduleUrl)}; await StateStore.open(${JSON.stringify(directory)}); console.log('locked'); setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Lock child exited before becoming ready');})]);
    await assert.rejects(StateStore.open(directory),/lock/);
    child.kill('SIGKILL');await once(child,'exit');
    const recovered=await StateStore.open(directory);
    await recovered.close();
  } finally {child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}
});
