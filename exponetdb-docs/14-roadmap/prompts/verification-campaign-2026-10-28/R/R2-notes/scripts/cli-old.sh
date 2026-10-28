. /srv/work/r2/ftlib.sh
ft_reset; ft_copy apps/cli/test/backups.test.ts apps/cli/test/foundation.test.ts
for t in "TC-031" "TC-032" "TC-033" "TC-022" "TC-015|query statistics|CAPABILITY_UNAVAILABLE"; do
  echo "##### OLD :: -t $t"
  (cd /srv/work/r2/old/apps/cli && bunx vitest run test/backups.test.ts test/foundation.test.ts -t "$t" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "^ *(×|✓)|Test Files|Tests  |AssertionError|Error:" | head -14)
done
ft_reset
