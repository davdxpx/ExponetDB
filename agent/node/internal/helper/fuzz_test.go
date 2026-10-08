package helper

import (
	"context"
	"encoding/json"
	"testing"
	"time"
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
			restarts := 0
			for _, c := range e.runner.calls {
				if len(c.Args) > 0 && c.Args[0] == "restart" {
					restarts++
				}
			}
			if restarts > 1 {
				t.Fatal("an effect ran twice")
			}
		}
	})
}
