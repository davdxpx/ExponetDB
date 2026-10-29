#!/usr/bin/env bash
# Control Store census:  counts.sh <label> [<baseline-label>]
#   <label>.counts.tsv   schema.table <TAB> exact row count (partition parents are counted with their children, kind p)
#   <label>.hashes.tsv   append-only tables (the ones whose row trigger control.reject_change refuses UPDATE): table <TAB> rows hashed <TAB> md5 <TAB> column list
#   <label>.cols.tsv     table <TAB> columns (the schema as the label saw it)
# With a baseline label the hash covers exactly the baseline's first N rows (ordered by the append key) and exactly
# the baseline's columns, so rows and columns a later release added do not count as change.
. /srv/work/s3-infra/s3/lib.sh
LABEL="${1:?label}"; BASE="${2:-}"
OUT="${S3_LOGS}/census"; mkdir -p "$OUT"
Q() { psql_control -X -At -F $'\t' -v ON_ERROR_STOP=1 -c "$1" </dev/null; }

# 1. exact counts of every base table (one statement; partition parents count their children)
Q "SELECT n.nspname||'.'||c.relname, c.relkind, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', c.oid::regclass), false, true, '')))[1]::text
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1" >"$OUT/$LABEL.counts.tsv"

# 2. columns per table
Q "SELECT table_schema||'.'||table_name, string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
   WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1 ORDER BY 1" >"$OUT/$LABEL.cols.tsv"

# 3. hashes of the append-only tables (partitions excluded: the parent covers them)
append_key() { case "$1" in audit.audit_events) echo seq ;; operations.operation_events) echo event_id ;; control.schema_migrations) echo applied_seq ;; *) echo "" ;; esac; }
Q "SELECT DISTINCT n.nspname||'.'||c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='reject_change' AND (t.tgtype & 1) = 1 AND (t.tgtype & 16) = 16 AND NOT c.relispartition AND c.relname <> 'operation_locks' ORDER BY 1" >"$OUT/$LABEL.append-only.txt"
: >"$OUT/$LABEL.hashes.tsv"
while read -r t; do
  [ -n "$t" ] || continue
  key="$(append_key "$t")"
  [ -n "$key" ] || key="$(Q "SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.ord) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
                          WHERE i.indisprimary AND n.nspname||'.'||c.relname='$t'")"
  [ -n "$key" ] || key=1
  if [ -n "$BASE" ]; then
    cols="$(awk -F'\t' -v t="$t" '$1==t {print $2}' "$OUT/$BASE.cols.tsv")"
    limit="$(awk -F'\t' -v t="$t" '$1==t {print $2}' "$OUT/$BASE.hashes.tsv")"
  else
    cols="$(awk -F'\t' -v t="$t" '$1==t {print $2}' "$OUT/$LABEL.cols.tsv")"; limit=""
  fi
  [ -n "$cols" ] || { printf '%s\t%s\t%s\t%s\n' "$t" "-" "NO_COLUMNS_IN_BASELINE" "-" >>"$OUT/$LABEL.hashes.tsv"; continue; }
  expr="$(awk -v c="$cols" 'BEGIN{n=split(c,a,","); s=""; for(i=1;i<=n;i++) s=s (i>1?", ":"") "\"" a[i] "\"::text"; print s}')"
  lim=""; [ -n "$limit" ] && [ "$limit" != "-" ] && lim="LIMIT $limit"
  row="$(Q "SELECT count(*), coalesce(md5(string_agg(r, E'\\n' ORDER BY k)), 'EMPTY') FROM (SELECT concat_ws('|', $expr) AS r, row($key)::text AS k FROM $t ORDER BY $key $lim) x" | tr '\t' ' ')"
  printf '%s\t%s\t%s\t%s\n' "$t" "${row% *}" "${row##* }" "$cols" >>"$OUT/$LABEL.hashes.tsv"
done <"$OUT/$LABEL.append-only.txt"
# the hashes file's second column is the number of rows hashed; the base's limit column is read from it
echo "census $LABEL: $(wc -l <"$OUT/$LABEL.counts.tsv") tables, $(wc -l <"$OUT/$LABEL.hashes.tsv") append-only tables hashed, $(awk -F'\t' '$2=="r"||$2=="p"{s+=$3} END{print s}' "$OUT/$LABEL.counts.tsv") rows (partition children counted twice via their parent)"
