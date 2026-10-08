package capabilities

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Host observations: read from /proc and statfs by the agent itself, or
// from systemd through the helper. They are the host's word, shown as such.

func (e *Env) read(path string) ([]byte, error) { return os.ReadFile(e.Root + path) }

func (e *Env) meminfo() (map[string]int64, error) {
	data, err := e.read("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	out := map[string]int64{}
	s := bufio.NewScanner(bytes.NewReader(data))
	for s.Scan() {
		name, rest, ok := strings.Cut(s.Text(), ":")
		f := strings.Fields(rest)
		if !ok || len(f) == 0 {
			continue
		}
		n, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		out[name] = n
	}
	return out, nil
}

func (e *Env) load() (float64, float64, float64, error) {
	data, err := e.read("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	f := strings.Fields(string(data))
	if len(f) < 3 {
		return 0, 0, 0, errors.New("/proc/loadavg is malformed")
	}
	l1, _ := strconv.ParseFloat(f[0], 64)
	l5, _ := strconv.ParseFloat(f[1], 64)
	l15, _ := strconv.ParseFloat(f[2], 64)
	return l1, l5, l15, nil
}

var realFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true, "overlay": true, "f2fs": true}

func percent(part, whole float64) float64 {
	if whole <= 0 {
		return 0
	}
	p := part * 100 / whole
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// mounts lists the real file systems with their use (at most 64).
func (e *Env) mounts() (canon.Array, error) {
	data, err := e.read("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	out := canon.Array{}
	seen := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || !realFS[f[2]] || seen[f[1]] || len(out) == 64 {
			continue
		}
		path := strings.ReplaceAll(f[1], `\040`, " ")
		if !strings.HasPrefix(path, "/") {
			continue
		}
		seen[f[1]] = true
		var st syscall.Statfs_t
		if syscall.Statfs(e.Root+path, &st) != nil {
			continue
		}
		total := int64(st.Blocks) * st.Bsize
		used := total - int64(st.Bfree)*st.Bsize
		inodes := percent(float64(st.Files-st.Ffree), float64(st.Files))
		out = append(out, obj("path", path, "usedBytes", used, "totalBytes", total, "inodesUsedPercent", inodes))
	}
	return out, nil
}

// ----- system.health@1 -----

type systemHealth struct{ unbound }

func (p systemHealth) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	l1, l5, l15, err := p.env.load()
	if err != nil {
		return nil, err
	}
	mem, err := p.env.meminfo()
	if err != nil {
		return nil, err
	}
	mounts, err := p.env.mounts()
	if err != nil {
		return nil, err
	}
	synced, _ := p.env.Clock.Synchronized()
	failed, err := p.env.Helper.Call(ctx, helperproto.OpFailedUnits, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "collect"); err != nil {
		return nil, err
	}
	return obj("load1", l1, "load5", l5, "load15", l15, "memoryTotalBytes", mem["MemTotal"],
		"memoryAvailableBytes", mem["MemAvailable"], "swapTotalBytes", mem["SwapTotal"],
		"swapUsedBytes", max(0, mem["SwapTotal"]-mem["SwapFree"]), "mounts", mounts, "ntpSynchronized", synced,
		"failedUnits", member(failed, "units")), nil
}

// ----- system.reboot_required@1 -----

type rebootRequired struct{ unbound }

func (p rebootRequired) Run(_ context.Context, _ *verify.Job, run *agent.Run) (canon.Object, error) {
	_, err := os.Stat(p.env.Root + "/var/run/reboot-required")
	required := err == nil
	packages := canon.Array{}
	if data, err := p.env.read("/var/run/reboot-required.pkgs"); err == nil {
		seen := map[string]bool{}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || seen[line] || len(packages) == 256 {
				continue
			}
			seen[line] = true
			packages = append(packages, canon.String(bound(line, 256)))
		}
	}
	if err := step(run, "collect"); err != nil {
		return nil, err
	}
	return obj("required", required, "packages", packages), nil
}

// ----- disk.stats@1 -----

type diskStats struct{ fixed }

// Precondition: the cluster binding when a cluster is named.
func (p diskStats) Precondition(args canon.Object) error {
	if _, isNull := member(args, "cluster").(canon.Null); isNull {
		return nil
	}
	return p.env.clusterPrecondition(args)
}

func (p diskStats) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	mounts, err := p.env.mounts()
	if err != nil {
		return nil, err
	}
	breakdown := canon.Array{}
	if _, isNull := member(job.Args, "cluster").(canon.Null); !isNull {
		in, c, err := p.env.session(ctx, job.Args, "")
		if err != nil {
			return nil, err
		}
		defer c.Close()
		name, _ := clusterRef(job.Args)
		major, cluster, _ := strings.Cut(name, "/")
		rows, err := c.Query(ctx, `SELECT
			(SELECT coalesce(sum(pg_catalog.pg_database_size(oid)), 0) FROM pg_catalog.pg_database) AS data,
			(SELECT coalesce(sum(size), 0) FROM pg_catalog.pg_ls_waldir()) AS wal,
			(SELECT coalesce(sum(size), 0) FROM pg_catalog.pg_ls_tmpdir()) AS temp,
			coalesce((pg_catalog.pg_stat_file($1, true)).size, 0) AS logs`,
			"/var/log/postgresql/postgresql-"+major+"-"+cluster+".log")
		if err != nil {
			return nil, err
		}
		_ = in
		r := rows.Each()[0]
		for _, k := range []string{"data", "wal", "logs", "temp"} {
			breakdown = append(breakdown, obj("category", k, "bytes", int64(r.Float(k))))
		}
	}
	if err := step(run, "collect"); err != nil {
		return nil, err
	}
	return obj("mounts", mounts, "breakdown", breakdown), nil
}

// ----- memory.stats@1 -----

type memoryStats struct{ unbound }

func (p memoryStats) Run(_ context.Context, _ *verify.Job, run *agent.Run) (canon.Object, error) {
	m, err := p.env.meminfo()
	if err != nil {
		return nil, err
	}
	if err := step(run, "collect"); err != nil {
		return nil, err
	}
	return obj("totalBytes", m["MemTotal"], "availableBytes", m["MemAvailable"],
		"usedBytes", max(0, m["MemTotal"]-m["MemAvailable"]), "cachedBytes", m["Cached"]+m["Buffers"],
		"swapTotalBytes", m["SwapTotal"], "swapUsedBytes", max(0, m["SwapTotal"]-m["SwapFree"])), nil
}

// ----- cpu.stats@1 -----

type cpuStats struct{ unbound }

type cpuSample struct{ user, system, iowait, idle, total float64 }

func (e *Env) cpuSample() (cpuSample, error) {
	data, err := e.read("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	line, _, _ := strings.Cut(string(data), "\n")
	f := strings.Fields(line)
	if len(f) < 8 || f[0] != "cpu" {
		return cpuSample{}, errors.New("/proc/stat is malformed")
	}
	v := make([]float64, len(f)-1)
	for i, x := range f[1:] {
		v[i], _ = strconv.ParseFloat(x, 64)
	}
	var s cpuSample
	for i, x := range v {
		if i < 8 { // user nice system idle iowait irq softirq steal (guest counts are in user)
			s.total += x
		}
	}
	s.user, s.system, s.idle, s.iowait = v[0]+v[1], v[2]+v[5]+v[6], v[3], v[4]
	return s, nil
}

func (p cpuStats) Run(ctx context.Context, _ *verify.Job, run *agent.Run) (canon.Object, error) {
	a, err := p.env.cpuSample()
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(500 * time.Millisecond):
	}
	b, err := p.env.cpuSample()
	if err != nil {
		return nil, err
	}
	l1, l5, l15, err := p.env.load()
	if err != nil {
		return nil, err
	}
	dt := b.total - a.total
	if err := step(run, "collect"); err != nil {
		return nil, err
	}
	return obj("cpus", runtime.NumCPU(), "load1", l1, "load5", l5, "load15", l15,
		"userPercent", percent(b.user-a.user, dt), "systemPercent", percent(b.system-a.system, dt),
		"iowaitPercent", percent(b.iowait-a.iowait, dt), "idlePercent", percent(b.idle-a.idle, dt)), nil
}
