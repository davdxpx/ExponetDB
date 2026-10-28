. /srv/work/r2/ftlib.sh
export PATH=$PATH:/usr/local/go/bin
echo "##### NEW"
(cd /srv/work/r2/new/agent/node && go test -count=1 -run 'TestOpenMissingDirectoryExplainsTheFix|TestEnrollMissingStateDirectoryExplainsFix|TestStatusSaysHowLongTheCertificateLasts' ./internal/state ./cmd/exponetdb-node 2>&1 | tail -8)
echo "##### OLD with the new test files copied"
ft_reset
ft_copy agent/node/internal/state/state_test.go agent/node/cmd/exponetdb-node/main_test.go
(cd /srv/work/r2/old/agent/node && go test -count=1 -run 'TestOpenMissingDirectoryExplainsTheFix|TestEnrollMissingStateDirectoryExplainsFix|TestStatusSaysHowLongTheCertificateLasts' ./internal/state ./cmd/exponetdb-node 2>&1 | grep -v '^\s*$' | head -24)
ft_reset
echo "##### NEW: full state and cmd packages (no regression)"
(cd /srv/work/r2/new/agent/node && go test -count=1 ./internal/state ./cmd/exponetdb-node 2>&1 | tail -5)
echo GO1-DONE
