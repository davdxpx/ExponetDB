. /srv/work/r2/ftlib.sh
export TC_PG=17 TC_EVID=/srv/work/r2/evid-new
D=/srv/work/r2/new/packages/migrations-engine/test
cp /srv/work/r2/tcmig/*.ts $D/
cd /srv/work/r2/new/packages/migrations-engine
run() { echo "--- $*"; bunx vitest run --config vitest.integration.config.ts "$@" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -a -E "^\[tc:|Test Files|Tests  |FAIL|AssertionError|Error:" | cut -c1-900 | head -${L:-40}; }
run test/tc-4.int.test.ts -t "E16"
run test/tc-4.int.test.ts -t "E18"
L=60 run test/tc-1.int.test.ts -t "tamper and delete"
run test/tc-1.int.test.ts -t "unknown id"
run test/tc-5.int.test.ts -t "(j)"
run test/tc-6.int.test.ts -t "resume planner"
rm -f $D/tc-*.ts
