// Package journal is the agent's durable memory of jobs (architecture.md §4,
// protocol.md §4.4, ADR-0024 §4): an append-only, hash-chained job journal and
// a separate nonce cache. Every record is synced to disk before the agent acts
// on it. A file that fails its chain check makes every later job fail with
// journal_corrupt until a local operator repairs it; nothing runs on a guess.
package journal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"syscall"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
)

// ErrCorrupt: a journal or nonce cache failed its integrity check, or a write
// to it failed; every job is refused (journal_corrupt).
var ErrCorrupt = errors.New("journal_corrupt")

const (
	maxRecordBytes = 64 * 1024
	maxFileBytes   = 64 * 1024 * 1024
	genesis        = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	kindCheckpoint = "checkpoint"
)

// chain is one append-only file of canonical JSON lines. Each record carries
// seq (1, 2, ...), prev (the previous record's hash; the genesis value or a
// checkpoint for the first) and hash (sha256 over the record's JCS without
// hash).
type chain struct {
	mu     sync.Mutex
	path   string
	f      *os.File
	seq    int64
	last   string
	size   int64
	broken error
}

func recordHash(withoutHash canon.Object) (string, error) {
	b, err := canon.Canonicalize(withoutHash)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func without(o canon.Object, name string) canon.Object {
	out := make(canon.Object, 0, len(o))
	for _, m := range o {
		if m.Name != name {
			out = append(out, m)
		}
	}
	return out
}

func member(o canon.Object, name string) string {
	v, _ := o.Get(name)
	s, _ := v.(canon.String)
	return string(s)
}

// openChain opens or creates path and replays it through visit. A final line
// without its newline is a write the crash interrupted before it was synced
// (nothing was acknowledged for it); it is cut off. Any other damage is
// ErrCorrupt.
func openChain(path string, visit func(canon.Object) error) (*chain, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	c := &chain{path: path, f: f, last: genesis}
	if err := c.replay(visit); err != nil {
		_ = f.Close()
		return nil, err
	}
	return c, nil
}

func (c *chain) replay(visit func(canon.Object) error) error {
	info, err := c.f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maxFileBytes {
		return fmt.Errorf("%w: %s is larger than %d bytes", ErrCorrupt, c.path, maxFileBytes)
	}
	data, err := io.ReadAll(io.NewSectionReader(c.f, 0, info.Size()))
	if err != nil {
		return err
	}
	if cut := bytes.LastIndexByte(data, '\n') + 1; cut < len(data) {
		// A torn final write: cut it off durably before appending anything.
		if err := c.f.Truncate(int64(cut)); err != nil {
			return err
		}
		if err := c.f.Sync(); err != nil {
			return err
		}
		data = data[:cut]
	}
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		line := data[:end]
		data = data[end+1:]
		record, err := c.check(line)
		if err != nil {
			return fmt.Errorf("%w: %s record %d: %v", ErrCorrupt, c.path, c.seq+1, err)
		}
		if member(record, "kind") != kindCheckpoint {
			if err := visit(record); err != nil {
				return fmt.Errorf("%w: %s record %d: %v", ErrCorrupt, c.path, c.seq, err)
			}
		}
	}
	c.size = info.Size()
	if _, err := c.f.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	return nil
}

// check validates one line against the chain and advances it.
func (c *chain) check(line []byte) (canon.Object, error) {
	if len(line) > maxRecordBytes {
		return nil, errors.New("record too large")
	}
	v, err := canon.Parse(line)
	if err != nil {
		return nil, err
	}
	record, ok := v.(canon.Object)
	if !ok {
		return nil, errors.New("not an object")
	}
	canonical, err := canon.Canonicalize(record)
	if err != nil || !bytes.Equal(canonical, line) {
		return nil, errors.New("not canonical")
	}
	want, err := recordHash(without(record, "hash"))
	if err != nil || member(record, "hash") != want {
		return nil, errors.New("hash mismatch")
	}
	seqValue, _ := record.Get("seq")
	seq, isNumber := seqValue.(canon.Number)
	if !isNumber || int64(seq) != c.seq+1 || float64(int64(seq)) != float64(seq) {
		return nil, errors.New("sequence gap")
	}
	prev := member(record, "prev")
	if c.seq == 0 && member(record, "kind") == kindCheckpoint {
		// A compacted file starts with a checkpoint that names the hash of
		// the last record it dropped.
		if len(prev) != len(genesis) {
			return nil, errors.New("invalid checkpoint")
		}
	} else if prev != c.last {
		return nil, errors.New("chain broken")
	}
	c.seq = int64(seq)
	c.last = member(record, "hash")
	return record, nil
}

// append writes one record durably and returns it as written. Once a write
// fails the chain is broken for good: its state on disk is unknown.
func (c *chain) append(fields canon.Object) (canon.Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.broken != nil {
		return nil, c.broken
	}
	record := append(canon.Object{
		{Name: "seq", Value: canon.Number(c.seq + 1)},
		{Name: "prev", Value: canon.String(c.last)},
	}, fields...)
	hash, err := recordHash(record)
	if err != nil {
		return nil, err
	}
	record = append(record, canon.Member{Name: "hash", Value: canon.String(hash)})
	line, err := canon.Canonicalize(record)
	if err != nil {
		return nil, err
	}
	if len(line) > maxRecordBytes || c.size+int64(len(line))+1 > maxFileBytes {
		return nil, errors.New("journal record or file too large")
	}
	if _, err := c.f.Write(append(line, '\n')); err != nil {
		c.broken = fmt.Errorf("%w: write: %v", ErrCorrupt, err)
		return nil, c.broken
	}
	if err := c.f.Sync(); err != nil {
		c.broken = fmt.Errorf("%w: sync: %v", ErrCorrupt, err)
		return nil, c.broken
	}
	c.seq++
	c.last = hash
	c.size += int64(len(line)) + 1
	return record, nil
}

// rewrite replaces the file with a checkpoint followed by the kept records,
// re-chained, atomically.
func (c *chain) rewrite(keep []canon.Object, at string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.broken != nil {
		return c.broken
	}
	var buf bytes.Buffer
	seq, last := int64(0), c.last
	add := func(fields canon.Object, prev string) error {
		seq++
		record := append(canon.Object{
			{Name: "seq", Value: canon.Number(seq)},
			{Name: "prev", Value: canon.String(prev)},
		}, fields...)
		hash, err := recordHash(record)
		if err != nil {
			return err
		}
		line, err := canon.Canonicalize(append(record, canon.Member{Name: "hash", Value: canon.String(hash)}))
		if err != nil {
			return err
		}
		buf.Write(line)
		buf.WriteByte('\n')
		last = hash
		return nil
	}
	if err := add(canon.Object{
		{Name: "kind", Value: canon.String(kindCheckpoint)},
		{Name: "at", Value: canon.String(at)},
		{Name: "droppedThrough", Value: canon.String(strconv.FormatInt(c.seq, 10))},
	}, c.last); err != nil {
		return err
	}
	for _, r := range keep {
		fields := without(without(without(r, "hash"), "prev"), "seq")
		if err := add(fields, last); err != nil {
			return err
		}
	}
	if err := fsutil.WriteAtomic(c.path, buf.Bytes(), 0o600); err != nil {
		c.broken = fmt.Errorf("%w: compaction: %v", ErrCorrupt, err)
		return c.broken
	}
	f, err := os.OpenFile(c.path, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		c.broken = fmt.Errorf("%w: reopen: %v", ErrCorrupt, err)
		return c.broken
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		_ = f.Close()
		return err
	}
	_ = c.f.Close()
	c.f, c.seq, c.last, c.size = f, seq, last, int64(buf.Len())
	return nil
}

func (c *chain) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.f.Close()
}

func (c *chain) err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.broken
}
