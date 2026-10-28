set -e
mkdir -p /srv/work/r1/lab && cd /srv/work/r1/lab
cat > Dockerfile <<'DF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive TZ=UTC
RUN apt-get update -q && apt-get install -y -q --no-install-recommends systemd systemd-sysv systemd-sysv dbus ca-certificates curl gnupg lsb-release sudo jq python3 openssl bc procps iproute2 tzdata git rsync xz-utils bzip2 unzip less iputils-ping postgresql-common libpq-dev \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y -q postgresql-17 postgresql-contrib pgbackrest \
 && pg_dropcluster --stop 17 main || true \
 && systemctl disable postgresql || true \
 && rm -rf /var/lib/apt/lists/*
RUN systemctl mask systemd-resolved.service systemd-timesyncd.service systemd-networkd.service getty.target console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DF
docker build -t r1-host-img . > /srv/work/r1/logs/lab-build.log 2>&1
echo BUILD-EXIT=$? >> /srv/work/r1/logs/lab-build.log
