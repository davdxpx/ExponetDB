source /srv/work/s4/env.sh; cd $S4
C17=$(stack_id cluster_pg17)
runuser -u postgres -- pgbackrest --stanza=s4main --no-online stanza-create 2>&1 | tail -2 | cut -c1-200
runuser -u postgres -- pgbackrest --stanza=s4main info 2>&1 | head -8 | cut -c1-160
s4ts s4/req.ts backup-adopt --reauth --wait --approve POST /api/v1/clusters/$C17/backup-repositories '{"layer":"l1_physical","engine":"pgbackrest","provider":"posix","location":{"endpointHost":null,"region":null,"bucket":null,"prefix":"var/lib/pgbackrest","stanza":"s4main","repoIndex":1},"cipher":"aes-256-cbc"}' 2>&1 | tail -1
exdb backup repositories $C17 --output json 2>&1 | head -c 600; echo
exdb backup refresh $C17 --output json 2>&1 | head -c 400; echo
exdb backup list $C17 --output json 2>&1 | head -c 300; echo
exdb backup runs $C17 --output json 2>&1 | head -c 300; echo
