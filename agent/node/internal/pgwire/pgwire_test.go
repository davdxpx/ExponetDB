package pgwire

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// fakeServer answers one startup with the given authentication request.
func fakeServer(t *testing.T, auth uint32, extra []byte) Options {
	t.Helper()
	dir := t.TempDir()
	l, err := net.Listen("unix", filepath.Join(dir, ".s.PGSQL.5432"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var n [4]byte
		if _, err := io.ReadFull(c, n[:]); err != nil {
			return
		}
		_, _ = io.CopyN(io.Discard, c, int64(binary.BigEndian.Uint32(n[:])-4))
		body := binary.BigEndian.AppendUint32(nil, auth)
		_, _ = c.Write(message('R', append(body, extra...)))
		time.Sleep(100 * time.Millisecond)
	}()
	return Options{SocketDirectory: dir, Port: 5432, User: "exponetdb_node", Database: "postgres"}
}

func TestPasswordAuthenticationIsRefused(t *testing.T) {
	for _, auth := range []uint32{3, 5, 10} { // cleartext, MD5, SASL
		o := fakeServer(t, auth, []byte{0, 0, 0, 0})
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, err := Connect(ctx, o)
		cancel()
		if !errors.Is(err, ErrAuthentication) {
			t.Fatalf("auth %d: %v", auth, err)
		}
	}
}

func TestOversizedMessageIsRefused(t *testing.T) {
	dir := t.TempDir()
	l, err := net.Listen("unix", filepath.Join(dir, ".s.PGSQL.5432"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = c.Write([]byte{'R', 0x7f, 0xff, 0xff, 0xff})
		time.Sleep(100 * time.Millisecond)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := Connect(ctx, Options{SocketDirectory: dir, Port: 5432, User: "u", Database: "d"}); err == nil {
		t.Fatal("an oversized message was accepted")
	}
}

func TestDataRowBounds(t *testing.T) {
	if _, err := dataRow([]byte{0, 1, 0, 0, 0, 9, 'a'}); err == nil {
		t.Fatal("a value beyond the row was accepted")
	}
	vals, err := dataRow([]byte{0, 2, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 1, 'x'})
	if err != nil || vals[0] != nil || vals[1] == nil || *vals[1] != "x" {
		t.Fatalf("%v %v", vals, err)
	}
	if _, err := encodeArg("a\x00b"); err == nil {
		t.Fatal("a NUL argument was accepted")
	}
}
