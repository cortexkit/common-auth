#!/usr/bin/env bash
# Run only on the dedicated VM: sixteen workers saturate its CPUs.
set -u
cd /home/tester/common-auth-round4-bg753
# This isolated measurement copy prints successful traces too; the committed
# fixture remains failure-only. No assertions, waits, or budgets are changed.
python3 - <<'PY'
from pathlib import Path
p = Path('test/fixtures/phase-clock.ts')
p.write_text(p.read_text().replace('if (!succeeded || performance.now() - started >= budgetMs)', 'if (true)'))
PY
status=0
for version in 1.3.14 1.4.2; do
  runtime="$HOME/rt/bun-$version/bun"
  "$runtime" --version
  "$runtime" scripts/load-probe.mjs test/fs/refresh-file-lock.test.ts 'elects one owner across 512 plain stale-lock contentions' 3 16 > "loaded.$version.elections.jsonl" || status=1
  "$runtime" scripts/load-probe.mjs test/auth-menu/accounts.test.ts 'Check quotas polls each account once and prints its windows from the store' 3 16 > "loaded.$version.quotas.jsonl" || status=1
done
exit "$status"
