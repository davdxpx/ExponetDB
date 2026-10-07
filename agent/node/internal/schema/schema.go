// Package schema validates node protocol values against the JSON Schema
// generated from packages/contracts (embedded as protocol.Schema), plus the
// cross-member rules the contract states as refinements (refine.go). It
// implements exactly the keywords the generated document uses and refuses to
// load a document with any other keyword, so a contract change that needs a
// new keyword fails the build instead of being ignored.
//
// The agent validates every job's arguments with it before executing
// anything (protocol.md §4.2 step 6, security.md §2.7).
package schema

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
)

// Annotation keywords carry no validation.
var annotations = map[string]bool{
	"description": true, "untrusted": true, "$schema": true, "$id": true,
	"$comment": true, "title": true, "format": true,
}

// Validation keywords this package implements.
var keywords = map[string]bool{
	"type": true, "$ref": true, "anyOf": true, "properties": true, "required": true,
	"additionalProperties": true, "propertyNames": true, "items": true,
	"minItems": true, "maxItems": true, "minLength": true, "maxLength": true,
	"pattern": true, "enum": true, "const": true, "minimum": true, "maximum": true,
	"x-exponetdb-raw-json": true,
}

// Validator validates values against the definitions of one document.
type Validator struct {
	defs         map[string]canon.Object
	patterns     map[string]*regexp.Regexp
	capabilities map[string][2]string
	sealed       map[string][][2]string
	limits       map[string][2]time.Duration
	messages     map[string]string
}

// Error is a validation failure at a JSON pointer.
type Error struct {
	Path   string
	Reason string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Path, e.Reason) }

func fail(path, format string, args ...any) error {
	if path == "" {
		path = "/"
	}
	return &Error{Path: path, Reason: fmt.Sprintf(format, args...)}
}

// New loads a schema document and checks that it uses supported keywords only.
func New(document []byte) (*Validator, error) {
	doc, err := canon.Parse(document)
	if err != nil {
		return nil, err
	}
	root, ok := doc.(canon.Object)
	if !ok {
		return nil, errors.New("schema: not an object")
	}
	v := &Validator{defs: map[string]canon.Object{}, patterns: map[string]*regexp.Regexp{}, capabilities: map[string][2]string{}, sealed: map[string][][2]string{}, limits: map[string][2]time.Duration{}}
	defs, _ := root.Get("$defs")
	defObject, ok := defs.(canon.Object)
	if !ok {
		return nil, errors.New("schema: no $defs")
	}
	for _, m := range defObject {
		o, ok := m.Value.(canon.Object)
		if !ok {
			return nil, fmt.Errorf("schema: $defs/%s is not an object", m.Name)
		}
		v.defs[m.Name] = o
	}
	for name, def := range v.defs {
		if err := v.check(def, "#/$defs/"+name); err != nil {
			return nil, err
		}
	}
	v.messages = map[string]string{}
	if msgs, ok := root.Get("x-exponetdb-messages"); ok {
		msgObject, _ := msgs.(canon.Object)
		for _, m := range msgObject {
			entry, _ := m.Value.(canon.Object)
			r, _ := entry.Get("$ref")
			if ref, isString := r.(canon.String); isString {
				v.messages[m.Name] = string(ref)
			}
		}
	}
	if caps, ok := root.Get("x-exponetdb-capabilities"); ok {
		capObject, ok := caps.(canon.Object)
		if !ok {
			return nil, errors.New("schema: capabilities is not an object")
		}
		for _, m := range capObject {
			entry, _ := m.Value.(canon.Object)
			args, _ := refOf(entry, "args")
			result, _ := refOf(entry, "result")
			if args == "" || result == "" {
				return nil, fmt.Errorf("schema: capability %s without args or result", m.Name)
			}
			v.capabilities[m.Name] = [2]string{args, result}
			run, _ := entry.Get("runSeconds")
			settle, _ := entry.Get("settleSeconds")
			rn, ok1 := run.(canon.Number)
			sn, ok2 := settle.(canon.Number)
			if !ok1 || !ok2 || rn <= 0 || sn <= 0 {
				return nil, fmt.Errorf("schema: capability %s without its run and settle limits", m.Name)
			}
			v.limits[m.Name] = [2]time.Duration{time.Duration(rn) * time.Second, time.Duration(sn) * time.Second}
			fields, _ := entry.Get("sealedFields")
			list, _ := fields.(canon.Array)
			for _, f := range list {
				fo, _ := f.(canon.Object)
				path, _ := fo.Get("path")
				field, _ := fo.Get("field")
				p, ok1 := path.(canon.String)
				fn, ok2 := field.(canon.String)
				if !ok1 || !ok2 {
					return nil, fmt.Errorf("schema: capability %s has an invalid sealed field", m.Name)
				}
				v.sealed[m.Name] = append(v.sealed[m.Name], [2]string{string(p), string(fn)})
			}
		}
	}
	return v, nil
}

// Protocol returns the validator for the embedded node protocol schema.
func Protocol() (*Validator, error) { return New(protocol.Schema) }

func refOf(o canon.Object, member string) (string, bool) {
	inner, _ := o.Get(member)
	io, ok := inner.(canon.Object)
	if !ok {
		return "", false
	}
	r, _ := io.Get("$ref")
	s, ok := r.(canon.String)
	return string(s), ok
}

// check walks a schema, compiles its patterns and refuses unknown keywords.
func (v *Validator) check(s canon.Object, at string) error {
	for _, m := range s {
		if !keywords[m.Name] && !annotations[m.Name] {
			return fmt.Errorf("schema: %s uses the unsupported keyword %q", at, m.Name)
		}
		switch m.Name {
		case "pattern":
			p, ok := m.Value.(canon.String)
			if !ok {
				return fmt.Errorf("schema: %s pattern", at)
			}
			re, err := regexp.Compile(string(p))
			if err != nil {
				return fmt.Errorf("schema: %s pattern: %v", at, err)
			}
			v.patterns[string(p)] = re
		case "$ref":
			r, _ := m.Value.(canon.String)
			if _, ok := v.defs[strings.TrimPrefix(string(r), "#/$defs/")]; !ok {
				return fmt.Errorf("schema: %s refers to unknown %s", at, r)
			}
		case "properties":
			props, ok := m.Value.(canon.Object)
			if !ok {
				return fmt.Errorf("schema: %s properties", at)
			}
			for _, p := range props {
				sub, ok := p.Value.(canon.Object)
				if !ok {
					return fmt.Errorf("schema: %s/%s", at, p.Name)
				}
				if err := v.check(sub, at+"/properties/"+p.Name); err != nil {
					return err
				}
			}
		case "items", "propertyNames":
			sub, ok := m.Value.(canon.Object)
			if !ok {
				return fmt.Errorf("schema: %s %s", at, m.Name)
			}
			if err := v.check(sub, at+"/"+m.Name); err != nil {
				return err
			}
		case "additionalProperties":
			if sub, ok := m.Value.(canon.Object); ok {
				if err := v.check(sub, at+"/additionalProperties"); err != nil {
					return err
				}
			}
		case "anyOf":
			list, ok := m.Value.(canon.Array)
			if !ok {
				return fmt.Errorf("schema: %s anyOf", at)
			}
			for i, item := range list {
				sub, ok := item.(canon.Object)
				if !ok {
					return fmt.Errorf("schema: %s anyOf", at)
				}
				if err := v.check(sub, at+"/anyOf/"+strconv.Itoa(i)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// MessageRef returns the definition of a protocol message by its name.
func (v *Validator) MessageRef(name string) (string, bool) {
	r, ok := v.messages[name]
	return r, ok
}

// SealedFields returns the (path, field) pairs of a capability's arguments
// that must hold sealed values.
func (v *Validator) SealedFields(key string) [][2]string { return v.sealed[key] }

// Limits returns how long a job of name@major runs after its start, and how
// long an effect it began can still land after it ended (contracts
// runSeconds and settleSeconds); zero for an unknown capability.
func (v *Validator) Limits(key string) (run, settle time.Duration) {
	l := v.limits[key]
	return l[0], l[1]
}

// CapabilityRefs returns the argument and result definitions of name@major.
func (v *Validator) CapabilityRefs(key string) (args, result string, ok bool) {
	r, ok := v.capabilities[key]
	return r[0], r[1], ok
}

// Validate checks value against the definition ref ("#/$defs/...").
func (v *Validator) Validate(ref string, value canon.Value) error {
	def, ok := v.defs[strings.TrimPrefix(ref, "#/$defs/")]
	if !ok {
		return fmt.Errorf("schema: unknown definition %s", ref)
	}
	return v.validate(def, value, "")
}

func number(n canon.Value) (float64, bool) {
	f, ok := n.(canon.Number)
	return float64(f), ok
}

func typeOf(value canon.Value) string {
	switch x := value.(type) {
	case canon.Null:
		return "null"
	case canon.Bool:
		return "boolean"
	case canon.String:
		return "string"
	case canon.Array:
		return "array"
	case canon.Object:
		return "object"
	case canon.Number:
		f := float64(x)
		if f == math.Trunc(f) && math.Abs(f) <= 9007199254740991 {
			return "integer"
		}
		return "number"
	}
	return "unknown"
}

func typeMatches(want string, value canon.Value) bool {
	got := typeOf(value)
	return got == want || (want == "number" && got == "integer")
}

func equal(a, b canon.Value) bool {
	x, err1 := canon.Canonicalize(a)
	y, err2 := canon.Canonicalize(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

func (v *Validator) validate(s canon.Object, value canon.Value, path string) error {
	if raw, ok := s.Get("x-exponetdb-raw-json"); ok && raw == canon.Value(canon.Bool(true)) {
		return nil
	}
	if r, ok := s.Get("$ref"); ok {
		ref, _ := r.(canon.String)
		return v.validate(v.defs[strings.TrimPrefix(string(ref), "#/$defs/")], value, path)
	}
	if alternatives, ok := s.Get("anyOf"); ok {
		list, _ := alternatives.(canon.Array)
		var first error
		for _, item := range list {
			sub, _ := item.(canon.Object)
			err := v.validate(sub, value, path)
			if err == nil {
				return nil
			}
			if first == nil {
				first = err
			}
		}
		return first
	}
	if t, ok := s.Get("type"); ok {
		var allowed []string
		switch x := t.(type) {
		case canon.String:
			allowed = []string{string(x)}
		case canon.Array:
			for _, item := range x {
				name, _ := item.(canon.String)
				allowed = append(allowed, string(name))
			}
		}
		matched := false
		for _, want := range allowed {
			if typeMatches(want, value) {
				matched = true
				break
			}
		}
		if !matched {
			return fail(path, "expected %s, got %s", strings.Join(allowed, " or "), typeOf(value))
		}
	}
	if c, ok := s.Get("const"); ok && !equal(c, value) {
		return fail(path, "not the constant value")
	}
	if e, ok := s.Get("enum"); ok {
		list, _ := e.(canon.Array)
		found := false
		for _, item := range list {
			if equal(item, value) {
				found = true
				break
			}
		}
		if !found {
			return fail(path, "not one of the allowed values")
		}
	}
	switch x := value.(type) {
	case canon.String:
		return v.validateString(s, string(x), path)
	case canon.Number:
		if min, ok := s.Get("minimum"); ok {
			if m, _ := number(min); float64(x) < m {
				return fail(path, "below the minimum")
			}
		}
		if max, ok := s.Get("maximum"); ok {
			if m, _ := number(max); float64(x) > m {
				return fail(path, "above the maximum")
			}
		}
	case canon.Array:
		if min, ok := s.Get("minItems"); ok {
			if m, _ := number(min); float64(len(x)) < m {
				return fail(path, "fewer than %v items", m)
			}
		}
		if max, ok := s.Get("maxItems"); ok {
			if m, _ := number(max); float64(len(x)) > m {
				return fail(path, "more than %v items", m)
			}
		}
		if items, ok := s.Get("items"); ok {
			sub, _ := items.(canon.Object)
			for i, item := range x {
				if err := v.validate(sub, item, path+"/"+strconv.Itoa(i)); err != nil {
					return err
				}
			}
		}
	case canon.Object:
		return v.validateObject(s, x, path)
	}
	return nil
}

func (v *Validator) validateString(s canon.Object, x, path string) error {
	n := float64(utf8.RuneCountInString(x))
	if min, ok := s.Get("minLength"); ok {
		if m, _ := number(min); n < m {
			return fail(path, "shorter than %v", m)
		}
	}
	if max, ok := s.Get("maxLength"); ok {
		if m, _ := number(max); n > m {
			return fail(path, "longer than %v", m)
		}
	}
	if p, ok := s.Get("pattern"); ok {
		ps, _ := p.(canon.String)
		if !v.patterns[string(ps)].MatchString(x) {
			return fail(path, "does not match its pattern")
		}
	}
	return nil
}

func pointerEscape(name string) string {
	return strings.ReplaceAll(strings.ReplaceAll(name, "~", "~0"), "/", "~1")
}

func (v *Validator) validateObject(s canon.Object, x canon.Object, path string) error {
	props, _ := s.Get("properties")
	propObject, _ := props.(canon.Object)
	if req, ok := s.Get("required"); ok {
		list, _ := req.(canon.Array)
		for _, r := range list {
			name, _ := r.(canon.String)
			if _, present := x.Get(string(name)); !present {
				return fail(path, "missing member %q", string(name))
			}
		}
	}
	extra, _ := s.Get("additionalProperties")
	names, _ := s.Get("propertyNames")
	for _, m := range x {
		at := path + "/" + pointerEscape(m.Name)
		if names != nil {
			sub, _ := names.(canon.Object)
			if err := v.validate(sub, canon.String(m.Name), at); err != nil {
				return err
			}
		}
		if sub, declared := propObject.Get(m.Name); declared {
			subObject, _ := sub.(canon.Object)
			if err := v.validate(subObject, m.Value, at); err != nil {
				return err
			}
			continue
		}
		switch e := extra.(type) {
		case canon.Bool:
			if !bool(e) {
				return fail(at, "unknown member")
			}
		case canon.Object:
			if err := v.validate(e, m.Value, at); err != nil {
				return err
			}
		}
	}
	return nil
}
