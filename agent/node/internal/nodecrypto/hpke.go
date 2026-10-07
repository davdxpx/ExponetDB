package nodecrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
)

// HPKE (RFC 9180), base mode, single shot, for DHKEM(X25519, HKDF-SHA256)
// and HKDF-SHA256 with AES-GCM: only what ns1 needs (no PSK, auth or export
// modes; sequence number 0). Written from the RFC and checked against its
// test vectors (A.1.1). The Go 1.24 standard library has no HPKE.

const (
	kemX25519   = 0x0020
	kdfSHA256   = 0x0001
	aesGCM128   = 0x0001
	aesGCM256   = 0x0002
	nSecret     = 32
	nNonce      = 12
	nTag        = 16
	x25519Bytes = 32
)

type hpkeAEAD struct {
	id uint16
	nk int
}

var (
	aead128 = hpkeAEAD{id: aesGCM128, nk: 16}
	aead256 = hpkeAEAD{id: aesGCM256, nk: 32}
)

func i2osp2(n int) []byte {
	return binary.BigEndian.AppendUint16(nil, uint16(n))
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func extract(salt, ikm []byte) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	mac := hmac.New(sha256.New, salt)
	mac.Write(ikm)
	return mac.Sum(nil)
}

func expand(prk, info []byte, length int) []byte {
	var out, previous []byte
	for i := byte(1); len(out) < length; i++ {
		mac := hmac.New(sha256.New, prk)
		mac.Write(concat(previous, info, []byte{i}))
		previous = mac.Sum(nil)
		out = append(out, previous...)
	}
	return out[:length]
}

var hpkeV1 = []byte("HPKE-v1")

func labeledExtract(suite, salt []byte, label string, ikm []byte) []byte {
	return extract(salt, concat(hpkeV1, suite, []byte(label), ikm))
}

func labeledExpand(suite, prk []byte, label string, info []byte, length int) []byte {
	return expand(prk, concat(i2osp2(length), hpkeV1, suite, []byte(label), info), length)
}

var kemSuite = concat([]byte("KEM"), i2osp2(kemX25519))

func sharedSecret(dh, enc, pkR []byte) []byte {
	eaePRK := labeledExtract(kemSuite, nil, "eae_prk", dh)
	return labeledExpand(kemSuite, eaePRK, "shared_secret", concat(enc, pkR), nSecret)
}

type hpkeContext struct {
	key, nonce []byte
}

func keySchedule(a hpkeAEAD, shared, info []byte) hpkeContext {
	suite := concat([]byte("HPKE"), i2osp2(kemX25519), i2osp2(kdfSHA256), i2osp2(int(a.id)))
	pskIDHash := labeledExtract(suite, nil, "psk_id_hash", nil)
	infoHash := labeledExtract(suite, nil, "info_hash", info)
	context := concat([]byte{0}, pskIDHash, infoHash)
	secret := labeledExtract(suite, shared, "secret", nil)
	return hpkeContext{
		key:   labeledExpand(suite, secret, "key", context, a.nk),
		nonce: labeledExpand(suite, secret, "base_nonce", context, nNonce),
	}
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// hpkeTrace exposes the intermediate values of RFC 9180 §5 to tests.
type hpkeTrace struct {
	sharedSecret, key, baseNonce []byte
}

// hpkeSeal seals pt to the raw X25519 public key pkR. The ephemeral key is
// drawn at random unless a test passes ephemeralSecret.
func hpkeSeal(pkR, info, aad, pt []byte, a hpkeAEAD, ephemeralSecret []byte, trace *hpkeTrace) (enc, ct []byte, err error) {
	curve := ecdh.X25519()
	recipient, err := curve.NewPublicKey(pkR)
	if err != nil {
		return nil, nil, err
	}
	var skE *ecdh.PrivateKey
	if ephemeralSecret == nil {
		skE, err = curve.GenerateKey(rand.Reader)
	} else {
		skE, err = curve.NewPrivateKey(ephemeralSecret)
	}
	if err != nil {
		return nil, nil, err
	}
	dh, err := skE.ECDH(recipient)
	if err != nil {
		return nil, nil, err
	}
	enc = skE.PublicKey().Bytes()
	shared := sharedSecret(dh, enc, pkR)
	ctx := keySchedule(a, shared, info)
	if trace != nil {
		*trace = hpkeTrace{sharedSecret: shared, key: ctx.key, baseNonce: ctx.nonce}
	}
	aead, err := gcm(ctx.key)
	if err != nil {
		return nil, nil, err
	}
	return enc, aead.Seal(nil, ctx.nonce, pt, aad), nil
}

// hpkeOpen opens a sealed value with the recipient's raw X25519 secret; ok is
// false when it does not open.
func hpkeOpen(skR, info, aad, enc, ct []byte, a hpkeAEAD) (pt []byte, ok bool) {
	if len(enc) != x25519Bytes || len(ct) < nTag {
		return nil, false
	}
	curve := ecdh.X25519()
	recipient, err := curve.NewPrivateKey(skR)
	if err != nil {
		return nil, false
	}
	ephemeral, err := curve.NewPublicKey(enc)
	if err != nil {
		return nil, false
	}
	dh, err := recipient.ECDH(ephemeral)
	if err != nil {
		return nil, false
	}
	ctx := keySchedule(a, sharedSecret(dh, enc, recipient.PublicKey().Bytes()), info)
	aead, err := gcm(ctx.key)
	if err != nil {
		return nil, false
	}
	pt, err = aead.Open(nil, ctx.nonce, ct, aad)
	if err != nil {
		return nil, false
	}
	return pt, true
}
