. /srv/work/r2/ftlib.sh
ft_reset
ft_copy packages/postgres/test/admission.test.ts packages/diagnostics/test/data-read.int.test.ts
echo "### admission.test on OLD"
(cd packages/postgres && bunx vitest run test/admission.test.ts 2>&1 | grep -E "✗|×|FAIL|Tests |Test Files|AssertionError|expected" | head -20)
echo "### data-read.int on OLD"
(cd packages/diagnostics && bunx vitest run --config vitest.integration.config.ts test/data-read.int.test.ts -t "TC-014" 2>&1 | grep -E "✗|×|FAIL|Tests |Test Files|AssertionError|expected|Error" | head -20)
ft_reset
