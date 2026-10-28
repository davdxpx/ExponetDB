// labctl (test campaign only): signs one job with the lab key and sends it to the
// helper socket as the calling uid; prints {"result":...} or {"error":{...}}.
//   labctl trust PATH                      write the helper trust for the lab key
//   labctl call SOCKET OP [ARGS.json|-]  [-node ID] [-op OPERATION_ID] [-jobid ID]
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperclient"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

const (
	installation = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	defNode      = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	defOperation = "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	keyID        = "jobkey_lab_01"
	crock        = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
)

var seed = bytes.Repeat([]byte{9}, 32)

func ulid() string {
	b := make([]byte, 26)
	_, _ = rand.Read(b)
	out := make([]byte, 26)
	out[0] = crock[b[0]%8]
	for i := 1; i < 26; i++ {
		out[i] = crock[b[i]%32]
	}
	return string(out)
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: labctl trust PATH | call SOCKET OP [ARGS|-] [-node ID] [-op ID] [-jobid ID]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "trust":
		pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
		err := helper.SaveTrust(os.Args[2], &helper.Trust{Schema: helper.TrustSchema, InstallationID: installation, NodeID: defNode,
			JobKeys: []state.JobKey{{KeyID: keyID, PublicKey: nodecrypto.B64U(pub)}}})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "call":
		call()
	}
}

func call() {
	sock, op := os.Args[2], os.Args[3]
	argsFile := "-"
	node, operation, jobID := defNode, defOperation, "job_"+ulid()
	rest := os.Args[4:]
	for i := 0; i < len(rest); i++ {
		switch rest[i] {
		case "-node":
			i++
			node = rest[i]
		case "-op":
			i++
			operation = rest[i]
		case "-jobid":
			i++
			jobID = rest[i]
		default:
			argsFile = rest[i]
		}
	}
	var raw []byte
	var err error
	if argsFile == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(argsFile)
	}
	if err != nil {
		panic(err)
	}
	args, err := canon.Parse(raw)
	if err != nil {
		panic(err)
	}
	capab := helper.Capability(op)
	if capab == "" {
		panic("unknown op " + op)
	}
	name, major, _ := strings.Cut(capab, "@")
	_ = major
	b, _ := canon.Canonicalize(args)
	sum := sha256.Sum256(b)
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	now := time.Now().UTC().Truncate(time.Second)
	envelope := canon.Object{
		{Name: "jobId", Value: canon.String(jobID)},
		{Name: "operationId", Value: canon.String(operation)},
		{Name: "nodeId", Value: canon.String(node)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String(name)}, {Name: "major", Value: canon.Number(1)}}},
		{Name: "args", Value: args},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(now.Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(now.Add(15 * time.Minute).Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nodecrypto.B64U(nonce))},
		{Name: "issuedAt", Value: canon.String(now.Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	signed, err := nodecrypto.SignJobEnvelope(envelope, keyID, seed)
	if err != nil {
		panic(err)
	}
	c := helperclient.Client{Socket: sock}
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Minute)
	defer cancel()
	res, err := c.Call(ctx, op, signed)
	out := map[string]any{"jobId": jobID}
	if err != nil {
		if eb, ok := err.(*helperproto.ErrorBody); ok {
			out["error"] = map[string]string{"code": eb.Code, "message": eb.Message}
		} else {
			out["error"] = map[string]string{"code": "CLIENT", "message": err.Error()}
		}
	} else {
		rb, _ := canon.Canonicalize(res)
		out["result"] = json.RawMessage(rb)
	}
	j, _ := json.Marshal(out)
	fmt.Println(string(j))
	if out["error"] != nil {
		os.Exit(3)
	}
}
