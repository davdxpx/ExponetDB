#!/usr/bin/env bash
# Renders $S1_LOGS/F/RESULTS.tsv (one row per failure-injection cell, written by F-matrix.sh) as a Markdown table.
#   render-results.sh [tsv] > fragment.md
tsv="${1:-/srv/work/logs-s1/F/RESULTS.tsv}"
echo '| cell (bundle:phase:injection) | verdict | Control Store state | CLI/REST state | ledger | objects | first stmt started | next plan | product pointer | seconds | judgement |'
echo '|---|---|---|---|---|---|---|---|---|---|---|'
awk -F'\t' '{ gsub(/\|/, "/", $11); printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", $1, $10, $2, $3, $4, $5, $6, $7, $8, $9, $11 }' "$tsv"
