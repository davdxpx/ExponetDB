// Package kdigest is the node's keyed digest kd1 (capabilities.md §6, Wave 5
// correction F1): HMAC-SHA-256 under a key that never leaves the node, over a
// purpose label and the content. Two digests of one purpose from one node
// are equal exactly when the contents are; nobody without the key can test a
// guessed content against a digest, so a digest may cover a value the node
// withholds (a password in pg_hba.conf, a token in a setting) without
// exporting a way to confirm it.
//
// Two keys exist, each held by the component that checks its digests: the
// agent's, derived from its node encryption secret (AgentKey), and the root
// helper's, a random key in its own state directory (LoadOrCreateHelperKey).
package kdigest

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Prefix marks a kd1 digest.
const Prefix = "kd1:"

// KeySize is the size of a digest key.
const KeySize = 32

// ErrNoKey: the component has no digest key; it exports no digest (fail closed).
var ErrNoKey = errors.New("kdigest: no digest key")

// Of returns kd1:hex(HMAC-SHA-256(key, purpose || 0x00 || content)).
func Of(key []byte, purpose string, content []byte) (string, error) {
	if len(key) != KeySize {
		return "", ErrNoKey
	}
	if purpose == "" || strings.ContainsRune(purpose, 0) {
		return "", errors.New("kdigest: invalid purpose")
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(purpose))
	m.Write([]byte{0})
	m.Write(content)
	return Prefix + hex.EncodeToString(m.Sum(nil)), nil
}

// agentKeyInfo labels the agent's digest key (HKDF info).
const agentKeyInfo = "exponetdb/node-digest-key/v1"

// AgentKey derives the agent's digest key from its node encryption secret
// (HKDF-SHA-256, empty salt): a key of its own purpose, never stored, that
// never leaves the host because the secret never does.
func AgentKey(nodeEncryptionSecret []byte) ([]byte, error) {
	if len(nodeEncryptionSecret) != 32 {
		return nil, ErrNoKey
	}
	return hkdf.Key(sha256.New, nodeEncryptionSecret, nil, agentKeyInfo, KeySize)
}

// helperKeyHeader opens the root helper's key file (format version 1).
const helperKeyHeader = "exponetdb.helper-digest-key/v1\n"

// LoadOrCreateHelperKey reads the root helper's digest key from path, a
// regular file of root (uid owner) with mode 0600 and exactly the v1 format;
// a missing file is created once, durably (the file and its directory are
// synced). Losing the key only changes every digest the helper exports, so
// every plan bound to one is stale: nothing is ever judged on a guess.
func LoadOrCreateHelperKey(path string, owner int) ([]byte, error) {
	key, err := loadHelperKey(path, owner)
	if !errors.Is(err, os.ErrNotExist) {
		return key, err
	}
	key = make([]byte, KeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	data := []byte(helperKeyHeader + hex.EncodeToString(key) + "\n")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return loadHelperKey(path, owner)
		}
		return nil, err
	}
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return nil, err
	}
	return loadHelperKey(path, owner)
}

func loadHelperKey(path string, owner int) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || int(st.Uid) != owner || st.Mode&0o077 != 0 {
		return nil, fmt.Errorf("kdigest: %s is not a private regular file of uid %d", path, owner)
	}
	buf := make([]byte, len(helperKeyHeader)+2*KeySize+2)
	n, _ := f.Read(buf)
	data := string(buf[:n])
	body, ok := strings.CutPrefix(data, helperKeyHeader)
	body, nl := strings.CutSuffix(body, "\n")
	key, err := hex.DecodeString(body)
	if !ok || !nl || err != nil || len(key) != KeySize {
		return nil, fmt.Errorf("kdigest: %s is not a v1 digest key", path)
	}
	return key, nil
}
