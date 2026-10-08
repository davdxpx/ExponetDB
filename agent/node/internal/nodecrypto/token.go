package nodecrypto

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// The enrollment token exdbt1 (protocol.md §7.3).
const (
	TokenPrefix      = "exdbt1."
	TokenSecretBytes = 32
	TokenMaxJobKeys  = 3
	tokenMaxLength   = 4096
)

// Token refusal reasons.
const (
	ReasonInvalidFormat  = "invalid_format"
	ReasonNotCanonical   = "not_canonical"
	ReasonInvalidPayload = "invalid_payload"
)

const dnsLabel = `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`

var (
	fingerprintRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	keyIDRE       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	timestampRE   = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
	hostRE        = regexp.MustCompile(`^` + dnsLabel + `(?:\.` + dnsLabel + `)*$`)
	gatewayRE     = regexp.MustCompile(`^https://(` + dnsLabel + `(?:\.` + dnsLabel + `)*)(?::([1-9][0-9]{0,4}))?$`)
)

// tokenMembers are the payload member names, sorted.
var tokenMembers = []string{
	"expiresAt", "gateway", "gatewayServerName", "installationId", "jobKeys",
	"rootFingerprint", "secret", "serverId", "tokenId", "v",
}

// TokenJobKey is a job-signing key the token anchors.
type TokenJobKey struct {
	KeyID       string
	Fingerprint string
}

// EnrollmentToken is a decoded exdbt1 payload.
type EnrollmentToken struct {
	TokenID           string
	InstallationID    string
	ServerID          string
	Gateway           string
	GatewayServerName string
	RootFingerprint   string
	JobKeys           []TokenJobKey
	// Secret is the 32-byte token secret; it never leaves the host and is
	// never stored after enrollment.
	Secret    []byte
	ExpiresAt string
}

// IsDNSName reports whether s is a lowercase DNS name of at most 253 bytes.
func IsDNSName(s string) bool {
	return len(s) >= 1 && len(s) <= 253 && hostRE.MatchString(s)
}

// IsGateway reports whether s is a gateway address as the token carries it:
// https://host[:port] with a lowercase DNS name or IPv4 address, port 1 to
// 65535 and never written as 443.
func IsGateway(s string) bool {
	if len(s) > 270 {
		return false
	}
	m := gatewayRE.FindStringSubmatch(s)
	if m == nil || len(m[1]) > 253 {
		return false
	}
	if m[2] == "" {
		return true
	}
	port, err := strconv.Atoi(m[2])
	return err == nil && port <= 65535 && m[2] != "443"
}

var daysInMonth = [12]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

// IsTimestamp reports whether s is RFC 3339 UTC ("Z", optional fraction of 1
// to 9 digits) naming a real calendar date and time without leap seconds.
func IsTimestamp(s string) bool {
	if !timestampRE.MatchString(s) {
		return false
	}
	num := func(from, to int) int {
		n, _ := strconv.Atoi(s[from:to])
		return n
	}
	year, month, day := num(0, 4), num(5, 7), num(8, 10)
	if month < 1 || month > 12 {
		return false
	}
	days := daysInMonth[month-1]
	if month == 2 && (year%4 == 0 && year%100 != 0 || year%400 == 0) {
		days = 29
	}
	return day >= 1 && day <= days && num(11, 13) <= 23 && num(14, 16) <= 59 && num(17, 19) <= 59
}

func stringMember(o canon.Object, name string) (string, bool) {
	v, _ := o.Get(name)
	s, ok := v.(canon.String)
	return string(s), ok
}

func validPayload(doc canon.Value) (*EnrollmentToken, bool) {
	o, ok := doc.(canon.Object)
	if !ok || len(o) != len(tokenMembers) {
		return nil, false
	}
	names := make([]string, 0, len(o))
	for _, m := range o {
		names = append(names, m.Name)
	}
	slices.Sort(names)
	if !slices.Equal(names, tokenMembers) {
		return nil, false
	}
	v, _ := stringMember(o, "v")
	tokenID, _ := stringMember(o, "tokenId")
	installationID, _ := stringMember(o, "installationId")
	serverID, _ := stringMember(o, "serverId")
	gateway, gatewayOK := stringMember(o, "gateway")
	serverName, serverNameOK := stringMember(o, "gatewayServerName")
	root, rootOK := stringMember(o, "rootFingerprint")
	secretText, secretOK := stringMember(o, "secret")
	expiresAt, expiresOK := stringMember(o, "expiresAt")
	var secret []byte
	if secretOK {
		secret, secretOK = FromB64UOf(secretText, TokenSecretBytes)
	}
	rawKeys, _ := o.Get("jobKeys")
	keys, keysOK := rawKeys.(canon.Array)
	if v != "exdbt1" ||
		!IsID("ent", tokenID) ||
		!IsID("ins", installationID) ||
		!IsID("srv", serverID) ||
		!gatewayOK || !IsGateway(gateway) ||
		!serverNameOK || !IsDNSName(serverName) ||
		!rootOK || !fingerprintRE.MatchString(root) ||
		!secretOK ||
		!expiresOK || !IsTimestamp(expiresAt) ||
		!keysOK || len(keys) < 1 || len(keys) > TokenMaxJobKeys {
		return nil, false
	}
	jobKeys := make([]TokenJobKey, 0, len(keys))
	for _, raw := range keys {
		k, isObject := raw.(canon.Object)
		if !isObject || len(k) != 2 {
			return nil, false
		}
		keyID, idOK := stringMember(k, "keyId")
		fingerprint, fpOK := stringMember(k, "fingerprint")
		if !idOK || !keyIDRE.MatchString(keyID) || !fpOK || !fingerprintRE.MatchString(fingerprint) ||
			slices.ContainsFunc(jobKeys, func(j TokenJobKey) bool { return j.KeyID == keyID }) {
			return nil, false
		}
		jobKeys = append(jobKeys, TokenJobKey{KeyID: keyID, Fingerprint: fingerprint})
	}
	return &EnrollmentToken{
		TokenID:           tokenID,
		InstallationID:    installationID,
		ServerID:          serverID,
		Gateway:           gateway,
		GatewayServerName: serverName,
		RootFingerprint:   root,
		JobKeys:           jobKeys,
		Secret:            secret,
		ExpiresAt:         expiresAt,
	}, true
}

// DecodeToken decodes a token string strictly: the prefix, canonical
// base64url, UTF-8, strict JSON whose bytes are exactly its own JCS form, and
// exactly the documented members. It returns the token or a refusal reason.
func DecodeToken(text string) (*EnrollmentToken, string) {
	if !strings.HasPrefix(text, TokenPrefix) || len(text) > tokenMaxLength {
		return nil, ReasonInvalidFormat
	}
	data, ok := FromB64U(text[len(TokenPrefix):])
	if !ok {
		return nil, ReasonInvalidFormat
	}
	doc, err := canon.Parse(data)
	if err != nil {
		return nil, ReasonInvalidFormat
	}
	canonical, err := canon.Canonicalize(doc)
	if err != nil || string(canonical) != string(data) {
		return nil, ReasonNotCanonical
	}
	token, ok := validPayload(doc)
	if !ok {
		return nil, ReasonInvalidPayload
	}
	return token, ""
}

func (t *EnrollmentToken) payload() canon.Object {
	keys := make(canon.Array, 0, len(t.JobKeys))
	for _, k := range t.JobKeys {
		keys = append(keys, canon.Object{
			{Name: "keyId", Value: canon.String(k.KeyID)},
			{Name: "fingerprint", Value: canon.String(k.Fingerprint)},
		})
	}
	return canon.Object{
		{Name: "v", Value: canon.String("exdbt1")},
		{Name: "tokenId", Value: canon.String(t.TokenID)},
		{Name: "installationId", Value: canon.String(t.InstallationID)},
		{Name: "serverId", Value: canon.String(t.ServerID)},
		{Name: "gateway", Value: canon.String(t.Gateway)},
		{Name: "gatewayServerName", Value: canon.String(t.GatewayServerName)},
		{Name: "rootFingerprint", Value: canon.String(t.RootFingerprint)},
		{Name: "jobKeys", Value: keys},
		{Name: "secret", Value: canon.String(B64U(t.Secret))},
		{Name: "expiresAt", Value: canon.String(t.ExpiresAt)},
	}
}

// EncodeToken returns the token string; it refuses a token that DecodeToken
// would refuse.
func EncodeToken(t *EnrollmentToken) (string, error) {
	payload := t.payload()
	if _, ok := validPayload(payload); !ok {
		return "", errorf("not a valid enrollment token")
	}
	data, err := canon.Canonicalize(payload)
	if err != nil {
		return "", err
	}
	return TokenPrefix + B64U(data), nil
}

func hkdf32(secret []byte, info string) []byte {
	key, err := hkdf.Key(sha256.New, secret, nil, info, 32)
	if err != nil {
		// HKDF-SHA-256 refuses only lengths above 255 * 32 bytes.
		panic(err)
	}
	return key
}

// TokenKeys derives k_redeem and k_bind from a token secret (HKDF-SHA-256,
// empty salt, 32 bytes).
func TokenKeys(secret []byte, tokenID string) (redeem, bind []byte, err error) {
	if len(secret) != TokenSecretBytes {
		return nil, nil, errorf("a token secret is %d bytes", TokenSecretBytes)
	}
	return hkdf32(secret, "exponetdb/enroll/redeem/v1:"+tokenID),
		hkdf32(secret, "exponetdb/enroll/bind/v1:"+tokenID), nil
}

// RedeemHash is "sha256:" + hex(SHA-256(k_redeem)), the only thing the
// gateway keeps of a token.
func RedeemHash(redeemKey []byte) string {
	sum := sha256.Sum256(redeemKey)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// RedeemKeyMatches checks a presented base64url redeem key against the stored
// hash in constant time.
func RedeemKeyMatches(presented, storedHash string) bool {
	key, ok := FromB64UOf(presented, 32)
	if !ok {
		return false
	}
	return SameFingerprint(RedeemHash(key), storedHash)
}

func purposeObject(purpose string, members ...string) canon.Object {
	o := canon.Object{{Name: "purpose", Value: canon.String(purpose)}}
	for i := 0; i+1 < len(members); i += 2 {
		o = append(o, canon.Member{Name: members[i], Value: canon.String(members[i+1])})
	}
	return o
}

// TLSKeyProofValue is what the enrollment proof of possession of the TLS key
// signs.
func TLSKeyProofValue(tokenID, tlsKey string) canon.Object {
	return purposeObject("exponetdb/enroll/tls-pop/v1", "tokenId", tokenID, "tlsKey", tlsKey)
}

// NodeSigningKeyProofValue is what the enrollment proof of possession of the
// node signing key signs.
func NodeSigningKeyProofValue(tokenID, nodeSigningKey string) canon.Object {
	return purposeObject("exponetdb/enroll/nsk-pop/v1", "tokenId", tokenID, "nodeSigningKey", nodeSigningKey)
}

// BindStatement binds the node's keys to the token, the installation and the
// server.
type BindStatement struct {
	InstallationID    string
	ServerID          string
	TokenID           string
	NodeSigningKey    string
	NodeEncryptionKey string
}

// BindValue is the object the binding proof covers.
func BindValue(s BindStatement) canon.Object {
	return purposeObject("exponetdb/enroll/bind/v1",
		"installationId", s.InstallationID,
		"serverId", s.ServerID,
		"tokenId", s.TokenID,
		"nodeSigningKey", s.NodeSigningKey,
		"nodeEncryptionKey", s.NodeEncryptionKey,
	)
}

// BindProof is b64u(HMAC-SHA-256(k_bind, JCS(BindValue(s)))).
func BindProof(bindKey []byte, s BindStatement) (string, error) {
	data, err := canon.Canonicalize(BindValue(s))
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, bindKey)
	mac.Write(data)
	return B64U(mac.Sum(nil)), nil
}

// BindProofMatches is the worker's constant-time check of a binding proof.
func BindProofMatches(bindKey []byte, s BindStatement, proof string) bool {
	expected, err := BindProof(bindKey, s)
	return err == nil && len(expected) == len(proof) &&
		subtle.ConstantTimeCompare([]byte(expected), []byte(proof)) == 1
}

// RenewTLSKeyProofValue is what the renewal proof of possession of the new
// TLS key signs.
func RenewTLSKeyProofValue(nodeID, tlsKey string) canon.Object {
	return purposeObject("exponetdb/renew/tls-pop/v1", "nodeId", nodeID, "tlsKey", tlsKey)
}

// RenewSignatureValue is what the node signing key signs on renewal.
func RenewSignatureValue(nodeID, tlsKey string) canon.Object {
	return purposeObject("exponetdb/renew/v1", "nodeId", nodeID, "tlsKey", tlsKey)
}
