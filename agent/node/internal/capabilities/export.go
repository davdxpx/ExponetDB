package capabilities

import (
	"context"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/kdigest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
)

// Export classes (capabilities.md §6, Wave 5 correction F1). A value read
// from PostgreSQL or the host leaves the node only when its class establishes
// that it is safe; otherwise the result carries {"withheld": reason}, never
// null, an empty string or a value as if it had been read. The rules are
// explicit lists and types, never a pattern over the text: a value whose
// safety the node cannot establish is withheld.

const (
	// withheldSecret: the value's kind holds credentials (a connection
	// string, a command, a password option).
	withheldSecret = "secret"
	// withheldUnclassified: the node cannot establish that the value is safe.
	withheldUnclassified = "unclassified"
)

func withheld(reason string) canon.Object { return obj("withheld", reason) }

// secretParameters are the core parameters whose values hold credentials or
// commands that can carry them (PostgreSQL 16 to 18).
var secretParameters = map[string]bool{
	"primary_conninfo":        true,
	"archive_command":         true,
	"archive_cleanup_command": true,
	"restore_command":         true,
	"recovery_end_command":    true,
	"ssl_passphrase_command":  true,
}

// shownStringParameters are the core free-text parameters of PostgreSQL 16 to
// 18 whose values are names, lists, paths or formats and never credentials.
// A string parameter not listed here (a later release's, an extension's, a
// custom one) is withheld as unclassified.
var shownStringParameters = map[string]bool{
	"datestyle": true, "timezone": true, "application_name": true, "archive_library": true,
	"backtrace_functions": true, "bonjour_name": true, "client_encoding": true, "cluster_name": true,
	"config_file": true, "createrole_self_grant": true, "data_directory": true, "debug_io_direct": true,
	"default_table_access_method": true, "default_tablespace": true, "default_text_search_config": true,
	"dynamic_library_path": true, "event_source": true, "extension_control_path": true,
	"extension_destdir": true, "external_pid_file": true, "hba_file": true, "ident_file": true,
	"jit_provider": true, "krb_server_keyfile": true, "lc_messages": true, "lc_monetary": true,
	"lc_numeric": true, "lc_time": true, "listen_addresses": true, "local_preload_libraries": true,
	"log_connections": true, "log_destination": true, "log_directory": true, "log_filename": true,
	"log_line_prefix": true, "log_timezone": true, "oauth_validator_libraries": true,
	"output_plugin_libraries": true, "primary_slot_name": true, "recovery_target": true,
	"recovery_target_lsn": true, "recovery_target_name": true, "recovery_target_time": true,
	"recovery_target_timeline": true, "recovery_target_xid": true, "restrict_nonsystem_relation_kind": true,
	"search_path": true, "server_encoding": true, "server_version": true, "session_preload_libraries": true,
	"shared_preload_libraries": true, "ssl_ca_file": true, "ssl_cert_file": true, "ssl_ciphers": true,
	"ssl_crl_dir": true, "ssl_crl_file": true, "ssl_dh_params_file": true, "ssl_ecdh_curve": true,
	"ssl_groups": true, "ssl_key_file": true, "ssl_library": true, "ssl_tls13_ciphers": true,
	"synchronized_standby_slots": true, "synchronous_standby_names": true, "syslog_ident": true,
	"temp_tablespaces": true, "timezone_abbreviations": true, "unix_socket_directories": true,
	"unix_socket_group": true, "wal_consistency_checking": true,
}

// paramType is what pg_settings says of a parameter.
type paramType struct {
	vartype  string
	unit     string
	enumvals []string
}

// paramTypes reads every parameter's type (the catalog, not a session's values).
func paramTypes(ctx context.Context, c *pgwire.Conn) (map[string]paramType, error) {
	rows, err := c.Query(ctx, `SELECT name, vartype, unit, array_to_string(enumvals, chr(31)) AS enumvals
		FROM pg_catalog.pg_settings ORDER BY name LIMIT 4096`)
	if err != nil {
		return nil, err
	}
	out := map[string]paramType{}
	for _, r := range rows.Each() {
		t := paramType{vartype: r.Text("vartype"), unit: r.Text("unit")}
		if e := r.Text("enumvals"); e != "" {
			t.enumvals = strings.Split(e, "\x1f")
		}
		out[strings.ToLower(r.Text("name"))] = t
	}
	return out, nil
}

// boolWords are the spellings PostgreSQL's parse_bool accepts.
var boolWords = map[string]bool{
	"t": true, "tr": true, "tru": true, "true": true, "f": true, "fa": true, "fal": true, "fals": true,
	"false": true, "y": true, "ye": true, "yes": true, "n": true, "no": true, "on": true, "of": true,
	"off": true, "1": true, "0": true,
}

// exportValue is a parameter's value as the node exports it: shown when its
// type makes it non-secret (a boolean, a number with its unit, a member of
// its enumeration: a credential cannot be written as one) and the text
// actually is of that type, or when it is a listed core string; a secret
// kind is withheld as secret, everything else as unclassified. known false:
// the catalog does not know the name.
func exportValue(name string, t paramType, known bool, raw string) canon.Value {
	lower := strings.ToLower(name)
	if secretParameters[lower] {
		return withheld(withheldSecret)
	}
	if !known {
		return withheld(withheldUnclassified)
	}
	v := strings.TrimSpace(raw)
	switch t.vartype {
	case "bool":
		if boolWords[strings.ToLower(v)] {
			return canon.String(bound(raw, 4096))
		}
	case "enum":
		for _, e := range t.enumvals {
			if strings.EqualFold(e, v) {
				return canon.String(bound(raw, 4096))
			}
		}
	case "integer", "real":
		if _, ok := numeric(t.unit, v); ok {
			return canon.String(bound(raw, 4096))
		}
	case "string":
		if !strings.Contains(name, ".") && shownStringParameters[lower] {
			return canon.String(bound(raw, 4096))
		}
	}
	return withheld(withheldUnclassified)
}

// shownNullable is exportValue for a nullable column (nil stays null).
func shownNullable(name string, t paramType, known bool, raw *string) canon.Value {
	if raw == nil {
		return canon.Null{}
	}
	return exportValue(name, t, known, *raw)
}

// fixedFileErrors are pg_file_settings.error texts without anything of the
// file in them; any other text (an included file's name, PostgreSQL's later
// messages) is withheld.
var fixedFileErrors = map[string]bool{
	"syntax error":                                              true,
	"unrecognized configuration parameter":                      true,
	"setting could not be applied":                              true,
	"parameter cannot be changed without restarting the server": true,
}

// fixedHbaErrors are pg_hba_file_rules.error texts without a token of the
// line; most of PostgreSQL's pg_hba messages quote one, so they are withheld.
var fixedHbaErrors = map[string]bool{
	"cannot use ldapbasedn, ldapbinddn, ldapbindpasswd, ldapsearchattribute, ldapsearchfilter, or ldapurl together with ldapprefix": true,
	"authentication method \"ldap\" requires argument \"ldapbasedn\", \"ldapprefix\", or \"ldapsuffix\" to be set":                  true,
	"list of RADIUS servers cannot be empty":                       true,
	"list of RADIUS secrets cannot be empty":                       true,
	"end-of-line before database specification":                    true,
	"end-of-line before role specification":                        true,
	"end-of-line before IP address specification":                  true,
	"end-of-line before authentication method":                     true,
	"connection type specified as hostssl, but SSL is not enabled": true,
}

func shownError(fixed map[string]bool, text *string) canon.Value {
	if text == nil {
		return canon.Null{}
	}
	if fixed[*text] {
		return canon.String(bound(*text, 1024))
	}
	return withheld(withheldUnclassified)
}

// hbaOptionsShown are pg_hba options whose values are names, hosts, numbers
// or flags; ldapbindpasswd and radiussecrets are secrets, every other option
// (ldapurl, which can carry user information, and any later one) is withheld
// as unclassified.
var hbaOptionsShown = map[string]bool{
	"map": true, "clientcert": true, "clientname": true, "include_realm": true, "krb_realm": true,
	"compat_realm": true, "upn_username": true, "ldapserver": true, "ldapport": true, "ldapscheme": true,
	"ldaptls": true, "ldapprefix": true, "ldapsuffix": true, "ldapbasedn": true, "ldapbinddn": true,
	"ldapsearchattribute": true, "ldapsearchfilter": true, "pamservice": true, "pam_use_hostname": true,
	"radiusservers": true, "radiusidentifiers": true, "radiusports": true, "issuer": true, "scope": true,
	"validator": true, "delegate_ident_mapping": true,
}

var hbaOptionsSecret = map[string]bool{"ldapbindpasswd": true, "radiussecrets": true}

// hbaOption splits name=value and shows the value by its option's class.
func hbaOption(option string) canon.Object {
	name, value, _ := strings.Cut(option, "=")
	var shown canon.Value
	switch {
	case hbaOptionsSecret[name]:
		shown = withheld(withheldSecret)
	case hbaOptionsShown[name]:
		shown = canon.String(bound(value, 512))
	default:
		shown = withheld(withheldUnclassified)
	}
	return obj("name", bound(name, 64), "value", shown)
}

// The purposes of the agent's keyed digests (kd1).
const (
	purposeConfigVersion = "exponetdb/config-version/v1"
	purposeRolesDigest   = "exponetdb/roles-digest/v1"
	purposeHbaBlock      = "exponetdb/hba-block/v1"
)

// keyed is the agent's kd1 digest of a canonical value; without the key no
// digest is exported (fail closed).
func (e *Env) keyed(purpose string, v canon.Value) (string, error) {
	b, err := canon.Canonicalize(v)
	if err != nil {
		return "", err
	}
	return kdigest.Of(e.DigestKey, purpose, b)
}

func (e *Env) keyedBytes(purpose string, data []byte) (string, error) {
	return kdigest.Of(e.DigestKey, purpose, data)
}
