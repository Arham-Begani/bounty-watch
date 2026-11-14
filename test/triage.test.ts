import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTriage, TRIAGE_SCHEMA, ingestCommand } from '../src/triage.ts';
const valid = {score: 8, solvability: 8, reproductionClarity: 9, summary: 'Clear failure',
  reproductionSteps: ['Run example'], uncertainty: 'Paths are hypotheses',
  predictedFiles: [{path: 'src/a.ts', reason: 'Parser'}, {path: 'src/b.ts', reason: 'Caller'}]};
test('rejects invented paths, invalid scores and duplicated predictions', () => {
  assert.equal(validateTriage(valid, ['src/a.ts','src/b.ts']).score, 8);
  assert.throws(() => validateTriage(valid, ['src/a.ts']));
  assert.throws(() => validateTriage({...valid, score: 11}, ['src/a.ts','src/b.ts']));
  assert.throws(() => validateTriage({...valid, predictedFiles: [valid.predictedFiles[0], valid.predictedFiles[0]]}, ['src/a.ts']));
  assert.throws(() => validateTriage({...valid, predictedFiles: []}, []));
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
});
test('commands use validated repository names and commit hashes', () => {
  const command = ingestCommand('acme/app', 'a'.repeat(40), '1.9.2');
  assert.match(command, /^git clone /);
  assert.match(command, /npx --yes repomix@1\.9\.2/);
  assert.match(command, /git checkout --detach/);
  assert.throws(() => ingestCommand('acme/$(touch_pwned)', 'a'.repeat(40), '1.9.2'));
  assert.throws(() => ingestCommand('acme/app', ';touch pwned', '1.9.2'));
});
test('OpenAI Responses contract parses output_text and rejects refusals and incomplete responses', async () => {
  const {Http}=await import('../src/http.ts');
  const {readConfig}=await import('../src/config.ts');
  const {triage}=await import('../src/triage.ts');
  const config=readConfig({GITHUB_TOKEN:'test',OPENAI_API_KEY:'test',DISCORD_WEBHOOK_URL:'http://127.0.0.1/discord'});
  const payload={schemaVersion:1,issue:{id:1,number:1,repo:'acme/app',state:'open',assignees:[],commentCount:0,isPullRequest:false,
    title:'Bug',body:'Bounty: $250',author:'owner',authorAssociation:'OWNER',createdAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-14T00:00:00Z',url:'https://github.com/acme/app/issues/1',labels:['bounty']},
    comments:[],bounty:{cents:25000,currency:'USD',sourceUrl:'https://github.com/acme/app/issues/1',evidence:'Bounty: $250'},
    context:{repository:{name:'acme/app',language:'TypeScript',private:false,archived:false,defaultBranch:'main'},commit:'a'.repeat(40),topLevelTree:[],filePaths:['src/a.ts','src/b.ts'],manifests:{},techStack:['TypeScript']}} satisfies import('../src/types.ts').TriagePayload;
  let mode='success',calls=0;
  const http=new Http({timeoutMs:1000,maxBytes:100000,signal:new AbortController().signal,fetch:async (_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));
    assert.equal(body.store,false);assert.equal(body.text.format.strict,true);
    assert.equal(JSON.parse(body.input).issue.body,'Bounty: $250');
    if(mode==='incomplete')return Response.json({status:'incomplete',output:[]});
    if(mode==='refusal')return Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]});
    return Response.json({status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:JSON.stringify(valid)}]}]});
  }});
  assert.equal((await triage(http,config,payload)).score,8);
  mode='incomplete';await assert.rejects(triage(http,config,payload),/incomplete/);
  mode='refusal';await assert.rejects(triage(http,config,payload),/refused/);
  await assert.rejects(triage(http,{...config,maxPayloadBytes:10},payload),/MAX_PAYLOAD_BYTES/);
  assert.equal(calls,3);
});
