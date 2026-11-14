#!/usr/bin/env bash
# One Bounty Watch poll inside GitHub Actions. Restores state, runs the app (with the
# local Gemini adapter when GEMINI_API_KEY is set) and classifies the result.
set -uo pipefail
export STATE_DIR="$RUNNER_TEMP/bounty-state"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
if [ -f .bounty-state/state.json ]; then cp .bounty-state/state.json "$STATE_DIR/state.json"; echo "Restored saved state."
else echo "No saved state yet (first run)."; fi
LOG="$RUNNER_TEMP/bounty-watch.log"; : > "$LOG"

ADAPTER=''
if [ -n "${GEMINI_API_KEY:-}" ]; then
  export LLM_MODE=webhook LLM_WEBHOOK_URL=http://127.0.0.1:18787/triage
  LLM_WEBHOOK_TOKEN=$(openssl rand -hex 24); export LLM_WEBHOOK_TOKEN
  echo "::add-mask::$LLM_WEBHOOK_TOKEN"
  node .github/bounty-watch/gemini-adapter.mjs >> "$LOG" 2>&1 & ADAPTER=$!
  for _ in $(seq 1 50); do grep -q gemini_adapter_ready "$LOG" && break; kill -0 "$ADAPTER" 2>/dev/null || break; sleep 0.2; done
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  export LLM_MODE=openai
fi

timeout --signal=TERM --kill-after=30 540 node src/main.ts 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
if [ -n "$ADAPTER" ]; then kill "$ADAPTER" 2>/dev/null; wait "$ADAPTER" 2>/dev/null; fi
grep -h '"event":"gemini' "$LOG" | grep -v gemini_adapter_ready || true

# Fail the run only for real problems; jobs that will retry next run are warnings.
node --input-type=module - "$LOG" "$rc" <<'EOF'
import { readFileSync, appendFileSync } from 'node:fs';
const [log, rc] = process.argv.slice(2);
const ev = readFileSync(log, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const by = n => ev.filter(e => e.event === n);
const fatal = [...by('configuration_error').map(e => `configuration error: ${e.message}`),
  ...by('run_failed').map(e => `run failed: ${e.error}`), ...by('discovery_failed').map(e => `discovery failed: ${e.error}`)];
const finished = by('run_finished').at(-1), started = by('run_started').at(-1);
const delivered = by('alert_delivered'), deferred = by('job_deferred');
for (const d of delivered) console.log(`::notice title=Alert delivered::${d.repo}#${d.issue} $${(d.cents / 100).toFixed(2)} via ${d.channel} (score ${d.score})`);
for (const d of deferred) console.log(`::warning title=Job deferred (retries next run)::${d.repo}#${d.issue}: ${d.error}`);
if (!finished && !fatal.length && rc !== '0') fatal.push(`app exited ${rc} without finishing (timeout or crash)`);
for (const f of fatal) console.log(`::error title=Bounty Watch::${f}`);
const lines = ['### Bounty Watch run', '',
  `- Window: ${started ? `${started.from} .. ${started.through}` : 'n/a'}`,
  `- Healthy: ${finished?.healthy ?? 'n/a'}; pending jobs: ${finished?.pending ?? 'n/a'}`,
  `- Alerts delivered: ${delivered.length}; deferred jobs: ${deferred.length}`,
  ...(fatal.length ? ['', ...fatal.map(f => `- **${f}**`)] : []),
  ...(!fatal.length && !delivered.length ? ['', 'No qualifying bounty in this window (not an error).'] : [])];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(fatal.length ? 1 : 0);
EOF
