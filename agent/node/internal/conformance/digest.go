package conformance

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// Hash-input headers of N6. Each is followed by LF in the hash input.
const (
	applyChecksumHeader  = "exponetdb/migration-checksum/c1"
	verifyDigestHeader   = "exponetdb/verify-digest/c1"
	rollbackDigestHeader = "exponetdb/rollback-digest/c1"
	bundleDigestHeader   = "exponetdb/bundle-digest/c1"

	c1DigestPrefix     = "sha256:c1:"
	sourceDigestPrefix = "sha256:"
)

// Frame returns frame(label, b) of N6: UTF8(label) LF decimal(len(b)) LF b LF,
// where len counts bytes and the decimal has no leading zeros ("0" for an
// empty b).
func Frame(label string, b []byte) []byte {
	out := make([]byte, 0, len(label)+len(b)+24)
	return appendFrame(out, label, b)
}

func appendFrame(dst []byte, label string, b []byte) []byte {
	dst = append(dst, label...)
	dst = append(dst, '\n')
	dst = strconv.AppendInt(dst, int64(len(b)), 10)
	dst = append(dst, '\n')
	dst = append(dst, b...)
	return append(dst, '\n')
}

// appendFileFrames appends F(name) of N6: frame(name, X(file)) for a present
// file, and frame(name, "") followed by frame(name + ":absent", "") for an
// absent one, so that an empty file and no file differ.
func appendFileFrames(dst []byte, name string, text []byte, present bool) []byte {
	if present {
		return appendFrame(dst, name, text)
	}
	dst = appendFrame(dst, name, nil)
	return appendFrame(dst, name+":absent", nil)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func header(h string) []byte {
	return append([]byte(h), '\n')
}

// ApplyChecksum returns the apply checksum "sha256:c1:<hex>" over the JCS
// text of the apply projection P and the executable text of up.sql.
func ApplyChecksum(applyProjection, upText []byte) string {
	in := header(applyChecksumHeader)
	in = appendFrame(in, "manifest", applyProjection)
	in = appendFrame(in, "up.sql", upText)
	return c1DigestPrefix + sha256Hex(in)
}

// VerifyDigest returns the verify digest "sha256:c1:<hex>" over the JCS text
// of the verify projection V and F("verify.sql").
func VerifyDigest(verifyProjection, verifyText []byte, present bool) string {
	in := header(verifyDigestHeader)
	in = appendFrame(in, "manifest", verifyProjection)
	in = appendFileFrames(in, "verify.sql", verifyText, present)
	return c1DigestPrefix + sha256Hex(in)
}

// RollbackDigest returns the rollback digest "sha256:c1:<hex>" over the JCS
// text of the rollback projection R and F("down.sql").
func RollbackDigest(rollbackProjection, downText []byte, present bool) string {
	in := header(rollbackDigestHeader)
	in = appendFrame(in, "manifest", rollbackProjection)
	in = appendFileFrames(in, "down.sql", downText, present)
	return c1DigestPrefix + sha256Hex(in)
}

// BundleDigest returns the bundle digest "sha256:c1:<hex>" over the three
// digest values, framed as ASCII text.
func BundleDigest(checksum, verifyDigest, rollbackDigest string) string {
	in := header(bundleDigestHeader)
	in = appendFrame(in, "checksum", []byte(checksum))
	in = appendFrame(in, "verifyDigest", []byte(verifyDigest))
	in = appendFrame(in, "rollbackDigest", []byte(rollbackDigest))
	return c1DigestPrefix + sha256Hex(in)
}

// SourceDigest returns "sha256:<hex>" over the bytes of up.sql after N1 and
// N2 (see NormalizeSource). It carries no c1 tag.
func SourceDigest(normalizedUp []byte) string {
	return sourceDigestPrefix + sha256Hex(normalizedUp)
}
