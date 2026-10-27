package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// FuzzHandle: any request bytes give exactly one of a result and a refusal,
// never a panic, and no job ever has two effects other than write and
// restore.
func FuzzHandle(f *testing.F) {
	e := newEnv(f)
	for _, op := range []string{OpServiceStatus, OpServiceRestart, OpHbaWrite} {
		name := map[string]string{OpServiceStatus: "service.status", OpServiceRestart: "postgres.restart", OpHbaWrite: "postgres.hba.apply"}[op]
		args := restartArgs()
		if op == OpServiceStatus {
			args = nil
		}
		req, _ := json.Marshal(Request{V: Version, Op: op, Job: e.job(name, args)})
		f.Add(req)
	}
	f.Add([]byte(`{"v":"exponetdb.helper/v1","op":"hba.restore","job":{}}`))
	// Wave 9 Part B: the run operations.
	for op, args := range map[string]canon.Object{
		OpBackupRun: runArgs(runA, "full", pgbrRepo()),
		OpRunStatus: {{Name: "runId", Value: canon.String(runA)}, {Name: "startJobId", Value: canon.String("job_01M60000000000000000000003")},
			{Name: "startArgsHash", Value: canon.String("sha256:" + strings.Repeat("a", 64))}},
		OpRestoreDiscard: {{Name: "runId", Value: canon.String(runA)}},
	} {
		req, _ := json.Marshal(Request{V: Version, Op: op, Job: e.job(op, args)})
		f.Add(req)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		resp := e.h.Handle(ctx, data)
		if (resp.Error == nil) == (resp.Result == nil) || resp.V != Version {
			t.Fatalf("malformed response %+v", resp)
		}
		var req Request
		if resp.Result != nil && json.Unmarshal(data, &req) == nil && operations[req.Op].effect {
			// The fuzzer cannot sign: an effect needs the seed's own envelope.
			restarts, starts := 0, 0
			for _, c := range e.runner.calls {
				if len(c.Args) > 0 && c.Args[0] == "restart" {
					restarts++
				}
				if c.Path == SystemdRun {
					starts++
				}
			}
			if restarts > 1 || starts > 0 {
				t.Fatal("an effect ran twice")
			}
		}
	})
}

// FuzzPairRecord: any bytes in the TLS installation record's place are
// either exactly a record the helper writes (they encode back to the same
// bytes and validate) or refused; never a panic, never a guess.
func FuzzPairRecord(f *testing.F) {
	digest := "sha256:" + strings.Repeat("ab", 32)
	r := pairRecord{
		Schema: pairRecordSchema, State: pairPrepared, JobID: "job_01JB2Z6G8M4Q7R9T1V3W5X7Y01", Cluster: "17/main",
		Key: pairFile{Path: "/etc/postgresql/17/main/server.key", Existed: true,
			Previous: &pairVersion{Digest: digest, UID: 102, GID: 104, Mode: "0600"},
			New:      pairVersion{Digest: digest, UID: 102, GID: 104, Mode: "0600"}},
		Certificate: pairFile{Path: "/etc/postgresql/17/main/server.crt",
			New: pairVersion{Digest: digest, UID: 102, GID: 104, Mode: "0644"}},
	}
	for _, state := range []string{pairPrepared, pairCommitted, pairRestored} {
		r.State = state
		data, err := r.encode()
		if err != nil {
			f.Fatal(err)
		}
		if _, err := decodePairRecord(data); err != nil {
			f.Fatal(err)
		}
		f.Add(data)
	}
	f.Add([]byte("{}\n"))
	f.Add([]byte(""))
	f.Fuzz(func(t *testing.T, data []byte) {
		rec, err := decodePairRecord(data)
		if err != nil {
			return
		}
		again, err := rec.encode()
		if err != nil || !bytes.Equal(again, data) {
			t.Fatalf("accepted %q, which encodes as %q (%v)", data, again, err)
		}
	})
}
