package capabilities

import (
	"context"
	"fmt"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// ----- extensions (per database) -----

func installedExtensions(ctx context.Context, c *pgwire.Conn) (canon.Array, string, error) {
	rows, err := c.Query(ctx, `SELECT e.extname, e.extversion, n.nspname FROM pg_catalog.pg_extension e
		JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace ORDER BY 1 LIMIT 1024`)
	if err != nil {
		return nil, "", err
	}
	installed := canon.Array{}
	for _, r := range rows.Each() {
		installed = append(installed, obj("name", bound(r.Text("extname"), 256), "version", bound(r.Text("extversion"), 256),
			"schema", bound(r.Text("nspname"), 256)))
	}
	d, err := digest(obj("installed", installed))
	return installed, d, err
}

type extensionsInspect struct{ clusterBound }

func (p extensionsInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, text(job.Args, "database"))
	if err != nil {
		return nil, err
	}
	defer c.Close()
	installed, d, err := installedExtensions(ctx, c)
	if err != nil {
		return nil, err
	}
	rows, err := c.Query(ctx, `SELECT a.name, a.default_version,
		(SELECT array_to_string(array_agg(v.version ORDER BY v.version), chr(31)) FROM pg_catalog.pg_available_extension_versions v
		  WHERE v.name = a.name) AS versions
		FROM pg_catalog.pg_available_extensions a ORDER BY 1 LIMIT 2048`)
	if err != nil {
		return nil, err
	}
	available := canon.Array{}
	for _, r := range rows.Each() {
		versions := canon.Array{}
		for i, v := range strings.Split(r.Text("versions"), "\x1f") {
			if v == "" || i == 256 {
				continue
			}
			versions = append(versions, canon.String(bound(v, 256)))
		}
		var def any
		if v := r.TextOrNil("default_version"); v != nil {
			def = bound(*v, 256)
		}
		available = append(available, obj("name", bound(r.Text("name"), 256), "defaultVersion", def, "versions", versions))
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("extensionsDigest", d, "installed", installed, "available", available), nil
}

type extensionsApply struct{ clusterBound }

// Run creates or updates extensions in order, in one transaction, never
// with CASCADE: a dependency is its own step. A version the server does not
// have (a missing package) is refused before anything changes.
func (p extensionsApply) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, text(job.Args, "database"))
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := c.Exec(ctx, "BEGIN"); err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = c.Exec(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()
	_, d, err := installedExtensions(ctx, c)
	if err != nil {
		return nil, err
	}
	if d != text(job.Args, "expectedExtensionsDigest") {
		return nil, preconditionf("the extensions changed since the plan")
	}
	steps := list(job.Args, "steps")
	for _, item := range steps {
		st, _ := item.(canon.Object)
		rows, err := c.Query(ctx, `SELECT 1 FROM pg_catalog.pg_available_extension_versions WHERE name = $1 AND version = $2`,
			text(st, "name"), text(st, "version"))
		if err != nil {
			return nil, err
		}
		if len(rows.Values) == 0 {
			return nil, preconditionf("extension %s %s is not available on the host (a missing package)", text(st, "name"), text(st, "version"))
		}
	}
	if err := step(run, "check"); err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	for i, item := range steps {
		st, _ := item.(canon.Object)
		name, version := quoteIdent(text(st, "name")), quoteLiteral(text(st, "version"))
		var sql string
		switch text(st, "op") {
		case "create":
			sql = "CREATE EXTENSION " + name + " WITH SCHEMA " + quoteIdent(text(st, "schema")) + " VERSION " + version
		case "update":
			sql = "ALTER EXTENSION " + name + " UPDATE TO " + version
		default:
			return nil, fmt.Errorf("step %d: unknown op", i)
		}
		if err := c.Exec(ctx, sql); err != nil {
			return nil, fmt.Errorf("step %d (%s %s): %w", i, text(st, "op"), text(st, "name"), err)
		}
	}
	if err := c.Exec(ctx, "COMMIT"); err != nil {
		return nil, err
	}
	committed = true
	if err := step(run, "execute"); err != nil {
		return nil, err
	}
	installed, d, err := installedExtensions(ctx, c)
	if err != nil {
		return nil, err
	}
	return obj("extensionsDigest", d, "installed", installed), nil
}

// ----- WAL (observation only) -----

type walStatus struct{ clusterBound }

func (p walStatus) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rows, err := c.Query(ctx, `SELECT CASE WHEN pg_catalog.pg_is_in_recovery() THEN NULL ELSE pg_catalog.pg_current_wal_lsn()::text END AS lsn,
		(SELECT coalesce(sum(size), 0) FROM pg_catalog.pg_ls_waldir()) AS bytes,
		current_setting('max_wal_size') AS max, w.wal_records, w.wal_bytes
		FROM pg_catalog.pg_stat_wal w`)
	if err != nil {
		return nil, err
	}
	r := rows.Each()[0]
	slots, err := c.Query(ctx, `SELECT slot_name, active, wal_status,
		CASE WHEN pg_catalog.pg_is_in_recovery() OR restart_lsn IS NULL THEN NULL
		     ELSE pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn)::bigint END AS retained
		FROM pg_catalog.pg_replication_slots ORDER BY 1 LIMIT 64`)
	if err != nil {
		return nil, err
	}
	list := canon.Array{}
	for _, s := range slots.Each() {
		var status, retained any
		if v := s.TextOrNil("wal_status"); v != nil {
			status = bound(*v, 16)
		}
		if !s.Null("retained") {
			retained = s.Int("retained")
		}
		list = append(list, obj("name", bound(s.Text("slot_name"), 256), "active", s.Bool("active"), "walStatus", status, "retainedBytes", retained))
	}
	var lsn, records, bytes any
	if v := r.TextOrNil("lsn"); v != nil {
		lsn = *v
	}
	if !r.Null("wal_records") {
		records = r.Int("wal_records")
	}
	if !r.Null("wal_bytes") {
		bytes = int64(r.Float("wal_bytes"))
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("currentLsn", lsn, "walDirectoryBytes", int64(r.Float("bytes")), "maxWalSize", bound(r.Text("max"), 32),
		"slots", list, "walRecords", records, "walBytes", bytes), nil
}

type walArchiveStatus struct{ clusterBound }

func (p walArchiveStatus) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rows, err := c.Query(ctx, `SELECT current_setting('archive_mode') AS mode, archived_count, failed_count,
		last_archived_wal, last_archived_time, last_failed_wal, last_failed_time FROM pg_catalog.pg_stat_archiver`)
	if err != nil {
		return nil, err
	}
	r := rows.Each()[0]
	name := func(col string) any {
		if v := r.TextOrNil(col); v != nil {
			return bound(*v, 256)
		}
		return nil
	}
	at := func(col string) any {
		if v := r.TextOrNil(col); v != nil {
			if t, ok := pgTime(*v); ok {
				return t
			}
		}
		return nil
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("archiveMode", bound(r.Text("mode"), 16), "archivedCount", r.Int("archived_count"), "failedCount", r.Int("failed_count"),
		"lastArchivedWal", name("last_archived_wal"), "lastArchivedAt", at("last_archived_time"),
		"lastFailedWal", name("last_failed_wal"), "lastFailedAt", at("last_failed_time")), nil
}

// ----- the helper's reads, forwarded -----

// forwarded is a capability the root helper answers in full (service status,
// package audit and plan): the agent passes the signed job and returns the
// helper's typed result, which the agent still checks against the schema.
type forwarded struct {
	unbound
	op string
}

func (f forwarded) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	out, err := f.env.Helper.Call(ctx, f.op, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "helper"); err != nil {
		return nil, err
	}
	return out, nil
}
