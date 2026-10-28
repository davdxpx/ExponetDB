#!/usr/bin/env bash
# Disposable CI replica for the verification campaign (Ubuntu 24.04, UTC).
# Pinned like .github/workflows/ci.yml: Node 24.22.1, Bun 1.4.4, Go 1.26.10,
# PostgreSQL 16/17/18 from PGDG, pgBackRest and restic. Idempotent; run as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_V=24.22.1
BUN_V=1.4.4
GO_V=1.26.10
RESTIC_V=0.16.4

timedatectl set-timezone UTC || true
apt-get update -q
apt-get install -y -q build-essential git curl unzip xz-utils bzip2 jq ca-certificates gnupg lsb-release \
  docker.io docker-compose-v2 iptables iproute2 sysstat stress-ng fio rsync python3 openssl \
  postgresql-common libpq-dev

# swap, so a 8 GB machine survives a turbo run
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
fi

# Node
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "v${NODE_V}"; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_V}/node-v${NODE_V}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi
# Bun (+ bunx symlink, the first campaign needed it)
if ! /usr/local/bin/bun --version 2>/dev/null | grep -q "^${BUN_V}$"; then
  curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_V}/bun-linux-x64.zip"
  unzip -o -q /tmp/bun.zip -d /tmp/bun-x && install -m 0755 /tmp/bun-x/bun-linux-x64/bun /usr/local/bin/bun
fi
ln -sf /usr/local/bin/bun /usr/local/bin/bunx
# Go
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_V} "; then
  rm -rf /usr/local/go
  curl -fsSL "https://go.dev/dl/go${GO_V}.linux-amd64.tar.gz" | tar -xz -C /usr/local
fi
ln -sf /usr/local/go/bin/go /usr/local/bin/go; ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# PostgreSQL 16/17/18 + pgBackRest from PGDG; the default clusters are removed
# (tooling/dev/node-clusters.sh and the stack scripts create their own).
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y -q postgresql-16 postgresql-17 postgresql-18 postgresql-contrib \
  postgresql-16-pgaudit postgresql-17-pgaudit postgresql-18-pgaudit pgbackrest
for v in 16 17 18; do pg_dropcluster --stop "$v" main 2>/dev/null || true; done
systemctl disable --now postgresql 2>/dev/null || true

# restic (pinned release binary)
if ! restic version 2>/dev/null | grep -q "restic ${RESTIC_V} "; then
  curl -fsSL "https://github.com/restic/restic/releases/download/v${RESTIC_V}/restic_${RESTIC_V}_linux_amd64.bz2" | bunzip2 > /usr/local/bin/restic
  chmod 0755 /usr/local/bin/restic
fi

systemctl enable --now docker
mkdir -p /srv/work && chmod 0755 /srv/work
{
  echo "node  $(node --version)"; echo "bun   $(bun --version)"; echo "go    $(go version)"
  echo "docker $(docker --version)"; echo "pgbackrest $(pgbackrest version)"; echo "restic $(restic version | head -1)"
  for v in 16 17 18; do echo "pg$v  $(/usr/lib/postgresql/$v/bin/postgres --version)"; done
  echo "tz $(timedatectl show -p Timezone --value)"
} | tee /srv/work/toolchain.txt
echo BOOTSTRAP-OK
