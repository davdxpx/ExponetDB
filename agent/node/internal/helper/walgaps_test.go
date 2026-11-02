package helper

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// continuousListing is a repo-ls listing of archive id's segments from..to on timeline 1, log 0.
func continuousListing(id string, from, to int) string {
	var b strings.Builder
	b.WriteString("{")
	for n := from; n <= to; n++ {
		if n > from {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"%s/0000000100000000/0000000100000000%08X-%040x.gz":{"type":"file","size":1,"time":1}`, id, n, n)
	}
	b.WriteString("}")
	return b.String()
}

// logSegments names the segments lo..hi of one log on timeline 1.
func logSegments(log, lo, hi int) []string {
	var out []string
	for n := lo; n <= hi; n++ {
		out = append(out, fmt.Sprintf("00000001%08X%08X", log, n))
	}
	return out
}

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

// VC-005 review: a log's last segment missing was never found (one deletion in 256). The number
// of segments per log is a power of two, the smallest one above the highest segment number listed.
func TestWalGapEndsSeesTheEndOfALog(t *testing.T) {
	full := append(append(logSegments(0, 0, 0xFF), logSegments(1, 0, 0xFF)...), logSegments(2, 0, 0)...)
	if got := walGapEnds(full); got != nil {
		t.Fatalf("complete logs: %v", got)
	}
	cut := append(append(logSegments(0, 0, 0xFF), logSegments(1, 0, 0xFE)...), logSegments(2, 0, 0)...)
	if got, want := walGapEnds(cut), []string{"000000010000000200000000"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missing last segment of log 1: %v, want %v", got, want)
	}
}

// VC-005 review: with more holes than reported, the newest are the ones a newer backup needs.
func TestTheNewestGapEndsAreReported(t *testing.T) {
	s, err := parsePgbrInfo([]byte(pgbrInfoFixture(sysid)), "main")
	if err != nil {
		t.Fatal(err)
	}
	var ends []string
	for n := 1; n <= 70; n++ {
		ends = append(ends, fmt.Sprintf("0000000100000000%08X", 2*n))
	}
	r := pgbrListResult(s, "2.60.0", map[string][]string{"17-1": ends})
	av, _ := r.Get("archive")
	first, _ := av.(canon.Array)[0].(canon.Object).Get("gapEnds")
	listed := first.(canon.Array)
	if tv, _ := r.Get("truncated"); len(listed) != 64 || listed[0] != canon.String(ends[6]) ||
		listed[63] != canon.String(ends[69]) || tv != canon.Bool(true) {
		t.Fatalf("gap ends %v (truncated %v)", listed, tv)
	}
}

// The cap a command names replaces the default one (the archive listing, VC-005 review).
func TestCappedOutputTakesTheCommandsLimit(t *testing.T) {
	big := make([]byte, maxOutput+1)
	if _, err := (&capped{}).Write(big); err == nil {
		t.Fatal("the default cap did not hold")
	}
	if _, err := (&capped{limit: 2 * maxOutput}).Write(big); err != nil {
		t.Fatal(err)
	}
}
