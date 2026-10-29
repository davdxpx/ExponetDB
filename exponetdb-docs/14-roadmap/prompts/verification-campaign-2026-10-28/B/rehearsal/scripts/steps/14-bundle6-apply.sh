source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
echo "B6 apply at $(date -u +%FT%TZ)" | tee $L/b6-apply-time
TAIL=10 tm apply-b6 exdb plan apply pln_01M64QT3TNESGTK8FR3KJX4N1C --wait
sleep 3
TAIL=14 tm drift-after-b6 exdb drift check lab/platform/rhstg
echo "last marker: $(tail -1 $L/marker.log)"
