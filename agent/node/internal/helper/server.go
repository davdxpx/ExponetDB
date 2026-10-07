package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
)

// Server accepts the agent's connections on the helper socket.
type Server struct {
	Helper *Helper
	// AgentUID is the only caller uid accepted (SO_PEERCRED).
	AgentUID int
	// Log receives one line per refused connection or failed request; it
	// never carries request content.
	Log func(format string, args ...any)
}

const (
	ioTimeout   = 10 * time.Second
	maxParallel = 4
)

// PeerUID reads the uid of the process on the other end of a Unix socket.
func PeerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, credErr
	}
	return int(cred.Uid), nil
}

// Serve accepts connections until ctx ends, then waits for the requests in
// flight: a stop never interrupts an operation (its own timeout bounds it).
func (s *Server) Serve(ctx context.Context, l *net.UnixListener) error {
	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()
	var inFlight sync.WaitGroup
	defer inFlight.Wait()
	slots := make(chan struct{}, maxParallel)
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		slots <- struct{}{}
		inFlight.Add(1)
		go func() {
			defer func() { <-slots; inFlight.Done() }()
			s.serveConn(context.WithoutCancel(ctx), c)
		}()
	}
}

func (s *Server) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log(format, args...)
	}
}

// serveConn answers one request. Another uid is refused before anything is
// read; the connection is then closed without an answer.
func (s *Server) serveConn(ctx context.Context, c *net.UnixConn) {
	defer c.Close()
	uid, err := PeerUID(c)
	if err != nil {
		s.logf("helper: refused a connection whose peer cannot be read")
		return
	}
	if uid != s.AgentUID {
		s.logf("helper: refused a connection from uid %d", uid)
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(ioTimeout))
	data, err := helperproto.ReadFrame(c)
	if err != nil {
		s.logf("helper: unreadable request")
		return
	}
	ctx, cancel := context.WithTimeout(ctx, maxTimeout)
	defer cancel()
	resp := s.Helper.Handle(ctx, data)
	if resp.Error != nil {
		s.logf("helper: refused (%s)", resp.Error.Code)
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = c.SetWriteDeadline(time.Now().Add(ioTimeout))
	_ = helperproto.WriteFrame(c, out)
}

// SystemdListener returns the socket systemd passed (LISTEN_FDS, fd 3), or
// nil when the helper was not socket-activated.
func SystemdListener() (*net.UnixListener, error) {
	if os.Getenv("LISTEN_PID") != strconv.Itoa(os.Getpid()) {
		return nil, nil
	}
	if os.Getenv("LISTEN_FDS") != "1" {
		return nil, errors.New("helper: systemd passed more or fewer than one socket")
	}
	_ = os.Unsetenv("LISTEN_PID")
	_ = os.Unsetenv("LISTEN_FDS")
	_ = os.Unsetenv("LISTEN_FDNAMES")
	syscall.CloseOnExec(3)
	f := os.NewFile(3, "helper.socket")
	l, err := net.FileListener(f)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	ul, ok := l.(*net.UnixListener)
	if !ok {
		_ = l.Close()
		return nil, errors.New("helper: the systemd socket is not a Unix stream socket")
	}
	return ul, nil
}

// Listen creates the socket at path (removing a stale socket, never another
// kind of file), mode 0660, group gid. The socket's directory must belong to
// ownerUID (root) and be writable by nobody else: in it no one can swap the
// path between the bind and the group change (Phase 4 review). The mode
// comes from the umask at bind, the group is changed without following a
// link. Production uses systemd socket activation (packaging, Phase 6).
func Listen(path string, gid, ownerUID int) (*net.UnixListener, error) {
	dir := filepath.Dir(path)
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(st.Uid) != ownerUID || info.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("helper: %s must be a directory of uid %d that no one else can write", dir, ownerUID)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("helper: the socket path exists and is not a socket")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	old := syscall.Umask(0o117)
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Lchown(path, -1, gid); err != nil {
		_ = l.Close()
		return nil, err
	}
	return l, nil
}
