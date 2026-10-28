package pgfiles

// Block R, tester R3, TC-071 (GAP-09): an empty managed rule list leaves the marker pair behind.
// Copy to agent/node/internal/pgfiles/r3_hba_empty_test.go; `go test -count=1 -run TestR3 -v ./internal/pgfiles`.

import "testing"

func TestR3EmptyManagedRules(t *testing.T) {
	foreign := []byte("# foreign\nlocal all all peer\nhost all all 127.0.0.1/32 scram-sha-256\n")
	withRule, err := RenderHbaBlock([]HbaRule{{Type: "local", Database: []string{"all"}, User: []string{"all"}, Method: "peer"}})
	if err != nil {
		t.Logf("render with a rule: %v (skipped the first splice)", err)
	}
	file, _ := SpliceHba(foreign, withRule)
	empty, err := RenderHbaBlock(nil)
	if err != nil {
		t.Fatal(err)
	}
	after, err := SpliceHba(file, empty)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("block rendered for an empty list: %q", empty)
	t.Logf("file after applying an empty list:\n%s", after)
	if string(after) == string(foreign) {
		t.Logf("RESULT: the file equals the original (markers removed)")
	} else {
		t.Logf("RESULT: the file differs from the original (an empty marker pair stays)")
	}
}
