package conformance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/davdxpx/exponetdb/agent/node/internal/canon"
)

type planVector struct {
	ID          string          `json:"id"`
	Description string          `json:"description"`
	Plan        json.RawMessage `json:"plan"`
	Expected    *struct {
		Canonical string `json:"canonical"`
		PlanHash  string `json:"planHash"`
	} `json:"expected"`
	ExpectedError string `json:"expectedError"`
}

func TestGoldenPlanHash(t *testing.T) {
	vectors := loadVectors[planVector](t, "plan-hash.json")
	ids := make([]string, len(vectors))
	for i, v := range vectors {
		ids[i] = v.ID
	}
	checkUniqueIDs(t, ids)
	for _, v := range vectors {
		t.Run(v.ID, func(t *testing.T) {
			if (v.Expected == nil) == (v.ExpectedError == "") {
				t.Fatal("vector must have exactly one of expected and expectedError")
			}
			if v.Plan == nil {
				t.Fatal("vector has no plan")
			}
			// The plan goes through canon.Parse as raw JSON, so that numbers
			// such as -0.0 and 1e+21 are read as doubles by this module.
			plan, err := canon.Parse(v.Plan)
			if err != nil {
				t.Fatalf("plan: %v", err)
			}
			canonical, hash, err := PlanHash(plan)
			if v.ExpectedError != "" {
				if code := errorCode(err); code != v.ExpectedError {
					t.Fatalf("got %q, %v; want error %s", hash, err, v.ExpectedError)
				}
				return
			}
			sum := sha256.Sum256([]byte(v.Expected.Canonical))
			if "sha256:"+hex.EncodeToString(sum[:]) != v.Expected.PlanHash {
				t.Fatalf("vector inconsistent: hash of canonical is %x, vector says %s", sum, v.Expected.PlanHash)
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(canonical) != v.Expected.Canonical {
				t.Fatalf("canonical mismatch\n got: %s\nwant: %s", canonical, v.Expected.Canonical)
			}
			if hash != v.Expected.PlanHash {
				t.Fatalf("plan hash mismatch: got %s, want %s", hash, v.Expected.PlanHash)
			}
		})
	}
	t.Logf("plan-hash.json: %d vectors", len(vectors))
}

func TestPlanHashRefusalOrder(t *testing.T) {
	// unknown_member wins over missing_member, which wins over invalid_plan_id.
	cases := []struct {
		json, code string
	}{
		{`{"id":"x","state":"active"}`, CodeUnknownMember},
		{`{"id":"x"}`, CodeMissingMember},
		{`[]`, CodeInvalidPlan},
		{`{"id":1,"kind":"k","kindVersion":1,"createdAt":"","expiresAt":"","actor":{},"client":{},"subject":{},"content":{},"contentChecksum":"","policy":{}}`, CodeInvalidPlanID},
		{`{"id":"pln_01JB2ZB3M5P7R9T1V3X5Z7B9D1 ","kind":"k","kindVersion":1,"createdAt":"","expiresAt":"","actor":{},"client":{},"subject":{},"content":{},"contentChecksum":"","policy":{}}`, CodeInvalidPlanID},
	}
	for _, c := range cases {
		v, err := canon.Parse([]byte(c.json))
		if err != nil {
			t.Fatalf("%s: %v", c.json, err)
		}
		if _, _, err := PlanHash(v); errorCode(err) != c.code {
			t.Errorf("%s: got %v, want %s", c.json, err, c.code)
		}
	}
}
