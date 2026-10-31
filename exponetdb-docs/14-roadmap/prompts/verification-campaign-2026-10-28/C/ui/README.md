# C/ui: the Web App and the CLI on the disposable stack (tester S7)

Tree `d51da5d0`. Server `vc-3`, the stack left by S1 and S4 (real `serve`, `worker`, `gateway`, Control Store, PG16/17/18 targets, a node agent). Nothing touched the live installation
or another server. **No P0.** Raw logs, screenshots and per-case outputs stay on the server in `/srv/work/logs-s7`.

| Task | File | Verdict |
|---|---|---|
| CLI sweep, text and JSON, exit codes, error envelope | [`cli-sweep.md`](./cli-sweep.md) | PASS with 5 P3 findings: 92 cases; the theme is information lost between server and operator (causes, ids, remedies) and exit 1 for a dead target; of E1's 7 predictions 4 are confirmed, 1 is refuted for the plan step, 2 NOT RUN |
| Web App accessibility pass | [`web-a11y.md`](./web-a11y.md) | PASS with P3 findings: 114 page loads (19 pages x 3 widths x 2 schemes), 0 serious or critical, 3 moderate rules, no overflow, keyboard reaches `Apply`; screen reader and the Approve button NOT RUN |

Related files by this tester: `D/security/network-review.md`, `D/security/promotion-leftovers.md`; findings in `F/findings-S7.md`, decisions in `F/decisions-S7.md`.

## Scripts (`scripts/`, run on the server)

| Purpose | Files |
|---|---|
| CLI sweep | `s7-cli-sweep.sh` (77 cases), `s7-cli-sweep2.sh` and `s7-cli-sweep3.sh` (15 more, fixtures corrected), `s7-sweep-render.py` (the table) |
| Web App | `s7-webcookie.ts` (copy to `packages/stack-kit/s7/webcookie.ts` of the stack's checkout; it imports `../human.ts`), `s7-web-a11y.mjs`, `s7-a11y-render.py` |

## Notes for the next tester

- `exdb_json` throws stderr away; when a call prints nothing, run `exdb ...` (text) once.
- `human.ts stepup <id> <code>` posts the wrong field; use `human call POST /api/v1/step-ups/<id>/confirm '{"userCode":"<Code: shown by the CLI>"}'`.
- A plan is bound to the actor and client that created it (`PLAN_BINDING_ACTOR`): a plan made with the CLI must be applied with the CLI, a high-class one after a step-up confirmed in the browser path.
- The product's circuit breaker (3 failures in 60 s, open for 30 s) hides the cause of a target failure; wait 35 s between certificate experiments.
- `pkill -f <name>` over ssh kills your own command (the name is in its command line); use `pkill -f "[n]ame"`.
- **State left on the stack:** the node agent is **revoked** (`D/security/network-review.md` section 5); two `backup refresh` operations are queued for it; targets `s7evi`, `s7prd`, `s7evib`,
  `s7prdb`, `s7evic`, `s7prdc` (evidence pairs; `s7evi` carries hand-written ledger rows on purpose, `LEDGER_DIVERGENCE` there is expected), `s7imm*`, `s7dang*`, `s7sweep`, `s7sw3*`; the PG18 server certificate
  is the original again; `iptables` and the clock are as found.
