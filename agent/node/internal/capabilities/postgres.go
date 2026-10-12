package capabilities

import (
	"context"
	"errors"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// ----- postgres.status@1 -----

type postgresStatus struct{ fixed }

// Precondition: a mapped cluster. Its identity is checked whenever it
// answers; a cluster that does not answer is reported as not running, which
// needs no identity (capabilities.md §2).
func (p postgresStatus) Precondition(args canon.Object) error {
	_, err := p.env.instance(args)
	return err
}

func (p postgresStatus) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, err := p.env.instance(job.Args)
	if err != nil {
		return nil, err
	}
	c, err := p.env.connect(ctx, in, "")
	if err != nil {
		var pe *pgwire.Error
		// 57P03: the server is starting up or shutting down; it runs.
		running := errors.As(err, &pe) && pe.Code == "57P03"
		if err := step(run, "probe"); err != nil {
			return nil, err
		}
		return obj("running", running, "acceptingConnections", false, "version", nil,
			"postmasterStartTime", nil, "inRecovery", nil, "dataDirectory", in.DataDirectory), nil
	}
	defer c.Close()
	if err := p.env.checkIdentity(ctx, c, job.Args); err != nil {
		return nil, err
	}
	rows, err := c.Query(ctx, `SELECT current_setting('server_version') AS version,
		pg_catalog.pg_postmaster_start_time() AS started, pg_catalog.pg_is_in_recovery() AS recovery`)
	if err != nil {
		return nil, err
	}
	r := rows.Each()[0]
	started, _ := pgTime(r.Text("started"))
	if err := step(run, "probe"); err != nil {
		return nil, err
	}
	return obj("running", true, "acceptingConnections", true, "version", bound(r.Text("version"), 64),
		"postmasterStartTime", started, "inRecovery", r.Bool("recovery"), "dataDirectory", in.DataDirectory), nil
}

// ----- shared reads -----

func pendingRestart(ctx context.Context, c *pgwire.Conn) (canon.Array, error) {
	rows, err := c.Query(ctx, `SELECT name FROM pg_catalog.pg_settings WHERE pending_restart ORDER BY name LIMIT 512`)
	if err != nil {
		return nil, err
	}
	out := canon.Array{}
	for _, r := range rows.Each() {
		out = append(out, canon.String(r.Text("name")))
	}
	return out, nil
}

func fileErrors(ctx context.Context, c *pgwire.Conn) (canon.Array, error) {
	rows, err := c.Query(ctx, `SELECT sourcefile, sourceline, error FROM pg_catalog.pg_file_settings
		WHERE error IS NOT NULL ORDER BY seqno LIMIT 64`)
	if err != nil {
		return nil, err
	}
	out := canon.Array{}
	for _, r := range rows.Each() {
		var line any
		if !r.Null("sourceline") {
			line = r.Int("sourceline")
		}
		var file any
		if f := r.TextOrNil("sourcefile"); f != nil {
			file = bound(*f, 4096)
		}
		// The message only when it is fixed text: PostgreSQL can quote the
		// file in it (an included file's name).
		out = append(out, obj("sourcefile", file, "sourceline", line, "error", shownError(fixedFileErrors, r.TextOrNil("error"))))
	}
	return out, nil
}

// StepReload is the step a job journals only after reload returned: the
// postmaster was signaled after the job's effect and this session saw the
// configuration loaded again. The contracts name it as the capability's
// reloadStep; a statement listing it after the effect step proves the reload
// for that job, whatever its outcome (ADR-0025).
const StepReload = "reload"

// reload signals the postmaster and waits until this session has loaded the
// configuration again (pg_conf_load_time advances), so what is read next
// reflects it.
func reload(ctx context.Context, c *pgwire.Conn) error {
	rows, err := c.Query(ctx, `SELECT pg_catalog.pg_conf_load_time()::text AS t`)
	if err != nil {
		return err
	}
	before := rows.Each()[0].Text("t")
	if _, err := c.Query(ctx, `SELECT pg_catalog.pg_reload_conf()`); err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		rows, err := c.Query(ctx, `SELECT pg_catalog.pg_conf_load_time()::text AS t`)
		if err != nil {
			return err
		}
		if rows.Each()[0].Text("t") != before {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return errors.New("the configuration was not loaded again within 10 s")
}

// ----- postgres.reload@2 -----

type postgresReload struct{ clusterBound }

func (p postgresReload) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	if err := reload(ctx, c); err != nil {
		return nil, err
	}
	if err := step(run, "reload"); err != nil {
		return nil, err
	}
	pending, err := pendingRestart(ctx, c)
	if err != nil {
		return nil, err
	}
	errs, err := fileErrors(ctx, c)
	if err != nil {
		return nil, err
	}
	return obj("reloadedAt", p.env.now(), "pendingRestart", pending, "fileErrors", errs), nil
}

// ----- postgres.restart.plan@2 -----

type restartPlan struct{ clusterBound }

func (p restartPlan) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	pending, err := pendingRestart(ctx, c)
	if err != nil {
		return nil, err
	}
	// Connections per role only: a client's application_name is a text it
	// chooses and never leaves the host (@2, Wave 5 correction review).
	conns, err := c.Query(ctx, `SELECT usename AS role, count(*) AS n
		FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()
		GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 256`)
	if err != nil {
		return nil, err
	}
	connections := canon.Array{}
	for _, r := range conns.Each() {
		var role any
		if v := r.TextOrNil("role"); v != nil {
			role = bound(*v, 256)
		}
		connections = append(connections, obj("role", role, "count", r.Int("n")))
	}
	counts, err := c.Query(ctx, `SELECT
		(SELECT count(*) FROM pg_catalog.pg_stat_progress_basebackup) AS backups,
		(SELECT count(*) FROM pg_catalog.pg_stat_progress_vacuum) +
		(SELECT count(*) FROM pg_catalog.pg_stat_progress_create_index) +
		(SELECT count(*) FROM pg_catalog.pg_stat_progress_cluster) AS maintenance`)
	if err != nil {
		return nil, err
	}
	slots, err := c.Query(ctx, `SELECT slot_name AS name, active FROM pg_catalog.pg_replication_slots ORDER BY 1 LIMIT 64`)
	if err != nil {
		return nil, err
	}
	slotList := canon.Array{}
	for _, r := range slots.Each() {
		slotList = append(slotList, obj("name", bound(r.Text("name"), 256), "active", r.Bool("active")))
	}
	n := counts.Each()[0]
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("shutdownMode", "fast", "pendingRestart", pending, "connections", connections,
		"activeBackups", n.Int("backups"), "activeMaintenance", n.Int("maintenance"), "replicationSlots", slotList), nil
}

// ----- postgres.restart@1 -----

type postgresRestart struct{ clusterBound }

func (p postgresRestart) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	rows, err := c.Query(ctx, `SELECT pg_catalog.pg_postmaster_start_time() AS started`)
	_ = c.Close()
	if err != nil {
		return nil, err
	}
	before, _ := pgTime(rows.Each()[0].Text("started"))
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	if _, err := p.env.Helper.Call(ctx, helperproto.OpServiceRestart, job.Envelope); err != nil {
		return nil, err
	}
	if err := step(run, "restart"); err != nil {
		return nil, err
	}
	c, err = waitReady(ctx, p.env, in)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	after, err := c.Query(ctx, `SELECT pg_catalog.pg_postmaster_start_time() AS started, current_setting('server_version') AS version`)
	if err != nil {
		return nil, err
	}
	started, _ := pgTime(after.Each()[0].Text("started"))
	if !started.After(before) {
		return nil, errors.New("the postmaster start time did not advance: the instance did not restart")
	}
	pending, err := pendingRestart(ctx, c)
	if err != nil {
		return nil, err
	}
	return obj("postmasterStartTimeBefore", before, "postmasterStartTimeAfter", started, "acceptingConnections", true,
		"version", bound(after.Each()[0].Text("version"), 64), "pendingRestart", pending), nil
}

// waitReady waits up to two minutes for the instance to accept connections.
func waitReady(ctx context.Context, e *Env, in config.Instance) (*pgwire.Conn, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		c, err := e.connect(ctx, in, "")
		if err == nil {
			return c, nil
		}
		if time.Now().After(deadline) {
			return nil, errors.New("the instance does not accept connections after the restart")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
