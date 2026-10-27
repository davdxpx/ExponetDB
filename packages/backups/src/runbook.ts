import { createHash } from 'node:crypto'

/**
 * The offline restore runbook of a repository (C-35, ADR-0038 §6): a plain
 * POSIX shell script generated from the repository's current record. It
 * needs no ExponetDB process and holds no secret: every key, passphrase and
 * storage credential is read at run time from a file the operator supplies
 * from the offline material. The same record revision always gives the
 * same bytes, so the digest tells whether a filed copy is current.
 *
 * Every value written into the script comes from the registry record and
 * was validated by its Control Store CHECK constraints (host names, bucket,
 * prefix, stanza, repository index: no quote, space, `$` or backslash can
 * occur); the generator checks the same patterns again and refuses
 * anything else rather than escaping it.
 */

export interface RunbookRepository {
  readonly repositoryId: string
  readonly revision: number
  readonly clusterId: string
  readonly engine: 'pgbackrest' | 'pg_dump' | 'restic'
  readonly provider: string
  readonly endpointHost: string | null
  readonly region: string | null
  readonly bucket: string | null
  readonly prefix: string
  readonly stanza: string | null
  readonly repoIndex: number | null
  readonly cipher: 'aes-256-cbc' | 'restic' | 'none' | 'unknown'
  readonly pinnedEngineVersion: string | null
  readonly postgresMajor: number | null
}

export interface Runbook {
  readonly filename: string
  readonly script: string
  readonly digest: string
  readonly placeholders: readonly { readonly name: string; readonly meaning: string }[]
}

export class RunbookRefused extends Error {
  override readonly name = 'RunbookRefused'
}

const SAFE = {
  host: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
  region: /^[a-z0-9][a-z0-9-]{0,31}$/,
  bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  prefix: /^([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/,
  stanza: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
  version: /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/,
  id: /^bkr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  cluster: /^cls_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
}

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value) || value.includes('..')) {
    throw new RunbookRefused(`${what} is not safe to write into a shell script`)
  }
  return value
}

const HEADER = (r: RunbookRepository) => `#!/bin/sh
# ExponetDB offline restore runbook (C-35). Generated from the repository record;
# it contains no secret and needs no ExponetDB process.
#
#   repository  ${r.repositoryId} (revision ${r.revision})
#   cluster     ${r.clusterId}
#   engine      ${r.engine}${r.pinnedEngineVersion === null ? '' : ` ${r.pinnedEngineVersion} (pinned)`}
#
# Run it on a disposable or recovery host as the PostgreSQL OS user. It never
# restores into an existing, non-empty directory and starts the restored
# cluster on a localhost-only port. Read the whole script before running it.
set -eu
umask 077

fail() { printf 'runbook: %s\\n' "$1" >&2; exit 1; }
`

const TARGET_CHECKS = `: "\${TARGET_DIR:?set TARGET_DIR (see the header)}"
: "\${PG_BIN:?set PG_BIN (see the header)}"
case "$TARGET_DIR" in /*) ;; *) fail "TARGET_DIR must be an absolute path" ;; esac
case "$TARGET_DIR" in *[!A-Za-z0-9_./-]*) fail "TARGET_DIR may hold only letters, digits and _ . / -" ;; esac
if [ -e "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
  fail "TARGET_DIR exists and is not empty: refusing to restore over it"
fi
PORT="\${PORT:-55432}"
case "$PORT" in *[!0-9]*|'') fail "PORT must be a number" ;; esac
[ -x "$PG_BIN/pg_ctl" ] || fail "PG_BIN does not contain pg_ctl"
`

const START_AND_CHECK = `
# Start the restored cluster on localhost only, with its own socket directory.
mkdir -p "$TARGET_DIR/exponetdb-socket"
cat > "$TARGET_DIR/exponetdb-restore.conf" <<CONF
port = $PORT
listen_addresses = 'localhost'
unix_socket_directories = '$TARGET_DIR/exponetdb-socket'
archive_mode = off
CONF
printf 'include_if_exists = %s\\n' "'$TARGET_DIR/exponetdb-restore.conf'" >> "$TARGET_DIR/postgresql.auto.conf"
"$PG_BIN/pg_ctl" -D "$TARGET_DIR" -l "$TARGET_DIR/exponetdb-restore.log" -w -t 3600 start

cat <<'NEXT'
The cluster runs. Check it before you trust it (restore.md §3):
  1. recovery finished:   psql -h "$TARGET_DIR/exponetdb-socket" -p "$PORT" -c 'SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn()'
  2. index integrity:     CREATE EXTENSION IF NOT EXISTS amcheck; SELECT bt_index_check(c.oid) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam WHERE a.amname = 'btree';
  3. data:                row counts of the tables you know, and your application's own checks.
Record the result afterwards in ExponetDB (POST /clusters/{id}/drills/offline): it is an attestation.
Stop it with: "$PG_BIN/pg_ctl" -D "$TARGET_DIR" stop
NEXT
`

function pgbackrest(r: RunbookRepository): {
  script: string
  placeholders: Runbook['placeholders']
} {
  const stanza = checked(r.stanza ?? '', SAFE.stanza, 'stanza')
  const repo = r.repoIndex
  if (repo === null || !Number.isInteger(repo) || repo < 1 || repo > 4) {
    throw new RunbookRefused('repository index is not 1 to 4')
  }
  const placeholders: { name: string; meaning: string }[] = [
    {
      name: 'TARGET_DIR',
      meaning: 'An absolute path of a new, empty directory for the restored cluster.',
    },
    { name: 'PG_BIN', meaning: 'The bin directory of the PostgreSQL major that wrote the backup.' },
    {
      name: 'PORT',
      meaning: 'Optional: the localhost port of the restored cluster (default 55432).',
    },
    {
      name: 'RESTORE_TYPE',
      meaning: 'Optional: default (to the end of the archive), time, lsn or immediate.',
    },
    {
      name: 'RESTORE_TARGET',
      meaning: 'With time or lsn: the target ("2026-10-26 09:30:00+00" or an LSN).',
    },
    { name: 'BACKUP_SET', meaning: 'Optional: a backup label to restore instead of the newest.' },
  ]
  let lines = `${TARGET_CHECKS}`
  lines += `
command -v pgbackrest >/dev/null 2>&1 || fail "pgbackrest is not installed"
`
  if (r.pinnedEngineVersion !== null) {
    const v = checked(r.pinnedEngineVersion, SAFE.version, 'engine version')
    lines += `pgbackrest version | grep -q 'pgBackRest ${v}' || printf 'runbook: warning: the installed pgBackRest is not the pinned %s\\n' '${v}' >&2
`
  }
  const work = '"$WORK"'
  lines += `WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CONF=${work}/pgbackrest.conf
{
  printf '[global]\\n'
`
  if (r.provider === 'posix') {
    const path = checked(
      `/${r.prefix}`.replace(/\/+$/, '') || '/',
      /^\/([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/,
      'path',
    )
    lines += `  printf 'repo${repo}-path=%s\\n' '${path}'
`
  } else {
    const host = checked(r.endpointHost ?? '', SAFE.host, 'endpoint host')
    const bucket = checked(r.bucket ?? '', SAFE.bucket, 'bucket')
    const region = r.region === null ? 'auto' : checked(r.region, SAFE.region, 'region')
    const path = `/${checked(r.prefix, SAFE.prefix, 'prefix')}`.replace(/\/+$/, '') || '/'
    placeholders.push(
      {
        name: 'S3_KEY_FILE',
        meaning: 'A file holding the storage access key id (offline material).',
      },
      {
        name: 'S3_SECRET_FILE',
        meaning: 'A file holding the storage secret key (offline material).',
      },
      {
        name: 'S3_URI_STYLE',
        meaning: 'Optional: host (default) or path, as the provider requires.',
      },
    )
    lines += `  printf 'repo${repo}-type=s3\\n'
  printf 'repo${repo}-s3-endpoint=%s\\n' '${host}'
  printf 'repo${repo}-s3-bucket=%s\\n' '${bucket}'
  printf 'repo${repo}-s3-region=%s\\n' '${region}'
  printf 'repo${repo}-s3-uri-style=%s\\n' "\${S3_URI_STYLE:-host}"
  printf 'repo${repo}-path=%s\\n' '${path}'
`
  }
  if (r.cipher === 'aes-256-cbc' || r.cipher === 'unknown') {
    placeholders.push({
      name: 'CIPHER_PASS_FILE',
      meaning:
        'A file holding the repository cipher passphrase (offline material; required when the repository is encrypted).',
    })
    lines += `  printf 'repo${repo}-cipher-type=aes-256-cbc\\n'
`
  }
  lines += `  printf '[${stanza}]\\npg1-path=%s\\n' "$TARGET_DIR"
} > "$CONF"
`
  if (r.provider !== 'posix') {
    lines += `: "\${S3_KEY_FILE:?set S3_KEY_FILE (see the header)}"
: "\${S3_SECRET_FILE:?set S3_SECRET_FILE (see the header)}"
PGBACKREST_REPO${repo}_S3_KEY="$(cat "$S3_KEY_FILE")"; export PGBACKREST_REPO${repo}_S3_KEY
PGBACKREST_REPO${repo}_S3_KEY_SECRET="$(cat "$S3_SECRET_FILE")"; export PGBACKREST_REPO${repo}_S3_KEY_SECRET
`
  }
  if (r.cipher === 'aes-256-cbc' || r.cipher === 'unknown') {
    lines += `: "\${CIPHER_PASS_FILE:?set CIPHER_PASS_FILE (see the header)}"
PGBACKREST_REPO${repo}_CIPHER_PASS="$(cat "$CIPHER_PASS_FILE")"; export PGBACKREST_REPO${repo}_CIPHER_PASS
`
  }
  lines += `
pgbackrest --config="$CONF" --stanza=${stanza} --repo=${repo} info
mkdir -p "$TARGET_DIR"
set -- --config="$CONF" --stanza=${stanza} --repo=${repo} --pg1-path="$TARGET_DIR"
case "\${RESTORE_TYPE:-default}" in
  default) ;;
  immediate) set -- "$@" --type=immediate --target-action=promote ;;
  time|lsn) : "\${RESTORE_TARGET:?set RESTORE_TARGET (see the header)}"; set -- "$@" --type="$RESTORE_TYPE" --target="$RESTORE_TARGET" --target-action=promote ;;
  *) fail "RESTORE_TYPE must be default, time, lsn or immediate" ;;
esac
if [ -n "\${BACKUP_SET:-}" ]; then set -- "$@" --set="$BACKUP_SET"; fi
pgbackrest "$@" restore
`
  lines += START_AND_CHECK
  return { script: lines, placeholders }
}

function restic(r: RunbookRepository): { script: string; placeholders: Runbook['placeholders'] } {
  const placeholders: { name: string; meaning: string }[] = [
    {
      name: 'TARGET_DIR',
      meaning: 'An absolute path of a new, empty directory for the restored cluster.',
    },
    {
      name: 'PG_BIN',
      meaning:
        'The bin directory of the PostgreSQL major to restore into (pg_ctl, initdb, pg_restore, psql).',
    },
    { name: 'PORT', meaning: 'Optional: the localhost port of the new cluster (default 55432).' },
    {
      name: 'RESTIC_PASSWORD_FILE',
      meaning: 'A file holding the restic repository password (offline material).',
    },
    {
      name: 'SNAPSHOT',
      meaning: 'Optional: the restic snapshot id; default the newest snapshot tagged exponetdb.',
    },
  ]
  let repository: string
  if (r.provider === 'posix') {
    repository = `/${checked(r.prefix, SAFE.prefix, 'prefix')}`.replace(/\/+$/, '') || '/'
  } else {
    const host = checked(r.endpointHost ?? '', SAFE.host, 'endpoint host')
    const bucket = checked(r.bucket ?? '', SAFE.bucket, 'bucket')
    const prefix = checked(r.prefix, SAFE.prefix, 'prefix').replace(/\/+$/, '')
    repository = `s3:https://${host}/${bucket}${prefix === '' ? '' : `/${prefix}`}`
    placeholders.push(
      {
        name: 'AWS_ACCESS_KEY_ID_FILE',
        meaning: 'A file holding the storage access key id (offline material).',
      },
      {
        name: 'AWS_SECRET_ACCESS_KEY_FILE',
        meaning: 'A file holding the storage secret key (offline material).',
      },
    )
  }
  let lines = TARGET_CHECKS
  lines += `
command -v restic >/dev/null 2>&1 || fail "restic is not installed"
: "\${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE (see the header)}"
export RESTIC_PASSWORD_FILE
RESTIC_REPOSITORY='${repository}'; export RESTIC_REPOSITORY
`
  if (r.provider !== 'posix') {
    lines += `: "\${AWS_ACCESS_KEY_ID_FILE:?set AWS_ACCESS_KEY_ID_FILE (see the header)}"
: "\${AWS_SECRET_ACCESS_KEY_FILE:?set AWS_SECRET_ACCESS_KEY_FILE (see the header)}"
AWS_ACCESS_KEY_ID="$(cat "$AWS_ACCESS_KEY_ID_FILE")"; export AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY="$(cat "$AWS_SECRET_ACCESS_KEY_FILE")"; export AWS_SECRET_ACCESS_KEY
`
  }
  lines += `WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
restic snapshots --tag exponetdb
restic restore "\${SNAPSHOT:-latest}" --tag exponetdb --target "$WORK/dump"
ls "$WORK/dump" >/dev/null

# A new, empty cluster for the logical dumps.
mkdir -p "$TARGET_DIR"
"$PG_BIN/initdb" -D "$TARGET_DIR" --auth=peer >/dev/null
`
  lines += START_AND_CHECK.replace(
    "cat <<'NEXT'",
    `for globals in $(find "$WORK/dump" -name 'globals*.sql' -type f); do
  printf 'runbook: review %s before applying it (roles without passwords)\\n' "$globals" >&2
done
for dump in $(find "$WORK/dump" -name '*.dump' -type f); do
  "$PG_BIN/pg_restore" --list "$dump" >/dev/null || fail "unreadable dump: $dump"
  name="$(basename "$dump" .dump)"
  "$PG_BIN/psql" -h "$TARGET_DIR/exponetdb-socket" -p "$PORT" -d postgres -c "CREATE DATABASE \\"$name\\"" || true
  "$PG_BIN/pg_restore" -h "$TARGET_DIR/exponetdb-socket" -p "$PORT" -d "$name" --no-owner --exit-on-error "$dump"
done
cat <<'NEXT'`,
  )
  return { script: lines, placeholders }
}

/** Generates the runbook; deterministic for one record revision. */
export function generateRunbook(r: RunbookRepository): Runbook {
  checked(r.repositoryId, SAFE.id, 'repository id')
  checked(r.clusterId, SAFE.cluster, 'cluster id')
  if (!Number.isInteger(r.revision) || r.revision < 1) {
    throw new RunbookRefused('revision is not a positive integer')
  }
  const body =
    r.engine === 'pgbackrest'
      ? pgbackrest(r)
      : r.engine === 'restic' || r.engine === 'pg_dump'
        ? restic(r)
        : null
  if (body === null) {
    throw new RunbookRefused('no runbook for this engine')
  }
  const script = `${HEADER(r)}${body.script}`
  const digest = `sha256:${createHash('sha256').update(script, 'utf8').digest('hex')}`
  return {
    filename: `exponetdb-restore-${r.repositoryId.toLowerCase()}.sh`,
    script,
    digest,
    placeholders: body.placeholders,
  }
}
