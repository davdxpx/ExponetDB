package pgfiles

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestRenderFragment(t *testing.T) {
	got, err := RenderFragment([]Parameter{
		{Name: "shared_buffers", Value: "1GB"},
		{Name: "auto_explain.log_min_duration", Value: `it's \ fine`},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := FragmentHeader + "shared_buffers = '1GB'\nauto_explain.log_min_duration = 'it''s \\\\ fine'\n"
	if string(got) != want {
		t.Fatalf("%q", got)
	}
	for _, bad := range [][]Parameter{
		{{Name: "work_mem", Value: "1MB\nlisten_addresses = '*'"}},
		{{Name: "work_mem", Value: "1MB\r"}},
		{{Name: "work_mem", Value: "a\x00"}},
		{{Name: "work_mem", Value: "a\x7f"}},
		{{Name: "work_mem = 1", Value: "x"}},
		{{Name: "work_mem", Value: "1"}, {Name: "work_mem", Value: "2"}},
		{{Name: "include", Value: strings.Repeat("a", 1025)}},
	} {
		if _, err := RenderFragment(bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%v rendered", bad)
		}
	}
}

func s(v string) *string { return &v }

func TestRenderHbaBlock(t *testing.T) {
	got, err := RenderHbaBlock([]HbaRule{
		{Type: "local", Database: []string{"all"}, User: []string{"exponetdb_agent"}, Method: "peer", Map: s("exponetdb")},
		{Type: "hostssl", Database: []string{"app", "app_ro"}, User: []string{"app"}, Address: s("10.0.0.0/8"), Method: "scram-sha-256"},
		{Type: "hostssl", Database: []string{"all"}, User: []string{"all"}, Address: s("all"), Method: "reject"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := BeginMarker + ": written by exponetdb-node-helper, do not edit\n" +
		"local all exponetdb_agent peer map=exponetdb\n" +
		"hostssl app,app_ro app 10.0.0.0/8 scram-sha-256\n" +
		"hostssl all all all reject\n" + EndMarker + "\n"
	if string(got) != want {
		t.Fatalf("%q", got)
	}
	for _, bad := range []HbaRule{
		{Type: "host", Database: []string{"all"}, User: []string{"all"}, Address: s("all"), Method: "trust"},
		{Type: "hostssl", Database: []string{"all"}, User: []string{"all"}, Address: s("all"), Method: "trust"},
		{Type: "hostssl", Database: []string{"all"}, User: []string{"all"}, Method: "reject"},
		{Type: "local", Database: []string{"all"}, User: []string{"all"}, Address: s("all"), Method: "peer"},
		{Type: "hostssl", Database: []string{"all"}, User: []string{"all"}, Address: s("all"), Method: "peer"},
		{Type: "local", Database: []string{"all"}, User: []string{"all"}, Method: "reject", Map: s("m")},
		{Type: "local", Database: []string{"all x"}, User: []string{"all"}, Method: "peer"},
		{Type: "local", Database: []string{"@file"}, User: []string{"all"}, Method: "peer"},
		{Type: "local", Database: []string{"all"}, User: []string{"+admins"}, Method: "peer"},
		{Type: "local", Database: []string{}, User: []string{"all"}, Method: "peer"},
		{Type: "hostssl", Database: []string{"all"}, User: []string{"all"}, Address: s("0.0.0.0/0 trust\nhost"), Method: "reject"},
	} {
		if _, err := RenderHbaBlock([]HbaRule{bad}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%+v rendered", bad)
		}
	}
}

func TestSpliceHba(t *testing.T) {
	block, _ := RenderHbaBlock([]HbaRule{{Type: "local", Database: []string{"all"}, User: []string{"x"}, Method: "peer"}})
	foreign := "# comment\nlocal all postgres peer\n"
	got, err := SpliceHba([]byte(foreign), block)
	if err != nil || string(got) != string(block)+foreign {
		t.Fatalf("insert %q %v", got, err)
	}
	// In place, foreign lines around it kept byte for byte.
	around := "local all postgres peer\r\n" + BeginMarker + "\nold rule\n" + EndMarker + "\nhost all all ::1/128 scram-sha-256"
	got, err = SpliceHba([]byte(around), block)
	if err != nil || string(got) != "local all postgres peer\r\n"+string(block)+"host all all ::1/128 scram-sha-256" {
		t.Fatalf("replace %q %v", got, err)
	}
	b, _ := FindBlock(got)
	if !b.Present || b.Lines != 1 {
		t.Fatalf("block %+v", b)
	}
	for _, bad := range []string{
		BeginMarker + "\n",
		EndMarker + "\n",
		EndMarker + "\n" + BeginMarker + "\n",
		BeginMarker + "\n" + BeginMarker + "\n" + EndMarker + "\n",
		BeginMarker + "\n" + EndMarker + "\n" + EndMarker + "\n",
	} {
		if _, err := SpliceHba([]byte(bad), block); !errors.Is(err, ErrMarkers) {
			t.Fatalf("%q spliced", bad)
		}
	}
}

// FuzzSpliceHba: every line outside the managed block survives a splice
// unchanged and in order.
func FuzzSpliceHba(f *testing.F) {
	f.Add([]byte("local all postgres peer\n"))
	f.Add([]byte("a\n" + BeginMarker + "\nb\n" + EndMarker + "\nc"))
	block, _ := RenderHbaBlock([]HbaRule{{Type: "local", Database: []string{"all"}, User: []string{"x"}, Method: "peer"}})
	f.Fuzz(func(t *testing.T, file []byte) {
		before, err := FindBlock(file)
		if err != nil {
			return
		}
		out, err := SpliceHba(file, block)
		if err != nil {
			t.Fatal(err)
		}
		var prefix, suffix []byte
		if before.Present {
			prefix, suffix = file[:before.Start], file[before.End:]
		} else {
			suffix = file
		}
		if !bytes.HasPrefix(out, prefix) || !bytes.HasSuffix(out, suffix) ||
			!bytes.Equal(out[len(prefix):len(out)-len(suffix)], block) {
			t.Fatalf("foreign content changed: %q -> %q", file, out)
		}
		after, err := FindBlock(out)
		if err != nil || !after.Present {
			t.Fatalf("the spliced file has no single block: %v", err)
		}
	})
}
