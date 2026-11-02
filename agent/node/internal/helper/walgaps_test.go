package helper

import (
	"reflect"
	"testing"
)

// VC-005: pgBackRest reports only the archive's min and max, and its verify does not report a
// segment missing between them; the node lists the segment names itself.
func TestArchiveSegmentsFromRepoLs(t *testing.T) {
	listing := []byte(`{".":{"type":"path"},"17-1":{"type":"path"},"17-1/0000000100000000":{"type":"path"},` +
		`"17-1/0000000100000000/000000010000000000000001-4d0710b693080a03e3ae61e5a5368443c6f5ba15.gz":{"type":"file","size":1,"time":1},` +
		`"17-1/0000000100000000/000000010000000000000002.00000028.backup":{"type":"file","size":1,"time":1},` +
		`"17-1/0000000100000000/000000010000000000000003-006681bf78bdf2b9e94cb274b9baf748f7c1a1a3.zst":{"type":"file","size":1,"time":1},` +
		`"17-1/00000002.history":{"type":"file","size":1,"time":1},` +
		`"17-1/0000000100000000/000000010000000000000004.partial-e70f178f7b0532e1970d2a7f7fe8c277754dcb48.gz":{"type":"file","size":1,"time":1},` +
		`"archive.info":{"type":"file","size":1,"time":1}}`)
	got, err := archiveSegments(listing)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"000000010000000000000001", "000000010000000000000003"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("segments %v, want %v", got, want)
	}
	if _, err := archiveSegments([]byte(`not json`)); err == nil {
		t.Fatal("an unreadable listing must be an error, never an empty archive")
	}
}

func TestWalGapEnds(t *testing.T) {
	for _, c := range []struct {
		name     string
		segments []string
		want     []string
	}{
		{"continuous", []string{"000000010000000000000001", "000000010000000000000002", "000000010000000000000003"}, nil},
		{"a hole in one log", []string{"000000010000000000000001", "000000010000000000000003"}, []string{"000000010000000000000003"}},
		{"two holes, unsorted input", []string{"000000010000000000000009", "000000010000000000000001", "000000010000000000000005", "000000010000000000000006"},
			[]string{"000000010000000000000005", "000000010000000000000009"}},
		{"next log at segment 0 is continuous", []string{"0000000100000000000000FF", "000000010000000100000000"}, nil},
		{"next log not at 0", []string{"0000000100000000000000FF", "000000010000000100000002"}, []string{"000000010000000100000002"}},
		{"a whole log skipped", []string{"000000010000000000000010", "000000010000000200000000"}, []string{"000000010000000200000000"}},
		{"timelines are apart", []string{"000000010000000000000004", "000000020000000000000005", "000000020000000000000006"}, nil},
	} {
		if got := walGapEnds(c.segments); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: gap ends %v, want %v", c.name, got, c.want)
		}
	}
}
