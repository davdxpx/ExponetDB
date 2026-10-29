. /srv/work/s3-infra/s3/lib.sh; s3_release new
psql_control -At -F ' | ' -c "select kind, left(policy_version,22), case when created_at < '2026-10-29 20:00:30' then 'created on d0229550' else 'created on d51da5d0' end as rel, count(*) from operations.plans group by 1,2,3 order by 1,3"
