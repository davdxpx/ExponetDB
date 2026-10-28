#!/usr/bin/env bash
# usage: make-symlink-bundle.sh <dir>   builds a project whose bundle has `verify.sql` as a symbolic link.
# The CLI loader (apps/cli/src/local/project.ts readBundles) loads a link as an EMPTY file (Dirent.isFile() is
# false for a link) and the bundle validates: a verify.sql the author sees is not the verify.sql that runs.
set -euo pipefail
d="${1:?dir}"; mkdir -p "$d"; cd "$d"
cat > exponetdb.project.yaml <<'Y'
schema: exponetdb.project/v1
project: conformance/project
layout: bundles
defaults: {role: owner, searchPath: [public]}
executionRoles: {owner: conformance_owner}
managedScope: {includeSchemas: [public], excludeSchemas: []}
lintProfile: strict
Y
b=01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_change; mkdir -p "$b"
printf 'CREATE TABLE public.t (i int);\n' > "$b/up.sql"
printf 'SELECT false AS ok;\n' > real-verify.sql
ln -sf ../real-verify.sql "$b/verify.sql"
cat > "$b/migration.yaml" <<'Y'
schema: exponetdb.migration/v1
id: 01JB2Z6G8M4Q7R9T1V3W5X7Y9Z
name: change
description: "symlinked verify.sql"
dependsOn: []
execution: {transactional: true}
compatibility: {declared: additive}
verification: {expectations: auto, runtimeChecks: verify.sql}
Y
echo "built $d"
