package conformance

import (
	"errors"
	"slices"

	"github.com/davdxpx/exponetdb/agent/node/internal/canon"
)

// Bundle refusal codes.
const (
	// CodeUnresolvedExecutionRole: neither the manifest nor the project
	// defaults set execution.role; there is no engine default (N7, C-11).
	CodeUnresolvedExecutionRole = "unresolved_execution_role"
	// CodeUnresolvedSearchPath: neither the manifest nor the project defaults
	// set execution.searchPath; there is no engine default (N7, C-11).
	CodeUnresolvedSearchPath = "unresolved_search_path"

	// The following codes are not named by the specification. The digest
	// layer works on a manifest that already passed schema validation; these
	// refusals only keep it from guessing when it is handed something it
	// cannot project (a missing required member or a member of the wrong JSON
	// type).

	// CodeInvalidManifest: the manifest cannot be projected.
	CodeInvalidManifest = "invalid_manifest"
	// CodeInvalidProjectDefaults: the project defaults block cannot be read
	// (timeouts in it are reported as invalid_duration or
	// duration_out_of_range instead).
	CodeInvalidProjectDefaults = "invalid_project_defaults"
	// CodeMissingFile: up.sql is absent. Only verify.sql and down.sql have a
	// framed absence (N6).
	CodeMissingFile = "missing_file"
)

// Bundle file names.
const (
	FileUp     = "up.sql"
	FileVerify = "verify.sql"
	FileDown   = "down.sql"
)

// Engine defaults for the timeouts (planning-and-apply.md §5). role and
// searchPath have no engine default.
const (
	engineLockTimeoutMillis      = 5 * 1000
	engineStatementTimeoutMillis = 15 * 60 * 1000
)

// Bundle is the input of the digest layer.
type Bundle struct {
	// Manifest is migration.yaml in the JSON data model.
	Manifest canon.Value
	// ProjectDefaults is the defaults block of exponetdb.project.yaml, with
	// the optional keys lockTimeout, statementTimeout, role and searchPath.
	// nil means the block is absent.
	ProjectDefaults canon.Value
	// Files maps "up.sql", "verify.sql" and "down.sql" to their raw bytes. A
	// missing key is an absent file. Other names are not read: which files a
	// bundle may contain, and whether they agree with the manifest, is
	// checked by bundle validation, not by the digest layer.
	Files map[string][]byte
}

// BundleDigests is the result of the digest layer for one bundle.
type BundleDigests struct {
	// ApplyProjection, VerifyProjection and RollbackProjection are the JCS
	// texts of P, V and R (N7).
	ApplyProjection    []byte
	VerifyProjection   []byte
	RollbackProjection []byte
	// ExecutableText holds X(f) for every present SQL file (N5); an absent
	// file has no key. verify.sql is scanned so that a lexically broken file
	// is refused, but its executable text is not hashed.
	ExecutableText map[string][]byte
	// VerifySource is S(verify.sql), the file after N1 and N2, which the
	// verify digest frames (N6). It is nil exactly when verify.sql is absent;
	// an empty file gives an empty, non-nil slice.
	VerifySource []byte

	Checksum       string // sha256:c1:<hex>
	VerifyDigest   string // sha256:c1:<hex>
	RollbackDigest string // sha256:c1:<hex>
	BundleDigest   string // sha256:c1:<hex>
	SourceDigest   string // sha256:<hex>
}

// ComputeBundleDigests computes the projections, executable texts and
// digests of a bundle (N5 to N7). Refusals are reported in the order of N7:
// project defaults, the projections P, V and R, then the files up.sql,
// verify.sql and down.sql; the first failure is the result. A refusal found
// in a SQL file has Error.File set.
func ComputeBundleDigests(b Bundle) (*BundleDigests, error) {
	defaults, err := readProjectDefaults(b.ProjectDefaults)
	if err != nil {
		return nil, err
	}
	manifest, ok := b.Manifest.(canon.Object)
	if !ok {
		return nil, refuse(CodeInvalidManifest, "the manifest must be an object")
	}
	// canon.Parse never yields duplicate member names or invalid UTF-8, but a
	// hand-built Value can; member lookup would then be ambiguous.
	if _, err := canon.Canonicalize(manifest); err != nil {
		return nil, refuse(CodeInvalidManifest, "the manifest is not valid JSON data: %v", err)
	}
	p, err := applyProjection(manifest, defaults)
	if err != nil {
		return nil, err
	}
	v, err := verifyProjection(manifest)
	if err != nil {
		return nil, err
	}
	r, err := rollbackProjection(manifest)
	if err != nil {
		return nil, err
	}
	out := &BundleDigests{ExecutableText: map[string][]byte{}}
	if out.ApplyProjection, err = canonicalProjection(p); err != nil {
		return nil, err
	}
	if out.VerifyProjection, err = canonicalProjection(v); err != nil {
		return nil, err
	}
	if out.RollbackProjection, err = canonicalProjection(r); err != nil {
		return nil, err
	}

	upSource, present := b.Files[FileUp]
	if !present {
		return nil, &Error{Code: CodeMissingFile, File: FileUp, Detail: "up.sql is required"}
	}
	upNormalized, err := NormalizeSource(upSource)
	if err != nil {
		return nil, inFile(err, FileUp)
	}
	upText, err := scanExecutableText([]rune(string(upNormalized)))
	if err != nil {
		return nil, inFile(err, FileUp)
	}
	out.ExecutableText[FileUp] = upText

	verifySource, verifyText, verifyPresent, err := optionalSQLFile(b.Files, FileVerify)
	if err != nil {
		return nil, err
	}
	_, downText, downPresent, err := optionalSQLFile(b.Files, FileDown)
	if err != nil {
		return nil, err
	}
	if verifyPresent {
		out.ExecutableText[FileVerify] = verifyText
		out.VerifySource = append([]byte{}, verifySource...)
	}
	if downPresent {
		out.ExecutableText[FileDown] = downText
	}

	out.Checksum = ApplyChecksum(out.ApplyProjection, upText)
	// The verify digest binds the whole normalized verify.sql, comments
	// included: its comment directives (check, covers, calls, reads-view)
	// change what verification means.
	out.VerifyDigest = VerifyDigest(out.VerifyProjection, verifySource, verifyPresent)
	out.RollbackDigest = RollbackDigest(out.RollbackProjection, downText, downPresent)
	out.BundleDigest = BundleDigest(out.Checksum, out.VerifyDigest, out.RollbackDigest)
	out.SourceDigest = SourceDigest(upNormalized)
	return out, nil
}

// canonicalProjection returns JCS(v) of a projection (N7: JCS is RFC 8785).
func canonicalProjection(v canon.Value) ([]byte, error) {
	text, err := canon.Canonicalize(v)
	if err != nil {
		// Projections hold only strings, booleans, null, arrays, objects and
		// integers, so only a string that is not valid UTF-8 can get here.
		return nil, refuse(CodeInvalidManifest, "projection cannot be canonicalized: %v", err)
	}
	return text, nil
}

// optionalSQLFile returns S(f) (N1, N2) and X(f) (N4, N5) of an optional
// file. Both checks run in this order, so the refusal is the same as for a
// required file.
func optionalSQLFile(files map[string][]byte, name string) (source, text []byte, present bool, err error) {
	raw, present := files[name]
	if !present {
		return nil, nil, false, nil
	}
	source, err = NormalizeSource(raw)
	if err != nil {
		return nil, nil, true, inFile(err, name)
	}
	text, err = scanExecutableText([]rune(string(source)))
	if err != nil {
		return nil, nil, true, inFile(err, name)
	}
	return source, text, true, nil
}

func inFile(err error, name string) error {
	var e *Error
	if errors.As(err, &e) {
		return &Error{Code: e.Code, File: name, Detail: e.Detail}
	}
	return err
}

// projectDefaults is the validated defaults block. A nil Value means unset.
type projectDefaults struct {
	lockTimeout      canon.Value // canon.Number of milliseconds
	statementTimeout canon.Value // canon.Number of milliseconds
	role             canon.Value // canon.String
	searchPath       canon.Value // canon.Array of canon.String
}

// readProjectDefaults validates every key of the defaults block, whether or
// not the manifest later uses it (N7).
func readProjectDefaults(v canon.Value) (projectDefaults, error) {
	var d projectDefaults
	if v == nil {
		return d, nil
	}
	obj, ok := v.(canon.Object)
	if !ok {
		return d, refuse(CodeInvalidProjectDefaults, "defaults must be an object")
	}
	if _, err := canon.Canonicalize(obj); err != nil {
		return d, refuse(CodeInvalidProjectDefaults, "defaults are not valid JSON data: %v", err)
	}
	const path = "defaults"
	var err error
	if d.lockTimeout, err = optionalTimeout(obj, path, "lockTimeout"); err != nil {
		return d, err
	}
	if d.statementTimeout, err = optionalTimeout(obj, path, "statementTimeout"); err != nil {
		return d, err
	}
	if m, ok := obj.Get("role"); ok {
		if d.role, err = asString(m, CodeInvalidProjectDefaults, path+".role"); err != nil {
			return d, err
		}
	}
	if m, ok := obj.Get("searchPath"); ok {
		if d.searchPath, err = asStringArray(m, CodeInvalidProjectDefaults, path+".searchPath"); err != nil {
			return d, err
		}
	}
	return d, nil
}

// optionalTimeout reads a timeout member as integer milliseconds, or returns
// nil when the member is absent. Any value that is not a valid duration
// string, including a value of another JSON type, is invalid_duration.
func optionalTimeout(obj canon.Object, path, name string) (canon.Value, error) {
	m, ok := obj.Get(name)
	if !ok {
		return nil, nil
	}
	s, ok := m.(canon.String)
	if !ok {
		return nil, refuse(CodeInvalidDuration, "%s.%s must be a duration string", path, name)
	}
	ms, err := TimeoutMillis(string(s))
	if err != nil {
		var e *Error
		if errors.As(err, &e) {
			return nil, refuse(e.Code, "%s.%s: %s", path, name, e.Detail)
		}
		return nil, err
	}
	return canon.Number(ms), nil
}

// applyProjection builds P (N7):
//
//	{"schema", "id", "dependsOn",
//	 "execution": {"transactional", "lockTimeout", "statementTimeout", "role", "searchPath"},
//	 "requires": {"postgres", "extensions"},
//	 "compatibility": {"declared"}}
func applyProjection(m canon.Object, d projectDefaults) (canon.Value, error) {
	const code = CodeInvalidManifest
	schema, err := requiredString(m, code, "manifest", "schema")
	if err != nil {
		return nil, err
	}
	id, err := requiredString(m, code, "manifest", "id")
	if err != nil {
		return nil, err
	}
	dependsOn, err := dependsOnProjection(m)
	if err != nil {
		return nil, err
	}
	execution, err := executionProjection(m, d)
	if err != nil {
		return nil, err
	}
	requires, err := requiresProjection(m)
	if err != nil {
		return nil, err
	}
	compatibility, err := requiredObject(m, code, "manifest", "compatibility")
	if err != nil {
		return nil, err
	}
	declared, err := requiredString(compatibility, code, "manifest.compatibility", "declared")
	if err != nil {
		return nil, err
	}
	return canon.Object{
		{Name: "schema", Value: schema},
		{Name: "id", Value: id},
		{Name: "dependsOn", Value: dependsOn},
		{Name: "execution", Value: execution},
		{Name: "requires", Value: requires},
		{Name: "compatibility", Value: canon.Object{{Name: "declared", Value: declared}}},
	}, nil
}

// dependsOnProjection returns the dependsOn entries without duplicates,
// sorted by code point (byte order of UTF-8 equals code point order).
func dependsOnProjection(m canon.Object) (canon.Value, error) {
	v, ok := m.Get("dependsOn")
	if !ok {
		return nil, refuse(CodeInvalidManifest, "manifest.dependsOn is required")
	}
	entries, err := asStringArray(v, CodeInvalidManifest, "manifest.dependsOn")
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		ids = append(ids, string(e.(canon.String)))
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	out := make(canon.Array, 0, len(ids))
	for _, s := range ids {
		out = append(out, canon.String(s))
	}
	return out, nil
}

// executionProjection materializes the execution fields: the manifest value,
// else the project default, else the engine default (timeouts only).
func executionProjection(m canon.Object, d projectDefaults) (canon.Value, error) {
	const code = CodeInvalidManifest
	const path = "manifest.execution"
	execution, err := requiredObject(m, code, "manifest", "execution")
	if err != nil {
		return nil, err
	}
	tv, ok := execution.Get("transactional")
	if !ok {
		return nil, refuse(code, "%s.transactional is required", path)
	}
	transactional, ok := tv.(canon.Bool)
	if !ok {
		return nil, refuse(code, "%s.transactional must be a boolean", path)
	}

	lockTimeout, err := optionalTimeout(execution, path, "lockTimeout")
	if err != nil {
		return nil, err
	}
	lockTimeout = firstSet(lockTimeout, d.lockTimeout, canon.Number(engineLockTimeoutMillis))

	statementTimeout, err := optionalTimeout(execution, path, "statementTimeout")
	if err != nil {
		return nil, err
	}
	statementTimeout = firstSet(statementTimeout, d.statementTimeout, canon.Number(engineStatementTimeoutMillis))

	var role canon.Value
	if v, ok := execution.Get("role"); ok {
		if role, err = asString(v, code, path+".role"); err != nil {
			return nil, err
		}
	}
	if role = firstSet(role, d.role); role == nil {
		return nil, refuse(CodeUnresolvedExecutionRole, "execution.role is set neither in the manifest nor in the project defaults")
	}

	var searchPath canon.Value
	if v, ok := execution.Get("searchPath"); ok {
		// Order is significant and kept; an empty list is a value.
		if searchPath, err = asStringArray(v, code, path+".searchPath"); err != nil {
			return nil, err
		}
	}
	if searchPath = firstSet(searchPath, d.searchPath); searchPath == nil {
		return nil, refuse(CodeUnresolvedSearchPath, "execution.searchPath is set neither in the manifest nor in the project defaults")
	}

	return canon.Object{
		{Name: "transactional", Value: transactional},
		{Name: "lockTimeout", Value: lockTimeout},
		{Name: "statementTimeout", Value: statementTimeout},
		{Name: "role", Value: role},
		{Name: "searchPath", Value: searchPath},
	}, nil
}

func firstSet(values ...canon.Value) canon.Value {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

// requiresProjection returns {"postgres", "extensions"}: postgres as written
// or null, extensions as [{"name", "version"}] sorted by name with version as
// written or null, and [] when absent.
func requiresProjection(m canon.Object) (canon.Value, error) {
	const code = CodeInvalidManifest
	const path = "manifest.requires"
	var postgres canon.Value = canon.Null{}
	extensions := canon.Array{}
	v, ok := m.Get("requires")
	if !ok {
		return canon.Object{{Name: "postgres", Value: postgres}, {Name: "extensions", Value: extensions}}, nil
	}
	requires, ok := v.(canon.Object)
	if !ok {
		return nil, refuse(code, "%s must be an object", path)
	}
	if pv, ok := requires.Get("postgres"); ok {
		s, err := asString(pv, code, path+".postgres")
		if err != nil {
			return nil, err
		}
		postgres = s
	}
	if ev, ok := requires.Get("extensions"); ok {
		list, ok := ev.(canon.Array)
		if !ok {
			return nil, refuse(code, "%s.extensions must be a list", path)
		}
		type extension struct {
			name    string
			version canon.Value
		}
		exts := make([]extension, 0, len(list))
		for i, item := range list {
			obj, ok := item.(canon.Object)
			if !ok {
				return nil, refuse(code, "%s.extensions[%d] must be an object", path, i)
			}
			name, err := requiredString(obj, code, path+".extensions[]", "name")
			if err != nil {
				return nil, err
			}
			var version canon.Value = canon.Null{}
			if vv, ok := obj.Get("version"); ok {
				if version, err = asString(vv, code, path+".extensions[].version"); err != nil {
					return nil, err
				}
			}
			exts = append(exts, extension{name: string(name.(canon.String)), version: version})
		}
		slices.SortFunc(exts, func(a, b extension) int {
			switch {
			case a.name < b.name:
				return -1
			case a.name > b.name:
				return 1
			}
			return 0
		})
		for i := 1; i < len(exts); i++ {
			if exts[i].name == exts[i-1].name {
				// The order of two equal names would depend on input order.
				return nil, refuse(code, "%s.extensions lists %q more than once", path, exts[i].name)
			}
		}
		for _, e := range exts {
			extensions = append(extensions, canon.Object{
				{Name: "name", Value: canon.String(e.name)},
				{Name: "version", Value: e.version},
			})
		}
	}
	return canon.Object{{Name: "postgres", Value: postgres}, {Name: "extensions", Value: extensions}}, nil
}

// verifyProjection builds V = {"verification": {"expectations", "runtimeChecks"}}.
func verifyProjection(m canon.Object) (canon.Value, error) {
	const code = CodeInvalidManifest
	verification, err := requiredObject(m, code, "manifest", "verification")
	if err != nil {
		return nil, err
	}
	expectations, err := requiredString(verification, code, "manifest.verification", "expectations")
	if err != nil {
		return nil, err
	}
	runtimeChecks, err := requiredString(verification, code, "manifest.verification", "runtimeChecks")
	if err != nil {
		return nil, err
	}
	return canon.Object{{Name: "verification", Value: canon.Object{
		{Name: "expectations", Value: expectations},
		{Name: "runtimeChecks", Value: runtimeChecks},
	}}}, nil
}

// rollbackProjection builds R: {"rollback": null} without a rollback block,
// else {"rollback": {"script", "safety", "notes"}} with safety and notes as
// written or null.
func rollbackProjection(m canon.Object) (canon.Value, error) {
	const code = CodeInvalidManifest
	const path = "manifest.rollback"
	v, ok := m.Get("rollback")
	if !ok {
		return canon.Object{{Name: "rollback", Value: canon.Null{}}}, nil
	}
	rollback, ok := v.(canon.Object)
	if !ok {
		return nil, refuse(code, "%s must be an object", path)
	}
	script, err := requiredString(rollback, code, path, "script")
	if err != nil {
		return nil, err
	}
	optional := func(name string) (canon.Value, error) {
		mv, ok := rollback.Get(name)
		if !ok {
			return canon.Null{}, nil
		}
		return asString(mv, code, path+"."+name)
	}
	safety, err := optional("safety")
	if err != nil {
		return nil, err
	}
	notes, err := optional("notes")
	if err != nil {
		return nil, err
	}
	return canon.Object{{Name: "rollback", Value: canon.Object{
		{Name: "script", Value: script},
		{Name: "safety", Value: safety},
		{Name: "notes", Value: notes},
	}}}, nil
}

// Typed member access. Explicit null is a type error, never "not set":
// only an absent key means not set.

func asString(v canon.Value, code, path string) (canon.Value, error) {
	s, ok := v.(canon.String)
	if !ok {
		return nil, refuse(code, "%s must be a string", path)
	}
	return s, nil
}

func asStringArray(v canon.Value, code, path string) (canon.Array, error) {
	list, ok := v.(canon.Array)
	if !ok {
		return nil, refuse(code, "%s must be a list of strings", path)
	}
	out := make(canon.Array, 0, len(list))
	for i, item := range list {
		s, ok := item.(canon.String)
		if !ok {
			return nil, refuse(code, "%s[%d] must be a string", path, i)
		}
		out = append(out, s)
	}
	return out, nil
}

func requiredString(obj canon.Object, code, path, name string) (canon.Value, error) {
	v, ok := obj.Get(name)
	if !ok {
		return nil, refuse(code, "%s.%s is required", path, name)
	}
	return asString(v, code, path+"."+name)
}

func requiredObject(obj canon.Object, code, path, name string) (canon.Object, error) {
	v, ok := obj.Get(name)
	if !ok {
		return nil, refuse(code, "%s.%s is required", path, name)
	}
	o, ok := v.(canon.Object)
	if !ok {
		return nil, refuse(code, "%s.%s must be an object", path, name)
	}
	return o, nil
}
