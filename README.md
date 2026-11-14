# Bounty Watch

A dependency-free TypeScript bounty triage worker for Linux and Docker. It runs directly on Node.js 24.22.1+ with native TypeScript support, built-in `fetch`, and built-in SQLite for crash-released locking. There are no npm dependencies, development dependencies, build step, SDKs, database services, or packages to install to run it.


## Running on GitHub Actions (this repository)

This copy runs as a scheduled GitHub Actions workflow (`.github/workflows/bounty-watch.yml`)
on GitHub-hosted Ubuntu runners every 5 minutes (GitHub may start scheduled runs late under load).

- **State**: `state.json` (discovery watermark, pending jobs, delivery receipts) is restored from
  and force-pushed back to the `bounty-state` branch after every run, so it survives between runs.
  The branch always holds a single commit. It contains public issue data only, never secrets.
- **Triage**: Google Gemini through a loopback adapter (`.github/bounty-watch/gemini-adapter.mjs`)
  that implements the webhook triage contract; responses still pass the app's strict validation.
- **Secrets** (Settings > Secrets and variables > Actions): `BOUNTY_GITHUB_TOKEN`, `GEMINI_API_KEY`,
  `DISCORD_WEBHOOK_URL` (or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). Optional variable `GEMINI_MODEL`.
- **Runs**: Actions tab > Bounty Watch. Run once with "Run workflow"; disable with "Disable workflow".
  A run fails only for configuration errors, crashes or discovery failures; jobs that will retry show as warnings.
- The original self-hosted workflow (`bounties.yml`) was replaced, so it is no longer in `SHA256SUMS`.

## Quick start

```sh
cp .env.example .env
chmod 600 .env
```

Fill in `GITHUB_TOKEN`, either OpenAI credentials or a triage webhook, and at least one alert destination. Blank values in the example are intentionally unset credentials. Then:

```sh
node --env-file=.env src/main.ts
```

For a continuously running process with a five-minute interval:

```sh
node --env-file=.env src/main.ts --daemon
```

Use a GitHub token that can read the public repositories, issues, comments, and Git objects you want to monitor. Private and archived repositories are excluded even if the token can access them. GitHub App installation tokens have an installation-scoped search universe; use an appropriately scoped personal token for cross-repository discovery. The application only reads GitHub; it never comments, claims a bounty, clones a repository, or executes code from an issue.

The default model is `gpt-6.1-terra` through the OpenAI Responses API. `OPENAI_MODEL` and `OPENAI_URL` are configurable. The model must support strict JSON Schema output. API usage is billed by the provider; a ChatGPT subscription is not used as an API credential.

## What it does

1. Search the four languages with each of the four predicates independently: `label:"💎 Bounty"`, `label:"bounty"`, `"algora.io" in:body`, and `"opire.dev" in:body`. Every query includes `is:open is:issue no:assignee`. Union results by GitHub issue ID. Also run the separate `repo:Expensify/App is:open is:issue label:External no:assignee` query.
2. Apply a bounded `updated:` timestamp interval. Creation initializes the update timestamp, so it includes newly created issues. On first startup the interval is the last 15 minutes. Later runs overlap the previous completed discovery by 15 minutes and catch up after downtime. A failed or incomplete discovery never advances the saved watermark.
3. Check the repository's **primary language**, including Expensify, against exactly TypeScript, Rust, JavaScript, and Python. A repository merely containing some Python does not qualify if its primary language is Go.
4. Read the current issue and **every comment page**, and recheck the issue version and comment count for a consistent snapshot. Recheck open/unassigned eligibility before alerting.
5. Extract an exact textual USD offer in integer cents. Reject amounts below $100. Fetch manifests and the repository tree only for qualifying, not-yet-delivered offers.
6. Resolve a default-branch commit, fetch its top-level tree and available `package.json`, `Cargo.toml`, `pyproject.toml`, and `requirements.txt`, and build a recursive list of real files. If GitHub truncates a recursive tree, walk its subtrees instead. Source files themselves are not downloaded for triage.
7. Send the complete issue, all comments, bounty evidence, manifests, tech stack, tree and file list to the configured LLM endpoint. Require a structured score and 2–3 unique predicted paths that actually exist at the pinned commit.
8. Save the validated result before sending alerts. Send Discord embeds and/or Telegram HTML messages with repository, amount, link, scores, tech stack, predicted files, evidence, uncertainty, and a shell command. Record each successful destination separately.

The generated POSIX shell command runs `git clone`, checks out the analyzed commit, and uses `npx --yes repomix@1.19.0 --style xml --output repomix-output.xml`. The repository name and commit are validated and shell-quoted. Git and npm are needed on the machine where **you run that command**, not by the daemon. Repomix is downloaded only when you run it. The command is included as copyable text; chat platforms do not execute arbitrary shell commands with one click.

## Bounty interpretation

Supported forms include `Bounty: $250`, `/bounty $500`, `USD 100 bounty`, `US$250 bounty`, and `$1,250.50 bounty`. A standalone `$250` is accepted in a bounty-labelled issue body. Leading Expensify-style title prices such as `[$250] Fix scrolling` are also recognized.

Quotes, fenced code, HTML comments, malformed decimals, shorthand amounts, ranges, approximate values, negative values, non-USD currency markers and proposals framed as questions are rejected. An unrelated price such as `The laptop costs $500` is ignored.

The issue body establishes the baseline. Later declarations from repository owners/members/collaborators, the issue author, or configured bot logins supersede it, ordered by comment edit time. Anonymous or unrelated commenters cannot inflate an offer. Withdrawals and ambiguous newer declarations invalidate the previous price. The current leading External-title price is given the issue's update time. GitHub does not expose a body-only edit timestamp here, so a trusted comment may take precedence over a later body edit; this is an explicit conservative heuristic, not a complete revision-history resolver.

Bare `$` is treated as USD by policy, matching the requested notation. These are **textual offers, not verified escrow balances or guaranteed payouts**. A regex cannot infer every natural-language offer, payment condition, or withdrawal; false negatives are intentional when the amount is ambiguous. Configure trusted bot logins for your sources instead of trusting all accounts ending in `[bot]`.

## Local webhook contract

Set `LLM_MODE=webhook`, `LLM_WEBHOOK_URL` to your endpoint, and optionally `LLM_WEBHOOK_TOKEN` for bearer authentication. HTTP is allowed only on loopback; other endpoints require HTTPS. In Docker, `127.0.0.1` refers to the container; for a host-local service on Linux use host networking or an HTTPS-reachable service.

The request body is:

```typescript
interface WebhookRequest {
  schemaVersion: 1;
  instructions: string;
  responseSchema: typeof TRIAGE_SCHEMA;
  payload: TriagePayload;
}
```

`TriagePayload` is fully defined in `src/types.ts`, and the JSON Schema is exported from `src/triage.ts`. Return the following shape directly as HTTP 200 JSON (without a wrapper):

```json
{
  "score": 8,
  "solvability": 8,
  "reproductionClarity": 9,
  "summary": "A deterministic reproduction points to the parser boundary.",
  "reproductionSteps": ["Run the reproduction supplied in the issue."],
  "predictedFiles": [
    {"path": "src/parser.ts", "reason": "The issue identifies this parser entry point."},
    {"path": "src/normalize.ts", "reason": "The failing input passes through normalization."}
  ],
  "uncertainty": "These are hypotheses based on issue context; source code was not inspected."
}
```

This is an illustrative response, not a stub used by the daemon. Your endpoint must return 2–3 real paths from the request's `context.filePaths`; the illustration will be rejected if those files do not exist. Scores must be integers 1–10. `reproductionSteps` may be empty. Extra properties, invalid scores, repeated/invented paths, refusals and incomplete OpenAI responses are rejected. Untrusted GitHub text is explicitly separated from the system instructions. No LLM response is executed.

## Docker

```sh
docker build -t bounty-watch:1.0.0 .
docker volume create bounty-watch-data
docker run -d --name bounty-watch --restart unless-stopped \
  --env-file .env -e STATE_DIR=/app/data \
  --mount source=bounty-watch-data,target=/app/data \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10m --log-opt max-file=3 \
  bounty-watch:1.0.0
```

The container runs as the unprivileged `node` user. Keep the named volume: it contains the discovery watermark, pending jobs, cached triage results, delivery receipts, and the SQLite mutex. The default container command runs the continuous daemon. For an external scheduler, override it with `node src/main.ts` and do not use the restart policy. Use one active deployment per state volume, on a local filesystem; this is not a distributed work queue. Stop with `docker stop --time 30 bounty-watch` to allow orderly cancellation.

## Five-minute cron

After configuring `.env`, install one cron entry for this checkout:

```sh
node scripts/install-cron.ts
```

The installer preserves unrelated entries and is idempotent. It uses the current absolute Node executable and checkout path. It writes to the current user's crontab, not root's. The entry runs every five minutes; stdout/stderr go to `data/cron.log`. Configure your host's log rotation for that file. Inspect the exact entry without modifying anything:

```sh
node scripts/install-cron.ts --print
```

Remove the entry bearing the `bounty-watch:` marker using `crontab -e`. Do not run cron and the continuous daemon against the same state directory; overlapping processes are safely rejected but create avoidable errors.

## GitHub Actions

The included `.github/workflows/bounties.yml` runs at minutes 2, 7, 12, …, 57 with concurrency protection. It deliberately targets **one persistent self-hosted Linux runner**, labelled `bounty-watch`, with Node 24.22.1+ installed. State lives in that runner user's `$HOME/.local/state/bounty-watch`, outside the checkout. Do not attach multiple machines to that runner label without providing a different durable shared-state design.

Add repository secrets `BOUNTY_GITHUB_TOKEN`, `OPENAI_API_KEY`, and your selected destination credentials. For a custom triage webhook, set repository variables `LLM_MODE=webhook` and `LLM_WEBHOOK_URL`, and the optional `LLM_WEBHOOK_TOKEN` secret. Keep the workflow on the default branch and enable Actions. For this initial release, the supplied workflow uses `actions/checkout@v4` with persisted credentials disabled.

A disposable GitHub-hosted runner loses local state between jobs unless a reliable state restoration/writeback mechanism is added. This workflow does not pretend an opportunistic cache is durable state. GitHub schedules can be delayed; a five-minute schedule is not a five-minute delivery guarantee. Local cron is preferable when prompt polling matters.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `STATE_DIR` | `./data` | Durable local state directory; must be writable. |
| `MIN_BOUNTY_USD` | `100` | Integer dollars; cannot be lower than 100. |
| `MIN_SCORE` | `1` | Alert threshold; all qualifying bounties are triaged. |
| `TRUSTED_BOUNTY_BOTS` | `algora[bot],opire[bot],expensifybot` | Comma-separated exact bot logins. |
| `REPOMIX_VERSION` | `1.19.0` | Exact version for the generated ingestion command. |
| `POLL_INTERVAL_MS` | `300000` | Continuous mode interval; never less than five minutes. |
| `RUN_BUDGET_MS` | `240000` | Deadline for one run, including retries and network reads. |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout including body consumption. |
| `SEARCH_INTERVAL_MS` | `2200` | Search spacing; minimum configurable value is 2100. |
| `MAX_PAYLOAD_BYTES` | `800000` | Full serialized triage payload limit; no silent truncation. |
| `MAX_RESPONSE_BYTES` | `64000000` | Streaming HTTP response byte limit. |
| `RETENTION_DAYS` | `90` | Completed job/receipt retention; pending work is retained. |

Payload size is a byte guard, not a token counter. Select a model whose context window fits your workload. Oversized context is deferred with an explicit error instead of sending incomplete comments. It will require a larger configured limit/model context or manual review. Very large backlogs or large repositories can exceed a run budget; watch logs and increase the budget for a controlled catch-up run if necessary.

## Reliability and limits

- All network responses are parsed from `unknown` and validated at the boundaries. TypeScript uses strict checking, exact optional properties and checked indexed access. Native TypeScript execution strips types; it does not itself type-check.
- HTTP handles timeouts, network failures, 429s, transient server errors, `Retry-After`, GitHub rate-limit reset headers and Telegram/Discord retry delays. Redirects are rejected so credentials cannot be forwarded to a redirected origin. Request/response bodies and secrets are never written to logs.
- Search endpoints have separate rate limits. Searches are sequential and spaced, with adaptive time-range splitting for GitHub's 1,000-result cap and incomplete responses. If even a one-second range is incomplete, discovery fails explicitly. GitHub search indexing and repository-scope limits still prevent an absolute completeness guarantee.
- The state file is written to a fresh file, fsynced, atomically renamed and followed by directory fsync. Invalid/corrupt state causes a failed run rather than resetting deduplication. Back up `state.json` and preserve the directory. SQLite is used only as a local process mutex; its lock is released on process exit, including SIGKILL.
- SIGINT/SIGTERM abort in-flight requests and persist pending jobs. An interrupted or unsuccessful job retries with exponential backoff from 5 minutes to 6 hours. Credentials or a changed endpoint must be corrected by the operator; the daemon does not silently discard such work.
- Delivery is **at least once**, not exactly once. A network timeout or crash after the remote service accepts a message but before a receipt is saved can cause a duplicate. Discord and Telegram do not give this client an atomic state+message transaction. Confirmed delivery receipts suppress ordinary retries per issue, amount and destination for the retention period. Repeated updates at the same amount do not generate new alerts; a new amount can.
- LLM file predictions are hypotheses. Existing paths and schemas are verified; actual fault location, solvability, bounty ownership and payout eligibility are not guaranteed.
- New runs recheck closure/assignment/version immediately before sending. GitHub state can still change in the small interval between that check and delivery.
- Structured logs contain run outcome, pending-job count, issue IDs, amounts and delivery channel. Monitor `discovery_failed`, `job_deferred`, `run_failed`, `configuration_error`, repeated unhealthy runs and growing pending counts. One-shot mode exits nonzero on current-run failure; daemon mode continues to retry.

## Verification

Tests run without installation or credentials:

```sh
npm test
```

Optional development-only static checking (neither package is needed to run the worker):

```sh
npm install --no-save --package-lock=false --ignore-scripts typescript@5.9.3 @types/node@24.19.2
npx --no-install tsc --project tsconfig.json
```

The test suite exercises extraction edge cases, comment pagination, search splitting, truncated-tree fallback, HTTP retries and byte limits, OpenAI response parsing, invalid model predictions, durable state, SIGKILL lock recovery, idempotent cron installation, and an end-to-end HTTP pipeline with partial Discord/Telegram delivery failure and restart deduplication.

Verification for this delivery: 23 tests passed on Node 24.22.1 with strict TypeScript 5.9.3 checking and local mocked provider endpoints. No live account credentials were used and no real alerts were sent. Docker is not installed in the build workspace, so the Docker image was not built here.

## Files

| File | Responsibility |
|---|---|
| `src/main.ts` | CLI, signals, interval loop. |
| `src/runner.ts` | Discovery, persistent job processing and orchestration. |
| `src/github.ts` | REST search, pagination, snapshots, pinned trees and manifests. |
| `src/bounty.ts` | Conservative exact-amount extraction and source precedence. |
| `src/triage.ts` | Schema, prompt, OpenAI/webhook client, validation, shell command. |
| `src/alerts.ts` | Discord embeds, Telegram formatting and acknowledgements. |
| `src/state.ts` | Strict state parsing, atomic checkpoints and crash-safe mutex. |
| `src/http.ts` | Bounded streaming HTTP, timeouts, retries and rate limits. |
| `src/config.ts`, `src/types.ts`, `src/util.ts` | Configuration, domain types and validation helpers. |
| `test/` | Dependency-free Node test suite. |
| `scripts/install-cron.ts` | Idempotent per-user cron installation. |

## API references

- [GitHub issue search and result limits](https://docs.github.com/en/rest/search/search)
- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Node native TypeScript execution](https://nodejs.org/api/typescript.html)
- [Node built-in SQLite](https://nodejs.org/api/sqlite.html)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [Discord webhook execution](https://docs.discord.com/developers/resources/webhook)
- [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)
- [Repomix CLI](https://repomix.com/guide/command-line-options)
