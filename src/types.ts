export interface IssueText {
  title: string; body: string; author: string; authorAssociation: string;
  createdAt: string; updatedAt: string; url: string; labels: string[];
}
export interface Issue extends IssueText {
  id: number; number: number; repo: string; state: string; assignees: string[];
  commentCount: number; isPullRequest: boolean;
}
export interface Comment {
  id: number; body: string; author: string; authorAssociation: string;
  url: string; createdAt: string; updatedAt: string;
}
export interface Bounty { cents: number; currency: 'USD'; sourceUrl: string; evidence: string }
export interface Repository {
  name: string; language: string; private: boolean; archived: boolean; defaultBranch: string;
}
export interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; mode: string }
export interface RepositoryContext {
  repository: Repository; commit: string; topLevelTree: TreeEntry[];
  filePaths: string[]; manifests: Record<string, string>; techStack: string[];
}
export interface TriagePayload {
  schemaVersion: 1; issue: Issue; comments: Comment[]; bounty: Bounty; context: RepositoryContext;
}
export interface Prediction { path: string; reason: string }
export interface Triage {
  score: number; solvability: number; reproductionClarity: number; summary: string;
  reproductionSteps: string[]; predictedFiles: Prediction[]; uncertainty: string;
}
export interface Alert {
  id: string; issue: Issue; bounty: Bounty; triage: Triage; techStack: string[]; commit: string;
}
export interface Job {
  repo: string; number: number; updatedAt: string; pending: boolean; touchedAt: string;
  failures: number; retryAt: string; alert: Alert | null; delivered: Record<string, string>;
}
export interface State { version: 1; discoveredThrough: string | null; jobs: Record<string, Job> }
export interface Config {
  githubToken: string; githubApi: string; githubVersion: string;
  llmMode: 'openai' | 'webhook'; llmUrl: string; llmKey: string; model: string;
  discordUrl: string; telegramToken: string; telegramChatId: string; stateDir: string;
  trustedBots: Set<string>; minBountyCents: number; minScore: number;
  requestTimeoutMs: number; runBudgetMs: number; searchIntervalMs: number;
  maxPayloadBytes: number; maxResponseBytes: number; retentionDays: number;
  pollIntervalMs: number; repomixVersion: string;
}
