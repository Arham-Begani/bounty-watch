import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBounty } from '../src/bounty.ts';

const issue = (body: string, title = 'Bug') => ({
  title, body, author: 'reporter', authorAssociation: 'NONE',
  createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z',
  url: 'https://github.com/acme/app/issues/1', labels: ['bounty'],
});
const comment = (body: string, author = 'maintainer', authorAssociation = 'MEMBER') => ({
  id: 1, body, author, authorAssociation, url: 'https://github.com/acme/app/issues/1#issuecomment-1',
  createdAt: '2026-11-14T00:01:00Z', updatedAt: '2026-11-14T00:01:00Z',
});
test('extracts precise cents and command syntax', () => {
  assert.equal(extractBounty(issue('Bounty: $1,250.50'), [], new Set())?.cents, 125050);
  assert.equal(extractBounty(issue('/bounty $500'), [], new Set())?.cents, 50000);
  assert.equal(extractBounty(issue('A **$250** bounty is available'), [], new Set())?.cents, 25000);
  assert.equal(extractBounty(issue('USD 100 bounty'), [], new Set())?.cents, 10000);
});
test('does not invent exact amounts from malformed, ranged, non-USD, or unrelated money', () => {
  for (const body of ['Bounty: $1.5k', 'Bounty: $100-$500', 'Bounty: $1,00',
    'Bounty: CAD $500', 'Bounty: $500 AUD', 'Bounty: €500', 'Price of laptop: $500',
    'Bounty: ~$500', 'Bounty: $500+', 'Bounty: $100.123', 'Bounty: $500 or $750',
    '> Bounty: $900', '```\nBounty: $500\n```']) {
    assert.equal(extractBounty(issue(body), [], new Set()), null, body);
  }
});
test('trusted latest offer replaces previous amount; stranger comments cannot inflate it', () => {
  const result = extractBounty(issue('Bounty: $500'), [comment('/bounty $250'),
    {...comment('/bounty $9000', 'stranger', 'NONE'), id: 2}], new Set());
  assert.equal(result?.cents, 25000);
  assert.equal(result?.sourceUrl, 'https://github.com/acme/app/issues/1#issuecomment-1');
});
test('recognizes configured bounty bots and Expensify title amounts', () => {
  assert.equal(extractBounty(issue('Fix'), [comment('Bounty: $200', 'algora[bot]', 'NONE')],
    new Set(['algora[bot]']))?.cents, 20000);
  assert.equal(extractBounty({...issue('Fix', '[$250] Fix scrolling'), labels: ['External']}, [], new Set())?.cents, 25000);
});
test('withdrawal and lower offers prevent alerting on obsolete large bounties', () => {
  assert.equal(extractBounty(issue('Bounty: $500'), [comment('Bounty cancelled')], new Set()), null);
  assert.equal(extractBounty(issue('Bounty: $500'), [comment('/bounty $50')], new Set())?.cents, 5000);
});
test('issue update time from a new comment does not resurrect its old body bounty', () => {
  assert.equal(extractBounty({...issue('Bounty: $500'), updatedAt: '2026-11-14T00:02:00Z'},
    [comment('/bounty $50')], new Set())?.cents, 5000);
});
test('rejects unsupported negative and proposed offers; newer ambiguous offers invalidate older prices', () => {
  for (const text of ['Bounty: -$500','Could we offer a $500 bounty?','Bounty: $100 to $200'])
    assert.equal(extractBounty(issue(text),[],new Set()),null);
  assert.equal(extractBounty(issue('Bounty: $500'),[comment('Bounty: $100-$300')],new Set()),null);
});
test('supports standalone price on bounty-labelled bodies', () => {
  assert.equal(extractBounty(issue('$250'),[],new Set())?.cents,25000);
});
test('currency markers do not match ordinary words; punctuation is not decimal precision', () => {
  for (const body of ['Bounty: US$250','Bounty: $250 for auditing','Bounty: $250.','Bounty: $250, paid on acceptance'])
    assert.equal(extractBounty(issue(body),[],new Set())?.cents,25000,body);
});
