package helper

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

// The TLS pair installation of postgres.tls.rotate@1 (architecture.md §2,
// item 9). PostgreSQL refuses a key that is not its certificate's, at a
// reload or a start, so the key and the certificate change together or not
// at all, across errors and crashes of the helper.
//
// Before the first file of the pair is touched, the helper writes a record
// to its state directory (synced, the directory synced): the cluster, the
// key and certificate paths of the operator's mapping (never of the job),
// whether each file existed, the digest, owner and mode of the previous and
// of the new content (never the content), and the job id. The previous
// contents are then kept as <file>.exponetdb-previous (durable before either
// file changes; no copy for a file that did not exist), the key and the
// certificate are installed, and the record is marked committed and removed.
//
// The record's states: prepared (unfinished) → committed (both files hold
// the new content, durably) or restored (both hold the previous content or
// are absent as before, durably). An unfinished record is settled from the
// record alone, at the helper's start and before any other change: both
// files new → committed; anything else → the previous pair put back exactly
// → restored. Never a mixed pair. Settling is not the job run again: it
// needs no job, admits no effect and leaves the ledger as it is. A record
// that cannot be trusted stops every change until the operator resolves it
// (node-runbook.md §7); nothing is guessed.
const (
	pairRecordName   = "tls-install.json"
	pairRecordSchema = "exponetdb.helper-tls-install/v1"
	maxPairRecord    = 16 * 1024

	pairPrepared  = "prepared"
	pairCommitted = "committed"
	pairRestored  = "restored"
)

// pairVersion is one content of a file: its digest, owner and mode.
type pairVersion struct {
	Digest string `json:"digest"`
	UID    int    `json:"uid"`
	GID    int    `json:"gid"`
	Mode   string `json:"mode"`
}

// pairFile is one file of the pair: previous is null when it did not exist.
type pairFile struct {
	Path     string       `json:"path"`
	Existed  bool         `json:"existed"`
	Previous *pairVersion `json:"previous"`
	New      pairVersion  `json:"new"`
}

// pairRecord is the installation record (tls-install.json), canonical JSON
// (RFC 8785) on one line with a SHA-256 checksum over the record without it.
type pairRecord struct {
	Schema      string   `json:"schema"`
	State       string   `json:"state"`
	JobID       string   `json:"jobId"`
	Cluster     string   `json:"cluster"`
	Key         pairFile `json:"key"`
	Certificate pairFile `json:"certificate"`
	Checksum    string   `json:"checksum,omitempty"`
}

var (
	digestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	modeRE   = regexp.MustCompile(`^0[0-7]{3}$`)
)

func contentDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func modeText(m os.FileMode) string { return fmt.Sprintf("%04o", uint32(m.Perm())) }

func (v pairVersion) owner() fsafe.Owner {
	m, _ := strconv.ParseUint(v.Mode, 8, 32)
	return fsafe.Owner{UID: v.UID, GID: v.GID, Mode: os.FileMode(m)}
}

func (v pairVersion) is(cur fsafe.Previous) bool {
	return cur.Existed && contentDigest(cur.Content) == v.Digest &&
		cur.Stat.UID == v.UID && cur.Stat.GID == v.GID && modeText(cur.Stat.Mode) == v.Mode
}

func versionOf(content []byte, o fsafe.Owner) pairVersion {
	return pairVersion{Digest: contentDigest(content), UID: o.UID, GID: o.GID, Mode: modeText(o.Mode)}
}

func pairFileOf(path string, cur fsafe.Previous, content []byte, o fsafe.Owner) pairFile {
	f := pairFile{Path: path, Existed: cur.Existed, New: versionOf(content, o)}
	if cur.Existed {
		v := versionOf(cur.Content, fsafe.Owner{UID: cur.Stat.UID, GID: cur.Stat.GID, Mode: cur.Stat.Mode})
		f.Previous = &v
	}
	return f
}

// encode is the record as written: canonical JSON with its checksum, and a
// newline.
func (r pairRecord) encode() ([]byte, error) {
	r.Checksum = ""
	body, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	canonical, err := canon.Transform(body)
	if err != nil {
		return nil, err
	}
	r.Checksum = contentDigest(canonical)
	if body, err = json.Marshal(r); err != nil {
		return nil, err
	}
	out, err := canon.Transform(body)
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// decodePairRecord accepts only what encode writes: strict JSON, exact
// member names, the canonical form, a matching checksum and valid values.
func decodePairRecord(data []byte) (*pairRecord, error) {
	body, ok := bytes.CutSuffix(data, []byte("\n"))
	if !ok {
		return nil, errors.New("it is not one complete line")
	}
	v, err := canon.Parse(body)
	if _, isObject := v.(canon.Object); err != nil || !isObject {
		return nil, errors.New("it is not a strict JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var r pairRecord
	if err := dec.Decode(&r); err != nil {
		return nil, errors.New("it does not have the record's members")
	}
	again, err := r.encode()
	if err != nil {
		return nil, err
	}
	var check pairRecord
	_ = json.Unmarshal(again, &check)
	if check.Checksum != r.Checksum {
		return nil, errors.New("its checksum does not match")
	}
	if !bytes.Equal(again, data) {
		return nil, errors.New("it is not in the form the helper writes")
	}
	return &r, r.validate()
}

func (r *pairRecord) validate() error {
	if r.Schema != pairRecordSchema {
		return errors.New("its schema is not " + pairRecordSchema)
	}
	if r.State != pairPrepared && r.State != pairCommitted && r.State != pairRestored {
		return errors.New("its state is unknown")
	}
	if !nodecrypto.IsID("job", r.JobID) {
		return errors.New("its job id is invalid")
	}
	if r.Cluster == "" || len(r.Cluster) > 64 {
		return errors.New("its cluster is invalid")
	}
	for _, c := range r.Cluster {
		if c < 0x21 || c > 0x7e {
			return errors.New("its cluster is invalid")
		}
	}
	if r.Key.Path == r.Certificate.Path {
		return errors.New("its key and certificate are one file")
	}
	for _, f := range []pairFile{r.Key, r.Certificate} {
		if _, _, err := fsafe.Split(f.Path); err != nil {
			return errors.New("a path is not a clean absolute file path")
		}
		if f.Existed != (f.Previous != nil) {
			return errors.New("a file's previous content contradicts whether it existed")
		}
		versions := []pairVersion{f.New}
		if f.Previous != nil {
			versions = append(versions, *f.Previous)
		}
		for _, v := range versions {
			if !digestRE.MatchString(v.Digest) || !modeRE.MatchString(v.Mode) ||
				v.UID < 0 || v.GID < 0 || v.UID > 1<<31-2 || v.GID > 1<<31-2 {
				return errors.New("a digest, owner or mode is invalid")
			}
		}
	}
	return nil
}

// pairBlocked: an installation the helper cannot settle. Every change is
// refused until it is settled (a later attempt) or the operator resolves it.
type pairBlocked struct {
	// corrupt: the record itself cannot be trusted; only the operator
	// resolves that.
	corrupt bool
	cluster string
	// detail is for the operator's log: paths and the reason, never file
	// content.
	detail string
}

func (b *pairBlocked) Error() string { return b.detail }

// refusal is what a change is answered with meanwhile (no path, no content).
func (b *pairBlocked) refusal() *Refusal {
	if b.corrupt {
		return refuse(CodeFailed, "the helper's TLS installation record cannot be trusted; every change is refused until the operator resolves it (node runbook)")
	}
	return refuse(CodeFailed, "an interrupted TLS installation of cluster %s is not settled; every change is refused until it is (node runbook)", b.cluster)
}

// stateDirectory holds the record: StateDirectory, or else the staging
// directory's parent (the helper process keeps both there).
func (h *Helper) stateDirectory() string {
	switch {
	case h.StateDirectory != "":
		return h.StateDirectory
	case h.StagingDirectory != "":
		return filepath.Dir(h.StagingDirectory)
	}
	return ""
}

func (h *Helper) recordPath() string { return filepath.Join(h.stateDirectory(), pairRecordName) }

func (h *Helper) corruptRecord(reason string) *pairBlocked {
	return &pairBlocked{corrupt: true, detail: fmt.Sprintf(
		"the TLS installation record %s cannot be trusted: %s; every change is refused until the operator resolves it (node-runbook.md §7)",
		h.recordPath(), reason)}
}

func (h *Helper) unsettled(cluster, reason string) *pairBlocked {
	return &pairBlocked{cluster: cluster, detail: fmt.Sprintf(
		"the interrupted TLS installation of cluster %s (record %s) cannot be settled: %s; every change is refused until it is (node-runbook.md §7)",
		cluster, h.recordPath(), reason)}
}

// stateDir opens the helper's state directory: root's, writable by no one
// else (the record in it is root's own, 0600).
func (h *Helper) stateDir() (*fsafe.Dir, fsafe.Owner, error) {
	path := h.stateDirectory()
	dir, err := fsafe.OpenDir(path)
	if err != nil {
		return nil, fsafe.Owner{}, fmt.Errorf("the state directory %s cannot be opened safely", path)
	}
	o, err := dir.Owner()
	if err != nil || o.UID != h.TrustOwner || o.Mode&0o022 != 0 {
		_ = dir.Close()
		return nil, fsafe.Owner{}, fmt.Errorf("the state directory %s is not root's alone to write", path)
	}
	return dir, o, nil
}

func writePairRecord(dir *fsafe.Dir, o fsafe.Owner, r *pairRecord) error {
	data, err := r.encode()
	if err != nil {
		return err
	}
	return dir.Install(pairRecordName, data, fsafe.Owner{UID: o.UID, GID: o.GID, Mode: 0o600})
}

// pairSettled is what settling found: the record (nil without one), its
// final state, and what this settling did ("" when nothing).
type pairSettled struct {
	record *pairRecord
	state  string
	did    string
}

// settlePair settles an interrupted installation from its record alone. It
// takes no job: it is not the job run again, admits nothing and never
// touches the ledger.
func (h *Helper) settlePair() (pairSettled, *pairBlocked) {
	if h.stateDirectory() == "" {
		// No state directory, no record: tls.install is refused then.
		return pairSettled{}, nil
	}
	dir, owner, err := h.stateDir()
	if err != nil {
		return pairSettled{}, &pairBlocked{corrupt: true, detail: err.Error() +
			"; every change is refused until the operator resolves it (node-runbook.md §7)"}
	}
	defer dir.Close()
	_ = dir.RemoveTemporaries(pairRecordName) // a record write a crash cut short
	data, st, err := dir.ReadFile(pairRecordName, maxPairRecord)
	if errors.Is(err, fsafe.ErrNotExist) {
		return pairSettled{}, nil
	}
	if err != nil {
		return pairSettled{}, h.corruptRecord("it cannot be read as a regular file")
	}
	if st.UID != h.TrustOwner || st.Mode&0o077 != 0 {
		return pairSettled{}, h.corruptRecord("it is not private to root")
	}
	rec, err := decodePairRecord(data)
	if err != nil {
		return pairSettled{}, h.corruptRecord(err.Error())
	}
	out := pairSettled{record: rec, state: rec.State}
	if rec.State == pairPrepared {
		state, blocked := h.resolvePair(dir, owner, rec)
		if blocked != nil {
			return out, blocked
		}
		out.state, out.did = state, state
	}
	// A settled record has done its work; one whose removal fails is
	// settled already and stops nothing (the next installation replaces it).
	_ = dir.Remove(pairRecordName)
	return out, nil
}

type pairSide struct {
	what string
	file pairFile
	dir  *fsafe.Dir
	name string
	cur  fsafe.Previous
}

// resolvePair completes or undoes a prepared installation, durably, then
// marks the record.
func (h *Helper) resolvePair(state *fsafe.Dir, owner fsafe.Owner, rec *pairRecord) (string, *pairBlocked) {
	in, ok := h.Config.Instance(rec.Cluster)
	if !ok || in.TLSKeyFile != rec.Key.Path || in.TLSCertificateFile != rec.Certificate.Path {
		return "", h.unsettled(rec.Cluster, "the operator configuration no longer maps these TLS files to the cluster")
	}
	sides := []*pairSide{{what: "key", file: rec.Key}, {what: "certificate", file: rec.Certificate}}
	for _, s := range sides {
		dir, name, r := h.file(s.file.Path)
		if r != nil {
			return "", h.unsettled(rec.Cluster, "the directory of the "+s.what+" cannot be opened safely")
		}
		defer dir.Close()
		s.dir, s.name = dir, name
		// What a crash between a temporary file and its rename left (the
		// new key, or the kept previous one): never left lying around.
		_ = dir.RemoveTemporaries(name)
		_ = dir.RemoveTemporaries(name + fsafe.PreviousSuffix)
		cur, err := dir.Current(name, maxFile)
		if err != nil {
			return "", h.unsettled(rec.Cluster, "the "+s.what+" cannot be read safely")
		}
		s.cur = cur
	}
	allNew := true
	for _, s := range sides {
		allNew = allNew && s.cur.Existed && contentDigest(s.cur.Content) == s.file.New.Digest
	}
	if allNew {
		// The new pair is complete: made durable before it is called so.
		for _, s := range sides {
			if err := s.dir.SyncFile(s.name); err != nil {
				return "", h.unsettled(rec.Cluster, "the "+s.what+" cannot be synced")
			}
			if err := s.dir.Sync(s.name); err != nil {
				return "", h.unsettled(rec.Cluster, "the directory of the "+s.what+" cannot be synced")
			}
		}
		rec.State = pairCommitted
		if err := writePairRecord(state, owner, rec); err != nil {
			return "", h.unsettled(rec.Cluster, "the record cannot be marked committed")
		}
		return pairCommitted, nil
	}
	for _, s := range sides {
		if reason := restorePairFile(s); reason != "" {
			return "", h.unsettled(rec.Cluster, reason)
		}
	}
	for _, s := range sides {
		cur, err := s.dir.Current(s.name, maxFile)
		back := err == nil && ((!s.file.Existed && !cur.Existed) || (s.file.Existed && s.file.Previous.is(cur)))
		if !back {
			return "", h.unsettled(rec.Cluster, "the previous "+s.what+" did not read back")
		}
	}
	rec.State = pairRestored
	if err := writePairRecord(state, owner, rec); err != nil {
		return "", h.unsettled(rec.Cluster, "the record cannot be marked restored")
	}
	return pairRestored, nil
}

// restorePairFile puts one file back as it was, durably: its previous
// content with its owner and mode (from the kept copy, only when that copy
// is the recorded content), or no file when it did not exist. It returns
// why it could not ("" when done).
func restorePairFile(s *pairSide) string {
	if !s.file.Existed {
		if s.cur.Existed {
			if err := s.dir.Remove(s.name); err != nil && !errors.Is(err, fsafe.ErrNotExist) {
				return "the " + s.what + ", which did not exist before, cannot be removed"
			}
			return ""
		}
		if err := s.dir.Sync(s.name); err != nil {
			return "the directory of the " + s.what + " cannot be synced"
		}
		return ""
	}
	prev := *s.file.Previous
	if prev.is(s.cur) {
		if s.dir.SyncFile(s.name) != nil || s.dir.Sync(s.name) != nil {
			return "the previous " + s.what + " cannot be synced"
		}
		return ""
	}
	kept, _, err := s.dir.ReadFile(s.name+fsafe.PreviousSuffix, maxFile)
	if err != nil {
		return "the kept previous " + s.what + " cannot be read safely"
	}
	if contentDigest(kept) != prev.Digest {
		return "the kept previous " + s.what + " is not the recorded content"
	}
	if err := s.dir.Install(s.name, kept, prev.owner()); err != nil {
		return "the previous " + s.what + " cannot be written back"
	}
	return ""
}

// SettleTLSInstall settles an interrupted TLS installation when the helper
// starts, before it serves anything (and again before every change, see
// handle). It returns what it did for the operator's log ("" when nothing),
// or why every change stays refused.
func (h *Helper) SettleTLSInstall() (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out, blocked := h.settlePair()
	if blocked != nil {
		return "", blocked
	}
	switch out.did {
	case pairCommitted:
		return fmt.Sprintf("the interrupted TLS installation of cluster %s (job %s) was completed: both files held the new key and certificate",
			out.record.Cluster, out.record.JobID), nil
	case pairRestored:
		return fmt.Sprintf("the interrupted TLS installation of cluster %s (job %s) was undone: the previous key and certificate are in place",
			out.record.Cluster, out.record.JobID), nil
	}
	return "", nil
}
