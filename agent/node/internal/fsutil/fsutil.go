// Package fsutil holds the agent's file primitives: atomic, durable writes
// (temporary file, fsync, rename, fsync of the directory), size-limited reads
// and ownership and permission checks. Nothing here follows a caller-chosen
// path outside the agent's own directories.
package fsutil

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// ErrTooLarge is returned by ReadLimited for a file above the limit.
var ErrTooLarge = errors.New("file too large")

// WriteAtomic replaces path with data durably: the data is written to a new
// file in the same directory, synced, renamed over path, and the directory is
// synced, so a crash leaves either the old or the new content, never a mix.
func WriteAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() {
		if name != "" {
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	name = ""
	return SyncDir(dir)
}

// ErrExists: WriteOnce found the file already there; it was not changed.
var ErrExists = errors.New("fsutil: the file already exists")

// WriteOnce writes data durably to a new file at path and refuses to replace
// an existing one (link(2) of a synced temporary file: either the complete
// content appears under path or nothing does).
func WriteOnce(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Link(name, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return ErrExists
		}
		return err
	}
	if FaultHook != nil {
		if err := FaultHook("after-link", path); err != nil {
			return err
		}
	}
	return SyncDir(dir)
}

// FaultHook, when set (tests only; nil in every build that runs on a host),
// fails a write at a named step after it happened: "after-link" is a
// WriteOnce whose file is in place but whose directory sync failed.
var FaultHook func(step, path string) error

// SyncDir fsyncs a directory so that a rename or a new entry in it is durable.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// ReadLimited reads a regular file of at most max bytes. A symbolic link at
// path is refused (O_NOFOLLOW), and so is anything that is not a regular file.
func ReadLimited(path string, max int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, ErrTooLarge
	}
	return data, nil
}

// Owner describes who must own a file or directory.
type Owner struct {
	// UID is the required owner.
	UID int
	// OtherReadable relaxes the mode check: a checked path is never writable
	// by group or others, and unless OtherReadable not readable by others.
	OtherReadable bool
}

// CheckOwnedPrivate refuses path unless it is owned by o.UID, is not a
// symbolic link, and is not writable by group or others (and, unless
// o.OtherReadable, not readable by others).
func CheckOwnedPrivate(path string, o Owner) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link", path)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: no ownership information", path)
	}
	if int(st.Uid) != o.UID {
		return fmt.Errorf("%s is owned by uid %d, not %d", path, st.Uid, o.UID)
	}
	mode := info.Mode().Perm()
	if mode&0o022 != 0 {
		return fmt.Errorf("%s is writable by group or others (%04o)", path, mode)
	}
	if !o.OtherReadable && mode&0o004 != 0 {
		return fmt.Errorf("%s is readable by others (%04o)", path, mode)
	}
	return nil
}

// CheckParent checks the directory of a root-owned file: owned by ownerUID
// or root, not a symbolic link, not writable by group or others, so no one
// else can replace the file under it.
func CheckParent(path string, ownerUID int) error {
	dir := filepath.Dir(path)
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if int(st.Uid) != ownerUID && st.Uid != 0 {
		return fmt.Errorf("%s is owned by uid %d", dir, st.Uid)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s is writable by group or others", dir)
	}
	return nil
}
