// Package config reads the operator configuration of the node agent
// (architecture.md §4, G5 record C8): a root-owned file that the operator
// writes and the agent only reads. Nothing the Control Plane sends ever
// changes it: capability toggles and the local instance mapping stay under
// the host operator's control. Agent-owned state (keys, gateway address,
// trusted job keys) lives in package state.
//
// The file is strict JSON (the agent module uses the standard library only):
// duplicate or unknown members, a wrong schema and invalid values are
// refused, and the agent does not start.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
)

// Schema is the version of the configuration format.
const Schema = "exponetdb.node-config/v1"

// DefaultPath is where the package installs the configuration.
const DefaultPath = "/etc/exponetdb-node/config.json"

const maxBytes = 64 * 1024

// Config is the operator configuration.
type Config struct {
	Schema string `json:"schema"`
	// StateDirectory holds the agent-owned state, identity, journal and
	// buffers (default /var/lib/exponetdb-node).
	StateDirectory string `json:"stateDirectory"`
	// HelperSocket is the root helper's Unix socket.
	HelperSocket string `json:"helperSocket"`
	// AgentUser is the agent's system user: the only caller the root
	// helper accepts (SO_PEERCRED). The helper refuses to start without it.
	AgentUser string `json:"agentUser,omitempty"`
	// DisabledCapabilities lists name@major entries the operator turned off;
	// the agent neither reports nor runs them (capabilities.md §3).
	DisabledCapabilities []string `json:"disabledCapabilities"`
	// Instances maps each local PostgreSQL instance the agent may act on to
	// its unit and files, as confirmed by the operator (G5 record C9).
	Instances []Instance `json:"instances"`
}

// Instance is one operator-confirmed local PostgreSQL instance.
type Instance struct {
	LocalName       string `json:"localName"`
	Unit            string `json:"unit"`
	Port            int    `json:"port"`
	SocketDirectory string `json:"socketDirectory"`
	DataDirectory   string `json:"dataDirectory"`
	ConfigFile      string `json:"configFile"`
	HbaFile         string `json:"hbaFile"`
	ManagedInclude  string `json:"managedInclude"`
	// TLSCertificateFile and TLSKeyFile are where postgres.tls.rotate@1
	// installs the server certificate and key; empty refuses the rotation.
	TLSCertificateFile string `json:"tlsCertificateFile,omitempty"`
	TLSKeyFile         string `json:"tlsKeyFile,omitempty"`
}

var (
	localNameRE  = regexp.MustCompile(`^[0-9]{2}/[a-z0-9_-]{1,63}$`)
	unitRE       = regexp.MustCompile(`^postgresql@[0-9]{2}-[a-z0-9_-]{1,63}\.service$`)
	userRE       = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	capabilityRE = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]{0,3}$`)
)

// Options control how Load checks the file.
type Options struct {
	// OwnerUID is the required owner of the file (0, root, in production).
	OwnerUID int
}

// Load reads and validates the configuration at path.
func Load(path string, o Options) (*Config, error) {
	if err := fsutil.CheckOwnedPrivate(path, fsutil.Owner{UID: o.OwnerUID, OtherReadable: true}); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	data, err := fsutil.ReadLimited(path, maxBytes)
	if err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	return Parse(data)
}

// Parse validates configuration bytes.
func Parse(data []byte) (*Config, error) {
	// Strict JSON first: duplicate members, which encoding/json would merge
	// silently, are refused here.
	if _, err := canon.Parse(data); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var c Config
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	return &c, nil
}

func absolute(what, p string) error {
	if p == "" || !filepath.IsAbs(p) || filepath.Clean(p) != p || strings.ContainsRune(p, 0) || len(p) > 4096 {
		return fmt.Errorf("%s %q is not a clean absolute path", what, p)
	}
	return nil
}

func (c *Config) validate() error {
	if c.Schema != Schema {
		return fmt.Errorf("schema %q, want %q", c.Schema, Schema)
	}
	if err := absolute("stateDirectory", c.StateDirectory); err != nil {
		return err
	}
	if err := absolute("helperSocket", c.HelperSocket); err != nil {
		return err
	}
	if c.AgentUser != "" && !userRE.MatchString(c.AgentUser) {
		return fmt.Errorf("agentUser %q is not a system user name", c.AgentUser)
	}
	seen := map[string]bool{}
	for _, d := range c.DisabledCapabilities {
		if !capabilityRE.MatchString(d) || seen[d] {
			return fmt.Errorf("disabledCapabilities: %q is not a unique name@major", d)
		}
		seen[d] = true
	}
	names, units := map[string]bool{}, map[string]bool{}
	for _, in := range c.Instances {
		if !localNameRE.MatchString(in.LocalName) || names[in.LocalName] {
			return fmt.Errorf("instance %q: not a unique local name", in.LocalName)
		}
		names[in.LocalName] = true
		if !unitRE.MatchString(in.Unit) || units[in.Unit] {
			return fmt.Errorf("instance %s: unit %q is not a unique postgresql@ unit", in.LocalName, in.Unit)
		}
		units[in.Unit] = true
		if (in.TLSCertificateFile == "") != (in.TLSKeyFile == "") {
			return fmt.Errorf("instance %s: tlsCertificateFile and tlsKeyFile go together", in.LocalName)
		}
		for _, p := range []struct{ what, path string }{
			{"tlsCertificateFile", in.TLSCertificateFile},
			{"tlsKeyFile", in.TLSKeyFile},
		} {
			if p.path == "" {
				continue
			}
			if err := absolute(in.LocalName+" "+p.what, p.path); err != nil {
				return err
			}
		}
		if in.Port < 1 || in.Port > 65535 {
			return fmt.Errorf("instance %s: port %d", in.LocalName, in.Port)
		}
		for _, p := range []struct{ what, path string }{
			{"socketDirectory", in.SocketDirectory},
			{"dataDirectory", in.DataDirectory},
			{"configFile", in.ConfigFile},
			{"hbaFile", in.HbaFile},
			{"managedInclude", in.ManagedInclude},
		} {
			if err := absolute(in.LocalName+" "+p.what, p.path); err != nil {
				return err
			}
		}
	}
	return nil
}

// Instance returns the instance with the local name, if the operator mapped it.
func (c *Config) Instance(localName string) (Instance, bool) {
	for _, in := range c.Instances {
		if in.LocalName == localName {
			return in, true
		}
	}
	return Instance{}, false
}

// Disabled reports whether the operator turned the capability off.
func (c *Config) Disabled(key string) bool {
	for _, d := range c.DisabledCapabilities {
		if d == key {
			return true
		}
	}
	return false
}
