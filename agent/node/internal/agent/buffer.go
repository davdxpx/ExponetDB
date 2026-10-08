package agent

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

// Buffer keeps signed completions until the gateway acknowledges them
// (architecture.md §3): each is written durably before the first delivery
// attempt, so a result survives a crash or an unreachable gateway. A
// completion the gateway refuses for good is parked for the local operator.
// A job has at most one stored completion: Put never replaces one, pending
// or parked (protocol.md §4.2, one statement per job).
type Buffer struct {
	mu  sync.Mutex
	dir string
}

const (
	pendingSuffix = ".json"
	parkedSuffix  = ".refused"
	maxCompletion = 1024 * 1024
)

func (b *Buffer) path(jobID, suffix string) (string, error) {
	if !nodecrypto.IsID("job", jobID) {
		return "", errors.New("buffer: not a job id")
	}
	return filepath.Join(b.dir, jobID+suffix), nil
}

// ErrStored: the job already has a stored completion; nothing was written.
var ErrStored = errors.New("buffer: the job already has a stored completion")

// Put stores a signed completion durably, once.
func (b *Buffer) Put(jobID string, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return err
	}
	parked, _ := b.path(jobID, parkedSuffix)
	if _, err := os.Lstat(parked); err == nil {
		return ErrStored
	}
	if err := fsutil.WriteOnce(p, data, 0o600); err != nil {
		if errors.Is(err, fsutil.ErrExists) {
			return ErrStored
		}
		return err
	}
	return nil
}

// Has reports whether a completion of the job is pending delivery.
func (b *Buffer) Has(jobID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return false
	}
	_, err = os.Lstat(p)
	return err == nil
}

// Get reads a stored completion that is pending delivery.
func (b *Buffer) Get(jobID string) ([]byte, error) {
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return nil, err
	}
	return fsutil.ReadLimited(p, maxCompletion)
}

// Stored reads the job's stored completion, pending or parked: a parked
// statement still is the job's one statement. ok is false when the buffer
// holds none (err tells whether it could not be read).
func (b *Buffer) Stored(jobID string) (data []byte, parked, ok bool, err error) {
	for _, suffix := range []string{pendingSuffix, parkedSuffix} {
		p, perr := b.path(jobID, suffix)
		if perr != nil {
			return nil, false, false, perr
		}
		data, err := fsutil.ReadLimited(p, maxCompletion)
		switch {
		case err == nil:
			return data, suffix == parkedSuffix, true, nil
		case !errors.Is(err, os.ErrNotExist):
			return nil, false, false, err
		}
	}
	return nil, false, false, nil
}

// Holds reports whether the buffer holds a completion of the job, pending or
// parked.
func (b *Buffer) Holds(jobID string) bool {
	for _, suffix := range []string{pendingSuffix, parkedSuffix} {
		p, err := b.path(jobID, suffix)
		if err != nil {
			return false
		}
		if _, err := os.Lstat(p); err == nil {
			return true
		}
	}
	return false
}

// Remove drops a delivered completion.
func (b *Buffer) Remove(jobID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return fsutil.SyncDir(b.dir)
}

// Park keeps a completion the gateway refused for good, out of delivery.
func (b *Buffer) Park(jobID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	from, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return err
	}
	to, _ := b.path(jobID, parkedSuffix)
	if err := os.Rename(from, to); err != nil {
		return err
	}
	return fsutil.SyncDir(b.dir)
}

// Pending lists buffered completions in job id order.
func (b *Buffer) Pending() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), pendingSuffix)
		if ok && nodecrypto.IsID("job", id) {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// Len is the number of pending completions.
func (b *Buffer) Len() int { return len(b.Pending()) }

// ExportsClassified names the buffer's marker (capabilities.md §6, Wave 5
// correction F1): every statement the buffer holds was signed by a release
// that classifies what it exports. Enrollment creates it before anything is
// stored; an agent that finds a buffer without it (a node enrolled by an
// earlier release) parks what that release left before anything is sent.
const ExportsClassified = "exports-classified"

// MarkClassified creates the marker in dir durably; one that exists is kept.
func MarkClassified(dir string) error {
	err := fsutil.WriteOnce(filepath.Join(dir, ExportsClassified), []byte("1\n"), 0o600)
	if errors.Is(err, fsutil.ErrExists) {
		return nil
	}
	return err
}

// Classified reports whether the buffer holds the marker.
func (b *Buffer) Classified() (bool, error) {
	_, err := os.Lstat(filepath.Join(b.dir, ExportsClassified))
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	}
	return false, err
}
