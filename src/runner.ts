import type { Config, Job, TriagePayload } from './types.ts';
import { destinations, deliver } from './alerts.ts';
import { extractBounty } from './bounty.ts';
import { eligible, GitHub, LANGUAGES, searchQueries } from './github.ts';
import { Http, HttpError } from './http.ts';
import { StateStore } from './state.ts';
import { triage } from './triage.ts';
import { errorCode, hash, log } from './util.ts';

export async function runOnce(config: Config, parent = new AbortController().signal): Promise<boolean> {
  const deadline = new AbortController();
  const timer = setTimeout(()=>deadline.abort(new Error('Run budget exceeded')),config.runBudgetMs);
  const signal=AbortSignal.any([parent,deadline.signal]);
  let store: StateStore | null=null;
  let healthy=true;
  try {
    store=await StateStore.open(config.stateDir);
    const http=new Http({signal,timeoutMs:config.requestTimeoutMs,maxBytes:config.maxResponseBytes});
    const github=new GitHub(http,config), state=store.state;
    const now=Date.now(), through=Math.floor(now/1000)*1000;
    // updated_at includes creation. Overlap also absorbs delayed search indexing.
    const from=Math.min(through-15*60000,state.discoveredThrough ? Date.parse(state.discoveredThrough)-15*60000 : through-15*60000);
    log('run_started',{from:new Date(from).toISOString(),through:new Date(through).toISOString()});
    try {
      for (const query of searchQueries()) {
        for await (const issue of github.search(query,from,through)) {
          const key=String(issue.id), old=state.jobs[key];
          if (!old) {
            state.jobs[key]={repo:issue.repo,number:issue.number,updatedAt:issue.updatedAt,pending:true,
              touchedAt:new Date().toISOString(),failures:0,retryAt:new Date(0).toISOString(),alert:null,delivered:{}};
            await store.save();
          } else if (Date.parse(issue.updatedAt)>Date.parse(old.updatedAt)) {
            old.updatedAt=issue.updatedAt;old.pending=true;old.alert=null;old.failures=0;
            old.retryAt=new Date(0).toISOString();old.touchedAt=new Date().toISOString();
            await store.save();
          }
        }
      }
      state.discoveredThrough=new Date(through).toISOString();
      await store.save();
    } catch(e) {
      healthy=false;log('discovery_failed',{error:errorCode(e)});
      // Retain the previous watermark and all jobs discovered before the failure.
    }
    const channels=destinations(config);
    const pending=Object.entries(state.jobs).filter(([,job])=>job.pending && Date.parse(job.retryAt)<=Date.now())
      .sort(([,a],[,b])=>Date.parse(a.retryAt)-Date.parse(b.retryAt));
    for (const [key,job] of pending) {
      if(signal.aborted){healthy=false;break;}
      try {
        const repository=await github.repository(job.repo);
        if(repository.private || repository.archived || !LANGUAGES.has(repository.language)) {job.pending=false;await store.save();continue;}
        const {issue,comments}=await github.snapshot(job.repo,job.number);
        if (!eligible(issue)) {job.pending=false;job.alert=null;await store.save();continue;}
        job.updatedAt=issue.updatedAt;
        const bounty=extractBounty(issue,comments,config.trustedBots);
        if(!bounty || bounty.cents<config.minBountyCents) {job.pending=false;job.alert=null;await store.save();continue;}
        if(channels.every(c=>job.delivered[`${bounty.cents}:${c.id}`])) {job.pending=false;await store.save();continue;}
        if(!job.alert || job.alert.issue.updatedAt!==issue.updatedAt || job.alert.bounty.cents!==bounty.cents) {
          const context=await github.context(job.repo);
          const payload: TriagePayload={schemaVersion:1,issue,comments,bounty,context};
          const prediction=await triage(http,config,payload);
          job.alert={id:hash(`${key}:${issue.updatedAt}:${bounty.cents}:${context.commit}`),issue,bounty,
            triage:prediction,techStack:context.techStack,commit:context.commit};
          await store.save();
        }
        if(job.alert.triage.score<config.minScore){job.pending=false;await store.save();continue;}
        // Recheck assignment/closure/version immediately before external delivery.
        const current=await github.issue(job.repo,job.number);
        if(!eligible(current)){job.pending=false;job.alert=null;await store.save();continue;}
        if(current.updatedAt!==issue.updatedAt){job.alert=null;throw new Error('Issue changed during triage');}
        for(const channel of channels) {
          const receipt=`${bounty.cents}:${channel.id}`;
          if(job.delivered[receipt])continue;
          await deliver(http,config,channel,job.alert);
          job.delivered[receipt]=new Date().toISOString();
          await store.save();
          log('alert_delivered',{repo:job.repo,issue:job.number,cents:bounty.cents,score:job.alert.triage.score,channel:channel.kind});
        }
        job.pending=false;job.failures=0;job.touchedAt=new Date().toISOString();
        await store.save();
      } catch(e) {
        if(e instanceof HttpError && [404,410].includes(e.status)) {
          // Only treat missing GitHub issues/repos as terminal; other services can also return 404.
          if(e.message.startsWith('github:')) {job.pending=false;await store.save();continue;}
        }
        healthy=false;job.failures++;
        job.retryAt=new Date(Date.now()+Math.min(6*3600000,300000*2**Math.min(job.failures-1,7))).toISOString();
        job.touchedAt=new Date().toISOString();
        await store.save();
        log('job_deferred',{repo:job.repo,issue:job.number,attempt:job.failures,error:errorCode(e),retryAt:job.retryAt});
      }
    }
    for (const [key,job] of Object.entries(state.jobs))
      if(!job.pending && Date.parse(job.touchedAt)<Date.now()-config.retentionDays*86400000)delete state.jobs[key];
    await store.save();
    log('run_finished',{healthy,pending:Object.values(state.jobs).filter((j:Job)=>j.pending).length});
    return healthy;
  } finally {
    clearTimeout(timer);
    if(store)await store.close();
  }
}
