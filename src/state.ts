import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Alert, Job, State } from './types.ts';
import { array, bool, integer, iso, record, repoName, string } from './util.ts';
import { validateTriage } from './triage.ts';
function parseAlert(value: unknown): Alert | null {
  if (value === null) return null;
  const a = record(value), issue = record(a['issue']), bounty = record(a['bounty']);
  const repo = repoName(issue['repo']), number = integer(issue['number']);
  if (number < 1 || bounty['currency'] !== 'USD') throw new Error('Invalid saved alert');
  const predictedPaths = array(record(a['triage'])['predictedFiles']).map(v => string(record(v)['path']));
  const cents = integer(bounty['cents']);
  if (cents < 0) throw new Error('Invalid saved amount');
  return {id: string(a['id']), commit: string(a['commit']),
    issue: {repo, number, id: integer(issue['id']), title: string(issue['title']), body: string(issue['body']),
      author: string(issue['author']), authorAssociation: string(issue['authorAssociation']),
      createdAt: iso(issue['createdAt']), updatedAt: iso(issue['updatedAt']),
      url: `https://github.com/${repo}/issues/${number}`, labels: array(issue['labels']).map(string),
      state: string(issue['state']), assignees: array(issue['assignees']).map(string),
      commentCount: integer(issue['commentCount']), isPullRequest: bool(issue['isPullRequest'])},
    bounty: {cents, currency:'USD', sourceUrl: string(bounty['sourceUrl']), evidence: string(bounty['evidence'])},
    triage: validateTriage(a['triage'], predictedPaths), techStack: array(a['techStack']).map(string)};
}
function parseState(value: unknown): State {
  const d = record(value);
  if (d['version'] !== 1) throw new Error('Unsupported state version');
  const jobs: Record<string, Job> = Object.create(null) as Record<string, Job>;
  for (const [key, raw] of Object.entries(record(d['jobs']))) {
    if (!/^\d+$/.test(key)) throw new Error('Invalid state key');
    const j = record(raw), delivered: Record<string,string> = Object.create(null) as Record<string,string>;
    for (const [destination, at] of Object.entries(record(j['delivered']))) {
      if (!/^\d+:[a-f0-9]{64}$/.test(destination)) throw new Error('Invalid delivery receipt');
      delivered[destination] = iso(at);
    }
    const number = integer(j['number']), failures = integer(j['failures']);
    if (number < 1 || failures < 0) throw new Error('Invalid saved job');
    jobs[key] = {repo:repoName(j['repo']),number,failures,delivered,
      updatedAt:iso(j['updatedAt']), pending:bool(j['pending']), touchedAt:iso(j['touchedAt']), retryAt:iso(j['retryAt']), alert:parseAlert(j['alert'])};
  }
  return {version:1,discoveredThrough:d['discoveredThrough'] === null ? null : iso(d['discoveredThrough']),jobs};
}
export class StateStore {
  readonly state: State;
  private readonly directory: string;
  private lock: DatabaseSync | null;
  private constructor(directory: string, state: State, lock: DatabaseSync) { this.directory = directory; this.state = state; this.lock = lock; }
  static async open(directory: string): Promise<StateStore> {
    if (process.platform !== 'linux') throw new Error('Run on Linux or in the supplied Linux container');
    await mkdir(directory,{recursive:true,mode:0o700});
    directory = await realpath(directory);
    // Node's built-in SQLite provides a kernel-backed advisory lock. A dedicated
    // database holds the lock across JSON checkpoints and releases it after a crash.
    const lock = new DatabaseSync(join(directory,'mutex.sqlite'));
    try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); }
    catch (e) {
      lock.close();
      const failure = new Error('State lock unavailable; another worker may own it', {cause:e});
      failure.name = 'StateLocked'; throw failure;
    }
    try {
      let state: State = {version:1,discoveredThrough:null,jobs:Object.create(null) as Record<string,Job>};
      try { state = parseState(JSON.parse(await readFile(join(directory,'state.json'),'utf8')) as unknown); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return new StateStore(directory,state,lock);
    } catch (e) { lock.close(); throw e; }
  }
  async save(): Promise<void> {
    if (!this.lock) throw new Error('State store is closed');
    const temp = join(this.directory,`state-${randomUUID()}.tmp`);
    const file = await open(temp,'wx',0o600);
    try {
      await file.writeFile(JSON.stringify(this.state)); await file.sync(); await file.close();
      await rename(temp,join(this.directory,'state.json'));
      const parent = await open(this.directory,'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await file.close().catch(() => {}); await unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); }
  }
  async close(): Promise<void> {
    if (!this.lock) return;
    const lock = this.lock; this.lock = null;
    lock.close();
  }
}
