#!/bin/bash
# usage: step.sh <name> <dir> <cmd...>   -- logs to /srv/work/logs/<name>.log, exit code to <name>.exit
name=$1; dir=$2; shift 2
source /srv/work/env.sh
[ -f /srv/work/step-env.sh ] && source /srv/work/step-env.sh
cd "$dir" || exit 99
start=$(date +%s)
{ echo "# $(date -u +%FT%TZ) in $dir: $*"; } > /srv/work/logs/$name.log
rm -f /srv/work/logs/$name.exit
"$@" >> /srv/work/logs/$name.log 2>&1
rc=$?
secs=$(( $(date +%s) - start ))
echo "$(date -u +%FT%TZ) $name rc=$rc secs=$secs" >> /srv/work/logs/summary.txt
echo "$rc" > /srv/work/logs/$name.exit
exit $rc
