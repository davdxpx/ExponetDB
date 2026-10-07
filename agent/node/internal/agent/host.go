package agent

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
)

// Host reads facts and metrics of the machine. Every value is reported by
// the host and shown as such; none decides an operation.
type Host interface {
	Facts() (protocol.HostFacts, error)
	Metrics(mounts []string) (protocol.HeartbeatRequestHost, error)
}

// Linux reads /proc, /etc and statfs. Root is a prefix for tests ("" in production).
type Linux struct {
	Root string
	prev cpuSample
}

type cpuSample struct{ busy, total uint64 }

var hostnameRE = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)

func (l *Linux) read(path string) ([]byte, error) {
	return os.ReadFile(l.Root + path)
}

// Facts returns the host facts of hello and enrollment.
func (l *Linux) Facts() (protocol.HostFacts, error) {
	name, err := os.Hostname()
	if err != nil || !hostnameRE.MatchString(name) {
		name = "unknown"
	}
	osName := "linux"
	if data, err := l.read("/etc/os-release"); err == nil {
		fields := map[string]string{}
		for _, line := range strings.Split(string(data), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok {
				fields[k] = strings.Trim(v, `"'`)
			}
		}
		if fields["ID"] != "" {
			osName = strings.TrimSpace(fields["ID"] + " " + fields["VERSION_ID"])
		}
	}
	var uts syscall.Utsname
	kernel := "unknown"
	if syscall.Uname(&uts) == nil {
		kernel = charsToString(uts.Release[:])
	}
	machineID, err := l.read("/etc/machine-id")
	if err != nil {
		return protocol.HostFacts{}, errors.New("host: /etc/machine-id is not readable")
	}
	sum := sha256.Sum256(bytes.TrimSpace(machineID))
	mem, _ := l.meminfo()
	return protocol.HostFacts{
		Hostname:      name,
		Os:            limit(osName, 128),
		Kernel:        limit(kernel, 256),
		Cpus:          int64(runtime.NumCPU()),
		MemoryBytes:   int64(mem["MemTotal"]),
		MachineIDHash: "sha256:" + hex.EncodeToString(sum[:]),
	}, nil
}

func limit(s string, n int) string {
	if s == "" {
		return "unknown"
	}
	if len(s) > n {
		return s[:n]
	}
	return s
}

func charsToString(cs []int8) string {
	b := make([]byte, 0, len(cs))
	for _, c := range cs {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

// meminfo returns /proc/meminfo in bytes.
func (l *Linux) meminfo() (map[string]uint64, error) {
	data, err := l.read("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	s := bufio.NewScanner(bytes.NewReader(data))
	for s.Scan() {
		name, rest, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		if len(fields) > 1 && fields[1] == "kB" {
			n *= 1024
		}
		out[name] = n
	}
	return out, nil
}

func (l *Linux) cpu() (cpuSample, error) {
	data, err := l.read("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	line, _, _ := strings.Cut(string(data), "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, errors.New("host: /proc/stat")
	}
	var s cpuSample
	for i, f := range fields[1:] {
		n, _ := strconv.ParseUint(f, 10, 64)
		s.total += n
		if i != 3 && i != 4 { // idle, iowait
			s.busy += n
		}
	}
	return s, nil
}

// Metrics returns the host part of a heartbeat for the given mount points.
func (l *Linux) Metrics(mounts []string) (protocol.HeartbeatRequestHost, error) {
	var h protocol.HeartbeatRequestHost
	if data, err := l.read("/proc/loadavg"); err == nil {
		f := strings.Fields(string(data))
		if len(f) >= 3 {
			h.Load1, _ = strconv.ParseFloat(f[0], 64)
			h.Load5, _ = strconv.ParseFloat(f[1], 64)
			h.Load15, _ = strconv.ParseFloat(f[2], 64)
		}
	}
	if mem, err := l.meminfo(); err == nil {
		h.MemoryUsedBytes = int64(mem["MemTotal"] - min(mem["MemAvailable"], mem["MemTotal"]))
	}
	if s, err := l.cpu(); err == nil {
		if dt := s.total - l.prev.total; l.prev.total != 0 && dt > 0 {
			h.CPUPercent = min(100, float64(s.busy-l.prev.busy)*100/float64(dt))
		}
		l.prev = s
	}
	h.Mounts = []protocol.HeartbeatRequestHostMount{}
	seen := map[string]bool{}
	for _, m := range mounts {
		if seen[m] {
			continue
		}
		seen[m] = true
		var st syscall.Statfs_t
		if syscall.Statfs(l.Root+m, &st) != nil {
			continue
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bfree * uint64(st.Bsize)
		inodes := 0.0
		if st.Files > 0 {
			inodes = float64(st.Files-st.Ffree) * 100 / float64(st.Files)
		}
		h.Mounts = append(h.Mounts, protocol.HeartbeatRequestHostMount{
			Path: m, UsedBytes: int64(total - free), TotalBytes: int64(total), InodesUsedPercent: inodes,
		})
	}
	return h, nil
}
