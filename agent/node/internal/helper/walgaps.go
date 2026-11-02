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

// listingMaxOutput bounds an archive listing: about 100 bytes per segment, so some 600,000
// segments (about 10 TiB of WAL at 16 MiB) before the listing fails (VC-005 review).
const listingMaxOutput = 64 << 20

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
// A log holds a power of two of segments (4 GiB over the segment size); the node takes the
// smallest power of two above the highest segment number listed, so a log's missing last
// segment is found once any log of the archive shows its full length (VC-005 review).
// shortcut: an archive whose every log lacks its upper half reads as having half the segment
// count; reading wal_segment_size from the cluster would close that.
func walGapEnds(segments []string) []string {
	sorted := append([]string(nil), segments...)
	sort.Strings(sorted)
	highest := uint64(0)
	for _, s := range sorted {
		highest = max(highest, hexPart(s[16:24]))
	}
	perLog := uint64(1)
	for perLog <= highest {
		perLog <<= 1
	}
	var ends []string
	for i := 1; i < len(sorted); i++ {
		prev, next := sorted[i-1], sorted[i]
		if prev[:8] != next[:8] {
			continue // another timeline
		}
		pl, ps := hexPart(prev[8:16]), hexPart(prev[16:24])
		nl, ns := hexPart(next[8:16]), hexPart(next[16:24])
		continuous := (nl == pl && ns == ps+1) || (nl == pl+1 && ns == 0 && ps+1 == perLog)
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
