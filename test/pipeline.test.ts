import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../src/runner.ts';
import { readConfig } from '../src/config.ts';
import { discordMessage, telegramMessage } from '../src/alerts.ts';
import type { Alert, State } from '../src/types.ts';

const result = {score:8,solvability:8,reproductionClarity:9,summary:'Reproducible parser bug',
  reproductionSteps:['Run supplied example'], uncertainty:'Source code has not been inspected.',
  predictedFiles:[{path:'src/a.ts',reason:'Parser entry point'},{path:'src/b.ts',reason:'Caller'}]};
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), blob = 'c'.repeat(40);
test('complete HTTP pipeline persists alerts and resumes only failed destinations', async () => {
  const dir = await mkdtemp(join(tmpdir(),'bounty-pipeline-'));
  const now = new Date().toISOString();
  const rawIssue = {id:10,number:1,state:'open',title:'Fix parser',body:'Bounty: $250',
    user:{login:'owner'},author_association:'OWNER',labels:[{name:'bounty'}],assignees:[],
    created_at:now,updated_at:now,comments:1,repository_url:'https://api.github.com/repos/acme/app'};
  let triages=0,alerts=0,telegrams=0,searches=0,failDelivery=true;
  const captured: Record<string,unknown>[] = [];
  const server = createServer(async (req,res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (value:unknown,status=200) => {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      if (url.pathname === '/search/issues') {searches++;return send({total_count:1,incomplete_results:false,items:[rawIssue]});}
      if (url.pathname === '/repos/acme/app/issues/1') return send(rawIssue);
      if (url.pathname.endsWith('/comments')) return send([{id:101,body:'Reproduce with empty string',user:{login:'reporter'},author_association:'NONE',created_at:now,updated_at:now}]);
      if (url.pathname === '/repos/acme/app') return send({full_name:'acme/app',language:'TypeScript',private:false,archived:false,default_branch:'main'});
      if (url.pathname.endsWith('/commits/main')) return send({sha:commit,commit:{tree:{sha:tree}}});
      if (url.pathname.includes('/git/trees/')) return send({truncated:false,tree:[
        {path:'package.json',type:'blob',sha:blob,mode:'100644'},
        ...(url.search ? [{path:'src/a.ts',type:'blob',sha:blob,mode:'100644'},{path:'src/b.ts',type:'blob',sha:blob,mode:'100644'}]
          : [{path:'src',type:'tree',sha:tree,mode:'040000'}]),
      ]});
      if (url.pathname.includes('/git/blobs/')) {
        const text='{"dependencies":{"react":"19.0.0"}}';
        return send({encoding:'base64',content:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text)});
      }
      let body='';for await(const chunk of req) body+=String(chunk);
      if (url.pathname === '/triage') {
        triages++;const envelope=JSON.parse(body);captured.push(envelope);
        assert.equal(envelope.payload.issue.body,'Bounty: $250');
        assert.equal(envelope.payload.comments.length,1);
        assert.ok(envelope.payload.context.filePaths.includes('src/b.ts'));
        return send(result);
      }
      if (url.pathname === '/discord') {
        alerts++;assert.equal(url.searchParams.get('wait'),'true');
        const message=JSON.parse(body);assert.deepEqual(message.allowed_mentions,{parse:[]});
        assert.match(JSON.stringify(message),/\$250\.00/);
        return send({id:'message-1'});
      }
      if(url.pathname === '/telegram') {
        telegrams++;
        if(failDelivery)return send({ok:false},400);
        return send({ok:true,result:{message_id:1}});
      }
      send({error:'not found'},404);
    } catch(e) {res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address && typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  const realFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>realFetch(String(input).startsWith('https://api.telegram.org/') ? base+'/telegram' : input,init);
  const config={...readConfig({GITHUB_TOKEN:'test',GITHUB_API_URL:base,LLM_MODE:'webhook',LLM_WEBHOOK_URL:base+'/triage',DISCORD_WEBHOOK_URL:base+'/discord',TELEGRAM_BOT_TOKEN:'12345:test-token',TELEGRAM_CHAT_ID:'12345',STATE_DIR:dir}),searchIntervalMs:0};
  try {
    assert.equal(await runOnce(config),false);
    assert.equal(triages,1);assert.equal(alerts,1);assert.equal(telegrams,1);
    const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8')) as State;
    assert.equal(saved.jobs['10']?.pending,true);
    assert.equal(saved.jobs['10']?.alert?.bounty.cents,25000);
    // Make the retained job due, as if five minutes had passed.
    const {writeFile}=await import('node:fs/promises');
    saved.jobs['10']!.retryAt='1970-01-01T00:00:00Z';
    await writeFile(join(dir,'state.json'),JSON.stringify(saved));
    failDelivery=false;
    assert.equal(await runOnce(config),true);
    assert.equal(triages,1);assert.equal(alerts,1);assert.equal(telegrams,2);
    assert.equal(await runOnce(config),true);
    assert.equal(triages,1);assert.equal(alerts,1);assert.equal(telegrams,2);assert.equal(searches,33);
    const completed=JSON.parse(await readFile(join(dir,'state.json'),'utf8')) as State;
    assert.equal(completed.jobs['10']?.pending,false);
    const alert=completed.jobs['10']?.alert as Alert;
    assert.ok(JSON.stringify(discordMessage(alert,config)).length<6000);
    assert.match(telegramMessage(alert,config),/<pre>/);
    assert.equal(captured.length,1);
  } finally {globalThis.fetch=realFetch;server.close();await once(server,'close');await rm(dir,{recursive:true,force:true});}
});
test('Discord embeds stay within field and aggregate limits with long model text',()=>{
  const text='*'.repeat(1200), path='a_'.repeat(250);
  const alert:Alert={id:'a'.repeat(64),commit:'a'.repeat(40),techStack:[text],
    issue:{id:1,number:1,repo:'acme/app',state:'open',assignees:[],commentCount:0,isPullRequest:false,title:text,body:'',
      author:'owner',authorAssociation:'OWNER',createdAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-14T00:00:00Z',url:'https://github.com/acme/app/issues/1',labels:['bounty']},
    bounty:{cents:25000,currency:'USD',evidence:text,sourceUrl:'https://github.com/acme/app/issues/1'},
    triage:{...result,summary:text,uncertainty:text,predictedFiles:[{path,reason:text.slice(0,800)},{path:path+'b',reason:text.slice(0,800)},{path:path+'c',reason:text.slice(0,800)}]}};
  const config=readConfig({GITHUB_TOKEN:'test',LLM_MODE:'webhook',LLM_WEBHOOK_URL:'http://127.0.0.1/triage',DISCORD_WEBHOOK_URL:'http://127.0.0.1/discord'});
  const message=discordMessage(alert,config) as {embeds:{title:string;description:string;fields:{name:string;value:string}[];footer:{text:string}}[]};
  const embed=message.embeds[0]!;
  assert.ok(embed.fields.every(f=>f.value.length<=1024));
  const size=embed.title.length+embed.description.length+embed.footer.text.length+embed.fields.reduce((total,f)=>total+f.name.length+f.value.length,0);
  assert.ok(size<=6000,`Embed size ${size}`);
});
