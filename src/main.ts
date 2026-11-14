import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from './config.ts';
import { errorCode, log } from './util.ts';
import { runOnce } from './runner.ts';

const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());
process.once('SIGTERM',()=>controller.abort());
try {
  const args=process.argv.slice(2);
  if(args.some(a=>a!=='--daemon') || args.length>1)throw new Error('Usage: node src/main.ts [--daemon]');
  const config=readConfig();
  const daemon=args.includes('--daemon');
  do {
    const start=Date.now();
    try {
      const ok=await runOnce(config,controller.signal);
      if(!daemon && !ok)process.exitCode=1;
    } catch(e) {
      log('run_failed',{error:errorCode(e)});
      if(!daemon)process.exitCode=1;
    }
    if(!daemon || controller.signal.aborted)break;
    await sleep(Math.max(1000,config.pollIntervalMs-(Date.now()-start)),undefined,{signal:controller.signal}).catch(()=>{});
  }while(!controller.signal.aborted);
} catch(e) {
  // Configuration errors are local validation messages, never HTTP responses.
  const message=e instanceof Error ? e.message : 'Invalid configuration';
  log('configuration_error',{message});process.exitCode=1;
}
