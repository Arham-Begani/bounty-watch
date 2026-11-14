import type { Bounty, Comment, IssueText } from './types.ts';

function visible(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n').replace(/[*_`]/g, '');
}
function amounts(line: string): number[] {
  if (/[-–—]\s*(?:US\$|\$|USD)|\?|\b(?:could|would|proposed|suggested)\b/i.test(line)) return [];
  if (/\b(?:CAD|AUD|NZD|SGD|HKD|CNY|EUR|INR|USDT|USDC)\b|\b(?:CA|AU|C|A|S|HK)\$/i.test(line)) return [];
  if (/[~≈]|\b(?:about|around|approximately|up to|at least|between)\b|\$[\d,.]+\s*\+|\$[\d,.]+\s*[-–—]/i.test(line)) return [];
  const found: number[] = [];
  const re = /(?:US\$|USD\s*\$?|\$)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?![\d\w]|[,.]\d)/gi;
  for (const m of line.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    const [whole, fraction = ''] = raw.replaceAll(',', '').split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (Number.isSafeInteger(cents) && cents >= 0) found.push(cents);
  }
  // A second currency marker means ambiguity even when one amount is malformed.
  const markers = line.match(/\$|\bUSD\s+(?!\$)/gi)?.length ?? 0;
  return markers === found.length ? found : [];
}
function declaration(text: string, sourceUrl: string, title = false, bare = false): Bounty | 'withdrawn' | null {
  const clean = visible(text);
  if (/\bbounty\s+(?:is\s+|has been\s+)?(?:cancelled|canceled|withdrawn|removed|paid|claimed)\b|\/bounty\s+(?:cancel|remove)\b/i.test(clean)) return 'withdrawn';
  const candidates: Bounty[] = [];
  let ambiguous = false;
  for (const line of clean.split('\n')) {
    const standalone = bare && /^\s*(?:US\$|USD\s*\$?|\$)\s*[\d,.]+\s*$/.test(line);
    if (!title && !standalone && !/\bbounty\b|algora\.io|opire\.dev/i.test(line)) continue;
    const values = amounts(line);
    if (values.length !== 1) { if (/\$|\bUSD\b/.test(line)) ambiguous = true; continue; }
    candidates.push({cents: values[0]!, currency: 'USD', sourceUrl, evidence: line.trim()});
  }
  if (ambiguous || new Set(candidates.map(c => c.cents)).size > 1) return 'withdrawn';
  if (!candidates.length) return null;
  return candidates[0]!;
}
/** Conservative textual offers, not payment verification. Bare $ means USD by policy. */
export function extractBounty(issue: IssueText, comments: Comment[], bots: Set<string>): Bounty | null {
  const sources = [
    {body: issue.body, url: issue.url, time: issue.createdAt, title: false, bare: issue.labels.some(l => /bounty/i.test(l))},
    ...comments.filter(c => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.authorAssociation)
      || c.author === issue.author || bots.has(c.author.toLowerCase()))
      .map(c => ({body: c.body, url: c.url, time: c.updatedAt, title: false, bare: false})),
  ];
  // Expensify posts the active price at the beginning of the title.
  if (issue.labels.some(l => l.toLowerCase() === 'external') && /^\s*\[?\s*\$/.test(issue.title))
    sources.push({body: issue.title, url: issue.url, time: issue.updatedAt, title: true, bare: false});
  sources.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  let current: Bounty | null = null;
  for (const source of sources) {
    const offer = declaration(source.body, source.url, source.title, source.bare);
    if (offer === 'withdrawn') current = null;
    else if (offer) current = offer;
  }
  return current;
}
