import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,copyFile,writeFile,readFile,rm } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
test('cron installation preserves other jobs and is idempotent', async()=>{
  const root=await mkdtemp(join(tmpdir(),'bounty-cron-'));
  try {
    await mkdir(root+'/scripts');await mkdir(root+'/bin');
    await copyFile(new URL('../scripts/install-cron.ts',import.meta.url),root+'/scripts/install-cron.ts');
    await writeFile(root+'/package.json','{"type":"module"}');await writeFile(root+'/.env','');
    const crontab=root+'/crontab';
    await writeFile(crontab,'0 1 * * * /usr/bin/true # existing-job\n');
    await writeFile(root+'/bin/crontab','#!/bin/sh\nif [ "$1" = "-l" ]; then cat "$CRON_TEST_FILE"; else cat > "$CRON_TEST_FILE"; fi\n',{mode:0o700});
    for(let i=0;i<2;i++) {
      const result=spawnSync(process.execPath,[root+'/scripts/install-cron.ts'],{encoding:'utf8',
        env:{...process.env,PATH:root+'/bin:'+dirname(process.execPath)+':/usr/bin:/bin',CRON_TEST_FILE:crontab}});
      assert.equal(result.status,0,result.stderr);
    }
    const lines=(await readFile(crontab,'utf8')).trim().split('\n');
    assert.equal(lines.length,2);assert.equal(lines[0],'0 1 * * * /usr/bin/true # existing-job');
    assert.match(lines[1]??'',/^\*\/5 \* \* \* \*/);
  } finally {await rm(root,{recursive:true,force:true});}
});
