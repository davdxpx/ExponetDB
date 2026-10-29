#!/usr/bin/env bash
# diff-census.sh <before-label> <after-label>  ->  counts-before-after.tsv on stdout:
#   table, kind, before, after, delta, hash   (hash: SAME | DIFFERENT | n/a when the table is not append-only; rows hashed = the baseline's N)
. /srv/work/s3-infra/s3/lib.sh
B="${S3_LOGS}/census/$1"; A="${S3_LOGS}/census/$2"
printf 'table\tkind\tbefore\tafter\tdelta\tappend_only_hash\n'
join -t $'\t' -a1 -a2 -e MISSING -o 0,1.2,1.3,2.3 <(awk -F'\t' '{print $1"\t"$2"\t"$3}' "$B.counts.tsv" | sort -t $'\t' -k1,1) <(awk -F'\t' '{print $1"\t"$2"\t"$3}' "$A.counts.tsv" | sort -t $'\t' -k1,1) \
| while IFS=$'\t' read -r t k b a; do
    d="n/a"; [ "$b" != MISSING ] && [ "$a" != MISSING ] && d=$((a - b))
    hb="$(awk -F'\t' -v t="$t" '$1==t {print $3}' "$B.hashes.tsv")"; ha="$(awk -F'\t' -v t="$t" '$1==t {print $3}' "$A.hashes.tsv")"
    h="n/a"; [ -n "$hb" ] && { [ "$hb" = "$ha" ] && h=SAME || h="DIFFERENT($hb vs $ha)"; }
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$t" "$k" "$b" "$a" "$d" "$h"
  done
