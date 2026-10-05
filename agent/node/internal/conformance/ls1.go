package conformance

import (
	"slices"
	"strings"
	"unicode/utf8"
)

// ls1 refusal codes (ledger.md §3), in the order the checks run.
const (
	CodeInvalidMigrationID   = "invalid_migration_id"
	CodeInvalidChecksum      = "invalid_checksum"
	CodeDuplicateMigrationID = "duplicate_migration_id"
	CodeInvalidBaselineID    = "invalid_baseline_id"
)

const ls1Prefix = "sha256:ls1:"

// LedgerRow is one row of exponetdb.schema_migrations as ls1 sees it.
type LedgerRow struct {
	MigrationID string
	Checksum    string
	// Reverted is reverted_at IS NOT NULL.
	Reverted bool
}

// LedgerStateHash computes the ls1 ledger state hash (ledger.md §3). rows are
// all ledger rows of every origin (bundles, legacy imports, the baseline row);
// baselineID is ledger_meta.baseline_id, nil for NULL. It returns the exact
// hash input and the value "sha256:ls1:<hex>".
//
// The hash input is one line "migration_id SP checksum SP state LF" per row,
// sorted by migration_id in UTF-8 byte order, with state A (applied) or R
// (reverted), followed by "baseline SP <baseline_id or -> LF".
//
// Checks run in this order and the first failure is the result: each row's
// migration_id then checksum, in input order (invalid_migration_id,
// invalid_checksum); duplicate ids (duplicate_migration_id); the baseline id
// (invalid_baseline_id).
func LedgerStateHash(rows []LedgerRow, baselineID *string) (hashInput []byte, hash string, err error) {
	for i, row := range rows {
		if !isLedgerToken(row.MigrationID) {
			return nil, "", refuse(CodeInvalidMigrationID, "row %d: migration_id %q is empty or contains a space, control character or DEL", i, row.MigrationID)
		}
		if !isLedgerToken(row.Checksum) {
			return nil, "", refuse(CodeInvalidChecksum, "row %d: checksum %q is empty or contains a space, control character or DEL", i, row.Checksum)
		}
	}
	sorted := slices.Clone(rows)
	// Go compares strings byte by byte, which for UTF-8 is code point order.
	slices.SortStableFunc(sorted, func(a, b LedgerRow) int {
		return strings.Compare(a.MigrationID, b.MigrationID)
	})
	for i := 1; i < len(sorted); i++ {
		if sorted[i].MigrationID == sorted[i-1].MigrationID {
			return nil, "", refuse(CodeDuplicateMigrationID, "migration_id %q occurs more than once", sorted[i].MigrationID)
		}
	}
	baseline := "-"
	if baselineID != nil {
		if !isBaselineID(*baselineID) {
			return nil, "", refuse(CodeInvalidBaselineID, "baseline id %q is not baseline:<slug>", *baselineID)
		}
		baseline = *baselineID
	}

	var b strings.Builder
	for _, row := range sorted {
		state := "A"
		if row.Reverted {
			state = "R"
		}
		b.WriteString(row.MigrationID)
		b.WriteByte(' ')
		b.WriteString(row.Checksum)
		b.WriteByte(' ')
		b.WriteString(state)
		b.WriteByte('\n')
	}
	b.WriteString("baseline ")
	b.WriteString(baseline)
	b.WriteByte('\n')
	hashInput = []byte(b.String())
	return hashInput, ls1Prefix + sha256Hex(hashInput), nil
}

// isLedgerToken reports whether s is non-empty valid UTF-8 without any code
// point up to U+0020 and without U+007F, so that the space and line
// separators of the hash input cannot occur inside it.
func isLedgerToken(s string) bool {
	if s == "" || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c <= 0x20 || c == 0x7F {
			return false
		}
	}
	return true
}

// isBaselineID reports whether s is "baseline:<slug>".
//
// The specification names the form baseline:<slug> without defining the slug
// grammar for baselines. This implementation uses the only slug grammar of
// the migration documents, the bundle name slug of migration-bundles.md §1:
// kebab-case [a-z0-9]+(-[a-z0-9]+)* of at most 64 characters.
func isBaselineID(s string) bool {
	slug, ok := strings.CutPrefix(s, "baseline:")
	return ok && isKebabSlug(slug, 64)
}

// isKebabSlug reports whether s matches [a-z0-9]+(-[a-z0-9]+)* and has at
// most maxLen characters.
func isKebabSlug(s string, maxLen int) bool {
	if s == "" || len(s) > maxLen {
		return false
	}
	prevHyphen := true // a slug cannot start with a hyphen
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			prevHyphen = false
		case c == '-' && !prevHyphen:
			prevHyphen = true
		default:
			return false
		}
	}
	return !prevHyphen // nor end with one
}
