package schema

import (
	"fmt"
	"strconv"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// The rules a JSON Schema cannot state, as packages/contracts states them in
// refinements (capabilities.ts). Shared fixtures in
// tooling/fixtures/node-capabilities-invalid keep both implementations equal.

// roleStepMembers is ROLE_STEP_MEMBERS: the members each role step requires
// and may carry besides op and role; every other member must be null.
var roleStepMembers = map[string]struct{ required, optional []string }{
	"create_role":        {required: []string{"attributes"}},
	"alter_role":         {required: []string{"attributes"}},
	"set_password":       {required: []string{"verifier"}},
	"clear_password":     {},
	"grant_membership":   {required: []string{"member", "admin", "inherit", "set"}},
	"revoke_membership":  {required: []string{"member"}},
	"set_role_setting":   {required: []string{"setting", "value"}, optional: []string{"database"}},
	"reset_role_setting": {required: []string{"setting"}, optional: []string{"database"}},
}

var roleStepOptional = []string{"attributes", "verifier", "member", "admin", "inherit", "set", "database", "setting", "value"}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func present(o canon.Object, name string) bool {
	v, ok := o.Get(name)
	if !ok {
		return false
	}
	_, isNull := v.(canon.Null)
	return !isNull
}

func str(o canon.Object, name string) string {
	v, _ := o.Get(name)
	s, _ := v.(canon.String)
	return string(s)
}

func array(o canon.Object, name string) canon.Array {
	v, _ := o.Get(name)
	a, _ := v.(canon.Array)
	return a
}

// Refine applies the cross-member rules of a capability's arguments, after
// they passed the schema.
func Refine(key string, args canon.Object) error {
	switch key {
	case "postgres.roles.apply@1":
		for i, item := range array(args, "steps") {
			step, _ := item.(canon.Object)
			op := str(step, "op")
			rule := roleStepMembers[op]
			for _, m := range roleStepOptional {
				at := "/steps/" + strconv.Itoa(i) + "/" + m
				switch {
				case contains(rule.required, m) && !present(step, m):
					return fail(at, "%s needs %s", op, m)
				case !contains(rule.required, m) && !contains(rule.optional, m) && present(step, m):
					return fail(at, "%s takes no %s", op, m)
				}
			}
		}
	case "postgres.hba.apply@1":
		for i, item := range array(args, "managedRules") {
			rule, _ := item.(canon.Object)
			at := "/managedRules/" + strconv.Itoa(i)
			local := str(rule, "type") == "local"
			switch {
			case local == present(rule, "address"):
				return fail(at, "local rules have no address; hostssl rules need one")
			case present(rule, "map") && str(rule, "method") != "peer":
				return fail(at, "only peer rules take a map")
			case str(rule, "method") == "peer" && !local:
				return fail(at, "peer is for local rules only")
			}
		}
	case "postgres.extensions.apply@1":
		for i, item := range array(args, "steps") {
			step, _ := item.(canon.Object)
			if (str(step, "op") == "create") != present(step, "schema") {
				return fail("/steps/"+strconv.Itoa(i), "create needs a schema; update takes none")
			}
		}
	case "log.inspect@1":
		if (str(args, "source") == "postgresql") != present(args, "cluster") {
			return fail("/cluster", "postgresql logs need a cluster; agent and helper logs take none")
		}
		since, err1 := time.Parse(time.RFC3339Nano, str(args, "since"))
		until, err2 := time.Parse(time.RFC3339Nano, str(args, "until"))
		if err1 != nil || err2 != nil || !since.Before(until) {
			return fail("/since", "since must be before until")
		}
	}
	return nil
}

// ValidateArgs validates a job's arguments for name@major: the schema, then
// the refinements. It returns an error for a capability outside the catalog.
func (v *Validator) ValidateArgs(key string, args canon.Value) error {
	ref, _, ok := v.CapabilityRefs(key)
	if !ok {
		return fmt.Errorf("schema: no capability %s", key)
	}
	if err := v.Validate(ref, args); err != nil {
		return err
	}
	o, _ := args.(canon.Object)
	return Refine(key, o)
}

// ValidateResult validates a capability result against its schema.
func (v *Validator) ValidateResult(key string, result canon.Value) error {
	_, ref, ok := v.CapabilityRefs(key)
	if !ok {
		return fmt.Errorf("schema: no capability %s", key)
	}
	return v.Validate(ref, result)
}
