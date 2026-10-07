package verify

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

const (
	installation = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	node         = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	jobID        = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	keyID        = "jobkey_2026_10"
)

var (
	jobSeed = []byte("0123456789abcdef0123456789abcdef")
	issued  = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
)

type fakeJournal struct {
	err   error
	known map[string]bool
}

func (f *fakeJournal) Err() error             { return f.err }
func (f *fakeJournal) Known(id string) bool   { return f.known[id] }
func (f *fakeJournal) Seen(nonce string) bool { return f.known[nonce] }

type fakeCaps map[string]string // key → "on" | "off"

func (c fakeCaps) Supported(key string) bool { _, ok := c[key]; return ok }
func (c fakeCaps) Enabled(key string) bool   { return c[key] == "on" }

func obj(t *testing.T, json string) canon.Object {
	t.Helper()
	v, err := canon.Parse([]byte(json))
	if err != nil {
		t.Fatal(err)
	}
	return v.(canon.Object)
}

func argsHash(t *testing.T, args canon.Value) string {
	t.Helper()
	b, err := canon.Canonicalize(args)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func set(o canon.Object, name string, v canon.Value) canon.Object {
	out := append(canon.Object{}, o...)
	for i := range out {
		if out[i].Name == name {
			out[i].Value = v
			return out
		}
	}
	return append(out, canon.Member{Name: name, Value: v})
}

// envelope builds a signed postgres.status@1 job, with edits applied before signing.
func envelope(t *testing.T, edits ...func(canon.Object) canon.Object) canon.Object {
	t.Helper()
	args := obj(t, `{"cluster":{"localName":"17/main","systemIdentifier":"7291234567890123456"}}`)
	e := obj(t, `{"jobId":"`+jobID+`","operationId":"op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z","nodeId":"`+node+`",
	  "capability":{"name":"postgres.status","major":1},"notBefore":"2026-10-07T12:00:00Z",
	  "expiresAt":"2026-10-07T12:15:00Z","nonce":"AAECAwQFBgcICQoLDA0ODw","issuedAt":"2026-10-07T12:00:00Z","attempt":1}`)
	e = set(e, "args", args)
	e = set(e, "argsHash", canon.String(argsHash(t, args)))
	for _, edit := range edits {
		e = edit(e)
	}
	signed, err := nodecrypto.SignJobEnvelope(e, keyID, jobSeed)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

type harness struct {
	v       *Verifier
	journal *fakeJournal
	clk     *clock.Fixed
	nek     *ecdh.PrivateKey
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	validator, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	nek, err := ecdh.X25519().NewPrivateKey(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{journal: &fakeJournal{known: map[string]bool{}}, clk: &clock.Fixed{T: issued.Add(time.Minute), Synced: true}, nek: nek}
	h.v = &Verifier{
		InstallationID: installation,
		NodeID:         node,
		Trusted: []nodecrypto.TrustedJobKey{
			{KeyID: keyID, PublicKey: ed25519.NewKeyFromSeed(jobSeed).Public().(ed25519.PublicKey)},
		},
		Clock:        h.clk,
		Journal:      h.journal,
		Nonces:       h.journal,
		Capabilities: fakeCaps{"postgres.status@1": "on", "postgres.roles.apply@1": "on", "postgres.reload@1": "off"},
		Schema:       validator,
		Sealed: func(key string) []SealedField {
			if key == "postgres.roles.apply@1" {
				return []SealedField{{Path: "steps[].verifier", Field: "verifier"}}
			}
			return nil
		},
		NodeEncryptionSecret: nek.Bytes(),
	}
	return h
}

func TestValidJobPasses(t *testing.T) {
	h := newHarness(t)
	d := h.v.Verify(envelope(t))
	if d.Reason != "" || !d.Signed || d.Job == nil || d.Job.Capability != "postgres.status@1" || d.JobID != jobID {
		t.Fatalf("%+v", d)
	}
}

func TestEveryRejectionReason(t *testing.T) {
	str := func(s string) canon.Value { return canon.String(s) }
	for _, c := range []struct {
		name   string
		reason string
		signed bool
		setup  func(*harness)
		env    func(t *testing.T) canon.Object
	}{
		{name: "tampered after signing", reason: SignatureInvalid, env: func(t *testing.T) canon.Object {
			return set(envelope(t), "attempt", canon.Number(2))
		}},
		{name: "signed by an untrusted key id", reason: UnknownSigningKey, env: func(t *testing.T) canon.Object {
			e := envelope(t)
			sig, _ := e.Get("signature")
			return set(e, "signature", set(sig.(canon.Object), "keyId", str("jobkey_2025_01")))
		}},
		{name: "signed envelope with a bad nonce", reason: EnvelopeInvalid, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object { return set(e, "nonce", str("short")) })
		}},
		{name: "signed envelope with an unknown member", reason: EnvelopeInvalid, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object { return set(e, "exec", str("id")) })
		}},
		{name: "another node", reason: NodeMismatch, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object { return set(e, "nodeId", str("nod_01JB2Z6G8M4Q7R9T1V3W5X7YA0")) })
		}},
		{name: "clock not synchronized", reason: ClockUntrusted, signed: true, setup: func(h *harness) { h.clk.Synced = false }},
		{name: "clock rolled back", reason: ClockUntrusted, signed: true, setup: func(h *harness) { h.v.HighestIssuedAt = issued.Add(time.Hour) }},
		{name: "window longer than 60 minutes", reason: Expired, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object { return set(e, "expiresAt", str("2026-10-07T13:00:01Z")) })
		}},
		{name: "expiresAt not after notBefore", reason: Expired, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object { return set(e, "expiresAt", str("2026-10-07T12:00:00Z")) })
		}},
		{name: "not yet valid", reason: NotYetValid, signed: true, setup: func(h *harness) { h.clk.T = issued.Add(-31 * time.Second) }},
		{name: "expired", reason: Expired, signed: true, setup: func(h *harness) { h.clk.T = issued.Add(15*time.Minute + 31*time.Second) }},
		{name: "journal broken", reason: JournalCorrupt, signed: true, setup: func(h *harness) { h.journal.err = errors.New("broken") }},
		{name: "job id in the journal", reason: JobReplayed, signed: true, setup: func(h *harness) { h.journal.known[jobID] = true }},
		{name: "nonce seen", reason: NonceReplayed, signed: true, setup: func(h *harness) { h.journal.known["AAECAwQFBgcICQoLDA0ODw"] = true }},
		{name: "capability outside the agent", reason: CapabilityUnsupported, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object {
				return set(e, "capability", obj(t, `{"name":"postgres.status","major":2}`))
			})
		}},
		{name: "capability disabled by the operator", reason: CapabilityDisabled, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object {
				return set(e, "capability", obj(t, `{"name":"postgres.reload","major":1}`))
			})
		}},
		{name: "arguments outside the schema", reason: ArgsInvalid, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object {
				args := obj(t, `{"cluster":{"localName":"17/main","systemIdentifier":"7291234567890123456"},"command":"id"}`)
				return set(set(e, "args", args), "argsHash", str(argsHash(t, args)))
			})
		}},
		{name: "argsHash of other arguments", reason: ArgsHashMismatch, signed: true, env: func(t *testing.T) canon.Object {
			return envelope(t, func(e canon.Object) canon.Object {
				return set(e, "argsHash", str("sha256:"+hex.EncodeToString(make([]byte, 32))))
			})
		}},
		{name: "precondition", reason: PreconditionFailed, signed: true, setup: func(h *harness) {
			h.v.Precondition = func(string, canon.Object) error { return errors.New("system identifier differs") }
		}},
		{name: "node mismatch wins over expiry", reason: NodeMismatch, signed: true, setup: func(h *harness) { h.clk.T = issued.Add(time.Hour) },
			env: func(t *testing.T) canon.Object {
				return envelope(t, func(e canon.Object) canon.Object { return set(e, "nodeId", str("nod_01JB2Z6G8M4Q7R9T1V3W5X7YA0")) })
			}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			if c.setup != nil {
				c.setup(h)
			}
			e := envelope(t)
			if c.env != nil {
				e = c.env(t)
			}
			d := h.v.Verify(e)
			if d.Reason != c.reason || d.Signed != c.signed || d.JobID != jobID || d.Job != nil {
				t.Fatalf("got %+v, want %s (signed %v)", d, c.reason, c.signed)
			}
		})
	}
}

func TestEnvelopeWithoutJobIDCannotBeAnswered(t *testing.T) {
	h := newHarness(t)
	e := set(envelope(t), "jobId", canon.String("not-a-job"))
	if d := h.v.Verify(e); d.JobID != "" || d.Reason != EnvelopeInvalid || d.Signed {
		t.Fatalf("%+v", d)
	}
}

func TestSealedVerifierMustOpenUnderThisJob(t *testing.T) {
	h := newHarness(t)
	rolesJob := func(t *testing.T, sealedFor nodecrypto.SealContext, key []byte) canon.Object {
		sealed, err := nodecrypto.SealNs1(key, sealedFor, []byte("SCRAM-SHA-256$4096:c2FsdA==$a2V5:a2V5"))
		if err != nil {
			t.Fatal(err)
		}
		args := obj(t, `{"cluster":{"localName":"17/main","systemIdentifier":"7291234567890123456"},
		  "expectedRolesDigest":"sha256:`+hex.EncodeToString(make([]byte, 32))+`",
		  "steps":[{"op":"set_password","role":"app_user","attributes":null,"member":null,"admin":null,
		    "inherit":null,"set":null,"database":null,"setting":null,"value":null,
		    "verifier":{"ns1":{"enc":"`+sealed.Enc+`","ct":"`+sealed.CT+`"}}}]}`)
		return envelope(t, func(e canon.Object) canon.Object {
			e = set(e, "capability", obj(t, `{"name":"postgres.roles.apply","major":1}`))
			return set(set(e, "args", args), "argsHash", canon.String(argsHash(t, args)))
		})
	}
	ctx := nodecrypto.SealContext{
		InstallationID: installation, NodeID: node, JobID: jobID,
		OperationID: "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", Capability: "postgres.roles.apply", Major: 1, Field: "verifier",
	}
	if d := h.v.Verify(rolesJob(t, ctx, h.nek.PublicKey().Bytes())); d.Reason != "" {
		t.Fatalf("sealed for this job: %+v", d)
	}
	other := ctx
	other.JobID = "job_01JB2Z6G8M4Q7R9T1V3W5X7YA0"
	if d := h.v.Verify(rolesJob(t, other, h.nek.PublicKey().Bytes())); d.Reason != ArgsInvalid {
		t.Fatalf("sealed for another job: %+v", d)
	}
	other = ctx
	other.Field = "newVerifier"
	if d := h.v.Verify(rolesJob(t, other, h.nek.PublicKey().Bytes())); d.Reason != ArgsInvalid {
		t.Fatalf("sealed for another field: %+v", d)
	}
	stranger, _ := ecdh.X25519().NewPrivateKey(bytesOf(9))
	if d := h.v.Verify(rolesJob(t, ctx, stranger.PublicKey().Bytes())); d.Reason != ArgsInvalid {
		t.Fatalf("sealed to another node: %+v", d)
	}
}

func bytesOf(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}
