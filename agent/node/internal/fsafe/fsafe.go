// Package fsafe is the root helper's file access (architecture.md §2, Phase
// 4): a path is opened component by component from "/" with O_NOFOLLOW, so
// a symlink anywhere on it is refused; files are read and replaced relative
// to an open directory (openat, renameat), never by a path the kernel
// resolves again later; new content goes to an exclusive temporary file,
// is synced, renamed into place and the directory synced; the previous
// content is kept next to it.
package fsafe

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// PreviousSuffix names the copy of a file's previous content.
const PreviousSuffix = ".exponetdb-previous"

// ErrNotExist: the file does not exist.
var ErrNotExist = errors.New("fsafe: no such file")

// Dir is an open directory reached without following a symlink.
type Dir struct {
	fd   int
	path string
}

// Stat is what a file's preconditions are checked against.
type Stat struct {
	UID, GID int
	Mode     os.FileMode
	Size     int64
}

func validName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > 255 ||
		strings.ContainsAny(name, "/\x00") {
		return fmt.Errorf("fsafe: %q is not a file name", name)
	}
	return nil
}

// OpenDir opens an absolute, clean directory path one component at a time
// with O_NOFOLLOW|O_DIRECTORY.
func OpenDir(path string) (*Dir, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return nil, fmt.Errorf("fsafe: %q is not a clean absolute path", path)
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		next, err := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
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

// Close closes the directory.
func (d *Dir) Close() error { return syscall.Close(d.fd) }

// Path is the directory's path.
func (d *Dir) Path() string { return d.path }

// Owner returns the directory's owner and permission bits.
func (d *Dir) Owner() (Owner, error) {
	var st syscall.Stat_t
	if err := syscall.Fstat(d.fd, &st); err != nil {
		return Owner{}, err
	}
	return Owner{UID: int(st.Uid), GID: int(st.Gid), Mode: os.FileMode(st.Mode & 0o7777)}, nil
}

func (d *Dir) open(name string, flags int, mode uint32) (*os.File, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(d.fd, name, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, mode)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, ErrNotExist
		}
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("fsafe: %s/%s is a symlink", d.path, name)
		}
		return nil, err
	}
	return os.NewFile(uintptr(fd), filepath.Join(d.path, name)), nil
}

func statOf(f *os.File) (Stat, error) {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return Stat{}, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return Stat{}, fmt.Errorf("fsafe: %s is not a regular file", f.Name())
	}
	return Stat{UID: int(st.Uid), GID: int(st.Gid), Mode: os.FileMode(st.Mode & 0o7777), Size: st.Size}, nil
}

// ReadFile reads a regular file of the directory (at most max bytes).
func (d *Dir) ReadFile(name string, max int64) ([]byte, Stat, error) {
	f, err := d.open(name, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, Stat{}, err
	}
	defer f.Close()
	st, err := statOf(f)
	if err != nil {
		return nil, Stat{}, err
	}
	if st.Size > max {
		return nil, Stat{}, fmt.Errorf("fsafe: %s is larger than %d bytes", f.Name(), max)
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, Stat{}, err
	}
	if int64(len(data)) > max {
		return nil, Stat{}, fmt.Errorf("fsafe: %s grew while it was read", f.Name())
	}
	return data, st, nil
}

// Owner is the owner and mode a written file gets.
type Owner struct {
	UID, GID int
	Mode     os.FileMode
}

func (d *Dir) writeTemp(name string, content []byte, o Owner) (string, error) {
	var suffix [8]byte
	if _, err := io.ReadFull(randReader, suffix[:]); err != nil {
		return "", err
	}
	tmp := fmt.Sprintf(".%s.exponetdb-%x", name, suffix)
	if len(tmp) > 255 {
		tmp = fmt.Sprintf(".exponetdb-%x", suffix)
	}
	f, err := d.open(tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = syscall.Unlinkat(d.fd, tmp)
		}
	}()
	if err := f.Chown(o.UID, o.GID); err != nil {
		return "", err
	}
	if err := f.Chmod(o.Mode); err != nil {
		return "", err
	}
	if _, err := f.Write(content); err != nil {
		return "", err
	}
	if err := f.Sync(); err != nil {
		return "", err
	}
	ok = true
	return tmp, nil
}

func (d *Dir) sync() error { return syscall.Fsync(d.fd) }

// Replace writes content to name atomically. When name exists, its content
// is first kept as name+PreviousSuffix (itself replaced atomically).
func (d *Dir) Replace(name string, content []byte, o Owner) error {
	if err := validName(name + PreviousSuffix); err != nil {
		return err
	}
	old, st, err := d.ReadFile(name, 16<<20)
	switch {
	case err == nil:
		prev, err := d.writeTemp(name+PreviousSuffix, old, Owner{UID: st.UID, GID: st.GID, Mode: st.Mode})
		if err != nil {
			return err
		}
		if err := syscall.Renameat(d.fd, prev, d.fd, name+PreviousSuffix); err != nil {
			_ = syscall.Unlinkat(d.fd, prev)
			return err
		}
	case errors.Is(err, ErrNotExist):
	default:
		return err
	}
	tmp, err := d.writeTemp(name, content, o)
	if err != nil {
		return err
	}
	if err := syscall.Renameat(d.fd, tmp, d.fd, name); err != nil {
		_ = syscall.Unlinkat(d.fd, tmp)
		return err
	}
	return d.sync()
}

// Restore puts the kept previous content back (with its owner and mode).
func (d *Dir) Restore(name string) error {
	prev, st, err := d.ReadFile(name+PreviousSuffix, 16<<20)
	if err != nil {
		return err
	}
	tmp, err := d.writeTemp(name, prev, Owner{UID: st.UID, GID: st.GID, Mode: st.Mode})
	if err != nil {
		return err
	}
	if err := syscall.Renameat(d.fd, tmp, d.fd, name); err != nil {
		_ = syscall.Unlinkat(d.fd, tmp)
		return err
	}
	return d.sync()
}

// Create writes a new file exclusively: it fails when name exists.
func (d *Dir) Create(name string, content []byte, o Owner) error {
	if err := validName(name); err != nil {
		return err
	}
	tmp, err := d.writeTemp(name, content, o)
	if err != nil {
		return err
	}
	// linkat refuses an existing name, unlike renameat.
	err = linkat(d.fd, tmp, d.fd, name)
	_ = syscall.Unlinkat(d.fd, tmp)
	if err != nil {
		return err
	}
	return d.sync()
}

// Remove removes a file of the directory (never a directory).
func (d *Dir) Remove(name string) error {
	if err := validName(name); err != nil {
		return err
	}
	if err := syscall.Unlinkat(d.fd, name); err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return ErrNotExist
		}
		return err
	}
	return d.sync()
}

// Entry is a regular file of the directory.
type Entry struct {
	Name    string
	ModTime time.Time
}

// Files lists the regular files of the directory (symlinks and other kinds
// are skipped).
func (d *Dir) Files() ([]Entry, error) {
	dup, err := syscall.Dup(d.fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dup), d.path)
	defer f.Close()
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, n := range names {
		var st syscall.Stat_t
		if err := fstatat(d.fd, n, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG {
			continue
		}
		out = append(out, Entry{Name: n, ModTime: time.Unix(st.Mtim.Sec, st.Mtim.Nsec)})
	}
	return out, nil
}

// Split returns the directory and file name of a clean absolute file path.
func Split(path string) (dir, name string, err error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return "", "", fmt.Errorf("fsafe: %q is not a clean absolute file path", path)
	}
	dir, name = filepath.Split(path)
	return filepath.Clean(dir), name, validName(name)
}

var randReader io.Reader = rand.Reader

// linkat(2) without flags: it never follows or replaces anything.
func linkat(olddirfd int, oldpath string, newdirfd int, newpath string) error {
	from, err := syscall.BytePtrFromString(oldpath)
	if err != nil {
		return err
	}
	to, err := syscall.BytePtrFromString(newpath)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(syscall.SYS_LINKAT, uintptr(olddirfd), uintptr(unsafe.Pointer(from)),
		uintptr(newdirfd), uintptr(unsafe.Pointer(to)), 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// fstatat stats a name of the directory without following a symlink (an
// O_NOFOLLOW|O_NONBLOCK open, so a FIFO never blocks).
func fstatat(dirfd int, name string, st *syscall.Stat_t) error {
	fd, err := syscall.Openat(dirfd, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Fstat(fd, st)
}
