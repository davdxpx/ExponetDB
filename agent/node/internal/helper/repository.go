package helper

import (
	"bufio"
	"bytes"
	"errors"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
)

// Backup repositories on the host (ADR-0036 §4): the node never takes a
// location, a key or a credential from the Control Plane. A pgBackRest
// repository is a stanza and repoN of the host's own pgBackRest
// configuration; a restic repository (engines restic and pg_dump: logical
// dumps stored by restic) is the directory the operator provisioned under
// RepositoriesRoot/<repositoryId>/ with the files repository (the restic
// repository), password (0600) and optionally env (KEY=VALUE lines of an
// allowlist). Every repository directory may hold a mode file: the host's
// side of the two-party control over what ExponetDB may do with it.

// Repository modes (the host's mode file).
const (
	ModeAdoptedObserved = "adopted_observed"
	ModeAdoptedRuns     = "adopted_runs"
	ModeOwned           = "owned"
)

// DefaultPgBackRestConfigs are the engine's default configuration files, in
// the engine's order, when the operator configuration names none.
var DefaultPgBackRestConfigs = []string{"/etc/pgbackrest/pgbackrest.conf", "/etc/pgbackrest.conf"}

type repositoryRef struct {
	RepositoryID string  `json:"repositoryId"`
	Engine       string  `json:"engine"`
	Stanza       *string `json:"stanza"`
	RepoIndex    *int    `json:"repoIndex"`
}

var (
	repositoryIDRE = regexp.MustCompile(`^bkr_[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
	stanzaRE       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
	envNameRE      = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
)

// resticEnvironment is the allowlist of the env file: the storage
// credentials and options restic reads from its environment.
var resticEnvironment = map[string]bool{
	"AWS_ACCESS_KEY_ID": true, "AWS_SECRET_ACCESS_KEY": true, "AWS_SESSION_TOKEN": true,
	"AWS_DEFAULT_REGION": true, "AWS_REGION": true,
	"B2_ACCOUNT_ID": true, "B2_ACCOUNT_KEY": true,
	"RESTIC_COMPRESSION": true, "RESTIC_PACK_SIZE": true,
}

// repository is a resolved repository: its mode and what the engine needs.
type repository struct {
	ref  repositoryRef
	mode string
	// pgBackRest: the configuration file and the paths its engine writes
	// besides the repository (log, lock, spool), from that file.
	pgbrConfig string
	// pgbrInclude is the conf.d directory the helper merged ("" when none):
	// every engine command names it.
	pgbrInclude string
	pgbrCipher  string
	pgbrPaths   pgbrPaths
	// restic: the provisioned files (content read by the helper only to copy
	// them into a run's private directory; never logged or returned).
	resticRepository []byte
	resticPassword   []byte
	resticEnv        []string
}

func (r *repository) stanza() string {
	if r.ref.Stanza == nil {
		return ""
	}
	return *r.ref.Stanza
}

func (r *repository) repoIndex() int {
	if r.ref.RepoIndex == nil {
		return 0
	}
	return *r.ref.RepoIndex
}

func (r *repository) logical() bool { return r.ref.Engine == "restic" || r.ref.Engine == "pg_dump" }

// resticLocalPath is the directory of a restic repository that lies on this host (a plain
// absolute path, or `local:` and one), or "" for a repository at a URL (`s3:`, `sftp:`, `rest:`,
// ...) and for a path that is not clean or is the root. A run writes it (locks, packs and
// snapshots), so the unit, which is ProtectSystem=strict, must list it (TC-012, D-06). The file
// that names it is root's and trusted, as the pgBackRest paths are.
func (r *repository) resticLocalPath() string {
	s := strings.TrimPrefix(string(bytes.TrimSpace(r.resticRepository)), "local:")
	if !strings.HasPrefix(s, "/") {
		return ""
	}
	if clean := path.Clean(s); clean != s || clean == "/" {
		return ""
	}
	return s
}

type pgbrPaths struct {
	// repo is the repository's local path (posix and cifs repositories
	// only; empty for object storage).
	log, lock, spool, repo string
}

// trustedFile reads a host configuration file: no symlink on its path, a
// regular file owned by root (or by one of owners), writable by its owner
// only. private additionally requires no access for group and others.
func (h *Helper) trustedFile(path string, private bool, owners ...int) ([]byte, *Refusal) {
	dirPath, name, err := fsafe.Split(path)
	if err != nil {
		return nil, refuse(CodeNotConfigured, "a host configuration path is not a file path")
	}
	dir, err := fsafe.OpenDir(h.path(dirPath))
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "the directory of a host configuration file cannot be opened safely")
	}
	defer dir.Close()
	if r := h.trustedDir(dir); r != nil {
		return nil, r
	}
	data, st, err := dir.ReadFile(name, maxFile)
	if errors.Is(err, fsafe.ErrNotExist) {
		return nil, refuse(CodePreconditionFailed, "a host configuration file is missing")
	}
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "a host configuration file cannot be read safely")
	}
	ok := st.UID == h.rootUID()
	for _, o := range owners {
		ok = ok || st.UID == o
	}
	if !ok || st.Mode&0o022 != 0 || (private && st.Mode&0o077 != 0) {
		return nil, refuse(CodePreconditionFailed, "a host configuration file has an unsafe owner or mode")
	}
	return data, nil
}

// trustedDir: a directory of host configuration belongs to root and no one
// else can write it.
func (h *Helper) trustedDir(dir *fsafe.Dir) *Refusal {
	o, err := dir.Owner()
	if err != nil || o.UID != h.rootUID() || o.Mode&0o022 != 0 {
		return refuse(CodePreconditionFailed, "a host configuration directory has an unsafe owner or mode")
	}
	return nil
}

// rootUID is the owner host files must have (root; the test's uid in tests).
func (h *Helper) rootUID() int {
	if h.Root == "" {
		return 0
	}
	return h.TrustOwner
}

// repositoryMode reads the mode file of a repository directory (absent
// directory or file: adopted_observed).
func (h *Helper) repositoryMode(id string) (string, *fsafe.Dir, *Refusal) {
	dir, err := fsafe.OpenDir(h.path(h.paths().Repositories + "/" + id))
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return ModeAdoptedObserved, nil, nil
		}
		return "", nil, refuse(CodePreconditionFailed, "the repository directory cannot be opened safely")
	}
	if r := h.trustedDir(dir); r != nil {
		dir.Close()
		return "", nil, r
	}
	data, st, err := dir.ReadFile("mode", 256)
	if errors.Is(err, fsafe.ErrNotExist) {
		return ModeAdoptedObserved, dir, nil
	}
	if err != nil || st.UID != h.rootUID() || st.Mode&0o022 != 0 {
		dir.Close()
		return "", nil, refuse(CodePreconditionFailed, "the repository mode file has an unsafe owner or mode")
	}
	switch m := strings.TrimSpace(string(data)); m {
	case ModeAdoptedObserved, ModeAdoptedRuns, ModeOwned:
		return m, dir, nil
	}
	dir.Close()
	return "", nil, refuse(CodePreconditionFailed, "the repository mode file names no known mode")
}

// resolveRepository resolves a job's repository on the host.
func (h *Helper) resolveRepository(ref repositoryRef, engineUID int) (*repository, *Refusal) {
	if !repositoryIDRE.MatchString(ref.RepositoryID) {
		return nil, refuse(CodeJobInvalid, "the repository id is invalid")
	}
	mode, dir, r := h.repositoryMode(ref.RepositoryID)
	if r != nil {
		return nil, r
	}
	if dir != nil {
		defer dir.Close()
	}
	repo := &repository{ref: ref, mode: mode}
	switch ref.Engine {
	case "pgbackrest":
		if ref.Stanza == nil || !stanzaRE.MatchString(*ref.Stanza) || ref.RepoIndex == nil || *ref.RepoIndex < 1 || *ref.RepoIndex > 4 {
			return nil, refuse(CodePreconditionFailed, "a pgBackRest repository needs its stanza and repo index")
		}
		if r := h.pgbackrestBinding(dir, repo); r != nil {
			return nil, r
		}
		if r := h.pgbackrestConfig(repo, engineUID); r != nil {
			return nil, r
		}
	case "restic", "pg_dump":
		if ref.Stanza != nil || ref.RepoIndex != nil {
			return nil, refuse(CodePreconditionFailed, "a restic repository has no stanza or repo index")
		}
		if dir == nil {
			return nil, refuse(CodePreconditionFailed, "the node has no host configuration for this repository")
		}
		if r := h.resticFiles(dir, repo); r != nil {
			return nil, r
		}
	default:
		return nil, refuse(CodeJobInvalid, "the repository engine is unknown")
	}
	return repo, nil
}

// pgbackrestBinding binds a repository id to one stanza and repoN of the
// host's pgBackRest configuration (review finding B-1): the host's file
// <repositoryId>/pgbackrest holds exactly the lines stanza=<name> and
// repo=<n> (root-owned, writable by root only). A mode that allows runs
// (adopted_runs, owned) needs it; whenever it exists, a job naming another
// stanza or repo index is refused. Without it, an owned repository id could
// carry the stanza and repo index of a repository the host only allowed to
// observe.
func (h *Helper) pgbackrestBinding(dir *fsafe.Dir, repo *repository) *Refusal {
	runs := repo.mode == ModeAdoptedRuns || repo.mode == ModeOwned
	if dir == nil {
		if runs {
			return refuse(CodePreconditionFailed, "the repository allows runs but binds no stanza")
		}
		return nil
	}
	data, st, err := dir.ReadFile("pgbackrest", 4096)
	if errors.Is(err, fsafe.ErrNotExist) {
		if runs {
			return refuse(CodePreconditionFailed, "the repository's mode allows runs, but the host binds it to no stanza and repo (file pgbackrest)")
		}
		return nil
	}
	if err != nil || st.UID != h.rootUID() || st.Mode&0o022 != 0 {
		return refuse(CodePreconditionFailed, "the repository's pgbackrest file has an unsafe owner or mode")
	}
	stanza, index, ok := parseBinding(data)
	if !ok {
		return refuse(CodePreconditionFailed, "the repository's pgbackrest file is not exactly stanza=<name> and repo=<n>")
	}
	if stanza != repo.stanza() || index != repo.repoIndex() {
		return refuse(CodePreconditionFailed, "the job names another stanza or repo index than the host binds to this repository")
	}
	return nil
}

// parseBinding reads the lines stanza=<name> and repo=<1..4>, each exactly
// once (blank lines and # comments skipped, nothing else).
func parseBinding(data []byte) (string, int, bool) {
	stanza, index := "", 0
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, found := strings.Cut(line, "=")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch {
		case !found:
			return "", 0, false
		case k == "stanza" && stanza == "" && stanzaRE.MatchString(v):
			stanza = v
		case k == "repo" && index == 0 && len(v) == 1 && v[0] >= '1' && v[0] <= '4':
			index = int(v[0] - '0')
		default:
			return "", 0, false
		}
	}
	return stanza, index, stanza != "" && index != 0
}

func (h *Helper) resticFiles(dir *fsafe.Dir, repo *repository) *Refusal {
	read := func(name string, private, optional bool) ([]byte, *Refusal) {
		data, st, err := dir.ReadFile(name, 64*1024)
		if errors.Is(err, fsafe.ErrNotExist) && optional {
			return nil, nil
		}
		if err != nil {
			return nil, refuse(CodePreconditionFailed, "the node has no host configuration for this repository")
		}
		if st.UID != h.rootUID() || st.Mode&0o022 != 0 || (private && st.Mode&0o077 != 0) {
			return nil, refuse(CodePreconditionFailed, "a repository file has an unsafe owner or mode")
		}
		return data, nil
	}
	var r *Refusal
	if repo.resticRepository, r = read("repository", false, false); r != nil {
		return r
	}
	if repo.resticPassword, r = read("password", true, false); r != nil {
		return r
	}
	if len(bytes.TrimSpace(repo.resticRepository)) == 0 || bytes.ContainsAny(bytes.TrimSpace(repo.resticRepository), "\n\x00") ||
		len(repo.resticPassword) == 0 {
		return refuse(CodePreconditionFailed, "a repository file is empty or malformed")
	}
	env, r := read("env", true, true)
	if r != nil {
		return r
	}
	lines, err := parseEnvFile(env)
	if err != nil {
		return refuse(CodePreconditionFailed, "the repository env file names a variable outside the allowlist")
	}
	repo.resticEnv = lines
	return nil
}

// parseEnvFile reads KEY=VALUE lines (blank lines and # comments skipped);
// every key must be on the allowlist.
func parseEnvFile(data []byte) ([]string, error) {
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || !envNameRE.MatchString(k) || !resticEnvironment[k] || strings.ContainsRune(v, 0) {
			return nil, errors.New("helper: env file")
		}
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out, sc.Err()
}

// pgbackrestConfig finds the host's pgBackRest configuration, checks it is
// safe and names the stanza and the repository, and reads the paths the
// engine writes besides the repository. Nothing of it leaves the helper.
func (h *Helper) pgbackrestConfig(repo *repository, engineUID int) *Refusal {
	candidates := DefaultPgBackRestConfigs
	if h.Config.PgBackRestConfig != "" {
		candidates = []string{h.Config.PgBackRestConfig}
	}
	var path string
	var data []byte
	for _, c := range candidates {
		dirPath, name, err := fsafe.Split(c)
		if err != nil {
			continue
		}
		dir, err := fsafe.OpenDir(h.path(dirPath))
		if err != nil {
			continue
		}
		info, err := dir.Lstat(name)
		dir.Close()
		if err != nil || info.Kind == fsafe.KindNone {
			continue
		}
		d, r := h.trustedFile(c, false, engineUID)
		if r != nil {
			return r
		}
		path, data = c, d
		break
	}
	if path == "" {
		return refuse(CodePreconditionFailed, "the node has no pgBackRest configuration")
	}
	sections := parseINI(data)
	// conf.d beside the file (the engine's default include path). The engine
	// reads it only when it is named (--config-include-path; with --config
	// pgBackRest ignores its default include path, review finding A-9), so
	// the helper names exactly the directory it read and merged, and the
	// helper and the engine see the same configuration.
	if dir, err := fsafe.OpenDir(h.path(filepath.Dir(path) + "/conf.d")); err == nil {
		if r := h.trustedDir(dir); r != nil {
			dir.Close()
			return r
		}
		files, err := dir.Files()
		dir.Close()
		if err != nil {
			return refuse(CodePreconditionFailed, "the host's pgBackRest conf.d cannot be listed")
		}
		repo.pgbrInclude = filepath.Dir(path) + "/conf.d"
		sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
		for _, f := range files {
			if !strings.HasSuffix(f.Name, ".conf") {
				continue
			}
			more, r := h.trustedFile(filepath.Dir(path)+"/conf.d/"+f.Name, false, engineUID)
			if r != nil {
				return r
			}
			for s, kv := range parseINI(more) {
				if sections[s] == nil {
					sections[s] = map[string]string{}
				}
				for k, v := range kv {
					sections[s][k] = v
				}
			}
		}
	}
	stanza, n := repo.stanza(), strconv.Itoa(repo.repoIndex())
	if sections[stanza] == nil {
		return refuse(CodePreconditionFailed, "the host's pgBackRest configuration has no such stanza")
	}
	get := func(key string) string {
		if v, ok := sections[stanza][key]; ok {
			return v
		}
		return sections["global"][key]
	}
	configured := repo.repoIndex() == 1
	for _, k := range []string{"path", "type", "s3-bucket", "gcs-bucket", "azure-container", "host"} {
		configured = configured || get("repo"+n+"-"+k) != ""
	}
	if !configured {
		return refuse(CodePreconditionFailed, "the host's pgBackRest configuration has no such repository")
	}
	repo.pgbrConfig = path
	repo.pgbrCipher = "none"
	if c := get("repo" + n + "-cipher-type"); c != "" {
		repo.pgbrCipher = c
	}
	repo.pgbrPaths = pgbrPaths{log: "/var/log/pgbackrest", lock: "/tmp/pgbackrest", spool: "/var/spool/pgbackrest"}
	// A repository on a local file system (posix, cifs) is a path the
	// engine writes: the run's unit may write it, nothing else of the host.
	if t := get("repo" + n + "-type"); t == "" || t == "posix" || t == "cifs" {
		repo.pgbrPaths.repo = "/var/lib/pgbackrest"
		if v := get("repo" + n + "-path"); v != "" {
			repo.pgbrPaths.repo = v
		}
	}
	for key, into := range map[string]*string{"log-path": &repo.pgbrPaths.log, "lock-path": &repo.pgbrPaths.lock, "spool-path": &repo.pgbrPaths.spool,
		"repo" + n + "-path": &repo.pgbrPaths.repo} {
		if v := get(key); v != "" && *into != "" {
			if !filepath.IsAbs(v) || filepath.Clean(v) != v || v == "/" || strings.ContainsAny(v, " \t\"'\\\x00") {
				return refuse(CodePreconditionFailed, "the host's pgBackRest configuration names an unsafe %s", key)
			}
			*into = v
		}
	}
	return nil
}

// parseINI reads pgBackRest's configuration format: [section] headers and
// key=value lines; comments start with #.
func parseINI(data []byte) map[string]map[string]string {
	out := map[string]map[string]string{}
	section := ""
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || section == "" {
			continue
		}
		if out[section] == nil {
			out[section] = map[string]string{}
		}
		out[section][strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}
