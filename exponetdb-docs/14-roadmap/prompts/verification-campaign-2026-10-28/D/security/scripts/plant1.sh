#!/usr/bin/env bash
# S4 task 1, step 1: plant the canaries (host secrets of the node, target role passwords) and register them through the product.
source /srv/work/s4/env.sh
set -u
cd "$S4"
C16=$(stack_id cluster_pg16); C17=$(stack_id cluster_pg17); C18=$(stack_id cluster_pg18)
# --- host secrets on the adopted PG17 cluster (settings the node reads and must withhold) and the backup tools' configuration
D=/etc/postgresql/17/exdbnode
python3 - <<'PY' | install -m 0644 -o postgres -g postgres /dev/stdin $D/conf.d/50-s4-host-secrets.conf
import json
p = json.load(open("/srv/work/s4/planted.json"))
print(f"ssl_passphrase_command = 'echo {p['C3-ssl-passphrase-command']}'")
print(f"archive_command = 'true # {p['C3-archive-command']}'")
print(f"primary_conninfo = 'host=127.0.0.1 port=1 user=s4repl password={p['C3-primary-conninfo']}'")
PY
cp -n $D/pg_hba.conf $S4/pg_hba.17.orig
python3 - <<'PY' >> $D/pg_hba.conf
import json
p = json.load(open("/srv/work/s4/planted.json"))
print(f"host all s4_ldap 203.0.113.0/24 ldap ldapserver=ldap.invalid ldapport=389 ldapbinddn=cn=s4 ldapbindpasswd={p['C3-hba-ldapbindpasswd']} ldapsearchattribute=uid ldapbasedn=dc=s4")
PY
python3 - <<'PY' > /etc/pgbackrest.conf
import json
p = json.load(open("/srv/work/s4/planted.json"))
print(f"""[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass={p['C3-pgbackrest-cipher-pass']}
repo1-retention-full=2

[s4main]
pg1-path=/var/lib/postgresql/17/exdbnode
pg1-port=55417
pg1-socket-path=/var/run/postgresql
""")
PY
chmod 0640 /etc/pgbackrest.conf; chown root:postgres /etc/pgbackrest.conf
install -m 0600 /dev/null /etc/restic-password; python3 -c "import json;print(json.load(open('/srv/work/s4/planted.json'))['C3-restic-password'])" > /etc/restic-password
systemctl reload postgresql@17-exdbnode.service && echo "pg17 reloaded"
psql_target pg17 -Atc "select name, left(setting,0)||'set' from pg_settings where name in ('ssl_passphrase_command','archive_command','primary_conninfo') and setting<>''"
# --- consumer role for the verifier flow; target role passwords (SCRAM verifiers computed here, never on a command line)
psql_target pg17 -qc "CREATE ROLE s4_canary_app LOGIN" 2>&1 | head -1
python3 $S4/scram.py C2-migrator-password | { read -r v; psql_target pg16 -q <<<"ALTER ROLE exponetdb_migrator PASSWORD '$v'"; }
python3 $S4/scram.py C2-reader-password   | { read -r v; psql_target pg16 -q <<<"ALTER ROLE exponetdb_reader PASSWORD '$v'"; }
# a row value carrying a canary-shaped literal in a target table (data, not a secret: it must not travel into audit or plans)
python3 -c "import json;print(json.load(open('/srv/work/s4/planted.json'))['C6-sql-literal'])" | { read -r v; PGDATABASE=lab_dev16 psql_target pg16 -q <<<"CREATE TABLE IF NOT EXISTS public.s4_rows(id int primary key, note text); INSERT INTO public.s4_rows VALUES (1,'$v') ON CONFLICT DO NOTHING; GRANT SELECT ON public.s4_rows TO exponetdb_reader"; }
echo planted
