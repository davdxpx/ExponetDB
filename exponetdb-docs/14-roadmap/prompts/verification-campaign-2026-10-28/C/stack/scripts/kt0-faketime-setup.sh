#!/usr/bin/env bash
# libfaketime drop-ins for serve, worker and gateway: the offset of each process is the first line of /srv/work/s6/ft-<role>
# and can be changed while the process runs (FAKETIME_NO_CACHE). Monotonic clocks are not faked. The VM clock is never touched.
. /srv/work/s6-infra/s6/lib6.sh
for r in serve worker gateway; do
  d=/etc/systemd/system/$(_stk_unit $r).d; mkdir -p $d
  echo "+0" >/srv/work/s6/ft-$r; chmod 644 /srv/work/s6/ft-$r
  cat >$d/faketime.conf <<EOT
[Service]
Environment=LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
Environment=FAKETIME_TIMESTAMP_FILE=/srv/work/s6/ft-$r
Environment=FAKETIME_NO_CACHE=1
Environment=FAKETIME_DONT_FAKE_MONOTONIC=1
EOT
done
systemctl daemon-reload; restart_cp
echo "ready: serve=$(hc $S) worker=$(hc $W) gw=$(hc $G)"
for r in serve worker gateway; do pid=$(systemctl show -p MainPID --value $(_stk_unit $r)); echo "$r pid $pid preload: $(tr '\0' '\n' </proc/$pid/environ | grep -c '^LD_PRELOAD=')"; done
