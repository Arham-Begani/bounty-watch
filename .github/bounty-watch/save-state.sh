#!/usr/bin/env bash
# Save state.json to the bounty-state branch as a single force-pushed commit,
# so the branch never grows. Runs even when the poll step failed.
set -euo pipefail
S="$RUNNER_TEMP/bounty-state/state.json"
if [ ! -f "$S" ]; then echo "No state file to save."; exit 0; fi
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.version!==1) process.exit(1)' "$S" \
  || { echo "::error::state.json is not valid; not saving it"; exit 1; }
cd .bounty-state
cp "$S" state.json
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git checkout -q --orphan snapshot
git add -A
git commit -q -m "Bounty Watch state after run ${GITHUB_RUN_ID} ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
for attempt in 1 2 3; do
  git push -q --force origin HEAD:bounty-state && { echo "State saved."; exit 0; }
  sleep $((attempt * 5))
done
echo "::error::Could not push state to the bounty-state branch"; exit 1
