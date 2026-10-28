. /srv/work/r2/ftlib.sh
cd /srv/work/r2/new
echo "##### TC-029: bun run verify:host --list"
bun run verify:host --list 2>&1 | head -20
echo "##### TC-026: test:lab script, lab config, go vet -tags pglab"
grep -n '"test:lab"' packages/backups/package.json; ls packages/backups/vitest.lab.config.ts
(cd agent/node && go vet -tags pglab ./... 2>&1 | tail -3; echo "go vet -tags pglab rc=${PIPESTATUS[0]}")
echo "##### TC-026: mutation (a symbol used by pglab_test.go is renamed in a scratch copy)"
rm -rf /srv/work/r2/mut && mkdir -p /srv/work/r2/mut && cp -r agent/node /srv/work/r2/mut/node
(cd /srv/work/r2/mut/node && sed -i 's/\bunitState\b/unitStateRenamed/g' $(grep -l '\bunitState\b' internal/helper/*.go | grep -v _test.go) && go vet ./... >/dev/null 2>&1; echo "untagged go vet after rename rc=$?"; go vet -tags pglab ./... 2>&1 | head -3; echo "go vet -tags pglab after rename rc=${PIPESTATUS[0]}")
rm -rf /srv/work/r2/mut
echo "##### TC-028: mutation check of selection.test.ts"
sed -i 's/const b = verified\[1\]/const b = verified[0]/' packages/backups/src/selection.ts
vt new packages/backups test/selection.test.ts
git checkout -q -- packages/backups/src/selection.ts
sed -i 's/Date.parse(x.view.finishedAt ?? .*) <= request.atMs)/Date.parse(x.view.finishedAt ?? "") >= request.atMs)/' packages/backups/src/selection.ts
git diff --stat | tail -2
vt new packages/backups test/selection.test.ts
git checkout -q -- packages/backups/src/selection.ts
git status --short | head -3
echo "##### golden:check"
bun run golden:check 2>&1 | tail -4
echo MISC-DONE
