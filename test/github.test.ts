import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, searchQueries } from '../src/github.ts';
import { Http } from '../src/http.ts';
import { readConfig } from '../src/config.ts';
const cfg = readConfig({GITHUB_TOKEN: 'test', LLM_MODE: 'webhook', LLM_WEBHOOK_URL: 'http://127.0.0.1/triage', DISCORD_WEBHOOK_URL: 'http://127.0.0.1/discord'});
test('fans out every language and predicate plus the External search', () => {
  const queries = searchQueries();
  assert.equal(queries.length, 17);
  for (const lang of ['TypeScript','Rust','JavaScript','Python']) {
    assert.equal(queries.filter(q => q.includes(`language:${lang}`)).length, 4);
  }
  assert.ok(queries.includes('repo:Expensify/App is:open is:issue label:External no:assignee'));
  assert.ok(queries.every(q => q.includes('no:assignee')));
});
test('retrieves every comment page, including comment 101', async () => {
  const http = new Http({timeoutMs:1000,maxBytes:1000000,signal:new AbortController().signal,fetch:async url => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    return Response.json(Array.from({length: page === 1 ? 100 : page === 2 ? 1 : 0}, (_, index) => ({
      id: (page - 1) * 100 + index + 1, body: 'Bounty: $200', user: {login:'owner'},
      author_association:'OWNER', created_at:'2026-11-14T00:00:00Z',updated_at:'2026-11-14T00:00:00Z',
    })));
  }});
  const result = await new GitHub(http,cfg).comments('acme/app',1);
  assert.equal(result.length,101);
  assert.equal(result[100]?.id,101);
});
test('search divides an overfull window and refuses incomplete one-second results', async () => {
  const ranges: string[] = [];
  const http = new Http({timeoutMs:1000,maxBytes:100000,signal:new AbortController().signal,fetch:async url => {
    const q = new URL(String(url)).searchParams.get('q') ?? '';
    ranges.push(q);
    return Response.json({total_count: ranges.length === 1 ? 1001 : 0, incomplete_results:false, items:[]});
  }});
  const gh = new GitHub(http,{...cfg,searchIntervalMs:0});
  const items = [];
  for await (const issue of gh.search('is:issue',Date.parse('2026-11-14T00:00:00Z'),Date.parse('2026-11-14T00:00:03Z'))) items.push(issue);
  assert.equal(ranges.length,3);
  const incomplete = new Http({timeoutMs:1000,maxBytes:100000,signal:new AbortController().signal,
    fetch:async () => Response.json({total_count:0,incomplete_results:true,items:[]})});
  await assert.rejects(async () => {
    for await (const _ of new GitHub(incomplete,{...cfg,searchIntervalMs:0}).search('is:issue',0,0)) { /* exhaust */ }
  }, /incomplete/);
});
test('falls back to subtree traversal when the recursive tree is truncated', async () => {
  const root='a'.repeat(40), sub='b'.repeat(40), blob='c'.repeat(40);
  const http=new Http({timeoutMs:1000,maxBytes:100000,signal:new AbortController().signal,fetch:async input=>{
    const u=new URL(String(input));
    if(u.pathname==='/repos/acme/app')return Response.json({full_name:'acme/app',language:'Rust',private:false,archived:false,default_branch:'main'});
    if(u.pathname.endsWith('/commits/main'))return Response.json({sha:root,commit:{tree:{sha:root}}});
    if(u.search)return Response.json({truncated:true,tree:[]});
    if(u.pathname.endsWith('/trees/'+root))return Response.json({truncated:false,tree:[{path:'src',type:'tree',sha:sub,mode:'040000'},{path:'Cargo.toml',type:'blob',sha:blob,mode:'100644'}]});
    if(u.pathname.endsWith('/trees/'+sub))return Response.json({truncated:false,tree:[{path:'lib.rs',type:'blob',sha:blob,mode:'100644'},{path:'main.rs',type:'blob',sha:blob,mode:'100644'}]});
    return Response.json({encoding:'base64',content:Buffer.from('[package]\nname = "app"').toString('base64'),size:22});
  }});
  const context=await new GitHub(http,cfg).context('acme/app');
  assert.deepEqual(context.filePaths,['Cargo.toml','src/lib.rs','src/main.rs']);
  assert.equal(context.topLevelTree.length,2);
  assert.equal(context.manifests['Cargo.toml'],'[package]\nname = "app"');
});
