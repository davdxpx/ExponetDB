// Package state keeps the agent-owned state on disk (architecture.md §4):
// the node's identity and trust anchors in state.json, its private keys and
// certificate in identity/keys.json, and the directories for the journal and
// the result buffer. Every file is written atomically and durably, carries a
// checksum over its canonical content, and is owned by the agent user with
// no access for group or others. A missing state means "not enrolled"; a
// damaged one stops the agent (fail closed) until a local operator repairs
// or re-enrolls it.
package state

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
	"syscall"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

// Schemas of the state files.
const (
	StateSchema    = "exponetdb.node-state/v1"
	IdentitySchema = "exponetdb.node-identity/v1"
)

// Errors of Load*.
var (
	// ErrNotEnrolled: there is no state file; the agent must be enrolled.
	ErrNotEnrolled = errors.New("not enrolled")
	// ErrCorrupt: a state file fails its checksum or validation.
	ErrCorrupt = errors.New("state corrupt")
)

const maxFileBytes = 256 * 1024

var jobKeyIDRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// JobKey is a trusted job-signing key.
type JobKey struct {
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

// State is the agent-owned identity and trust state.
type State struct {
	Schema            string   `json:"schema"`
	InstallationID    string   `json:"installationId"`
	ServerID          string   `json:"serverId"`
	NodeID            string   `json:"nodeId"`
	GatewayURL        string   `json:"gatewayUrl"`
	GatewayServerName string   `json:"gatewayServerName"`
	RootCertificate   string   `json:"rootCertificate"`
	RootFingerprint   string   `json:"rootFingerprint"`
	JobKeys           []JobKey `json:"jobKeys"`
	// HighestIssuedAt is the latest issuedAt of an accepted job; a host
	// clock earlier than it by more than 30 s is a rollback (ADR-0024 §5).
	HighestIssuedAt string `json:"highestIssuedAt"`
	EnrolledAt      string `json:"enrolledAt"`
}

// Identity is the node's private key material and current certificate.
type Identity struct {
	Schema               string   `json:"schema"`
	TLSSeed              string   `json:"tlsSeed"`
	NodeSigningSeed      string   `json:"nodeSigningSeed"`
	NodeEncryptionSecret string   `json:"nodeEncryptionSecret"`
	CertificateChain     []string `json:"certificateChain"`
	CertificateExpiresAt string   `json:"certificateExpiresAt"`
}

// Store is the agent's state directory.
type Store struct {
	dir string
	uid int
}

// Subdirectories of the state directory.
const (
	IdentityDir = "identity"
	JournalDir  = "journal"
	BufferDir   = "buffer"
)

// Open checks the state directory (owned by uid, no access for group or
// others) and creates its subdirectories.
func Open(dir string, uid int) (*Store, error) {
	if err := fsutil.CheckOwnedPrivate(dir, fsutil.Owner{UID: uid}); err != nil {
		return nil, fmt.Errorf("state directory: %w", err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("state directory %s must be mode 0700", dir)
	}
	for _, sub := range []string{IdentityDir, JournalDir, BufferDir} {
		p := filepath.Join(dir, sub)
		if err := os.Mkdir(p, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if err := fsutil.CheckOwnedPrivate(p, fsutil.Owner{UID: uid}); err != nil {
			return nil, fmt.Errorf("state directory: %w", err)
		}
	}
	return &Store{dir: dir, uid: uid}, nil
}

// ErrLocked: another agent process holds the state directory.
var ErrLocked = errors.New("state directory: another exponetdb-node process holds it")

// Lock takes the state directory's exclusive lock (flock on its lock file)
// for the life of the returned file: one process at a time may enroll or run
// on a state directory, so two agents can never journal, or execute, the same
// job (architecture.md §4). It never waits.
func (s *Store) Lock() (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(s.dir, "lock"), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return f, nil
}

// Path returns a path inside the state directory.
func (s *Store) Path(parts ...string) string {
	return filepath.Join(append([]string{s.dir}, parts...)...)
}

// UID is the owner the store requires.
func (s *Store) UID() int { return s.uid }

// seal returns the file bytes: JCS({checksum, content}) with checksum the
// sha256 of JCS(content).
func seal(content any) ([]byte, error) {
	raw, err := json.Marshal(content)
	if err != nil {
		return nil, err
	}
	canonical, err := canon.Transform(raw)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canonical)
	wrapped := fmt.Sprintf(`{"checksum":"sha256:%s","content":%s}`, hex.EncodeToString(sum[:]), canonical)
	return canon.Transform([]byte(wrapped))
}

// unseal checks the checksum and decodes content strictly into v.
func unseal(data []byte, v any) error {
	doc, err := canon.Parse(data)
	if err != nil {
		return err
	}
	o, ok := doc.(canon.Object)
	if !ok || len(o) != 2 {
		return errors.New("not a sealed state file")
	}
	sumValue, _ := o.Get("checksum")
	content, hasContent := o.Get("content")
	sum, isString := sumValue.(canon.String)
	if !isString || !hasContent {
		return errors.New("not a sealed state file")
	}
	canonical, err := canon.Canonicalize(content)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(canonical)
	if !nodecrypto.SameFingerprint(string(sum), "sha256:"+hex.EncodeToString(digest[:])) {
		return errors.New("checksum mismatch")
	}
	dec := json.NewDecoder(bytes.NewReader(canonical))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Store) load(name string, v any) error {
	path := s.Path(name)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return ErrNotEnrolled
	}
	if err := fsutil.CheckOwnedPrivate(path, fsutil.Owner{UID: s.uid}); err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	data, err := fsutil.ReadLimited(path, maxFileBytes)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrCorrupt, name, err)
	}
	if err := unseal(data, v); err != nil {
		return fmt.Errorf("%w: %s: %v", ErrCorrupt, name, err)
	}
	return nil
}

func (s *Store) save(name string, v any) error {
	data, err := seal(v)
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(s.Path(name), data, 0o600)
}

const (
	stateFile    = "state.json"
	identityFile = IdentityDir + "/keys.json"
)

// LoadState reads and validates state.json.
func (s *Store) LoadState() (*State, error) {
	var st State
	if err := s.load(stateFile, &st); err != nil {
		return nil, err
	}
	if err := st.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	return &st, nil
}

// SaveState validates and writes state.json.
func (s *Store) SaveState(st *State) error {
	if err := st.Validate(); err != nil {
		return err
	}
	return s.save(stateFile, st)
}

// LoadIdentity reads and validates identity/keys.json.
func (s *Store) LoadIdentity() (*Identity, error) {
	var id Identity
	if err := s.load(identityFile, &id); err != nil {
		return nil, err
	}
	if err := id.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	return &id, nil
}

// SaveIdentity validates and writes identity/keys.json.
func (s *Store) SaveIdentity(id *Identity) error {
	if err := id.Validate(); err != nil {
		return err
	}
	return s.save(identityFile, id)
}

// Validate checks every member of the state.
func (st *State) Validate() error {
	switch {
	case st.Schema != StateSchema:
		return fmt.Errorf("schema %q", st.Schema)
	case !nodecrypto.IsID("ins", st.InstallationID), !nodecrypto.IsID("srv", st.ServerID), !nodecrypto.IsID("nod", st.NodeID):
		return errors.New("invalid ids")
	case !nodecrypto.IsGateway(st.GatewayURL), !nodecrypto.IsDNSName(st.GatewayServerName):
		return errors.New("invalid gateway")
	case !nodecrypto.IsTimestamp(st.EnrolledAt):
		return errors.New("invalid enrolledAt")
	case st.HighestIssuedAt != "" && !nodecrypto.IsTimestamp(st.HighestIssuedAt):
		return errors.New("invalid highestIssuedAt")
	case len(st.JobKeys) < 1 || len(st.JobKeys) > nodecrypto.TokenMaxJobKeys:
		return fmt.Errorf("%d job keys", len(st.JobKeys))
	}
	root, ok := nodecrypto.FromB64U(st.RootCertificate)
	if !ok || len(root) == 0 {
		return errors.New("invalid root certificate")
	}
	sum := sha256.Sum256(root)
	if st.RootFingerprint != "sha256:"+hex.EncodeToString(sum[:]) {
		return errors.New("root fingerprint does not match the root certificate")
	}
	seen := map[string]bool{}
	for _, k := range st.JobKeys {
		if _, ok := nodecrypto.FromB64UOf(k.PublicKey, 32); !ok || seen[k.KeyID] || !jobKeyIDRE.MatchString(k.KeyID) {
			return fmt.Errorf("invalid job key %q", k.KeyID)
		}
		seen[k.KeyID] = true
	}
	return nil
}

// Trusted returns the trusted job keys for signature verification.
func (st *State) Trusted() []nodecrypto.TrustedJobKey {
	out := make([]nodecrypto.TrustedJobKey, 0, len(st.JobKeys))
	for _, k := range st.JobKeys {
		pub, _ := nodecrypto.FromB64UOf(k.PublicKey, 32)
		out = append(out, nodecrypto.TrustedJobKey{KeyID: k.KeyID, PublicKey: pub})
	}
	return out
}

// Validate checks every member of the identity.
func (id *Identity) Validate() error {
	if id.Schema != IdentitySchema {
		return fmt.Errorf("schema %q", id.Schema)
	}
	for name, v := range map[string]string{"tlsSeed": id.TLSSeed, "nodeSigningSeed": id.NodeSigningSeed, "nodeEncryptionSecret": id.NodeEncryptionSecret} {
		if _, ok := nodecrypto.FromB64UOf(v, 32); !ok {
			return fmt.Errorf("invalid %s", name)
		}
	}
	if len(id.CertificateChain) < 2 || len(id.CertificateChain) > 3 {
		return fmt.Errorf("certificate chain of %d", len(id.CertificateChain))
	}
	for _, c := range id.CertificateChain {
		if b, ok := nodecrypto.FromB64U(c); !ok || len(b) == 0 {
			return errors.New("invalid certificate")
		}
	}
	if !nodecrypto.IsTimestamp(id.CertificateExpiresAt) {
		return errors.New("invalid certificateExpiresAt")
	}
	return nil
}

// Seed decodes a 32-byte base64url member (validated on load).
func Seed(v string) []byte {
	b, _ := nodecrypto.FromB64UOf(v, 32)
	return b
}
