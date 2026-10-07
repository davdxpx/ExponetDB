package helper

import (
	"context"
	"regexp"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Packages is the allowlist of packages.audit and packages.plan_update
// (capabilities.md §2): the PostgreSQL stack ExponetDB manages and the agent.
var Packages = []string{
	"postgresql-common", "postgresql-client-common",
	"postgresql-16", "postgresql-17", "postgresql-18",
	"postgresql-client-16", "postgresql-client-17", "postgresql-client-18",
	"postgresql-16-pgvector", "postgresql-17-pgvector", "postgresql-18-pgvector",
	"exponetdb-node",
}

func allowlisted(name string) bool {
	for _, p := range Packages {
		if p == name {
			return true
		}
	}
	return false
}

var (
	packageNameRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,63}$`)
	packageVersionRE = regexp.MustCompile(`^[0-9A-Za-z.+~:-]{1,64}$`)
	serverPackageRE  = regexp.MustCompile(`^postgresql-[0-9]{2}$`)
	instRE           = regexp.MustCompile(`^Inst (\S+) (?:\[(\S+)\] )?\((\S+) `)
	remvRE           = regexp.MustCompile(`^Remv (\S+)(?: \[(\S+)\])?`)
)

// dpkgInstalled reads the installed versions of the packages (absent when
// not installed).
func (h *Helper) dpkgInstalled(ctx context.Context, names []string) (map[string]string, *Refusal) {
	args := append([]string{"-W", "-f=${Package}\t${db:Status-Abbrev}\t${Version}\n", "--"}, names...)
	out, err := h.Runner.Run(ctx, Command{Path: DpkgQuery, Args: args})
	// Exit 1: some package is unknown to dpkg; the known ones are listed.
	if err != nil || out.ExitCode > 1 {
		return nil, refuse(CodeFailed, "dpkg-query failed")
	}
	got := map[string]string{}
	for _, line := range strings.Split(string(out.Stdout), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 || !allowlisted(f[0]) {
			continue
		}
		status := f[1]
		// The second letter is the current state: n not installed, c only
		// configuration files left; anything else has the version unpacked.
		if len(status) >= 2 && status[1] != 'n' && status[1] != 'c' && f[2] != "" {
			if !packageVersionRE.MatchString(f[2]) {
				return nil, refuse(CodeFailed, "an installed version is outside the contract pattern")
			}
			got[f[0]] = f[2]
		}
	}
	return got, nil
}

type policy struct {
	candidate string
	security  bool
}

// aptPolicy reads candidates from `apt-cache policy`, as of the host's last
// package list update (the helper never updates the lists).
func (h *Helper) aptPolicy(ctx context.Context, names []string) (map[string]policy, *Refusal) {
	out, err := h.Runner.Run(ctx, Command{Path: AptCache, Args: append([]string{"policy"}, names...)})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "apt-cache policy failed")
	}
	return parsePolicy(out.Stdout), nil
}

// parsePolicy reads, per package, its candidate and whether the candidate
// comes from a security suite.
func parsePolicy(out []byte) map[string]policy {
	got := map[string]policy{}
	var name, version string
	var p policy
	inTable := false
	flush := func() {
		if name != "" {
			got[name] = p
		}
	}
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		indent := len(line) - len(trimmed)
		switch {
		case line == "":
		case indent == 0 && strings.HasSuffix(line, ":"):
			flush()
			name, p, inTable, version = strings.TrimSuffix(line, ":"), policy{}, false, ""
		case strings.HasPrefix(trimmed, "Candidate:"):
			c := strings.TrimSpace(strings.TrimPrefix(trimmed, "Candidate:"))
			if c != "(none)" {
				p.candidate = c
			}
		case strings.HasPrefix(trimmed, "Version table:"):
			inTable = true
		case inTable && indent < 8:
			// A version line: "     1.2-3 500" or " *** 1.2-3 100".
			f := strings.Fields(strings.TrimPrefix(trimmed, "*** "))
			if len(f) >= 1 {
				version = f[0]
			}
		case inTable && indent >= 8:
			// A source line: "        500 http://… noble-security/main amd64 Packages".
			f := strings.Fields(trimmed)
			if version != "" && version == p.candidate && len(f) >= 3 &&
				strings.Contains(strings.SplitN(f[2], "/", 2)[0], "-security") {
				p.security = true
			}
		}
	}
	flush()
	return got
}

func versionOrNull(v string) canon.Value {
	if v == "" {
		return canon.Null{}
	}
	return canon.String(v)
}

func packagesAudit(ctx context.Context, h *Helper, _ *verify.Job) (canon.Object, *Refusal) {
	inst, r := h.dpkgInstalled(ctx, Packages)
	if r != nil {
		return nil, r
	}
	pol, r := h.aptPolicy(ctx, Packages)
	if r != nil {
		return nil, r
	}
	list := canon.Array{}
	for _, name := range Packages {
		i, p := inst[name], pol[name]
		if i == "" && p.candidate == "" {
			continue
		}
		if p.candidate != "" && !packageVersionRE.MatchString(p.candidate) {
			return nil, refuse(CodeFailed, "a candidate version is outside the contract pattern")
		}
		list = append(list, canon.Object{
			{Name: "name", Value: canon.String(name)},
			{Name: "installed", Value: versionOrNull(i)},
			{Name: "candidate", Value: versionOrNull(p.candidate)},
			{Name: "security", Value: canon.Bool(p.security && p.candidate != i)},
		})
	}
	return canon.Object{{Name: "packages", Value: list}}, nil
}

// packagesPlanUpdate simulates the update of allowlisted packages to exact
// versions (`apt-get -s`, no lock, nothing changes) and reports every change
// apt would make, a PostgreSQL restart and a major change.
func packagesPlanUpdate(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Packages []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"packages"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	cmd := []string{"-s", "-q", "-o", "Debug::NoLocking=true", "install", "--only-upgrade"}
	for _, p := range args.Packages {
		if !allowlisted(p.Name) || !packageVersionRE.MatchString(p.Version) {
			return nil, refuse(CodePreconditionFailed, "a package is not on the allowlist")
		}
		cmd = append(cmd, p.Name+"="+p.Version)
	}
	out, err := h.Runner.Run(ctx, Command{Path: AptGet, Args: cmd})
	if err != nil {
		return nil, refuse(CodeFailed, "apt-get simulation failed")
	}
	if out.ExitCode != 0 {
		return nil, refuse(CodePreconditionFailed, "apt cannot plan the requested versions")
	}
	changes := canon.Array{}
	restarts, major := false, false
	for _, line := range strings.Split(string(out.Stdout), "\n") {
		var name, from, to, action string
		if m := instRE.FindStringSubmatch(line); m != nil {
			name, from, to = m[1], m[2], m[3]
			action = "upgrade"
			if from == "" {
				action = "install"
			}
		} else if m := remvRE.FindStringSubmatch(line); m != nil {
			name, from, action = m[1], m[2], "remove"
		} else {
			continue
		}
		name, _, _ = strings.Cut(name, ":") // an architecture qualifier
		if !packageNameRE.MatchString(name) || (from != "" && !packageVersionRE.MatchString(from)) ||
			(to != "" && !packageVersionRE.MatchString(to)) {
			return nil, refuse(CodeFailed, "apt reported a name or version outside the contract pattern")
		}
		if len(changes) >= 256 {
			return nil, refuse(CodeFailed, "apt reported more than 256 changes")
		}
		if serverPackageRE.MatchString(name) {
			restarts = true
			major = major || action != "upgrade"
		}
		changes = append(changes, canon.Object{
			{Name: "name", Value: canon.String(name)},
			{Name: "action", Value: canon.String(action)},
			{Name: "from", Value: versionOrNull(from)},
			{Name: "to", Value: versionOrNull(to)},
			{Name: "allowlisted", Value: canon.Bool(allowlisted(name))},
		})
	}
	return canon.Object{
		{Name: "changes", Value: changes},
		{Name: "restartsPostgresql", Value: canon.Bool(restarts)},
		{Name: "postgresqlMajorChange", Value: canon.Bool(major)},
	}, nil
}
