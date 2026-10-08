package nodecrypto

import "github.com/davdxpx/ExponetDB/agent/node/internal/canon"

// ResultContext is what binds a node result signature (nr1, protocol.md §7.5)
// to one job.
type ResultContext struct {
	InstallationID string
	NodeID         string
	JobID          string
	ArgsHash       string
}

// UnsignedCompletion is the completion request without "nodeSignature".
func UnsignedCompletion(complete canon.Object) canon.Object {
	out := make(canon.Object, 0, len(complete))
	for _, m := range complete {
		if m.Name != "nodeSignature" {
			out = append(out, m)
		}
	}
	return out
}

// ResultSigningValue is the object nr1 signs.
func ResultSigningValue(c ResultContext, complete canon.Object) canon.Object {
	return canon.Object{
		{Name: "purpose", Value: canon.String("exponetdb/node-result/nr1")},
		{Name: "installationId", Value: canon.String(c.InstallationID)},
		{Name: "nodeId", Value: canon.String(c.NodeID)},
		{Name: "jobId", Value: canon.String(c.JobID)},
		{Name: "argsHash", Value: canon.String(c.ArgsHash)},
		{Name: "complete", Value: UnsignedCompletion(complete)},
	}
}

// SignResult signs a completion with the node signing key (its seed).
func SignResult(seed []byte, c ResultContext, complete canon.Object) (string, error) {
	return SignCanonical(seed, ResultSigningValue(c, complete))
}

// VerifyResult verifies nr1 against the node's bound signing key.
func VerifyResult(nodeSigningKey []byte, c ResultContext, complete canon.Object, signature string) bool {
	return VerifyCanonical(nodeSigningKey, ResultSigningValue(c, complete), signature)
}
