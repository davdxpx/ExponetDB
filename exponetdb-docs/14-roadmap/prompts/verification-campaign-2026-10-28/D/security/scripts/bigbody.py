#!/usr/bin/env python3
"""S4 task 2: a lesser credential posts a large, valid-shaped body to a plan route (D1 finding F-D1-1, first P2).
Measures the serve process (RSS peak, CPU seconds) and the latency of the refusal.
usage: bigbody.py <token file or -> <MiB> [route]   (route default: POST /targets/{nonprod}/migrations/plans)"""
import json, os, subprocess, sys, threading, time, urllib.request, urllib.error
S4 = "/srv/work/s4"
tf, mib = sys.argv[1], float(sys.argv[2])
fx = json.load(open(S4 + "/authz/fixtures.json"))
tok = None if tf == "-" else open(tf).read().strip()
pid = int(subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "exstack-serve.service"]).strip())
def rss(): return int([l for l in open(f"/proc/{pid}/status") if l.startswith("VmRSS")][0].split()[1]) / 1024
def cpu():
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split(); return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")
total = int(mib * 1024 * 1024)
sql = "-- " + ("x" * 1000) + "\n"
bundles = []
n = 0
# every bundle: a ULID-named directory, a manifest, an up.sql of ~900 KiB of comment text (valid shape, never executed)
size = 0
while size < total - 20000 and n < 49:
    ulid = "01M64Q" + "%020d" % (n + 1)
    ulid = ulid[:26].replace("0", "0")
    up = sql * 900
    bundles.append({"directory": f"{ulid}_pad-{n}", "files": {"migration.yaml": f"schema: exponetdb.migration/v1\nid: {ulid}\nname: pad-{n}\ndependsOn: []\nexecution:\n  transactional: true\n", "up.sql": up}})
    size += len(up) + 300; n += 1
body = json.dumps({"bundles": bundles}).encode()
path = f"/api/v1/targets/{fx['targets']['nonprod']}/migrations/plans"
peak = [rss()]; stop = [False]
def sampler():
    while not stop[0]:
        peak[0] = max(peak[0], rss()); time.sleep(0.02)
r0, c0 = rss(), cpu()
th = threading.Thread(target=sampler); th.start()
t0 = time.time()
req = urllib.request.Request("http://127.0.0.1:58480" + path, data=body, method="POST", headers={"content-type": "application/json", **({"authorization": "Bearer " + tok} if tok else {})})
try:
    r = urllib.request.urlopen(req, timeout=120); status, code = r.status, ""
except urllib.error.HTTPError as e:
    status = e.code
    try: code = json.loads(e.read()).get("code")
    except Exception: code = "?"
dt = time.time() - t0
time.sleep(0.5); stop[0] = True; th.join()
print(json.dumps({"bodyMiB": round(len(body) / 1048576, 1), "bundles": n, "credential": "none" if tok is None else os.path.basename(tf), "status": status, "code": code, "latencySec": round(dt, 2),
                  "serveRssMiB_before": round(r0), "serveRssMiB_peak": round(peak[0]), "serveRssMiB_after": round(rss()), "serveCpuSec": round(cpu() - c0, 2)}))
