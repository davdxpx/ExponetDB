# usage: s2-inject.sh CASE apply|revert   (inside s2-host). Every change is reversible: originals are saved under $SAVE.
CASE=$1; ACT=$2
SAVE=/srv/work/s2/xfer/saved; mkdir -p $SAVE
REPO=/var/lib/pgbackrest; ARC=$REPO/archive/exdbnode/17-1; BK=$REPO/backup/exdbnode
PGB="runuser -u postgres -- pgbackrest --stanza=exdbnode"
NEWEST=$($PGB info --output=json | jq -r '.[0].backup|sort_by(.timestamp.stop)|map(select(.type=="full"))|last|.label')
STOP=$($PGB info --output=json | jq -r --arg l "$NEWEST" '.[0].backup[]|select(.label==$l)|.archive.stop')
segs() { find $ARC -type f ! -name '*.backup' ! -name '*.history' | sed 's#.*/##' | sort; }
segpath() { find $ARC -type f -name "$1*" ! -name '*.backup' | head -1; }
after_stop() { segs | awk -v s="$STOP" 'substr($0,1,24) > s'; }
mid() { local n=$(after_stop | wc -l); after_stop | sed -n "$(( (n+1)/2 ))p"; }
last() { segs | tail -1; }
flip() { # file : 16 random bytes in the middle, original saved
  local f=$1; local b=$(basename "$f"); [ -n "$b" ] || { echo "no file to flip"; return 1; }; cp -p $f $SAVE/$b; echo "$f" > $SAVE/$b.path
  local sz=$(stat -c %s $f); head -c 16 /dev/urandom | dd of=$f bs=1 seek=$((sz/2)) conv=notrunc 2>/dev/null; echo "flipped 16 bytes at offset $((sz/2)) of $b ($sz bytes)"; }
away() { local f=$1; local b=$(basename "$f"); [ -n "$b" ] || { echo "no file to move"; return 1; }; mv $f $SAVE/$b; echo "$f" > $SAVE/$b.path; echo "moved away $b"; }
restore_saved() { for p in $SAVE/*.path $SAVE/.path; do [ -f "$p" ] || continue; local b=$(basename $p .path); cp -p $SAVE/$b "$(cat $p)" && rm -f $SAVE/$b $p && echo "restored $b"; done; }
case "$CASE:$ACT" in
  corrupt-backup-file:apply) f=$(find $BK/$NEWEST/pg_data/base -type f -size +50M | head -1); flip $f;;
  corrupt-wal-mid:apply)     flip $(segpath $(mid | cut -c1-24));;
  corrupt-wal-last:apply)    flip $(segpath $(last | cut -c1-24));;
  delete-wal-mid:apply)      away $(segpath $(mid | cut -c1-24));;
  delete-wal-last:apply)     away $(segpath $(last | cut -c1-24));;
  delete-wal-stop:apply)     away $(segpath $STOP);;
  wrong-key:apply)           cp -p /etc/pgbackrest/pgbackrest.conf $SAVE/pgbackrest.conf.orig; sed -i 's#^repo1-cipher-pass=.*#repo1-cipher-pass=wrong-key-for-the-test#' /etc/pgbackrest/pgbackrest.conf; echo "cipher pass replaced in the host config";;
  wrong-key:revert)          cp -p $SAVE/pgbackrest.conf.orig /etc/pgbackrest/pgbackrest.conf && rm -f $SAVE/pgbackrest.conf.orig && echo "config restored";;
  repo-deleted:apply)        mkdir -p $SAVE/repo; mv $REPO/archive $SAVE/repo/archive; mv $REPO/backup $SAVE/repo/backup; echo "repository content moved away (archive, backup)";;
  repo-deleted:revert)       mv $SAVE/repo/archive $REPO/archive; mv $SAVE/repo/backup $REPO/backup; echo "repository content moved back";;
  *:revert)                  restore_saved;;
  *) echo "unknown $CASE:$ACT"; exit 2;;
esac
echo "newest full=$NEWEST stop=$STOP mid=$(mid | cut -c1-24) last=$(last | cut -c1-24) segs-after-stop=$(after_stop | wc -l)"
