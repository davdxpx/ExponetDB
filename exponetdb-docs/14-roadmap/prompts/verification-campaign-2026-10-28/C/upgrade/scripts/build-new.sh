#!/bin/bash
# build the release under test next to the running stack (source + build only, no services): stack name s3new
set -e
export STACK_NAME=s3new PORT_BASE=59600 PG_PORT_BASE=56600 AGENT=0 EXSTACK_REPO_SEED=/srv/work/new COMMIT=d51da5d0d8832ebc569f23985c7e5176e4d450ad
cd /srv/work/s3-infra
for p in preflight src build; do ./stack-up.sh --only $p; done
