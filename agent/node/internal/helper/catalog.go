package helper

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// The engines' catalogs, read as untrusted host data: pgBackRest's
// `info --output=json` and restic's `snapshots --json`. Every value is
// checked against the contract's pattern before it is reported; one that
// does not fit is reported null, never passed through.

type pgbrStatus struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type pgbrBackup struct {
	Label   string `json:"label"`
	Type    string `json:"type"`
	Error   *bool  `json:"error"`
	Archive struct {
		Start *string `json:"start"`
		Stop  *string `json:"stop"`
	} `json:"archive"`
	Database struct {
		ID int `json:"id"`
	} `json:"database"`
	Info struct {
		Size       *int64 `json:"size"`
		Repository struct {
			Size *int64 `json:"size"`
		} `json:"repository"`
	} `json:"info"`
	LSN struct {
		Start *string `json:"start"`
		Stop  *string `json:"stop"`
	} `json:"lsn"`
	Prior     *string `json:"prior"`
	Timestamp struct {
		Start int64 `json:"start"`
		Stop  int64 `json:"stop"`
	} `json:"timestamp"`
}

type pgbrStanza struct {
	Name   string     `json:"name"`
	Cipher string     `json:"cipher"`
	Status pgbrStatus `json:"status"`
	DB     []struct {
		ID       int         `json:"id"`
		SystemID json.Number `json:"system-id"`
		Version  string      `json:"version"`
	} `json:"db"`
	Archive []struct {
		ID  string  `json:"id"`
		Min *string `json:"min"`
		Max *string `json:"max"`
	} `json:"archive"`
	Backup []pgbrBackup `json:"backup"`
}

// parsePgbrInfo reads the JSON of `pgbackrest --stanza=<s> info
// --output=json`: one stanza, the one asked for.
func parsePgbrInfo(out []byte, stanza string) (*pgbrStanza, error) {
	dec := json.NewDecoder(bytes.NewReader(out))
	dec.UseNumber()
	var list []pgbrStanza
	if err := dec.Decode(&list); err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].Name == stanza {
			return &list[i], nil
		}
	}
	return nil, errors.New("helper: the engine did not report the stanza")
}

var (
	lsnRE     = regexp.MustCompile(`^[0-9A-F]{1,8}/[0-9A-F]{1,8}$`)
	segmentRE = regexp.MustCompile(`^[0-9A-F]{24}$`)
	labelRE   = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?$`)
	digitsRE  = regexp.MustCompile(`^[0-9]{1,20}$`)
	versionRE = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,3}$`)
)

func optPattern(re *regexp.Regexp, s *string, upper bool) canon.Value {
	if s == nil {
		return canon.Null{}
	}
	v := *s
	if upper {
		v = strings.ToUpper(v)
	}
	if !re.MatchString(v) {
		return canon.Null{}
	}
	return canon.String(v)
}

func optBytes(n *int64) canon.Value {
	if n == nil || *n < 0 {
		return canon.Null{}
	}
	return canon.Number(*n)
}

func unixTime(s int64) canon.Value {
	if s <= 0 {
		return canon.Null{}
	}
	return canon.String(time.Unix(s, 0).UTC().Format(time.RFC3339))
}

// systemID is the stanza's current database system identifier (the
// highest database id), "" when the engine reports none.
func (s *pgbrStanza) systemID() string {
	best, id := -1, ""
	for _, db := range s.DB {
		if db.ID > best && digitsRE.MatchString(db.SystemID.String()) {
			best, id = db.ID, db.SystemID.String()
		}
	}
	return id
}

func (s *pgbrStanza) major(dbID int) canon.Value {
	for _, db := range s.DB {
		if db.ID == dbID {
			head, _, _ := strings.Cut(db.Version, ".")
			if n, err := strconv.Atoi(head); err == nil && n >= 9 && n <= 99 {
				return canon.Number(n)
			}
		}
	}
	return canon.Null{}
}

// stanzaState maps the engine's status code: 0 ok and 2 (no valid backups)
// are a stanza that exists; 1 (missing stanza path) and 3 (missing stanza
// data) a missing one; anything else (cipher, mismatch, unreadable) an error.
func stanzaState(code int) string {
	switch code {
	case 0, 2:
		return "ok"
	case 1, 3:
		return "missing"
	}
	return "error"
}

var pgbrKinds = map[string]string{"full": "full", "diff": "differential", "incr": "incremental"}

// pgbrListResult is backup.list@1's result for a pgBackRest stanza.
func pgbrListResult(s *pgbrStanza, engineVersion string) canon.Object {
	sysid := canon.Value(canon.Null{})
	if id := s.systemID(); id != "" {
		sysid = canon.String(id)
	}
	cipher := "unknown"
	if s.Cipher == "aes-256-cbc" || s.Cipher == "none" {
		cipher = s.Cipher
	}
	message := Redact(s.Status.Message, 256)
	backups := canon.Array{}
	list := s.Backup
	truncated := false
	if len(list) > 1000 {
		list, truncated = list[len(list)-1000:], true
	}
	for _, b := range list {
		kind, ok := pgbrKinds[b.Type]
		if !ok || !labelRE.MatchString(b.Label) || b.Timestamp.Start <= 0 {
			truncated = true
			continue
		}
		backups = append(backups, canon.Object{
			{Name: "label", Value: canon.String(b.Label)},
			{Name: "kind", Value: canon.String(kind)},
			{Name: "startedAt", Value: unixTime(b.Timestamp.Start)},
			{Name: "finishedAt", Value: unixTime(b.Timestamp.Stop)},
			{Name: "lsnStart", Value: optPattern(lsnRE, b.LSN.Start, true)},
			{Name: "lsnStop", Value: optPattern(lsnRE, b.LSN.Stop, true)},
			{Name: "walStart", Value: optPattern(segmentRE, b.Archive.Start, true)},
			{Name: "sizeBytes", Value: optBytes(b.Info.Size)},
			{Name: "repositorySizeBytes", Value: optBytes(b.Info.Repository.Size)},
			{Name: "postgresMajor", Value: s.major(b.Database.ID)},
			{Name: "error", Value: canon.Bool(b.Error != nil && *b.Error)},
		})
	}
	archive := canon.Array{}
	for _, a := range s.Archive {
		if len(archive) == 16 {
			truncated = true
			break
		}
		archive = append(archive, canon.Object{
			{Name: "id", Value: canon.String(bounded(a.ID, 32))},
			{Name: "min", Value: optPattern(segmentRE, a.Min, true)},
			{Name: "max", Value: optPattern(segmentRE, a.Max, true)},
		})
	}
	return canon.Object{
		{Name: "engineVersion", Value: versionValue(engineVersion)},
		{Name: "stanza", Value: canon.Object{
			{Name: "status", Value: canon.String(stanzaState(s.Status.Code))},
			{Name: "message", Value: canon.String(message)},
			{Name: "systemIdentifier", Value: sysid},
			{Name: "cipher", Value: canon.String(cipher)},
		}},
		{Name: "backups", Value: backups},
		{Name: "archive", Value: archive},
		{Name: "truncated", Value: canon.Bool(truncated)},
	}
}

func versionValue(v string) canon.Value {
	if versionRE.MatchString(v) && len(v) <= 32 {
		return canon.String(v)
	}
	return canon.Null{}
}

// engineVersion reads "pgBackRest 2.60.0" or "restic 0.16.4 compiled …".
func engineVersion(out []byte) string {
	f := strings.Fields(string(out))
	if len(f) >= 2 && versionRE.MatchString(f[1]) {
		return f[1]
	}
	return ""
}

// ----- restic -----

type resticSnapshot struct {
	Time    string   `json:"time"`
	ID      string   `json:"id"`
	Tags    []string `json:"tags"`
	Summary *struct {
		BackupEnd           string `json:"backup_end"`
		TotalBytesProcessed *int64 `json:"total_bytes_processed"`
	} `json:"summary"`
}

var snapshotRE = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

func resticTime(s string) canon.Value {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return canon.Null{}
	}
	return canon.String(t.UTC().Format(time.RFC3339Nano))
}

// resticListResult is backup.list@1's result for a restic repository: the
// snapshots ExponetDB's runs tagged, as logical backups.
func resticListResult(out []byte, version string) (canon.Object, error) {
	var snaps []resticSnapshot
	if err := json.Unmarshal(out, &snaps); err != nil {
		return nil, err
	}
	sort.SliceStable(snaps, func(i, j int) bool { return snaps[i].Time < snaps[j].Time })
	truncated := false
	if len(snaps) > 1000 {
		snaps, truncated = snaps[len(snaps)-1000:], true
	}
	backups := canon.Array{}
	for _, s := range snaps {
		started := resticTime(s.Time)
		if !snapshotRE.MatchString(s.ID) {
			truncated = true
			continue
		}
		if _, isNull := started.(canon.Null); isNull {
			truncated = true
			continue
		}
		finished, size := canon.Value(canon.Null{}), canon.Value(canon.Null{})
		if s.Summary != nil {
			finished = resticTime(s.Summary.BackupEnd)
			size = optBytes(s.Summary.TotalBytesProcessed)
		}
		backups = append(backups, canon.Object{
			{Name: "label", Value: canon.String(s.ID)},
			{Name: "kind", Value: canon.String("logical")},
			{Name: "startedAt", Value: started},
			{Name: "finishedAt", Value: finished},
			{Name: "lsnStart", Value: canon.Null{}},
			{Name: "lsnStop", Value: canon.Null{}},
			{Name: "walStart", Value: canon.Null{}},
			{Name: "sizeBytes", Value: size},
			{Name: "repositorySizeBytes", Value: canon.Null{}},
			{Name: "postgresMajor", Value: canon.Null{}},
			{Name: "error", Value: canon.Bool(false)},
		})
	}
	return canon.Object{
		{Name: "engineVersion", Value: versionValue(version)},
		{Name: "stanza", Value: canon.Null{}},
		{Name: "backups", Value: backups},
		{Name: "archive", Value: canon.Array{}},
		{Name: "truncated", Value: canon.Bool(truncated)},
	}, nil
}

// ----- retention (backup.expire@1) -----

// pgbrSurvivors computes, conservatively, the labels that certainly
// survive `expire` with full retention fullCount (count type) and
// differential retention diffCount (nil: the run passes none). A label not
// in the returned set may be removed; the expiry is refused then.
func pgbrSurvivors(s *pgbrStanza, fullCount int, diffCount *int) map[string]bool {
	byLabel := map[string]pgbrBackup{}
	var fulls, diffs []string
	for _, b := range s.Backup {
		byLabel[b.Label] = b
		switch b.Type {
		case "full":
			fulls = append(fulls, b.Label)
		case "diff":
			diffs = append(diffs, b.Label)
		}
	}
	keepFull := map[string]bool{}
	for i := max(0, len(fulls)-fullCount); i < len(fulls); i++ {
		keepFull[fulls[i]] = true
	}
	keepDiff := map[string]bool{}
	if diffCount != nil {
		for i := max(0, len(diffs)-*diffCount); i < len(diffs); i++ {
			keepDiff[diffs[i]] = true
		}
	}
	survives := map[string]bool{}
	for label, b := range byLabel {
		full, _, _ := strings.Cut(label, "_")
		if !keepFull[full] {
			continue
		}
		// Walk to the backup this one rests on: the full itself, or a
		// differential (whose retention decides), through incrementals.
		cur, ok, depth := b, true, 0
		for cur.Type == "incr" && ok && depth < 10000 {
			if cur.Prior == nil {
				ok = false
				break
			}
			cur, ok = byLabel[*cur.Prior]
			depth++
		}
		switch {
		case !ok || depth >= 10000:
		case cur.Type == "full":
			survives[label] = true
		case cur.Type == "diff" && diffCount != nil && keepDiff[cur.Label]:
			survives[label] = true
		}
	}
	return survives
}

var (
	safeDatabaseRE = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$`)
	managedIdentRE = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
)
