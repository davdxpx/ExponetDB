package nodecrypto

import "github.com/davdxpx/ExponetDB/agent/node/internal/canon"

// SealContext binds a sealed value (ns1, protocol.md §7.6) to one argument of
// one job.
type SealContext struct {
	InstallationID string
	NodeID         string
	JobID          string
	OperationID    string
	Capability     string
	Major          int
	// Field is the argument the value fills.
	Field string
}

// Ns1 is the sealed value: the HPKE encapsulated key and the ciphertext, both
// base64url.
type Ns1 struct {
	Enc string
	CT  string
}

// SealInfo is the HPKE info of a seal: JCS of the purpose and the context.
func SealInfo(c SealContext) ([]byte, error) {
	return canon.Canonicalize(canon.Object{
		{Name: "purpose", Value: canon.String("exponetdb/sealed/ns1")},
		{Name: "installationId", Value: canon.String(c.InstallationID)},
		{Name: "nodeId", Value: canon.String(c.NodeID)},
		{Name: "jobId", Value: canon.String(c.JobID)},
		{Name: "operationId", Value: canon.String(c.OperationID)},
		{Name: "capability", Value: canon.Object{
			{Name: "name", Value: canon.String(c.Capability)},
			{Name: "major", Value: canon.Number(c.Major)},
		}},
		{Name: "field", Value: canon.String(c.Field)},
	})
}

// sealNs1 seals plaintext to the node's raw X25519 public key. Only the
// worker seals; the agent opens. Tests pass ephemeralSecret to reproduce the
// golden vectors.
func sealNs1(nodeEncryptionKey []byte, c SealContext, plaintext, ephemeralSecret []byte, trace *hpkeTrace) (Ns1, error) {
	info, err := SealInfo(c)
	if err != nil {
		return Ns1{}, err
	}
	enc, ct, err := hpkeSeal(nodeEncryptionKey, info, nil, plaintext, aead256, ephemeralSecret, trace)
	if err != nil {
		return Ns1{}, err
	}
	return Ns1{Enc: B64U(enc), CT: B64U(ct)}, nil
}

// ParseNs1 reads the args form {"ns1": {"enc": …, "ct": …}} strictly: exactly
// those members, both strings.
func ParseNs1(v canon.Value) (Ns1, bool) {
	outer, ok := v.(canon.Object)
	if !ok || len(outer) != 1 {
		return Ns1{}, false
	}
	raw, _ := outer.Get("ns1")
	inner, ok := raw.(canon.Object)
	if !ok || len(inner) != 2 {
		return Ns1{}, false
	}
	enc, encOK := stringMember(inner, "enc")
	ct, ctOK := stringMember(inner, "ct")
	if !encOK || !ctOK {
		return Ns1{}, false
	}
	return Ns1{Enc: enc, CT: ct}, true
}

// OpenNs1 opens a sealed value with the node's X25519 secret; ok is false
// when it does not open under exactly this context.
func OpenNs1(nodeEncryptionSecret []byte, c SealContext, v Ns1) ([]byte, bool) {
	enc, encOK := FromB64UOf(v.Enc, x25519Bytes)
	ct, ctOK := FromB64U(v.CT)
	info, err := SealInfo(c)
	if !encOK || !ctOK || err != nil {
		return nil, false
	}
	return hpkeOpen(nodeEncryptionSecret, info, nil, enc, ct, aead256)
}
