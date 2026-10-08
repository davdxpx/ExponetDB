package capabilities

import (
	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
)

// All returns the Wave 5 catalog this package implements (the agent adds
// agent.diagnostics@2 and config.update@1 itself). The majors retired by the
// Wave 5 correction (F1: results that carried host values unclassified) are
// not implemented: a job of one is refused as capability_unsupported.
func All(e *Env) []agent.Capability {
	f := func(key, effect string) fixed { return fixed{key: key, effect: effect, env: e} }
	c := func(key, effect string) clusterBound { return clusterBound{f(key, effect)} }
	u := func(key string) unbound { return unbound{f(key, "")} }
	return []agent.Capability{
		postgresStatus{f("postgres.status@1", "")},
		postgresReload{c("postgres.reload@2", "reload")},
		restartPlan{c("postgres.restart.plan@1", "")},
		postgresRestart{c("postgres.restart@1", "restart")},
		configInspect{c("postgres.config.inspect@2", "")},
		configPlan{c("postgres.config.plan@2", "")},
		configApply{c("postgres.config.apply@2", "write_fragment")},
		hbaInspect{c("postgres.hba.inspect@2", "")},
		hbaApply{c("postgres.hba.apply@2", "write_file")},
		tlsInspect{c("postgres.tls.inspect@1", "")},
		tlsPlan{c("postgres.tls.plan@1", "")},
		tlsRotate{c("postgres.tls.rotate@1", "install")},
		rolesInspect{c("postgres.roles.inspect@2", "")},
		rolesPlan{c("postgres.roles.plan@2", "")},
		rolesApply{c("postgres.roles.apply@2", "execute")},
		extensionsInspect{c("postgres.extensions.inspect@1", "")},
		extensionsApply{c("postgres.extensions.apply@1", "execute")},
		systemHealth{u("system.health@1")},
		rebootRequired{u("system.reboot_required@1")},
		diskStats{f("disk.stats@1", "")},
		memoryStats{u("memory.stats@1")},
		cpuStats{u("cpu.stats@1")},
		forwarded{u("service.status@1"), helperproto.OpServiceStatus},
		logInspect{f("log.inspect@2", "")},
		walStatus{c("wal.status@1", "")},
		walArchiveStatus{c("wal.archive_status@1", "")},
		forwarded{u("packages.audit@1"), helperproto.OpPackagesAudit},
		forwarded{u("packages.plan_update@1"), helperproto.OpPackagesPlanUpdate},
	}
}
