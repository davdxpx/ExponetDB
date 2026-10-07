package capabilities

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Roles (credentials-and-roles.md §4, §5). **[DECIDED]** (Phase 5) The agent
// never changes a superuser role, never grants membership in one, and never
// grants the predefined roles that reach the server's files or programs:
// they are superuser in all but name, like the SUPERUSER attribute no step
// can set.
var superuserEquivalent = map[string]bool{
	"pg_execute_server_program": true,
	"pg_read_server_files":      true,
	"pg_write_server_files":     true,
}

type roleRow struct {
	name                                                                    string
	login, superuser, inherit, createdb, createrole, replication, bypassrls bool
	connLimit                                                               int64
}

type membership struct {
	role, member         string
	admin, inherit, set_ bool
}

type roleSetting struct {
	role, database *string
	name, value    string
}

type rolesState struct {
	roles       map[string]roleRow
	order       []string
	memberships []membership
	settings    []roleSetting
	json        canon.Object
	digest      string
}

func inspectRoles(ctx context.Context, c *pgwire.Conn) (*rolesState, error) {
	rows, err := c.Query(ctx, `SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreatedb, r.rolcreaterole,
		r.rolreplication, r.rolbypassrls, r.rolconnlimit,
		CASE WHEN r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity' THEN NULL ELSE r.rolvaliduntil::text END AS valid_until,
		CASE WHEN a.rolpassword IS NULL THEN 'none' WHEN a.rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram-sha-256'
		     WHEN a.rolpassword LIKE 'md5%' THEN 'md5' ELSE 'other' END AS password
		FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_authid a ON a.oid = r.oid
		WHERE r.rolname !~ '^pg_' ORDER BY r.rolname LIMIT 4096`)
	if err != nil {
		return nil, err
	}
	s := &rolesState{roles: map[string]roleRow{}}
	rolesJSON := canon.Array{}
	for _, r := range rows.Each() {
		row := roleRow{name: r.Text("rolname"), login: r.Bool("rolcanlogin"), superuser: r.Bool("rolsuper"),
			inherit: r.Bool("rolinherit"), createdb: r.Bool("rolcreatedb"), createrole: r.Bool("rolcreaterole"),
			replication: r.Bool("rolreplication"), bypassrls: r.Bool("rolbypassrls"), connLimit: r.Int("rolconnlimit")}
		s.roles[row.name] = row
		s.order = append(s.order, row.name)
		var until any
		if v := r.TextOrNil("valid_until"); v != nil {
			if t, ok := pgTime(*v); ok {
				until = t
			}
		}
		rolesJSON = append(rolesJSON, obj("name", bound(row.name, 256), "login", row.login, "superuser", row.superuser,
			"inherit", row.inherit, "createdb", row.createdb, "createrole", row.createrole, "replication", row.replication,
			"bypassrls", row.bypassrls, "connectionLimit", row.connLimit, "validUntil", until, "password", r.Text("password")))
	}
	ms, err := c.Query(ctx, `SELECT g.rolname AS role, m.rolname AS member, gr.rolname AS grantor,
		am.admin_option, am.inherit_option, am.set_option
		FROM pg_catalog.pg_auth_members am JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
		JOIN pg_catalog.pg_roles m ON m.oid = am.member LEFT JOIN pg_catalog.pg_roles gr ON gr.oid = am.grantor
		WHERE m.rolname !~ '^pg_' ORDER BY 1, 2, 3 LIMIT 16384`)
	if err != nil {
		return nil, err
	}
	msJSON := canon.Array{}
	for _, r := range ms.Each() {
		m := membership{role: r.Text("role"), member: r.Text("member"), admin: r.Bool("admin_option"),
			inherit: r.Bool("inherit_option"), set_: r.Bool("set_option")}
		s.memberships = append(s.memberships, m)
		var grantor any
		if v := r.TextOrNil("grantor"); v != nil {
			grantor = bound(*v, 256)
		}
		msJSON = append(msJSON, obj("role", bound(m.role, 256), "member", bound(m.member, 256), "grantor", grantor,
			"admin", m.admin, "inherit", m.inherit, "set", m.set_))
	}
	st, err := c.Query(ctx, `SELECT r.rolname AS role, d.datname AS database, cfg
		FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
		LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase, pg_catalog.unnest(s.setconfig) AS cfg
		ORDER BY 1 NULLS FIRST, 2 NULLS FIRST, 3 LIMIT 4096`)
	if err != nil {
		return nil, err
	}
	settingsJSON := canon.Array{}
	for _, r := range st.Each() {
		name, value, _ := strings.Cut(r.Text("cfg"), "=")
		rs := roleSetting{role: r.TextOrNil("role"), database: r.TextOrNil("database"), name: name, value: value}
		s.settings = append(s.settings, rs)
		settingsJSON = append(settingsJSON, obj("role", rs.role, "database", rs.database, "name", bound(name, 256), "value", bound(value, 4096)))
	}
	s.json = obj("roles", rolesJSON, "memberships", msJSON, "settings", settingsJSON)
	s.digest, err = digest(s.json)
	return s, err
}

// ----- postgres.roles.inspect@1 -----

type rolesInspect struct{ clusterBound }

func (p rolesInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	s, err := inspectRoles(ctx, c)
	if err != nil {
		return nil, err
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	out := obj("rolesDigest", s.digest)
	return append(out, s.json...), nil
}

// ----- postgres.roles.plan@1 -----

type rolesPlan struct{ clusterBound }

type attrs struct {
	login, inherit, createdb, createrole, replication, bypassrls *bool
	connLimit                                                    *int64
}

func attrsOf(o canon.Object) attrs {
	b := func(name string) *bool {
		v, ok := member(o, name).(canon.Bool)
		if !ok {
			return nil
		}
		x := bool(v)
		return &x
	}
	var a attrs
	a.login, a.inherit, a.createdb = b("login"), b("inherit"), b("createdb")
	a.createrole, a.replication, a.bypassrls = b("createrole"), b("replication"), b("bypassrls")
	if n, ok := member(o, "connectionLimit").(canon.Number); ok {
		x := int64(n)
		a.connLimit = &x
	}
	return a
}

func (a attrs) privileged() bool {
	t := func(p *bool) bool { return p != nil && *p }
	return t(a.createrole) || t(a.replication) || t(a.bypassrls)
}

// diff lists the attributes that differ from the role's.
func (a attrs) diff(r roleRow) []string {
	var out []string
	cmp := func(name string, want *bool, have bool) {
		if want != nil && *want != have {
			out = append(out, fmt.Sprintf("%s %t", name, *want))
		}
	}
	cmp("login", a.login, r.login)
	cmp("inherit", a.inherit, r.inherit)
	cmp("createdb", a.createdb, r.createdb)
	cmp("createrole", a.createrole, r.createrole)
	cmp("replication", a.replication, r.replication)
	cmp("bypassrls", a.bypassrls, r.bypassrls)
	if a.connLimit != nil && *a.connLimit != r.connLimit {
		out = append(out, fmt.Sprintf("connection limit %d", *a.connLimit))
	}
	return out
}

func (s *rolesState) privilegedRole(name string) bool {
	if superuserEquivalent[name] {
		return true
	}
	r, ok := s.roles[name]
	return ok && (r.superuser || r.createrole || r.replication || r.bypassrls)
}

func (p rolesPlan) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	s, err := inspectRoles(ctx, c)
	if err != nil {
		return nil, err
	}
	changes := canon.Array{}
	add := func(change, role, detail, class string) {
		changes = append(changes, obj("change", change, "role", role, "detail", bound(detail, 1024), "classification", class))
	}
	named := map[string]bool{}
	for _, item := range list(job.Args, "roles") {
		d, _ := item.(canon.Object)
		name := text(d, "name")
		named[name] = true
		a, _ := member(d, "attributes").(canon.Object)
		want := attrsOf(a)
		cur, exists := s.roles[name]
		if exists && cur.superuser {
			return nil, preconditionf("role %s is a superuser; ExponetDB never manages one", name)
		}
		if !exists {
			class := "standard"
			switch {
			case want.privileged():
				class = "critical"
			case want.login != nil && *want.login:
				class = "high"
			}
			add("create_role", name, "create the role", class)
		} else if d := want.diff(cur); len(d) > 0 {
			class := "standard"
			if want.privileged() {
				class = "critical"
			}
			add("alter_role", name, "set "+strings.Join(d, ", "), class)
		}
		if boolOf(d, "passwordChange") {
			add("set_password", name, "install a new SCRAM-SHA-256 verifier", "high")
		}
		have := map[string]membership{}
		for _, m := range s.memberships {
			if m.member == name {
				have[m.role] = m
			}
		}
		wanted := map[string]bool{}
		for _, mi := range list(d, "memberOf") {
			m, _ := mi.(canon.Object)
			group := text(m, "role")
			wanted[group] = true
			if superuserEquivalent[group] || (s.roles[group].superuser) {
				return nil, preconditionf("membership in %s is superuser in all but name; never granted", group)
			}
			cur, ok := have[group]
			if ok && cur.admin == boolOf(m, "admin") && cur.inherit == boolOf(m, "inherit") && cur.set_ == boolOf(m, "set") {
				continue
			}
			class := "standard"
			switch {
			case s.privilegedRole(group) || strings.HasPrefix(group, "pg_"):
				class = "critical"
			case boolOf(m, "admin"):
				class = "high"
			}
			add("grant_membership", name, fmt.Sprintf("member of %s (admin %t, inherit %t, set %t)", group,
				boolOf(m, "admin"), boolOf(m, "inherit"), boolOf(m, "set")), class)
		}
		groups := make([]string, 0, len(have))
		for g := range have {
			groups = append(groups, g)
		}
		sort.Strings(groups)
		for _, g := range groups {
			if !wanted[g] {
				add("revoke_membership", name, "no longer a member of "+g, "standard")
			}
		}
		current := map[string]string{}
		for _, st := range s.settings {
			if st.role != nil && *st.role == name {
				db := ""
				if st.database != nil {
					db = *st.database
				}
				current[db+"\x00"+st.name] = st.value
			}
		}
		desired := map[string]bool{}
		for _, si := range list(d, "settings") {
			st, _ := si.(canon.Object)
			db := ""
			if v := textOrNil(st, "database"); v != nil {
				db = *v
			}
			key := db + "\x00" + text(st, "name")
			desired[key] = true
			if v, ok := current[key]; ok && v == text(st, "value") {
				continue
			}
			add("set_role_setting", name, "set "+text(st, "name")+inDatabase(db), "standard")
		}
		keys := make([]string, 0, len(current))
		for k := range current {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if !desired[k] {
				db, setting, _ := strings.Cut(k, "\x00")
				add("reset_role_setting", name, "reset "+setting+inDatabase(db), "standard")
			}
		}
	}
	unmanaged := canon.Array{}
	for _, n := range s.order {
		if !named[n] {
			unmanaged = append(unmanaged, canon.String(bound(n, 256)))
		}
	}
	if err := step(run, "plan"); err != nil {
		return nil, err
	}
	return obj("rolesDigest", s.digest, "changes", changes, "unmanaged", unmanaged), nil
}

func inDatabase(db string) string {
	if db == "" {
		return ""
	}
	return " in database " + db
}

// ----- postgres.roles.apply@1 -----

type rolesApply struct{ clusterBound }

var scramVerifierRE = regexp.MustCompile(`^SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$`)

func attrClause(a attrs) string {
	var parts []string
	flag := func(p *bool, yes, no string) {
		if p == nil {
			return
		}
		if *p {
			parts = append(parts, yes)
		} else {
			parts = append(parts, no)
		}
	}
	flag(a.login, "LOGIN", "NOLOGIN")
	flag(a.inherit, "INHERIT", "NOINHERIT")
	flag(a.createdb, "CREATEDB", "NOCREATEDB")
	flag(a.createrole, "CREATEROLE", "NOCREATEROLE")
	flag(a.replication, "REPLICATION", "NOREPLICATION")
	flag(a.bypassrls, "BYPASSRLS", "NOBYPASSRLS")
	if a.connLimit != nil {
		parts = append(parts, fmt.Sprintf("CONNECTION LIMIT %d", *a.connLimit))
	}
	return strings.Join(parts, " ")
}

func boolWord(b bool) string {
	if b {
		return "TRUE"
	}
	return "FALSE"
}

// Run applies the typed steps in one transaction, after checking the roles
// are still what the plan saw. Statement logging is off for the
// transaction, and a verifier never appears in a statement's text: it is a
// session value the statement reads.
func (p rolesApply) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := c.Exec(ctx, "BEGIN"); err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = c.Exec(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()
	for _, stmt := range []string{
		"SET LOCAL log_statement = 'none'",
		"SET LOCAL log_min_duration_statement = -1",
		"SET LOCAL log_min_error_statement = 'panic'",
	} {
		if err := c.Exec(ctx, stmt); err != nil {
			return nil, err
		}
	}
	s, err := inspectRoles(ctx, c)
	if err != nil {
		return nil, err
	}
	if s.digest != text(job.Args, "expectedRolesDigest") {
		return nil, preconditionf("the roles changed since the plan")
	}
	if err := step(run, "check"); err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	steps := list(job.Args, "steps")
	for i, item := range steps {
		st, _ := item.(canon.Object)
		if err := p.apply(ctx, c, s, run, st); err != nil {
			return nil, fmt.Errorf("step %d (%s): %w", i, text(st, "op"), err)
		}
	}
	if err := c.Exec(ctx, "COMMIT"); err != nil {
		return nil, err
	}
	committed = true
	if err := step(run, "execute"); err != nil {
		return nil, err
	}
	after, err := inspectRoles(ctx, c)
	if err != nil {
		return nil, err
	}
	return obj("rolesDigest", after.digest, "appliedSteps", len(steps)), nil
}

func (p rolesApply) apply(ctx context.Context, c *pgwire.Conn, s *rolesState, run *agent.Run, st canon.Object) error {
	op, role := text(st, "op"), text(st, "role")
	if r, ok := s.roles[role]; ok && r.superuser {
		return preconditionf("role %s is a superuser; ExponetDB never manages one", role)
	}
	a, _ := member(st, "attributes").(canon.Object)
	inDB := ""
	if db := textOrNil(st, "database"); db != nil {
		inDB = " IN DATABASE " + quoteIdent(*db)
	}
	switch op {
	case "create_role":
		return c.Exec(ctx, "CREATE ROLE "+quoteIdent(role)+" WITH NOSUPERUSER "+attrClause(attrsOf(a)))
	case "alter_role":
		clause := attrClause(attrsOf(a))
		if clause == "" {
			return nil
		}
		return c.Exec(ctx, "ALTER ROLE "+quoteIdent(role)+" WITH "+clause)
	case "set_password":
		plain, ok := run.Open("verifier", member(st, "verifier"))
		if !ok {
			return errors.New("the sealed verifier does not open")
		}
		verifier := string(plain)
		for i := range plain {
			plain[i] = 0
		}
		if !scramVerifierRE.MatchString(verifier) {
			return errors.New("the sealed value is not a SCRAM-SHA-256 verifier")
		}
		if err := c.Exec(ctx, `SELECT pg_catalog.set_config('exponetdb.role', $1, true),
			pg_catalog.set_config('exponetdb.verifier', $2, true)`, role, verifier); err != nil {
			return err
		}
		err := c.Exec(ctx, `DO $do$ BEGIN
			EXECUTE pg_catalog.format('ALTER ROLE %I PASSWORD %L',
				pg_catalog.current_setting('exponetdb.role'), pg_catalog.current_setting('exponetdb.verifier'));
			END $do$`)
		_ = c.Exec(ctx, `SELECT pg_catalog.set_config('exponetdb.verifier', '', true)`)
		return err
	case "clear_password":
		return c.Exec(ctx, "ALTER ROLE "+quoteIdent(role)+" PASSWORD NULL")
	case "grant_membership":
		group, memberRole := role, text(st, "member")
		if superuserEquivalent[group] || s.roles[group].superuser {
			return preconditionf("membership in %s is superuser in all but name; never granted", group)
		}
		return c.Exec(ctx, fmt.Sprintf("GRANT %s TO %s WITH ADMIN %s, INHERIT %s, SET %s", quoteIdent(group), quoteIdent(memberRole),
			boolWord(boolOf(st, "admin")), boolWord(boolOf(st, "inherit")), boolWord(boolOf(st, "set"))))
	case "revoke_membership":
		return c.Exec(ctx, "REVOKE "+quoteIdent(role)+" FROM "+quoteIdent(text(st, "member")))
	case "set_role_setting":
		// The name passed the contract's pattern and DENIED_PARAMETERS.
		return c.Exec(ctx, "ALTER ROLE "+quoteIdent(role)+inDB+" SET "+text(st, "setting")+" = "+quoteLiteral(text(st, "value")))
	case "reset_role_setting":
		return c.Exec(ctx, "ALTER ROLE "+quoteIdent(role)+inDB+" RESET "+text(st, "setting"))
	}
	return fmt.Errorf("unknown step %q", op)
}
