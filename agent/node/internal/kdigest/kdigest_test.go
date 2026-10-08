package kdigest

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfIsKeyedAndPurposeBound(t *testing.T) {
	k1, k2 := bytes.Repeat([]byte{1}, KeySize), bytes.Repeat([]byte{2}, KeySize)
	a, err := Of(k1, "exponetdb/test/v1", []byte("primary_conninfo=password=x"))
	if err != nil || !strings.HasPrefix(a, Prefix) || len(a) != len(Prefix)+64 {
		t.Fatalf("%q %v", a, err)
	}
	same, _ := Of(k1, "exponetdb/test/v1", []byte("primary_conninfo=password=x"))
	other, _ := Of(k2, "exponetdb/test/v1", []byte("primary_conninfo=password=x"))
	purpose, _ := Of(k1, "exponetdb/other/v1", []byte("primary_conninfo=password=x"))
	changed, _ := Of(k1, "exponetdb/test/v1", []byte("primary_conninfo=password=y"))
	if a != same || a == other || a == purpose || a == changed {
		t.Fatal("kd1 is not keyed, purpose-bound and content-sensitive")
	}
	if _, err := Of(nil, "exponetdb/test/v1", nil); err != ErrNoKey {
		t.Fatalf("no key: %v", err)
	}
}

func TestAgentKeyIsDerivedNotTheSecret(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, 32)
	k, err := AgentKey(secret)
	if err != nil || len(k) != KeySize || bytes.Equal(k, secret) {
		t.Fatalf("%x %v", k, err)
	}
	again, _ := AgentKey(secret)
	if !bytes.Equal(k, again) {
		t.Fatal("the derivation is not deterministic")
	}
	if _, err := AgentKey(secret[:31]); err != ErrNoKey {
		t.Fatal("a short secret was accepted")
	}
}

func TestHelperKeyIsCreatedOnceAndChecked(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "digest.key")
	k1, err := LoadOrCreateHelperKey(path, os.Geteuid())
	if err != nil || len(k1) != KeySize {
		t.Fatal(err)
	}
	k2, err := LoadOrCreateHelperKey(path, os.Geteuid())
	if err != nil || !bytes.Equal(k1, k2) {
		t.Fatal("the key changed on a second load")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateHelperKey(path, os.Geteuid()); err == nil {
		t.Fatal("a key readable by others was accepted")
	}
	_ = os.Chmod(path, 0o600)
	if err := os.WriteFile(path, []byte("garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateHelperKey(path, os.Geteuid()); err == nil {
		t.Fatal("a damaged key was accepted (or replaced)")
	}
	link := filepath.Join(dir, "link.key")
	_ = os.Symlink(path, link)
	if _, err := LoadOrCreateHelperKey(link, os.Geteuid()); err == nil {
		t.Fatal("a symlink was followed")
	}
}
