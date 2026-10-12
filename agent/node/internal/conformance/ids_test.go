package conformance

import "testing"

type idVector struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Value       string `json:"value"`
	Kind        string `json:"kind"`
	Valid       *bool  `json:"valid"`
	Reason      string `json:"reason"`
}

func TestGoldenIDs(t *testing.T) {
	vectors := loadVectors[idVector](t, "ids.json")
	ids := make([]string, len(vectors))
	for i, v := range vectors {
		ids[i] = v.ID
	}
	checkUniqueIDs(t, ids)
	for _, v := range vectors {
		t.Run(v.ID, func(t *testing.T) {
			if v.Valid == nil || v.Kind == "" {
				t.Fatal("vector needs kind and valid")
			}
			if *v.Valid != (v.Reason == "") {
				t.Fatal("a valid vector has no reason and an invalid one has exactly one")
			}
			err := ValidateID(v.Value, v.Kind)
			if *v.Valid {
				if err != nil {
					t.Fatalf("ValidateID(%q, %q) = %v; want valid", v.Value, v.Kind, err)
				}
				return
			}
			if got := errorCode(err); got != v.Reason {
				t.Fatalf("ValidateID(%q, %q) = %v; want reason %s", v.Value, v.Kind, err, v.Reason)
			}
		})
	}
	t.Logf("ids.json: %d vectors", len(vectors))
}

func TestValidateIDUnknownKind(t *testing.T) {
	if got := errorCode(ValidateID("tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", "nope")); got != CodeUnknownKind {
		t.Fatalf("got %q, want %s", got, CodeUnknownKind)
	}
}

func TestValidateIDEveryPrefix(t *testing.T) {
	const ulid = "01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	for p := range idPrefixes {
		if err := ValidateID(p+"_"+ulid, p); err != nil {
			t.Errorf("prefix %s: %v", p, err)
		}
	}
	if len(idPrefixes) != 42 {
		t.Fatalf("got %d prefixes; want the 41 of domain-model.md §2 plus req", len(idPrefixes))
	}
}
