source /root/lab/lib.sh
exec > >(tee $LOGS/t1-full.log) 2>&1
set -x
psqlx "CREATE TABLE public.filler AS SELECT g, repeat(md5(g::text), 20) AS pad FROM generate_series(1,250000) g"
psqlx "SELECT pg_size_pretty(pg_database_size('app'))"
set +x
echo "=== host mode: absent -> run must be refused"
mode absent; bind
R=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"full\",\"databases\":[]}"; echo rc=$?
echo "=== mode owned, FULL via backup.run@1"
mode owned
R=$(rid); T0=$(ts)
c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"full\",\"databases\":[]}"
T1=$(ts); echo "start job returned after $(echo "$T1 - $T0" | bc) s"
echo "--- unit while running"
systemctl show exponetdb-run-$R.service -p Id,LoadState,ActiveState,SubState,User,Group,NoNewPrivileges,PrivateTmp,PrivateDevices,ProtectSystem,ProtectHome,ProtectKernelTunables,ProtectKernelModules,ProtectControlGroups,RestrictSUIDSGID,LimitCORE,UMask,KillMode,CPUWeight,IOWeight,TasksMax,MemoryMax,RuntimeMaxUSec,TimeoutStopUSec,Restart,StandardOutput,StandardError,ReadWritePaths,BindPaths,IPAddressDeny,IPAddressAllow,CapabilityBoundingSet,SystemCallFilter,RestrictAddressFamilies,PrivateNetwork,ExecStart,MainPID,Type
ls -la /var/lib/exponetdb-node-engine/runs/$R /var/lib/exponetdb-node-engine/runs/$R/work 2>&1
stat -c '%U:%G %a %n' /var/lib/exponetdb-node-engine/runs/$R/*
ps -o pid,user,args -u postgres | grep -v "postgres:" | head
OUT=$(wait_run $R 900); T2=$(ts)
echo "$OUT"
echo "full backup wall time (start request -> terminal status): $(echo "$T2 - $T0" | bc) s"
ls -la /var/lib/exponetdb-node-engine/runs/$R; stat -c '%U:%G %a %n' /var/lib/exponetdb-node-engine/runs/$R/*
echo $R > $LOGS/last-full-run
