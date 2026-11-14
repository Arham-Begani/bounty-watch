import type { Comment, Config, Issue, Repository, RepositoryContext, TreeEntry } from './types.ts';
import { Http } from './http.ts';
import { array, bool, integer, iso, record, repoName, string, utc } from './util.ts';
export const LANGUAGES = new Set(['TypeScript', 'Rust', 'JavaScript', 'Python']);
export function searchQueries(): string[] {
  const queries: string[] = [];
  for (const language of LANGUAGES) for (const predicate of ['label:"💎 Bounty"','label:"bounty"'])
    queries.push(`is:open is:issue no:assignee language:${language} ${predicate}`);
  // Full-text body searches are expensive for GitHub and trip its secondary rate limit when
  // fanned out per language, so run each once; runOnce() still drops repos outside LANGUAGES.
  for (const term of ['"algora.io" in:body', '"opire.dev" in:body'])
    queries.push(`is:open is:issue no:assignee ${term}`);
  queries.push('repo:Expensify/App is:open is:issue label:External no:assignee');
  return queries;
}
export function parseIssue(value: unknown, repo: string): Issue {
  const d = record(value), number = integer(d['number']);
  if (number < 1) throw new Error('Invalid issue number');
  return {id: integer(d['id']), number, repo: repoName(repo), state: string(d['state']),
    title: string(d['title']), body: d['body'] === null ? '' : string(d['body']),
    author: d['user'] === null ? 'ghost' : string(record(d['user'])['login']),
    authorAssociation: string(d['author_association']),
    labels: array(d['labels']).map(l => typeof l === 'string' ? l : string(record(l)['name'])),
    assignees: array(d['assignees']).map(a => string(record(a)['login'])),
    createdAt: iso(d['created_at']), updatedAt: iso(d['updated_at']),
    url: `https://github.com/${repo}/issues/${number}`,
    commentCount: integer(d['comments']), isPullRequest: Boolean(d['pull_request'])};
}
export function eligible(issue: Issue): boolean {
  return issue.state === 'open' && !issue.isPullRequest && issue.assignees.length === 0 && (
    issue.labels.some(l => ['bounty','💎 bounty'].includes(l.toLowerCase())) || /algora\.io|opire\.dev/i.test(issue.body) ||
    (issue.repo.toLowerCase() === 'expensify/app' && issue.labels.some(l => l.toLowerCase() === 'external')));
}
function sha(v: unknown): string {
  const s = string(v); if (!/^[0-9a-f]{40,64}$/.test(s)) throw new Error('Invalid git object hash'); return s;
}
function parseTree(value: unknown): {entries: TreeEntry[]; truncated: boolean} {
  const d = record(value);
  return {truncated: bool(d['truncated']), entries: array(d['tree']).map(v => {
    const e = record(v), type = string(e['type']);
    if (type !== 'tree' && type !== 'blob' && type !== 'commit') throw new Error('Invalid git object type');
    return {path: string(e['path']), type, sha: sha(e['sha']), mode: string(e['mode'])};
  })};
}
export class GitHub {
  private readonly http: Http;
  private readonly config: Config;
  private lastSearch = 0;
  private readonly repos = new Map<string, Repository>();
  private readonly contexts = new Map<string, RepositoryContext>();
  constructor(http: Http, config: Config) { this.http = http; this.config = config; }
  private get(path: string): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    return this.http.json(this.config.githubApi + path, {headers: {
      Authorization: `Bearer ${this.config.githubToken}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'bounty-watch/1.0',
    }}, 'github');
  }
  async *search(query: string, from: number, through: number): AsyncGenerator<Issue> {
    const start = Math.floor(from / 1000) * 1000, end = Math.floor(through / 1000) * 1000;
    if (start > end) throw new Error('Invalid discovery interval');
    const q = `${query} updated:${utc(start)}..${utc(end)}`;
    let total = Infinity;
    for (let page = 1; (page - 1) * 100 < total; page++) {
      await this.http.pause(Math.max(0, this.lastSearch + this.config.searchIntervalMs - Date.now()));
      this.lastSearch = Date.now();
      const parameters = new URLSearchParams({q, per_page: '100', page: String(page), sort: 'updated', order: 'asc'});
      const result = record(await this.get('/search/issues?' + parameters));
      total = integer(result['total_count']);
      if (bool(result['incomplete_results']) || total > 1000) {
        if (end - start < 1000) throw new Error('GitHub search incomplete at one-second resolution');
        const mid = Math.floor((start + end) / 2000) * 1000;
        yield* this.search(query, start, mid);
        yield* this.search(query, mid + 1000, end);
        return;
      }
      const items = array(result['items']);
      if (!items.length && (page - 1) * 100 < total) throw new Error('GitHub search pagination changed; retry required');
      for (const value of items) {
        const r = record(value), url = new URL(string(r['repository_url']));
        const name = repoName(decodeURIComponent(url.pathname.replace(/^\/repos\//, '')));
        const issue = parseIssue(value, name);
        if (eligible(issue)) yield issue;
      }
    }
  }
  async issue(repo: string, number: number): Promise<Issue> {
    return parseIssue(await this.get(`/repos/${repoName(repo)}/issues/${number}`), repo);
  }
  async comments(repo: string, number: number): Promise<Comment[]> {
    const comments = new Map<number, Comment>();
    for (let page = 1; ; page++) {
      const items = array(await this.get(`/repos/${repoName(repo)}/issues/${number}/comments?per_page=100&page=${page}`));
      for (const value of items) {
        const d = record(value), id = integer(d['id']);
        comments.set(id, {id, body: d['body'] === null ? '' : string(d['body']),
          author: d['user'] === null ? 'ghost' : string(record(d['user'])['login']),
          authorAssociation: string(d['author_association']),
          createdAt: iso(d['created_at']), updatedAt: iso(d['updated_at']),
          url: `https://github.com/${repo}/issues/${number}#issuecomment-${id}`});
      }
      if (items.length < 100) return [...comments.values()];
    }
  }
  async snapshot(repo: string, number: number): Promise<{issue: Issue; comments: Comment[]}> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.issue(repo, number);
      const comments = await this.comments(repo, number);
      const after = await this.issue(repo, number);
      if (before.updatedAt === after.updatedAt && before.commentCount === after.commentCount && after.commentCount === comments.length)
        return {issue: after, comments};
    }
    throw new Error('Issue changed while reading comments; retry required');
  }
  async repository(name: string): Promise<Repository> {
    const existing = this.repos.get(name); if (existing) return existing;
    const d = record(await this.get(`/repos/${repoName(name)}`));
    const canonicalName = repoName(d['full_name']);
    if (canonicalName.toLowerCase() !== name.toLowerCase()) throw new Error('Repository moved; rediscovery required');
    const repository = {name: canonicalName, language: d['language'] === null ? '' : string(d['language']),
      private: bool(d['private']), archived: bool(d['archived']), defaultBranch: string(d['default_branch'])};
    this.repos.set(name, repository);
    return repository;
  }
  async context(name: string): Promise<RepositoryContext> {
    const existing = this.contexts.get(name); if (existing) return existing;
    const repository = await this.repository(name);
    const commitData = record(await this.get(`/repos/${name}/commits/${encodeURIComponent(repository.defaultBranch)}`));
    const commit = sha(commitData['sha']), rootSha = sha(record(record(commitData['commit'])['tree'])['sha']);
    const root = parseTree(await this.get(`/repos/${name}/git/trees/${rootSha}`));
    if (root.truncated) throw new Error('Top-level directory tree is incomplete');
    let recursive = parseTree(await this.get(`/repos/${name}/git/trees/${rootSha}?recursive=1`));
    if (recursive.truncated) {
      const entries: TreeEntry[] = [];
      const queue = [{prefix: '', entries: root.entries}];
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index]!;
        for (const entry of item.entries) {
          const path = item.prefix + entry.path;
          entries.push({...entry, path});
          if (entry.type === 'tree') {
            const sub = parseTree(await this.get(`/repos/${name}/git/trees/${entry.sha}`));
            if (sub.truncated) throw new Error('Subdirectory tree is incomplete');
            queue.push({prefix: path + '/', entries: sub.entries});
          }
        }
      }
      recursive = {entries, truncated: false};
    }
    const filePaths = recursive.entries.filter(e => e.type === 'blob' && e.mode !== '120000').map(e => e.path).sort();
    const manifests: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const file of root.entries.filter(e => e.type === 'blob' && e.mode !== '120000' && ['package.json','Cargo.toml','pyproject.toml','requirements.txt'].includes(e.path))) {
      const blob = record(await this.get(`/repos/${name}/git/blobs/${file.sha}`));
      if (blob['encoding'] !== 'base64') throw new Error('Unexpected manifest encoding');
      const content = Buffer.from(string(blob['content']), 'base64');
      if (content.length !== integer(blob['size'])) throw new Error('Incomplete manifest');
      manifests[file.path] = content.toString('utf8');
    }
    const tech = new Set([repository.language]);
    if (manifests['package.json']) {
      const pkg = record(JSON.parse(manifests['package.json']) as unknown);
      tech.add('Node.js');
      if (typeof pkg['packageManager'] === 'string') tech.add(pkg['packageManager']);
      for (const section of ['dependencies','devDependencies']) {
        if (!pkg[section]) continue;
        const dependencies = record(pkg[section]);
        for (const key of ['react','react-native','next','vue','svelte','angular','@angular/core','express','fastify','typescript','vite','jest','vitest'])
          if (typeof dependencies[key] === 'string') tech.add(`${key} ${dependencies[key]}`);
      }
    }
    if (manifests['Cargo.toml']) tech.add('Rust / Cargo');
    if (manifests['pyproject.toml'] || manifests['requirements.txt']) tech.add('Python');
    const result = {repository, commit, topLevelTree: root.entries, filePaths, manifests, techStack: [...tech]};
    this.contexts.set(name, result); return result;
  }
}
