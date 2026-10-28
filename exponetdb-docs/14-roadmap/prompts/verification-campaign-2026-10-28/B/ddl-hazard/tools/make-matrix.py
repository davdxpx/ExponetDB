#!/usr/bin/env python3
"""Builds the table part of B/ddl-hazard-matrix.md from the analysis results and the PostgreSQL
ground truth, so that no rule id, level or lock mode is typed by hand.

usage: make-matrix.py > table.md      (run from anywhere; paths are relative to this file)

Inputs
  results/hazard-strict-plan-large.json   lint + plan + policy as the server's planner would see a
                                          10M-row `orders` (same output as offline for every rule
                                          that needs a table size: unknown size blocks like large)
  results/safe-strict-plan-large.json     the same for the safe-form fixtures
  evidence/pgcheck-01-rewrite-lock-scan.txt   what PostgreSQL 17 did (relfilenode, scans, locks)
"""
import json, os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, "..")


def load(name):
    return {b["id"]: b for b in json.load(open(os.path.join(root, "results", name)))["bundles"]}


HAZ, SAFE = load("hazard-strict-plan-large.json"), load("safe-strict-plan-large.json")


def truth():
    out, cur = {}, None
    for line in open(os.path.join(root, "evidence", "pgcheck-01-rewrite-lock-scan.txt")):
        line = line.rstrip("\n")
        m = re.match(r"### (\w+?)-", line)
        if m:
            cur = m.group(1)
            out[cur] = []
        elif cur and line.strip() and not line.startswith(("HINT", "DETAIL", "LINE", "  ", "ERROR:  current")):
            out[cur].append(line.strip())
    return out


TRUTH = truth()


def short_locks(s):
    s = s.replace("AccessExclusiveLock", "AEL").replace("ShareUpdateExclusiveLock", "SUEL")
    s = s.replace("ShareRowExclusiveLock", "SREL").replace("RowExclusiveLock", "REL")
    s = s.replace("ExclusiveLock", "EL").replace("RowShareLock", "RSL").replace("ShareLock", "SL")
    return re.sub(r"\b(order_items|orders|events_2026_11|events_2026_10|events|audit_log|order_totals|open_orders)\b", lambda m: m.group(1), s)


def pg(i):
    lines = TRUTH.get(i)
    if not lines:
        return ""
    return "; ".join(short_locks(l.replace("ERROR:  ", "ERROR ")) for l in lines)[:230]


def lint(b):
    if b is None:
        return "-"
    f = [f"`{x['rule']}` {x['level']}{' BLOCKS' if x['blocking'] else ''}" for x in b["findings"]]
    return ", ".join(f) if f else "none"


def plan(b):
    if b is None:
        return "-"
    st = b["statements"]
    locks = []
    for s in st:
        if s["lock"]:
            locks.append(f"{s['lock']['mode'].replace('ACCESS EXCLUSIVE', 'AEL').replace('SHARE UPDATE EXCLUSIVE', 'SUEL').replace('SHARE ROW EXCLUSIVE', 'SREL').replace('ROW EXCLUSIVE', 'REL').replace('SHARE', 'SL')}/{s['lock']['severity']}")
    rewrite = "table" if any(s["rewrite"] == "table" for s in st) else ("possible" if any(s["rewrite"] == "possible" for s in st) else "none")
    return f"{b['observed']}; lock {b['lockSeverity']} ({', '.join(locks) or 'no lock fact'}); rewrite {rewrite}; {'tx' if b['transactional'] else 'non-tx'}"


def pol(b):
    if b is None:
        return "-"
    p = b["policy"]
    short = [x.replace("migration.", "") for x in p["failed"]]
    return f"{p['decision']} ({', '.join(short)})" if short else p["decision"]


def cell(ids, table, truth_ids=None):
    parts = []
    for i in ids:
        b = table.get(i)
        parts.append(f"**{i}** L: {lint(b)} · P: {plan(b)} · Pol: {pol(b)}")
    return "<br>".join(parts)


# (pattern, hazard ids, safe ids, extra PG ground-truth ids, load scenario, safe form text, notes)
ROWS = [
    ("Non-concurrent `CREATE INDEX`", ["h01"], ["s01"], ["h01"], "01",
     "`CREATE INDEX CONCURRENTLY IF NOT EXISTS` in its own `transactional: false` bundle, `statementTimeout` raised (default 15 min would kill a long build and leave an INVALID index).",
     "Blocks writes for the whole build (ShareLock). Warns only because the table size is unknown offline or large at plan time; a table below 64 MiB / 1M rows is silent. Advisor: none."),
    ("`CREATE INDEX CONCURRENTLY` (declared wrongly / extra statements / left INVALID)", ["h02", "h03", "h44"], ["s01"], ["h41"], "01",
     "Own `transactional: false` bundle, one statement. After a failed run the INVALID index must be dropped (`resume` offers `cleanup: drop_invalid_index`, code-read, not run here) before the same bundle is planned again: `IF NOT EXISTS` skips the invalid index silently (proved, `evidence/pgcheck-02-multi-session.txt`).",
     "Both directions of the transactional flag are fixed errors (`nontransactional_statement_in_transactional`, `needless_nontransactional`), and the executor refuses an autocommit statement in a transactional run (`MIGRATION_STATEMENT_FORBIDDEN`, code-read). `multiple_nontransactional_statements` is a warning that never blocks."),
    ("`ADD COLUMN` with a volatile default (uuid)", ["h04"], ["s02", "s03"], ["h04", "h10b"], "02",
     "Add the column nullable (metadata only), `SET DEFAULT` for new rows, backfill old rows in bounded batches outside the engine.",
     "Correctly classified: data_rewrite, critical, `rewriteRisk` lists the table with bytes and rows. Needs a verified backup (`destructive-backup`) and an approval on prod."),
    ("`ADD COLUMN` with a constant default (PG 11+ fast path)", ["h05"], [], ["h05"], "16",
     "Already the safe form (metadata only, brief ACCESS EXCLUSIVE).",
     "Correct: no rewrite finding. Lock severity `high` is the engine's label for every ACCESS EXCLUSIVE statement, so `lock-risk` asks for an approval on prod. The brief lock still queues behind a long reader (scenario 16)."),
    ("`ADD COLUMN` with `DEFAULT now()` / an immutable function (no rewrite on PG 11+)", ["h06", "h07"], [], ["h06", "h07", "h06b"], "-",
     "Same statement; no safe form is needed, but the lint has no way to say so. A project may lower `volatile_default_rewrite` (all tables) or break-glass cannot help (`lint-errors` is not overridable).",
     "**Classification differs from PostgreSQL (false positive):** `now()`, `statement_timestamp()`, `transaction_timestamp()` are stable and any unqualified function is treated as volatile (`volatileExpression`, parser/migration.ts:496-525); PG did not rewrite. The author is also forced to declare `data_rewrite` (`compatibility_understated`, fixed error) and the plan then demands a verified backup."),
    ("`ADD COLUMN` serial / bigserial / identity (rewrite via `nextval`)", ["h08", "h09"], [], ["h08", "h09"], "03",
     "`ADD COLUMN seq bigint`, create the sequence, `SET DEFAULT nextval(...)`; backfill in batches.",
     "**Classification differs from PostgreSQL (missed rewrite):** PG rewrote the table (3 scans, size x1.09) under ACCESS EXCLUSIVE; lint is silent, the plan says additive / `high` (brief) / `rewrite none`."),
    ("`ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`", ["h10"], [], ["h10"], "-",
     "Add a plain column, fill it with a trigger or batches, add the generated column only on PG 18 as `VIRTUAL`.",
     "Rewrite flagged correctly on PG 17. Every `GENERATED` column is flagged volatile, including PG 18 `VIRTUAL` columns that need no rewrite (PG 18: NOT RUN, PG 17 only here)."),
    ("`ALTER COLUMN TYPE` that rewrites", ["h11"], ["s05"], ["h11", "h11b", "h12c", "h13b"], "04",
     "Expand and contract: new column, dual write, batched copy, switch reads, drop the old column in a later bundle.",
     "Correct: data_rewrite, critical, rewrite `possible`."),
    ("`ALTER COLUMN TYPE` without rewrite (varchar widening, varchar to text, timestamp to timestamptz under UTC)", ["h12", "h13"], ["s30"], ["h12", "h12b", "h13"], "05",
     "Same statement; nothing safer exists, the lint cannot tell.",
     "**Classification differs from PostgreSQL (false positive):** the analyzer assumes a rewrite for every type change (`migration.ts:840`, \"needs the old type\"), although the planner could read the column type; docs (analysis.md section 3) promise `high` for binary-coercible changes. The engine pins `TimeZone=UTC`, which is exactly the case where timestamp to timestamptz needs no rewrite."),
    ("`SET NOT NULL` (full scan)", ["h14"], ["s06", "s07", "s08"], ["h14", "h14b"], "06",
     "Four steps in separate bundles: `CHECK (c IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT`, `SET NOT NULL` (scan skipped, proved), drop the CHECK. PG 18: `ADD CONSTRAINT ... NOT NULL ... NOT VALID` (lints clean on the PG 18 grammar, PG 17 grammar: `parse_error`).",
     "**The documented safe form cannot pass the planner:** `unsafe_not_null` needs `provenNotNull`, which the planner never supplies (`planner.ts:668-677`), so step 3 (**s08**) blocks on a large table. See finding on `unsafe_not_null`."),
    ("The NOT NULL recipe in ONE transactional bundle (lock held through the scan)", ["h42"], ["s06", "s07", "s08"], ["h14b"], "07",
     "One bundle per step: the lock a cheap statement takes is held to COMMIT.",
     "**No finding for the composition:** PG keeps ACCESS EXCLUSIVE (from `ADD CONSTRAINT`) through the `VALIDATE` scan (proved: AEL and SUEL both held after VALIDATE). The plan shows `high` (brief)."),
    ("`ADD CONSTRAINT CHECK` validated / `ADD FOREIGN KEY` without `NOT VALID`", ["h15", "h16"], ["s09", "s10", "s12", "s13"], ["h15", "h15b", "h15c", "h16", "h16b", "h16c"], "08, 09",
     "`NOT VALID` first (no scan), `VALIDATE CONSTRAINT` in a separate bundle (SHARE UPDATE EXCLUSIVE, writes continue). Index the FK column concurrently first.",
     "Correct, and the safe steps lint clean. FK takes SHARE ROW EXCLUSIVE on both tables (proved), the plan lists both."),
    ("`ADD CONSTRAINT UNIQUE` / `PRIMARY KEY` without `USING INDEX`", ["h17"], ["s14", "s15"], ["h17", "h17b"], "10",
     "`CREATE UNIQUE INDEX CONCURRENTLY` (non-tx bundle), then `ADD CONSTRAINT ... UNIQUE USING INDEX` (no scan, proved).",
     "**The safe step (s15) is flagged like the dangerous one:** `add_constraint_without_not_valid` fires for `USING INDEX` too, and its remediation (\"add it NOT VALID\") does not exist for UNIQUE."),
    ("`ALTER TYPE ... ADD VALUE`, enum rename", ["h18", "h19", "h20"], ["s16", "s17"], ["h18", "h19"], "-",
     "Add the value in one bundle, use it in a later one. PG 12+ allows `ADD VALUE` in a transaction (lint agrees).",
     "Use in the same transaction is a fixed error (`enum_value_used_in_same_tx`, PG refuses: `unsafe use of new value`). The check is a string-constant match, a use through a default or a function body is not seen."),
    ("`DROP COLUMN` still read by the running build", ["h21"], ["s18"], ["h21"], "-",
     "Expand and contract: stop reading in a deployed build first, drop in a later bundle (shorter `lockTimeout`).",
     "`drop_without_expand_contract` is a warning that never blocks (info in `standard`); nothing can check that the build stopped reading the column, so no lint-clean form exists."),
    ("`RENAME` table / column", ["h22", "h23"], ["s19"], ["h22", "h23"], "-",
     "Add the new name, dual write, copy, switch, drop (or a compatibility view).",
     "`rename_in_place` warns, never blocks (info in `standard`). The rename itself is metadata only (proved) but breaks running code."),
    ("Long ACCESS EXCLUSIVE: cheap lock + slow statement in one bundle", ["h24"], [], ["h24"], "-",
     "One slow action per bundle; the backfill outside the engine.",
     "**No finding:** the lock of `ADD COLUMN` is held until COMMIT while the `UPDATE` runs (proved: AEL + REL held after the UPDATE, table size x2.00). The plan reports `high` (brief). Hold time is bounded only by `statement_timeout` per statement (15 min), not for the bundle."),
    ("Lock queueing behind a long transaction", ["h05"], ["s04"], [], "16",
     "Short `lockTimeout` plus re-planning at a quiet moment. The engine never retries by itself.",
     "Proved here (100k rows): a reader holds the table 9 s, the DDL waits and gives up after the 5 s default, a SELECT issued behind it waits 4.1 s instead of 0.08 s. `analysis.md` section 3 says the plan shows the longest-running queries on the affected tables on prod; **not implemented** (no `pg_stat_activity` read in the planner). `lock_timeout` above 60 s only warns (`long_lock_timeout`, h43), the docs promise an acknowledgement."),
    ("Unbounded `UPDATE` backfill in one statement", ["h25", "h26"], [], ["h25"], "15",
     "Batches of bounded size with a pause, outside the engine: a transactional bundle is one transaction and COMMIT is a forbidden statement, so the engine cannot express it.",
     "`data_change_unbounded` fires only for a missing `WHERE` (h25); `WHERE id > 0` (h26) is silent. 15 min `statement_timeout` rolls a long UPDATE back."),
    ("`CREATE TRIGGER` / `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` on a hot table", ["h28", "h29", "h30"], ["s26", "s27"], ["h28", "h29", "h30"], "17",
     "No lock-free form. Short `lockTimeout`; enable RLS together with its policies in one bundle so there is no window without a policy.",
     "Lock facts present (SHARE ROW EXCLUSIVE / ACCESS EXCLUSIVE, both proved); no lint. `ENABLE ROW LEVEL SECURITY` without a policy hides all rows from non-owner roles: no finding (advisor `rls_enabled_without_policy` only after the fact)."),
    ("`ALTER EXTENSION ... UPDATE`", ["h31"], [], [], "-",
     "Update on staging first; read the extension's upgrade script; apply in a quiet window.",
     "Runs inside a transaction (proved). Only `compatibility_unknown` (warn) and no lock fact; gates as unknown (backup + approval on prod). The script runs with the execution role's rights."),
    ("`ATTACH PARTITION` without a validated `CHECK`", ["h32"], ["s20", "s21", "s22"], ["h32", "h32b"], "-",
     "Validated `CHECK` on the new partition first (scan under SHARE UPDATE EXCLUSIVE on the partition), then attach (no scan, proved), then drop the CHECK.",
     "No lint; the plan records only the parent lock (SUEL), not the ACCESS EXCLUSIVE on the attached table (proved). `DETACH PARTITION ... CONCURRENTLY` cannot be authored: in a transactional bundle the lint is silent but PG refuses (h45); in a non-transactional bundle `needless_nontransactional` (fixed) blocks it (h46)."),
    ("`DETACH PARTITION ... CONCURRENTLY`", ["h45", "h46"], [], ["h45"], "-",
     "No authorable form: it must run outside a transaction, and the lint treats it as an ordinary statement.",
     "In a transactional bundle the lint is silent and PostgreSQL refuses at apply (clean rollback, `MIGRATION_EXECUTION_FAILED` expected, not run); in a non-transactional bundle `needless_nontransactional` (fixed, not lowerable) blocks it."),
    ("`lockTimeout` far above the 60 s the docs allow", ["h43"], [], [], "16",
     "Keep the 5 s default or lower; plan again at a quiet moment.",
     "`long_lock_timeout` warns and never blocks (`rules.ts:210-216`); `planning-and-apply.md` section 6 promises a maximum of 60 s without an acknowledgement. A 2 h wait would queue every later query on the table for 2 h."),
    ("`DROP INDEX` (non-concurrent)", ["h33"], ["s23"], ["h33"], "11",
     "`DROP INDEX CONCURRENTLY IF EXISTS` in a non-tx bundle.",
     "No lint rule; lock fact `high`."),
    ("`REINDEX` (non-concurrent)", ["h34"], ["s24"], ["h34"], "12",
     "`REINDEX TABLE CONCURRENTLY` in a non-tx bundle.",
     "No lint rule; lock fact says ACCESS EXCLUSIVE/critical, PG held SHARE on the table (proved; the script does not list index locks)."),
    ("`VACUUM FULL` / `CLUSTER`", ["h35", "h36"], ["s25"], ["h36"], "13",
     "Plain `VACUUM (ANALYZE)` (does not shrink the file); a real rewrite needs a maintenance window.",
     "No lint rule; critical + `rewriteRisk` with bytes. `VACUUM FULL` is correctly non-transactional, `CLUSTER table` correctly transactional."),
    ("`TRUNCATE`", ["h27"], [], ["h27"], "-", "No safe form (it is the point); `DELETE` in batches if rows must stay visible.",
     "No lint rule; destructive, so a verified backup and an approval on prod."),
    ("`ALTER TABLE ... SET LOGGED / UNLOGGED`", ["h37"], [], ["h37"], "-", "New table, copy, swap.",
     "PG rewrites the table (proved); the analyzer has no rule (`unknown` severity/class, `rewrite none`, no `rewriteRisk`). Gates as unknown."),
    ("`ALTER SEQUENCE ... RESTART`", ["h38"], [], ["h38"], "-", "Do not restart; `setval` to max(id) in an application job.",
     "No lock fact at all (PG takes SHARE ROW EXCLUSIVE on the sequence); duplicate keys are not detected."),
    ("`CREATE OR REPLACE VIEW` on a heavy view", ["h39"], ["s28"], ["h39"], "-", "A new view name; callers switch in their own release.",
     "No lock fact (PG takes ACCESS EXCLUSIVE on the view and queues like any DDL), so `lock-risk` does not fire."),
    ("`REFRESH MATERIALIZED VIEW` (non-concurrent)", ["h40"], ["s29"], ["h40", "h40b"], "14",
     "`REFRESH MATERIALIZED VIEW CONCURRENTLY` (needs a unique index; allowed in a transaction, proved).",
     "Correct: ACCESS EXCLUSIVE / high vs EXCLUSIVE / medium; no lint rule."),
]


def main():
    out = []
    out.append("| Pattern | Warns before apply? (L lint rule, P plan, Pol policy on prod; advisor: none) | What PostgreSQL 17 does (measured, 100k rows) and under load | Safe form (and whether it lints clean) | Notes |")
    out.append("|---|---|---|---|---|")
    for pattern, hz, sf, tr, scen, safe_text, notes in ROWS:
        warns = cell(hz, HAZ)
        if sf:
            warns += "<br>_safe:_ " + "<br>".join(f"**{i}** L: {lint(SAFE.get(i))}" for i in sf)
        truths = "<br>".join(f"{i}: {pg(i)}" for i in tr if pg(i)) or "-"
        load = f"Under load: PENDING (pgbench scenario {scen})" if scen != "-" else "Under load: PENDING (no pgbench scenario; locks and rewrite proved above)"
        out.append(f"| {pattern} | {warns} | {truths}<br>**{load}** | {safe_text} | {notes} |")
    print("\n".join(out))


main()
