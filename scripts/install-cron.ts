import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(/[\r\n]/.test(root))throw new Error('Installation path cannot contain newlines');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const marker='# bounty-watch:'+createHash('sha256').update(root).digest('hex').slice(0,16);
const command=`cd ${quote(root)} && ${quote(process.execPath)} --env-file=.env src/main.ts >> ${quote(root+'/data/cron.log')} 2>&1`;
const line='*/5 * * * * '+command.replaceAll('%','\\%')+' '+marker;
if(process.argv.includes('--print'))process.stdout.write(line+'\n');
else {
  if(!existsSync(root+'/.env'))throw new Error('Create .env from .env.example and configure credentials before installing cron');
  await mkdir(root+'/data',{recursive:true,mode:0o700});
  const current=spawnSync('crontab',['-l'],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
  if(current.error)throw current.error;
  if(current.status!==0 && !/no crontab for/i.test(current.stderr))throw new Error('Could not read the existing crontab');
  const previous=current.status===0 ? current.stdout : '';
  const lines=previous.split('\n').filter(s=>!s.endsWith(marker));
  while(lines.at(-1)==='')lines.pop();
  const updated=spawnSync('crontab',['-'],{input:[...lines,line,''].join('\n'),encoding:'utf8'});
  if(updated.error || updated.status!==0)throw new Error('Could not install crontab');
  process.stdout.write('Installed one five-minute job. Logs: '+root+'/data/cron.log\n');
}
