package conformance

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

type ls1Vector struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Entries     []struct {
		MigrationID string `json:"migrationId"`
		Checksum    string `json:"checksum"`
		Reverted    *bool  `json:"reverted"`
	} `json:"entries"`
	BaselineID *string `json:"baselineId"`
	Expected   *struct {
		HashInput       string `json:"hashInput"`
		LedgerStateHash string `json:"ledgerStateHash"`
	} `json:"expected"`
	ExpectedError string `json:"expectedError"`
}

func TestGoldenLS1(t *testing.T) {
	vectors := loadVectors[ls1Vector](t, "ls1.json")
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
			if v.Entries == nil {
				t.Fatal("vector has no entries list")
			}
			rows := make([]LedgerRow, len(v.Entries))
			for i, e := range v.Entries {
				if e.Reverted == nil {
					t.Fatalf("entry %d has no reverted flag", i)
				}
				rows[i] = LedgerRow{MigrationID: e.MigrationID, Checksum: e.Checksum, Reverted: *e.Reverted}
			}
			input, hash, err := LedgerStateHash(rows, v.BaselineID)
			if v.ExpectedError != "" {
				if code := errorCode(err); code != v.ExpectedError {
					t.Fatalf("got %q, %v; want error %s", hash, err, v.ExpectedError)
				}
				return
			}
			sum := sha256.Sum256([]byte(v.Expected.HashInput))
			if "sha256:ls1:"+hex.EncodeToString(sum[:]) != v.Expected.LedgerStateHash {
				t.Fatalf("vector inconsistent: hash of hashInput is %x, vector says %s", sum, v.Expected.LedgerStateHash)
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(input) != v.Expected.HashInput {
				t.Fatalf("hash input mismatch\n got: %q\nwant: %q", input, v.Expected.HashInput)
			}
			if hash != v.Expected.LedgerStateHash {
				t.Fatalf("ledger state hash mismatch: got %s, want %s", hash, v.Expected.LedgerStateHash)
			}
		})
	}
	t.Logf("ls1.json: %d vectors", len(vectors))
}

func TestLedgerStateHashCheckOrder(t *testing.T) {
	bad := "bad id"
	good := "sha256:c1:aa"
	// A row's migration_id is checked before its checksum, rows in input
	// order, before duplicates, before the baseline.
	cases := []struct {
		rows     []LedgerRow
		baseline string
		code     string
	}{
		{[]LedgerRow{{MigrationID: bad, Checksum: ""}}, "x", CodeInvalidMigrationID},
		{[]LedgerRow{{MigrationID: "a", Checksum: ""}, {MigrationID: bad, Checksum: good}}, "x", CodeInvalidChecksum},
		{[]LedgerRow{{MigrationID: "a", Checksum: good}, {MigrationID: "a", Checksum: good}}, "x", CodeDuplicateMigrationID},
		{[]LedgerRow{{MigrationID: "a\x7f", Checksum: good}}, "", CodeInvalidMigrationID},
		{[]LedgerRow{{MigrationID: "a\xff", Checksum: good}}, "", CodeInvalidMigrationID},
		{nil, "baseline:", CodeInvalidBaselineID},
		{nil, "baseline:-a", CodeInvalidBaselineID},
		{nil, "baseline:a-", CodeInvalidBaselineID},
		{nil, "baseline:a--b", CodeInvalidBaselineID},
		{nil, "baseline:a_b", CodeInvalidBaselineID},
	}
	for i, c := range cases {
		var baseline *string
		if c.baseline != "" {
			baseline = &c.baseline
		}
		if _, _, err := LedgerStateHash(c.rows, baseline); errorCode(err) != c.code {
			t.Errorf("case %d: got %v, want %s", i, err, c.code)
		}
	}
	ok := "baseline:0-a1-2026"
	if _, _, err := LedgerStateHash(nil, &ok); err != nil {
		t.Fatalf("%s: %v", ok, err)
	}
}
