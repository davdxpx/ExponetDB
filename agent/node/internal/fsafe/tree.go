package fsafe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// Directory trees for the engine runs (ADR-0037): run and scratch
// directories are created exclusively relative to an open directory, looked
// at without following a symlink and removed without ever following one or
// leaving the directory they were opened from.

// ErrExist: the name exists already.
var ErrExist = errors.New("fsafe: the name exists")

// Kind is what a directory entry is.
type Kind int

// The kinds.
const (
	KindNone Kind = iota
	KindFile
	KindDir
	KindSymlink
	KindOther
)

// Info is a directory entry as lstat(2) sees it.
type Info struct {
	Kind     Kind
	UID, GID int
	Mode     os.FileMode
	Dev      uint64
	Size     int64
}

const atRemoveDir = 0x200

// Lstat describes name without following a symlink; a missing name is
// Info{Kind: KindNone} and no error.
func (d *Dir) Lstat(name string) (Info, error) {
	if err := validName(name); err != nil {
		return Info{}, err
	}
	var st syscall.Stat_t
	if err := lstatat(d.fd, name, &st); err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return Info{Kind: KindNone}, nil
		}
		return Info{}, err
	}
	return infoOf(&st), nil
}

func infoOf(st *syscall.Stat_t) Info {
	kind := KindOther
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		kind = KindFile
	case syscall.S_IFDIR:
		kind = KindDir
	case syscall.S_IFLNK:
		kind = KindSymlink
	}
	return Info{Kind: kind, UID: int(st.Uid), GID: int(st.Gid), Mode: os.FileMode(st.Mode & 0o7777), Dev: uint64(st.Dev), Size: st.Size}
}

// Stat describes the open directory itself.
func (d *Dir) Stat() (Info, error) {
	var st syscall.Stat_t
	if err := syscall.Fstat(d.fd, &st); err != nil {
		return Info{}, err
	}
	return infoOf(&st), nil
}

// Mkdir creates the directory name exclusively with the owner and mode (set
// on the new directory's own descriptor, never by path) and syncs the parent.
func (d *Dir) Mkdir(name string, o Owner) error {
	if err := validName(name); err != nil {
		return err
	}
	if err := syscall.Mkdirat(d.fd, name, 0o700); err != nil {
		if errors.Is(err, syscall.EEXIST) {
			return ErrExist
		}
		return err
	}
	sub, err := d.OpenDir(name)
	if err != nil {
		return err
	}
	defer sub.Close()
	if err := syscall.Fchown(sub.fd, o.UID, o.GID); err != nil {
		return err
	}
	if err := syscall.Fchmod(sub.fd, uint32(o.Mode&0o777)); err != nil {
		return err
	}
	return d.syncFor(name)
}

// OpenDir opens the subdirectory name of d without following a symlink.
func (d *Dir) OpenDir(name string) (*Dir, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(d.fd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, ErrNotExist
		}
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
			return nil, fmt.Errorf("fsafe: %s/%s is a symlink or not a directory", d.path, name)
		}
		return nil, err
	}
	return &Dir{fd: fd, path: d.path + "/" + name}, nil
}

// Names lists every entry name of the directory (any kind).
func (d *Dir) Names() ([]string, error) {
	dup, err := syscall.Dup(d.fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dup), d.path)
	defer f.Close()
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	return f.Readdirnames(-1)
}

// ErrOtherFilesystem: a directory of the tree lies on another file system
// (a mount point); nothing below it is removed.
var ErrOtherFilesystem = errors.New("fsafe: the tree crosses a mount point")

// maxDepth bounds the removal's recursion.
const maxDepth = 128

// RemoveAll removes name and, when it is a directory, everything below it:
// every entry is opened relative to its parent's descriptor with
// O_NOFOLLOW, a symlink is removed as a link (never followed), a directory
// on another file system is refused, and nothing outside name is touched.
// It reports whether name existed. ctx is checked between entries: a
// removal stopped by it leaves part of the tree, and a later call finishes.
func (d *Dir) RemoveAll(ctx context.Context, name string) (bool, error) {
	info, err := d.Lstat(name)
	if err != nil {
		return false, err
	}
	if info.Kind == KindNone {
		return false, nil
	}
	self, err := d.Stat()
	if err != nil {
		return true, err
	}
	if err := d.removeEntry(ctx, name, info, self.Dev, 0); err != nil {
		return true, err
	}
	return true, d.syncFor(name)
}

func (d *Dir) removeEntry(ctx context.Context, name string, info Info, dev uint64, depth int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if info.Kind != KindDir {
		if err := syscall.Unlinkat(d.fd, name); err != nil && !errors.Is(err, syscall.ENOENT) {
			return err
		}
		return nil
	}
	if info.Dev != dev {
		return ErrOtherFilesystem
	}
	if depth >= maxDepth {
		return fmt.Errorf("fsafe: %s/%s is nested deeper than %d", d.path, name, maxDepth)
	}
	sub, err := d.OpenDir(name)
	if err != nil {
		return err
	}
	names, err := sub.Names()
	if err == nil {
		for _, n := range names {
			var ci Info
			if ci, err = sub.Lstat(n); err != nil {
				break
			}
			if err = sub.removeEntry(ctx, n, ci, dev, depth+1); err != nil {
				break
			}
		}
	}
	_ = sub.Close()
	if err != nil {
		return err
	}
	return unlinkatFlags(d.fd, name, atRemoveDir)
}

func unlinkatFlags(dirfd int, name string, flags int) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dirfd), uintptr(unsafe.Pointer(p)), uintptr(flags))
	if errno != 0 && errno != syscall.ENOENT {
		return errno
	}
	return nil
}

// Chown sets the owner and mode of a regular file of the directory (opened
// without following a link).
func (d *Dir) Chown(name string, o Owner) error {
	f, err := d.open(name, syscall.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := statOf(f); err != nil {
		return err
	}
	if err := f.Chown(o.UID, o.GID); err != nil {
		return err
	}
	return f.Chmod(o.Mode & 0o777)
}

// lstatat stats name without following a symlink: an O_PATH|O_NOFOLLOW
// descriptor refers to the link itself, and fstat(2) on it describes it
// (portable across the architectures the agent is built for).
func lstatat(dirfd int, name string, st *syscall.Stat_t) error {
	const oPath = 0o10000000
	fd, err := syscall.Openat(dirfd, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Fstat(fd, st)
}

// OpenDirSearch opens an absolute, clean directory path like OpenDir, but
// needs only search permission on every component, the last included
// (O_PATH): the engine user reaches its run directory through root's 0711
// directories. The result is used for *at operations on its entries
// (ReadFile, OpenDir, Lstat) and Owner; it cannot list or sync.
func OpenDirSearch(path string) (*Dir, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return nil, fmt.Errorf("fsafe: %q is not a clean absolute path", path)
	}
	const oPath = 0o10000000
	fd, err := syscall.Open("/", oPath|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		next, err := syscall.Openat(fd, part, oPath|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		_ = syscall.Close(fd)
		if err != nil {
			if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
				return nil, fmt.Errorf("fsafe: %s: a component is a symlink or not a directory", path)
			}
			return nil, fmt.Errorf("fsafe: %s: %w", path, err)
		}
		fd = next
	}
	return &Dir{fd: fd, path: path}, nil
}
