package conformance

import (
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// Plan-hash refusal codes (operations-engine.md §3.1), in the order the
// checks run.
const (
	CodeUnknownMember = "unknown_member"
	CodeMissingMember = "missing_member"
	CodeInvalidPlanID = "invalid_plan_id"

	// CodeInvalidPlan is not named by the specification: the hashed object
	// is not a JSON object at all.
	CodeInvalidPlan = "invalid_plan"
)

// planMembers lists the binding members of the hashed object B: true for a
// member that is always present, false for one that is present only when
// the kind or the plan uses it. planHash, state and every lifecycle, display
// or approval field of the plan row are deliberately absent.
var planMembers = map[string]bool{
	"id":              true,
	"kind":            true,
	"kindVersion":     true,
	"createdAt":       true,
	"expiresAt":       true,
	"actor":           true,
	"client":          true,
	"subject":         true,
	"content":         true,
	"contentChecksum": true,
	"policy":          true,
	"expectedState":   false,
	"analysis":        false,
	"evidence":        false,
}

// requiredPlanMembers is the order in which missing members are reported.
var requiredPlanMembers = []string{
	"id", "kind", "kindVersion", "createdAt", "expiresAt", "actor",
	"client", "subject", "content", "contentChecksum", "policy",
}

// PlanHash computes the plan hash of the binding object B: it returns JCS(B)
// and "sha256:" followed by the lowercase hexadecimal SHA-256 of it. B is
// refused when it has a member outside the binding set (unknown_member), lacks
// a required member (missing_member) or has an id that is not a canonical
// pln_ id (invalid_plan_id), checked in this order, so that a new binding
// field cannot silently stay outside the hash.
func PlanHash(b canon.Value) (canonical []byte, hash string, err error) {
	obj, ok := b.(canon.Object)
	if !ok {
		return nil, "", refuse(CodeInvalidPlan, "the plan must be a JSON object")
	}
	for _, m := range obj {
		if _, known := planMembers[m.Name]; !known {
			return nil, "", refuse(CodeUnknownMember, "member %q is not a plan binding member", m.Name)
		}
	}
	for _, name := range requiredPlanMembers {
		if _, ok := obj.Get(name); !ok {
			return nil, "", refuse(CodeMissingMember, "required member %q is missing", name)
		}
	}
	id, _ := obj.Get("id")
	idText, ok := id.(canon.String)
	if !ok {
		return nil, "", refuse(CodeInvalidPlanID, "id must be a string")
	}
	if err := ValidateID(string(idText), "pln"); err != nil {
		return nil, "", refuse(CodeInvalidPlanID, "id %q: %v", string(idText), err)
	}
	canonical, err = canon.Canonicalize(obj)
	if err != nil {
		return nil, "", err
	}
	return canonical, "sha256:" + sha256Hex(canonical), nil
}
