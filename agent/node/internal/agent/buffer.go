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

// Put stores a signed completion durably.
func (b *Buffer) Put(jobID string, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(p, data, 0o600)
}

// Get reads a stored completion.
func (b *Buffer) Get(jobID string) ([]byte, error) {
	p, err := b.path(jobID, pendingSuffix)
	if err != nil {
		return nil, err
	}
	return fsutil.ReadLimited(p, maxCompletion)
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
