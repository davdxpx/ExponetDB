package journal

import (
	"errors"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// NonceWindow is how long the cache remembers a nonce (protocol.md §4.2
// step 4); it outlives every job window (at most 60 minutes).
const NonceWindow = 7 * 24 * time.Hour

const kindNonce = "nonce"

// Nonces is the nonce cache: a second, independent record of accepted
// envelopes, in case the journal were lost.
type Nonces struct {
	mu    sync.Mutex
	chain *chain
	seen  map[string]canon.Object
	at    map[string]time.Time
	now   func() time.Time
}

// OpenNonces opens the nonce cache in dir.
func OpenNonces(dir string, now func() time.Time) (*Nonces, error) {
	n := &Nonces{seen: map[string]canon.Object{}, at: map[string]time.Time{}, now: now}
	c, err := openChain(filepath.Join(dir, "nonces.log"), n.replay, false)
	if err != nil {
		return nil, err
	}
	n.chain = c
	return n, nil
}

func (n *Nonces) replay(r canon.Object) error {
	at, err := time.Parse(time.RFC3339Nano, member(r, "at"))
	nonce := member(r, "nonce")
	if member(r, "kind") != kindNonce || err != nil || nonce == "" || member(r, "jobId") == "" {
		return errors.New("not a nonce record")
	}
	if _, dup := n.seen[nonce]; dup {
		return errors.New("nonce recorded twice")
	}
	n.seen[nonce], n.at[nonce] = r, at
	return nil
}

// Err reports a broken cache (journal_corrupt).
func (n *Nonces) Err() error { return n.chain.err() }

// Seen reports whether the nonce is remembered. A nonce is forgotten only by
// compaction, never by reading the host clock.
func (n *Nonces) Seen(nonce string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	_, ok := n.at[nonce]
	return ok
}

// Record remembers the nonce of an accepted job durably.
func (n *Nonces) Record(nonce, jobID string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, dup := n.seen[nonce]; dup {
		return errors.New("journal: nonce already recorded")
	}
	at := n.now().UTC()
	written, err := n.chain.append(canon.Object{
		{Name: "kind", Value: canon.String(kindNonce)},
		{Name: "nonce", Value: canon.String(nonce)},
		{Name: "jobId", Value: canon.String(jobID)},
		{Name: "at", Value: canon.String(at.Format(time.RFC3339Nano))},
	})
	if err != nil {
		return err
	}
	n.seen[nonce], n.at[nonce] = written, at
	return nil
}

// Len is the number of remembered nonces.
func (n *Nonces) Len() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.seen)
}

// Bytes is the cache file's size.
func (n *Nonces) Bytes() int64 {
	n.chain.mu.Lock()
	defer n.chain.mu.Unlock()
	return n.chain.size
}

// Compact drops nonces recorded before the cutoff (see Cutoff, with
// NonceWindow).
func (n *Nonces) Compact(highestIssuedAt time.Time) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	cutoff := Cutoff(n.now(), highestIssuedAt, NonceWindow)
	var keep []canon.Object
	nonces := make([]string, 0, len(n.seen))
	for nonce, at := range n.at {
		if !at.Before(cutoff) {
			nonces = append(nonces, nonce)
		}
	}
	sort.Slice(nonces, func(a, b int) bool { return n.at[nonces[a]].Before(n.at[nonces[b]]) })
	for _, nonce := range nonces {
		keep = append(keep, n.seen[nonce])
	}
	if err := n.chain.rewrite(keep, n.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	path := n.chain.path
	if err := n.chain.close(); err != nil {
		return err
	}
	n.seen, n.at = map[string]canon.Object{}, map[string]time.Time{}
	c, err := openChain(path, n.replay, false)
	if err != nil {
		return err
	}
	n.chain = c
	return nil
}

// Close closes the cache file.
func (n *Nonces) Close() error { return n.chain.close() }
