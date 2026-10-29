#!/usr/bin/env bash
# Full physical backup with pg_basebackup (WAL comes from the archive): backup_basebackup.sh NAME
source /srv/work/s5/rehearsal/rh-lib.sh
N="${1:?name}"; DEST=/srv/work/s5/base/$N
rm -rf "$DEST"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_basebackup -h /var/run/postgresql -p 55417 -D "$DEST" -Fp -X none -c fast -l "rh-$N" -P -v 2>&1 | tail -4
echo "size: $(du -sm "$DEST" | cut -f1) MB; backup_label:"; head -4 "$DEST/backup_label"
