source /srv/work/s5/rehearsal/rh-lib.sh; cd $PROJ
(nohup bash -c 'source /srv/work/s5/rehearsal/rh-lib.sh; cd $PROJ; exdb plan apply pln_01M64PWK8A0JHZE9S6M5HBY0P8 --yes --no-wait' > $L/prod-baseline-apply.log 2>&1 < /dev/null &)
sleep 8; cat $L/prod-baseline-apply.log | cut -c1-300
