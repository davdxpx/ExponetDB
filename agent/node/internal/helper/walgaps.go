package helper

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
)

// VC-005: pgBackRest's info gives an archive's oldest and newest segment only, and its verify
// reports a hole between two segments only when a backup's own start..stop falls into it. The
// node lists the segment names (repo-ls) and finds the holes itself.

// archivedSegmentRE is one archived WAL segment as pgBackRest stores it: <segment>-<sha1>, with
// an optional compression extension. History, .backup and .partial files do not match.
var archivedSegmentRE = regexp.MustCompile(`(?:^|/)([0-9A-F]{24})-[0-9a-f]{40}(?:\.(?:gz|lz4|zst|bz2))?$`)

// archiveIDRE is a pgBackRest archive id (<major>-<history id>), safe to put into a repository path.
var archiveIDRE = regexp.MustCompile(`^[0-9]{1,3}-[0-9]{1,6}$`)

// archiveSegments reads `pgbackrest repo-ls --output=json --recurse` of an archive id: the
// segment names, sorted. An unreadable listing is an error, never an empty archive.
func archiveSegments(listing []byte) ([]string, error) {
	var entries map[string]struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(listing, &entries); err != nil {
		return nil, err
	}
	var out []string
	for name, e := range entries {
		if e.Type != "file" {
			continue
		}
		if m := archivedSegmentRE.FindStringSubmatch(name); m != nil {
			out = append(out, m[1])
		}
	}
	sort.Strings(out)
	return out, nil
}

// walGapEnds names, per timeline, the first segment present after each run of missing ones.
// shortcut: the segment size is not known here, so only a gap the names show is found: a jump
// within one log, or a next log that does not start at segment 0. A segment missing at the end
// of a log (before the wrap) is not found; reading wal_segment_size from the cluster would.
func walGapEnds(segments []string) []string {
	sorted := append([]string(nil), segments...)
	sort.Strings(sorted)
	var ends []string
	for i := 1; i < len(sorted); i++ {
		prev, next := sorted[i-1], sorted[i]
		if prev[:8] != next[:8] {
			continue // another timeline
		}
		pl, ps := hexPart(prev[8:16]), hexPart(prev[16:24])
		nl, ns := hexPart(next[8:16]), hexPart(next[16:24])
		continuous := (nl == pl && ns == ps+1) || (nl == pl+1 && ns == 0)
		if !continuous {
			ends = append(ends, next)
		}
	}
	return ends
}

func hexPart(s string) uint64 {
	v, _ := strconv.ParseUint(s, 16, 64)
	return v
}
