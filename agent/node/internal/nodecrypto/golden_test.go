package nodecrypto

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// goldenDir walks up from the test's working directory until it finds a
// directory that contains tooling/golden.
func goldenDir(t *testing.T) string {
	t.Helper()
	start, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for dir := start; ; {
		candidate := filepath.Join(dir, "tooling", "golden")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no tooling/golden directory above %s", start)
		}
		dir = parent
	}
}

// loadGolden decodes a golden file into v; unknown fields are an error.
func loadGolden(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir(t), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

func mustRaw(t *testing.T, s string) []byte {
	t.Helper()
	b, ok := FromB64UOf(s, 32)
	if !ok {
		t.Fatalf("not a 32-byte base64url value: %q", s)
	}
	return b
}

func mustObject(t *testing.T, raw json.RawMessage) canon.Object {
	t.Helper()
	v, err := canon.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	o, ok := v.(canon.Object)
	if !ok {
		t.Fatalf("not a JSON object: %s", raw)
	}
	return o
}

func jcs(t *testing.T, v canon.Value) string {
	t.Helper()
	b, err := canon.Canonicalize(v)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	return string(b)
}

func ed25519Public(seed []byte) []byte {
	return ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
}

func x25519Public(t *testing.T, secret []byte) []byte {
	t.Helper()
	k, err := ecdh.X25519().NewPrivateKey(secret)
	if err != nil {
		t.Fatalf("x25519: %v", err)
	}
	return k.PublicKey().Bytes()
}

// TestHPKERFC9180 checks HPKE against RFC 9180 A.1.1 (DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode, sequence number 0).
func TestHPKERFC9180(t *testing.T) {
	pkR := mustHex(t, "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d")
	skR := mustHex(t, "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8")
	skE := mustHex(t, "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736")
	info := mustHex(t, "4f6465206f6e2061204772656369616e2055726e")
	aad := mustHex(t, "436f756e742d30")
	pt := mustHex(t, "4265617574792069732074727574682c20747275746820626561757479")
	var trace hpkeTrace
	enc, ct, err := hpkeSeal(pkR, info, aad, pt, aead128, skE, &trace)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ name, got, want string }{
		{"enc", hex.EncodeToString(enc), "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"},
		{"shared_secret", hex.EncodeToString(trace.sharedSecret), "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc"},
		{"key", hex.EncodeToString(trace.key), "4531685d41d65f03dc48f6b8302c05b0"},
		{"base_nonce", hex.EncodeToString(trace.baseNonce), "56d890e5accaaf011cff4b7d"},
		{"ct", hex.EncodeToString(ct), "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"},
	} {
		if c.got != c.want {
			t.Errorf("%s = %s, want %s", c.name, c.got, c.want)
		}
	}
	if got, ok := hpkeOpen(skR, info, aad, enc, ct, aead128); !ok || !bytes.Equal(got, pt) {
		t.Errorf("open = %x, %v", got, ok)
	}
	if _, ok := hpkeOpen(skR, info, []byte{0}, enc, ct, aead128); ok {
		t.Error("opened under another aad")
	}
}

func TestB64U(t *testing.T) {
	for _, c := range []struct {
		in string
		ok bool
	}{
		{"AQ", true}, {"", true}, {"AQ==", false}, {"AR", false}, {"A", false},
		{"AQ\n", false}, {"A\nQ", false}, {"+w", false}, {"/w", false}, {"_w", true},
	} {
		if _, ok := FromB64U(c.in); ok != c.ok {
			t.Errorf("FromB64U(%q) ok = %v, want %v", c.in, ok, c.ok)
		}
	}
	if _, ok := FromB64UOf("AQ", 2); ok {
		t.Error("FromB64UOf accepted the wrong length")
	}
}

func TestIsTimestamp(t *testing.T) {
	for _, c := range []struct {
		in string
		ok bool
	}{
		{"2026-10-07T12:30:00Z", true},
		{"2028-02-29T23:59:59.5Z", true},
		{"2000-02-29T00:00:00Z", true},
		{"2026-02-29T00:00:00Z", false},
		{"1900-02-29T00:00:00Z", false},
		{"2026-13-01T00:00:00Z", false},
		{"2026-00-01T00:00:00Z", false},
		{"2026-04-31T00:00:00Z", false},
		{"2026-10-07T24:00:00Z", false},
		{"2026-10-07T12:60:00Z", false},
		{"2026-10-07T12:00:60Z", false},
		{"2026-10-07T12:00:00+00:00", false},
		{"2026-10-07T12:00:00.1234567890Z", false},
		{"2026-10-07t12:00:00Z", false},
	} {
		if got := IsTimestamp(c.in); got != c.ok {
			t.Errorf("IsTimestamp(%q) = %v, want %v", c.in, got, c.ok)
		}
	}
}

func TestIsGateway(t *testing.T) {
	for _, c := range []struct {
		in string
		ok bool
	}{
		{"https://10.8.2.2:7443", true},
		{"https://gateway.exdb.internal", true},
		{"https://gateway.exdb.internal:65535", true},
		{"https://gateway.exdb.internal:65536", false},
		{"https://gateway.exdb.internal:443", false},
		{"https://gateway.exdb.internal:0", false},
		{"https://gateway.exdb.internal:07443", false},
		{"https://Gateway.exdb.internal", false},
		{"https://gateway.exdb.internal/", false},
		{"https://gateway.exdb.internal:7443/path", false},
		{"http://gateway.exdb.internal", false},
		{"https://user@gateway.exdb.internal", false},
		{"https://-gateway.exdb.internal", false},
		{"https://gateway.exdb.internal\n", false},
		{"https://[::1]:7443", false},
	} {
		if got := isGateway(c.in); got != c.ok {
			t.Errorf("isGateway(%q) = %v, want %v", c.in, got, c.ok)
		}
	}
}

type trustedKeyJSON struct {
	KeyID       string `json:"keyId"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
}

type jobVector struct {
	ID            string           `json:"id"`
	Description   string           `json:"description"`
	Envelope      json.RawMessage  `json:"envelope"`
	SigningInput  string           `json:"signingInput"`
	KeyID         string           `json:"keyId"`
	SignerSeedHex string           `json:"signerSeedHex"`
	Valid         bool             `json:"valid"`
	Reason        string           `json:"reason"`
	TrustedKeys   []trustedKeyJSON `json:"trustedKeys"`
}

func TestGoldenJobSignature(t *testing.T) {
	var file struct {
		Contract      string      `json:"contract"`
		Specification string      `json:"specification"`
		Notes         string      `json:"notes"`
		Vectors       []jobVector `json:"vectors"`
	}
	loadGolden(t, "node-job-signature.json", &file)
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range file.Vectors {
		t.Run(v.ID, func(t *testing.T) {
			var trusted []TrustedJobKey
			for _, k := range v.TrustedKeys {
				pub := mustRaw(t, k.PublicKey)
				if got := KeyFingerprint(pub); got != k.Fingerprint {
					t.Fatalf("fingerprint of %s = %s, want %s", k.KeyID, got, k.Fingerprint)
				}
				trusted = append(trusted, TrustedJobKey{KeyID: k.KeyID, PublicKey: pub})
			}
			envelope := mustObject(t, v.Envelope)
			keyID, reason := VerifyJobEnvelope(envelope, trusted)
			if !v.Valid {
				if reason != v.Reason || keyID != "" {
					t.Fatalf("verify = (%q, %q), want refusal %q", keyID, reason, v.Reason)
				}
				return
			}
			if reason != "" || keyID != v.KeyID {
				t.Fatalf("verify = (%q, %q), want key %q", keyID, reason, v.KeyID)
			}
			if got := jcs(t, JobSigningValue(envelope)); got != v.SigningInput {
				t.Fatalf("signing input = %s, want %s", got, v.SigningInput)
			}
			// Ed25519 is deterministic: re-signing reproduces the envelope.
			signed, err := SignJobEnvelope(envelope, v.KeyID, mustHex(t, v.SignerSeedHex))
			if err != nil {
				t.Fatal(err)
			}
			if jcs(t, signed) != jcs(t, envelope) {
				t.Fatal("re-signing does not reproduce the envelope")
			}
		})
	}
}

type tokenVector struct {
	ID          string          `json:"id"`
	Description string          `json:"description"`
	Payload     json.RawMessage `json:"payload"`
	Token       string          `json:"token"`
	SecretHex   string          `json:"secretHex"`
	KRedeemHex  string          `json:"kRedeemHex"`
	RedeemKey   string          `json:"redeemKey"`
	RedeemHash  string          `json:"redeemHash"`
	KBindHex    string          `json:"kBindHex"`
	Reason      string          `json:"reason"`

	TokenID                  string `json:"tokenId"`
	NodeID                   string `json:"nodeId"`
	TLSSeedHex               string `json:"tlsSeedHex"`
	TLSKey                   string `json:"tlsKey"`
	TLSKeyProofInput         string `json:"tlsKeyProofInput"`
	TLSKeyProof              string `json:"tlsKeyProof"`
	NodeSigningSeedHex       string `json:"nodeSigningSeedHex"`
	NodeSigningKey           string `json:"nodeSigningKey"`
	NodeSigningKeyProofInput string `json:"nodeSigningKeyProofInput"`
	NodeSigningKeyProof      string `json:"nodeSigningKeyProof"`
	NodeEncryptionSecretHex  string `json:"nodeEncryptionSecretHex"`
	NodeEncryptionKey        string `json:"nodeEncryptionKey"`
	BindInput                string `json:"bindInput"`
	BindProof                string `json:"bindProof"`
	NodeSignatureInput       string `json:"nodeSignatureInput"`
	NodeSignature            string `json:"nodeSignature"`
}

func TestGoldenEnrollment(t *testing.T) {
	var file struct {
		Contract      string        `json:"contract"`
		Specification string        `json:"specification"`
		Notes         string        `json:"notes"`
		Vectors       []tokenVector `json:"vectors"`
	}
	loadGolden(t, "node-enrollment.json", &file)
	byID := map[string]tokenVector{}
	for _, v := range file.Vectors {
		if _, dup := byID[v.ID]; dup || v.ID == "" {
			t.Fatalf("vector id %q is empty or not unique", v.ID)
		}
		byID[v.ID] = v
	}
	tok, proof, renew := byID["tok-001"], byID["proof-001"], byID["proof-002"]
	if tok.ID == "" || proof.ID == "" || renew.ID == "" {
		t.Fatal("tok-001, proof-001 or proof-002 is missing")
	}

	t.Run("tok-001", func(t *testing.T) {
		token, reason := DecodeToken(tok.Token)
		if token == nil {
			t.Fatalf("refused: %s", reason)
		}
		if hex.EncodeToString(token.Secret) != tok.SecretHex {
			t.Fatal("secret differs")
		}
		if encoded, err := EncodeToken(token); err != nil || encoded != tok.Token {
			t.Fatalf("re-encoding = %q, %v", encoded, err)
		}
		if TokenPrefix+B64U([]byte(jcs(t, mustObject(t, tok.Payload)))) != tok.Token {
			t.Fatal("token is not exdbt1. + b64u(JCS(payload))")
		}
		redeem, bind, err := TokenKeys(token.Secret, token.TokenID)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(redeem) != tok.KRedeemHex || hex.EncodeToString(bind) != tok.KBindHex {
			t.Fatal("derived keys differ")
		}
		if B64U(redeem) != tok.RedeemKey || RedeemHash(redeem) != tok.RedeemHash {
			t.Fatal("redeem key or hash differs")
		}
		if !RedeemKeyMatches(tok.RedeemKey, tok.RedeemHash) || RedeemKeyMatches(B64U(bind), tok.RedeemHash) {
			t.Fatal("redeem key check")
		}
		if RedeemKeyMatches(tok.RedeemKey+"=", tok.RedeemHash) {
			t.Fatal("a padded redeem key matched")
		}
	})

	for _, v := range file.Vectors {
		if !strings.HasPrefix(v.ID, "tok-1") {
			continue
		}
		t.Run(v.ID, func(t *testing.T) {
			if token, reason := DecodeToken(v.Token); token != nil || reason != v.Reason {
				t.Fatalf("decode = (%v, %q), want refusal %q", token != nil, reason, v.Reason)
			}
		})
	}

	t.Run("proof-001", func(t *testing.T) {
		tlsSeed := mustHex(t, proof.TLSSeedHex)
		nskSeed := mustHex(t, proof.NodeSigningSeedHex)
		if B64U(ed25519Public(tlsSeed)) != proof.TLSKey || B64U(ed25519Public(nskSeed)) != proof.NodeSigningKey {
			t.Fatal("public keys differ")
		}
		if B64U(x25519Public(t, mustHex(t, proof.NodeEncryptionSecretHex))) != proof.NodeEncryptionKey {
			t.Fatal("encryption key differs")
		}
		tlsValue := TLSKeyProofValue(proof.TokenID, proof.TLSKey)
		if jcs(t, tlsValue) != proof.TLSKeyProofInput {
			t.Fatal("tls proof input differs")
		}
		if sig, err := SignCanonical(tlsSeed, tlsValue); err != nil || sig != proof.TLSKeyProof {
			t.Fatalf("tls proof = %q, %v", sig, err)
		}
		if !VerifyCanonical(mustRaw(t, proof.TLSKey), tlsValue, proof.TLSKeyProof) {
			t.Fatal("tls proof does not verify")
		}
		nskValue := NodeSigningKeyProofValue(proof.TokenID, proof.NodeSigningKey)
		if jcs(t, nskValue) != proof.NodeSigningKeyProofInput {
			t.Fatal("nsk proof input differs")
		}
		if sig, err := SignCanonical(nskSeed, nskValue); err != nil || sig != proof.NodeSigningKeyProof {
			t.Fatalf("nsk proof = %q, %v", sig, err)
		}
		token, _ := DecodeToken(tok.Token)
		statement := BindStatement{
			InstallationID:    token.InstallationID,
			ServerID:          token.ServerID,
			TokenID:           token.TokenID,
			NodeSigningKey:    proof.NodeSigningKey,
			NodeEncryptionKey: proof.NodeEncryptionKey,
		}
		if jcs(t, BindValue(statement)) != proof.BindInput {
			t.Fatal("bind input differs")
		}
		kBind := mustHex(t, tok.KBindHex)
		if got, err := BindProof(kBind, statement); err != nil || got != proof.BindProof {
			t.Fatalf("bind proof = %q, %v", got, err)
		}
		if !BindProofMatches(kBind, statement, proof.BindProof) {
			t.Fatal("bind proof does not match")
		}
		other := statement
		other.NodeEncryptionKey = proof.TLSKey
		if BindProofMatches(kBind, other, proof.BindProof) {
			t.Fatal("bind proof matched another key")
		}
	})

	t.Run("proof-002", func(t *testing.T) {
		tlsValue := RenewTLSKeyProofValue(renew.NodeID, renew.TLSKey)
		if jcs(t, tlsValue) != renew.TLSKeyProofInput {
			t.Fatal("renew tls proof input differs")
		}
		if sig, err := SignCanonical(mustHex(t, renew.TLSSeedHex), tlsValue); err != nil || sig != renew.TLSKeyProof {
			t.Fatalf("renew tls proof = %q, %v", sig, err)
		}
		sigValue := RenewSignatureValue(renew.NodeID, renew.TLSKey)
		if jcs(t, sigValue) != renew.NodeSignatureInput {
			t.Fatal("renew signature input differs")
		}
		if sig, err := SignCanonical(mustHex(t, proof.NodeSigningSeedHex), sigValue); err != nil || sig != renew.NodeSignature {
			t.Fatalf("renew signature = %q, %v", sig, err)
		}
		if !VerifyCanonical(mustRaw(t, proof.NodeSigningKey), sigValue, renew.NodeSignature) {
			t.Fatal("renew signature does not verify")
		}
	})
}

type resultVector struct {
	ID                 string            `json:"id"`
	Description        string            `json:"description"`
	NodeSigningSeedHex string            `json:"nodeSigningSeedHex"`
	NodeSigningKey     string            `json:"nodeSigningKey"`
	Context            resultContextJSON `json:"context"`
	Complete           json.RawMessage   `json:"complete"`
	SigningInput       string            `json:"signingInput"`
	Signature          string            `json:"signature"`
	Valid              bool              `json:"valid"`
}

func TestGoldenResult(t *testing.T) {
	var file struct {
		Contract      string         `json:"contract"`
		Specification string         `json:"specification"`
		Notes         string         `json:"notes"`
		Vectors       []resultVector `json:"vectors"`
	}
	loadGolden(t, "node-result.json", &file)
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range file.Vectors {
		t.Run(v.ID, func(t *testing.T) {
			complete := mustObject(t, v.Complete)
			key := mustRaw(t, v.NodeSigningKey)
			ctx := v.Context.context()
			if got := VerifyResult(key, ctx, complete, v.Signature); got != v.Valid {
				t.Fatalf("verify = %v, want %v", got, v.Valid)
			}
			if !v.Valid {
				return
			}
			if got := jcs(t, ResultSigningValue(ctx, complete)); got != v.SigningInput {
				t.Fatalf("signing input = %s, want %s", got, v.SigningInput)
			}
			if sig, err := SignResult(mustHex(t, v.NodeSigningSeedHex), ctx, complete); err != nil || sig != v.Signature {
				t.Fatalf("sign = %q, %v", sig, err)
			}
			// A nodeSignature member already present is not signed over.
			withSignature := append(canon.Object{{Name: "nodeSignature", Value: canon.String("x")}}, complete...)
			if !VerifyResult(key, ctx, withSignature, v.Signature) {
				t.Fatal("nodeSignature member was signed over")
			}
		})
	}
}

type resultContextJSON struct {
	InstallationID string `json:"installationId"`
	NodeID         string `json:"nodeId"`
	JobID          string `json:"jobId"`
	ArgsHash       string `json:"argsHash"`
}

func (c resultContextJSON) context() ResultContext {
	return ResultContext(c)
}

type sealContextJSON struct {
	InstallationID string `json:"installationId"`
	NodeID         string `json:"nodeId"`
	JobID          string `json:"jobId"`
	OperationID    string `json:"operationId"`
	Capability     struct {
		Name  string `json:"name"`
		Major int    `json:"major"`
	} `json:"capability"`
	Field string `json:"field"`
}

func (c sealContextJSON) context() SealContext {
	return SealContext{
		InstallationID: c.InstallationID, NodeID: c.NodeID, JobID: c.JobID, OperationID: c.OperationID,
		Capability: c.Capability.Name, Major: c.Capability.Major, Field: c.Field,
	}
}

type sealedVector struct {
	ID                 string          `json:"id"`
	Description        string          `json:"description"`
	RecipientSecretHex string          `json:"recipientSecretHex"`
	RecipientKey       string          `json:"recipientKey"`
	EphemeralSecretHex string          `json:"ephemeralSecretHex"`
	Context            sealContextJSON `json:"context"`
	Info               string          `json:"info"`
	PlaintextHex       string          `json:"plaintextHex"`
	SharedSecretHex    string          `json:"sharedSecretHex"`
	KeyHex             string          `json:"keyHex"`
	BaseNonceHex       string          `json:"baseNonceHex"`
	Sealed             json.RawMessage `json:"sealed"`
	Valid              *bool           `json:"valid"`
}

func TestGoldenSealed(t *testing.T) {
	var file struct {
		Contract      string         `json:"contract"`
		Specification string         `json:"specification"`
		Notes         string         `json:"notes"`
		Vectors       []sealedVector `json:"vectors"`
	}
	loadGolden(t, "node-sealed.json", &file)
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range file.Vectors {
		t.Run(v.ID, func(t *testing.T) {
			secret := mustHex(t, v.RecipientSecretHex)
			ctx := v.Context.context()
			sealed, ok := ParseNs1(canon.Object{{Name: "ns1", Value: mustObject(t, v.Sealed)}})
			if !ok {
				t.Fatal("ParseNs1 refused the args form")
			}
			if v.Valid != nil && !*v.Valid {
				if pt, ok := OpenNs1(secret, ctx, sealed); ok {
					t.Fatalf("opened: %x", pt)
				}
				return
			}
			if B64U(x25519Public(t, secret)) != v.RecipientKey {
				t.Fatal("recipient key differs")
			}
			info, err := SealInfo(ctx)
			if err != nil || string(info) != v.Info {
				t.Fatalf("info = %s, %v", info, err)
			}
			plaintext := mustHex(t, v.PlaintextHex)
			var trace hpkeTrace
			out, err := sealNs1(mustRaw(t, v.RecipientKey), ctx, plaintext, mustHex(t, v.EphemeralSecretHex), &trace)
			if err != nil {
				t.Fatal(err)
			}
			if out != sealed {
				t.Fatalf("sealed = %+v, want %+v", out, sealed)
			}
			if hex.EncodeToString(trace.sharedSecret) != v.SharedSecretHex ||
				hex.EncodeToString(trace.key) != v.KeyHex ||
				hex.EncodeToString(trace.baseNonce) != v.BaseNonceHex {
				t.Fatal("key schedule differs")
			}
			if pt, ok := OpenNs1(secret, ctx, sealed); !ok || !bytes.Equal(pt, plaintext) {
				t.Fatalf("open = %x, %v", pt, ok)
			}
			// A random ephemeral key opens the same way.
			fresh, err := sealNs1(mustRaw(t, v.RecipientKey), ctx, plaintext, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if pt, ok := OpenNs1(secret, ctx, fresh); !ok || !bytes.Equal(pt, plaintext) {
				t.Fatalf("open fresh = %x, %v", pt, ok)
			}
		})
	}
}

func TestParseNs1Strict(t *testing.T) {
	s := func(v string) canon.Value { return canon.String(v) }
	for name, v := range map[string]canon.Value{
		"not an object": s("x"),
		"extra member": canon.Object{
			{Name: "ns1", Value: canon.Object{{Name: "enc", Value: s("a")}, {Name: "ct", Value: s("b")}}},
			{Name: "x", Value: s("y")},
		},
		"inner extra":   canon.Object{{Name: "ns1", Value: canon.Object{{Name: "enc", Value: s("a")}, {Name: "ct", Value: s("b")}, {Name: "x", Value: s("y")}}}},
		"inner missing": canon.Object{{Name: "ns1", Value: canon.Object{{Name: "enc", Value: s("a")}, {Name: "x", Value: s("b")}}}},
		"number":        canon.Object{{Name: "ns1", Value: canon.Object{{Name: "enc", Value: s("a")}, {Name: "ct", Value: canon.Number(1)}}}},
	} {
		if _, ok := ParseNs1(v); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}
