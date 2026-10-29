#!/bin/bash
# Phase 10: Go test counts old vs new (go test -race -json)
S=/srv/work/bin/step.sh
source /srv/work/env.sh
nice $S n-go-json-new /srv/work/new/agent/node bash -c 'go test -race -count=1 -json ./... > /srv/work/results/go-new.jsonl'
nice $S o-go-json-old /srv/work/old/agent/node bash -c 'go test -race -count=1 -json ./... > /srv/work/results/go-old.jsonl'
for r in new old; do
  jq -r 'select(.Test != null and (.Action=="pass" or .Action=="fail" or .Action=="skip")) | [.Package,.Test,.Action] | @tsv' /srv/work/results/go-$r.jsonl | sort > /srv/work/results/go-$r.tsv
  echo "go-$r: $(awk -F'\t' '{c[$3]++} END{for(k in c) printf "%s=%d ", k, c[k]}' /srv/work/results/go-$r.tsv)" >> /srv/work/results/go-counts.txt
done
echo done-phase10 >> /srv/work/logs/summary.txt
