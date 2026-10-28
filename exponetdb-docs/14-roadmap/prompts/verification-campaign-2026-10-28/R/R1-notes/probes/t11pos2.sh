ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
for SEG in 000000010000000000000004 000000010000000000000012 000000010000000000000016; do
  F=$(ls $ARC | grep "^$SEG" | head -1); cp -a $ARC/$F /root/lab/walsave/pos.save
  SZ=$(stat -c %s $ARC/$F)
  printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$F bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null
  echo "=== corrupt $SEG size=$SZ file=$F"
  runuser -u postgres -- pgbackrest --stanza=exdbnode verify --verbose --log-level-console=info 2>&1 | grep -vE "command begin|^$" | head -12 | cut -c1-200
  cp -a /root/lab/walsave/pos.save $ARC/$F
done
