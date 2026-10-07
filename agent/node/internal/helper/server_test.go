package helper_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperclient"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
)

// startServer serves a helper without trust: what these tests observe is
// the caller check and the framing, never an operation.
func startServer(t *testing.T, agentUID int) (string, *logs) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "helper.sock")
	l, err := helper.Listen(path, os.Getegid())
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode %v", info.Mode())
	}
	lg := &logs{}
	s := &helper.Server{Helper: helper.NewRefusingHelper(t, dir), AgentUID: agentUID, Log: lg.add}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Serve(ctx, l); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return path, lg
}

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) add(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, format)
}

func (l *logs) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

func envelope() canon.Object {
	return canon.Object{{Name: "jobId", Value: canon.String("job_01JB2Z6G8M4Q7R9T1V3W5X7Y01")}}
}

func TestAnotherUIDIsRefusedBeforeReading(t *testing.T) {
	path, lg := startServer(t, os.Geteuid()+1)
	c := &helperclient.Client{Socket: path}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.Call(ctx, helperproto.OpServiceStatus, envelope())
	if !errors.Is(err, helperclient.ErrUnavailable) {
		t.Fatalf("another uid got an answer: %v", err)
	}
	if !strings.Contains(lg.text(), "refused a connection") {
		t.Fatalf("log %q", lg.text())
	}
}

func TestAgentUIDGetsTypedRefusal(t *testing.T) {
	path, _ := startServer(t, os.Geteuid())
	c := &helperclient.Client{Socket: path}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := c.Call(ctx, helperproto.OpServiceStatus, envelope())
	var refusal *helperproto.ErrorBody
	if !errors.As(err, &refusal) || refusal.Code != helperproto.CodeJobInvalid {
		t.Fatalf("answer %v", err)
	}
	// An oversized frame is dropped without an answer.
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], helperproto.MaxMessage+1)
	_, _ = conn.Write(n[:])
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := helperproto.ReadFrame(conn); err == nil {
		t.Fatal("an oversized request was answered")
	}
}

func TestListenRefusesAnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper.sock")
	_ = os.WriteFile(path, []byte("x"), 0o600)
	if _, err := helper.Listen(path, os.Getegid()); err == nil {
		t.Fatal("a regular file was replaced by the socket")
	}
}

func TestFrames(t *testing.T) {
	var b bytes.Buffer
	if err := helperproto.WriteFrame(&b, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	got, err := helperproto.ReadFrame(&b)
	if err != nil || string(got) != `{"a":1}` {
		t.Fatalf("%q %v", got, err)
	}
	if err := helperproto.WriteFrame(&b, make([]byte, helperproto.MaxMessage+1)); err == nil {
		t.Fatal("an oversized frame was written")
	}
}

func FuzzReadFrame(f *testing.F) {
	f.Add([]byte{0, 0, 0, 2, '{', '}'})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := helperproto.ReadFrame(bytes.NewReader(data))
		if err == nil && (len(got) > helperproto.MaxMessage || len(data) < 4+len(got)) {
			t.Fatal("frame bound broken")
		}
	})
}
