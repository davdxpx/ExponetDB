source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
echo ---- BEFORE drift
TAIL=14 tm drift-before exdb drift check lab/platform/rhstg
