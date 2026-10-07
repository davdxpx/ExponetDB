package nodecrypto

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// fixture reads one node protocol fixture as a canonical JSON object.
func fixture(t *testing.T, name string) canon.Object {
	t.Helper()
	dir := filepath.Join(filepath.Dir(goldenDir(t)), "fixtures", "node-protocol")
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	v, err := canon.Parse(data)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	o, ok := v.(canon.Object)
	if !ok {
		t.Fatalf("%s: not an object", name)
	}
	return o
}

func str(t *testing.T, o canon.Object, name string) string {
	t.Helper()
	s, ok := stringMember(o, name)
	if !ok {
		t.Fatalf("member %s is not a string", name)
	}
	return s
}

// TestFixtureProofs verifies, independently of the TypeScript contract tests,
// the proofs that the enroll and renew fixtures carry and the nr1 signature
// of every job completion fixture.
func TestFixtureProofs(t *testing.T) {
	enroll := fixture(t, "EnrollRequest.json")
	tokenID, tlsKey, nsk := str(t, enroll, "tokenId"), str(t, enroll, "tlsKey"), str(t, enroll, "nodeSigningKey")
	if !VerifyCanonical(mustRaw(t, tlsKey), TLSKeyProofValue(tokenID, tlsKey), str(t, enroll, "tlsKeyProof")) {
		t.Error("enroll tlsKeyProof")
	}
	if !VerifyCanonical(mustRaw(t, nsk), NodeSigningKeyProofValue(tokenID, nsk), str(t, enroll, "nodeSigningKeyProof")) {
		t.Error("enroll nodeSigningKeyProof")
	}
	renew := fixture(t, "RenewRequest.json")
	nodeID, newKey := str(t, renew, "nodeId"), str(t, renew, "tlsKey")
	if !VerifyCanonical(mustRaw(t, newKey), RenewTLSKeyProofValue(nodeID, newKey), str(t, renew, "tlsKeyProof")) {
		t.Error("renew tlsKeyProof")
	}
	if !VerifyCanonical(mustRaw(t, nsk), RenewSignatureValue(nodeID, newKey), str(t, renew, "nodeSignature")) {
		t.Error("renew nodeSignature")
	}

	installationID := str(t, fixture(t, "EnrollResponse.json"), "installationId")
	argsHash := str(t, fixture(t, "JobEnvelope.json"), "argsHash")
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(goldenDir(t)), "fixtures", "node-protocol"))
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "JobCompleteRequest.") {
			continue
		}
		complete := fixture(t, e.Name())
		raw, _ := complete.Get("nodeSignature")
		signature, ok := raw.(canon.Object)
		if !ok || str(t, signature, "alg") != "Ed25519" {
			t.Fatalf("%s: nodeSignature", e.Name())
		}
		ctx := ResultContext{
			InstallationID: installationID,
			NodeID:         str(t, complete, "nodeId"),
			JobID:          str(t, complete, "jobId"),
			ArgsHash:       argsHash,
		}
		if !VerifyResult(mustRaw(t, nsk), ctx, complete, str(t, signature, "value")) {
			t.Errorf("%s: nr1 does not verify", e.Name())
		}
		checked++
	}
	if checked < 3 {
		t.Fatalf("only %d completion fixtures", checked)
	}
}
