#!/usr/bin/env python3
"""S4: refine run-matrix.ts results. The harness counts a generic 404 NOT_FOUND / 422 as 'A'. Here a 404 where the owner got
2xx for the same request is a CONCEALED DENY, a 422 (also for the owner) is a bad sample (the decision is not observable),
a 200 on a list route is a visibility-filtered list (checked by hand). Prints the residual candidates."""
import collections, json, sys
r = json.load(open(sys.argv[1]))
res = r["results"]
owner = {(x["row"], x["variant"]): x for x in res if x["cls"] == "owner"}
LISTS = {"listProducts","listProjects","listTargets","listFindings","getFleet","getFindingSummary","listSavedQueries","getBackupOverview","listNodes","listOperations","listPlans","listAuditEvents","listApprovals"}
out = collections.Counter(); cand = []
for x in res:
    if "#existence" in x["row"] or x["verdict"] == "skipped": continue
    o = owner.get((x["row"], x["variant"]))
    st, code, exp = x["status"], x["code"], x["exp"]
    obs = x["obs"]
    if obs == "A" and st == 404 and o and 200 <= o["status"] < 300: obs = "D"   # concealed
    if obs == "A" and st == 422: obs = "V"                                       # sample not valid-shaped
    if obs == "A" and o and o["status"] == st and o["code"] == code and x["cls"] != "owner" and exp == "D": obs = "A=owner"  # same answer as the owner (domain refusal)
    key = (x["row"], x["cls"], x["variant"])
    if exp == "N": out["undecidable"] += 1
    elif obs == "V": out["bad-sample"] += 1
    elif obs == exp: out["ok"] += 1
    elif exp == "D" and obs == "A" and x["row"] in LISTS and st == 200: out["list(filtered)"] += 1; cand.append(("LIST", *key, st, code))
    elif exp == "D" and obs == "A=owner": out["same-as-owner(unobservable)"] += 1; cand.append(("SAME-AS-OWNER", *key, st, code))
    elif exp == "D" and obs == "A": out["CANDIDATE bypass"] += 1; cand.append(("BYPASS?", *key, st, code))
    elif exp == "A" and obs == "D": out["CANDIDATE over-restrictive"] += 1; cand.append(("OVERRESTRICT?", *key, st, code))
    else: out["other:" + exp + obs] += 1; cand.append(("OTHER", *key, st, code))
print(dict(out))
g = collections.defaultdict(list)
for c in cand: g[(c[0], c[1], c[4], c[5])].append(f"{c[2]}" + (f"/{c[3][:2]}" if c[3] != "none" else ""))
for k, v in sorted(g.items()): print(k[0], k[1], f"HTTP {k[2]} {k[3]}", "|", ",".join(sorted(set(v))))
