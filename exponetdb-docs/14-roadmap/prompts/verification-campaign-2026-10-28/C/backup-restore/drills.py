import sys,json,re
for l in sys.stdin:
    m=re.match(r"\[(.*?)\] (.*?DRILL .*?): (\{.*\})",l.strip())
    if not m: continue
    d=json.loads(m[3]); dr=d.get("drill") or {}; rs=d.get("restore") or {}
    ph=[(p["name"],p["startedAt"][11:19],p["finishedAt"][11:19]) for p in rs.get("phases",[])]
    print(m[2], "| wall plan->done",d.get("wallSecondsPlanToDone", d.get("seconds")), "| outcome",dr.get("outcome"), "| rto",dr.get("measuredRtoSeconds"), "| started",dr.get("startedAt","")[11:19], "finished",dr.get("finishedAt","")[11:19], "| tApply",d.get("tApply","")[11:19], "| head", d.get("head"))
    print("   src", {k:v for k,v in (rs.get("source") or {}).items() if k in ("backupId","pointInTime","walFrom","walTo","timeline")})
    print("   phases",ph); print("   checks",[(c["check"],c["outcome"],(c.get("detail") or "")[:60]) for c in rs.get("checks",[])])
