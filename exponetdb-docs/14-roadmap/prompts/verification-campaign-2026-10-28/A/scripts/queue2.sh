#!/bin/bash
# Phase 2 on the NEW clone: conformance and the check scripts (CI order), then the working-tree check
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
nice $S n-conformance $N bun run --cwd apps/server test:conformance
nice $S n-verify-generated $N bun run verify:generated
nice $S n-golden-check $N bun run golden:check
nice $S n-golden-history-before $N bun run golden:history a0fda7ca47db703093518caae64eb6a647e53d93
nice $S n-golden-history-g4 $N bun run golden:history 6e556f6b5a26ba141f600d38f612134af3600e49
nice $S n-boundaries $N bun run boundaries
nice $S n-secrets $N bun run secrets
nice $S n-audit $N bun audit
nice $S n-third-party $N bun run third-party
nice $S n-licenses $N bun run licenses
nice $S n-ui-safety $N bun run ui-safety
nice $S n-toolchain $N bun run toolchain
nice $S n-verify-host $N bun run verify:host --list
$S n-worktree-clean $N bash -c 'status="$(git status --porcelain --untracked-files=all)"; echo "[$status]"; test -z "$status"'
echo done-phase2 >> /srv/work/logs/summary.txt
