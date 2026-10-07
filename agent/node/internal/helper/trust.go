package helper

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"syscall"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

// TrustSchema is the version of the helper's trust file.
const TrustSchema = "exponetdb.helper-trust/v1"

// DefaultTrustPath is where the helper keeps its trust (root-owned, 0644).
const DefaultTrustPath = "/etc/exponetdb-node/helper-trust.json"

// Trust is the helper's own copy of what a job must be signed for: the
// installation, the node and the trusted job keys. It is written by root
// only: once by `exponetdb-node-helper trust` after enrollment, later by a
// signed config.update@1 job the current trust verifies.
type Trust struct {
	Schema         string         `json:"schema"`
	InstallationID string         `json:"installationId"`
	NodeID         string         `json:"nodeId"`
	JobKeys        []state.JobKey `json:"jobKeys"`
}

// Validate checks ids, one to three distinct keys of 32 bytes.
func (t *Trust) Validate() error {
	if t.Schema != TrustSchema || !nodecrypto.IsID("ins", t.InstallationID) || !nodecrypto.IsID("nod", t.NodeID) {
		return errors.New("helper trust: schema, installation or node invalid")
	}
	if len(t.JobKeys) < 1 || len(t.JobKeys) > 3 {
		return errors.New("helper trust: one to three job keys")
	}
	seen := map[string]bool{}
	for _, k := range t.JobKeys {
		if seen[k.KeyID] || k.KeyID == "" {
			return errors.New("helper trust: duplicate or empty key id")
		}
		seen[k.KeyID] = true
		if _, ok := nodecrypto.FromB64UOf(k.PublicKey, 32); !ok {
			return errors.New("helper trust: a public key is not 32 bytes")
		}
	}
	return nil
}

// Trusted are the job keys to verify against.
func (t *Trust) Trusted() []nodecrypto.TrustedJobKey {
	out := make([]nodecrypto.TrustedJobKey, 0, len(t.JobKeys))
	for _, k := range t.JobKeys {
		pub, _ := nodecrypto.FromB64UOf(k.PublicKey, 32)
		out = append(out, nodecrypto.TrustedJobKey{KeyID: k.KeyID, PublicKey: pub})
	}
	return out
}

// LoadTrust reads the trust file: owned by root, never writable by group or
// others, strict JSON.
func LoadTrust(path string, ownerUID int) (*Trust, error) {
	if err := fsutil.CheckOwnedPrivate(path, fsutil.Owner{UID: ownerUID, OtherReadable: true}); err != nil {
		return nil, fmt.Errorf("helper trust: %w", err)
	}
	data, err := fsutil.ReadLimited(path, 64*1024)
	if err != nil {
		return nil, fmt.Errorf("helper trust: %w", err)
	}
	if _, err := canon.Parse(data); err != nil {
		return nil, fmt.Errorf("helper trust: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var t Trust
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("helper trust: %w", err)
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	return &t, nil
}

// SaveTrust writes the trust file atomically (mode 0644).
func SaveTrust(path string, t *Trust) error {
	if err := t.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(path, append(data, '\n'), 0o644)
}

// TrustFromAgentState builds the initial trust from a freshly enrolled
// agent's state directory (the operator's act right after enrollment). The
// directory must belong to the uid that owns it, as the agent checks.
func TrustFromAgentState(dir string) (*Trust, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, errors.New("helper trust: cannot read the state directory owner")
	}
	store, err := state.Open(dir, int(sys.Uid))
	if err != nil {
		return nil, err
	}
	st, err := store.LoadState()
	if err != nil {
		return nil, err
	}
	t := &Trust{Schema: TrustSchema, InstallationID: st.InstallationID, NodeID: st.NodeID, JobKeys: st.JobKeys}
	return t, t.Validate()
}
