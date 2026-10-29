import sys,datetime
rows=[]
for l in open(sys.argv[1] if len(sys.argv)>1 else "/srv/work/s2/logs/watch.log"):
    p=l.split()
    if len(p)<6: continue
    try: t=float(p[0])
    except: continue
    kv=dict(x.split("=") for x in p[1:])
    rows.append((t,int(kv["dirs"]),int(kv["restore"]),int(kv["scratch_pm"]),int(kv.get("verify",0)),int(kv.get("backup",0))))
fmt=lambda t: datetime.datetime.utcfromtimestamp(t).strftime("%H:%M:%S.%f")[:-4]
ep=None; eps=[]
for t,d,r,pm,v,b in rows:
    if d>0 and ep is None: ep={"dir_on":t,"restore_on":None,"restore_off":None,"pm_on":None,"pm_off":None}
    if ep:
        if r>0 and ep["restore_on"] is None: ep["restore_on"]=t
        if r>0: ep["restore_off"]=t
        if pm>0 and ep["pm_on"] is None: ep["pm_on"]=t
        if pm>0: ep["pm_off"]=t
        if d==0: ep["dir_off"]=t; eps.append(ep); ep=None
for i,e in enumerate(eps):
    print(i,"dir",fmt(e["dir_on"]),"->",fmt(e["dir_off"]),"restore proc",fmt(e["restore_on"]) if e["restore_on"] else "-","->",fmt(e["restore_off"]) if e["restore_off"] else "-","postmaster",fmt(e["pm_on"]) if e["pm_on"] else "-","->",fmt(e["pm_off"]) if e["pm_off"] else "-",
      "| restore-start->postmaster-gone %.1fs"%(e["pm_off"]-(e["restore_on"] or e["dir_on"])) if e["pm_off"] else "", "| dir total %.1fs"%(e["dir_off"]-e["dir_on"]))
