package helper

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// NewRefusingHelper is a helper without trust (for the socket tests).
func NewRefusingHelper(t *testing.T, dir string) *Helper {
	clk := &clock.Fixed{T: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC), Synced: true}
	ledger, err := journal.OpenLedger(dir, "effects.log", clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })
	sv, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	return &Helper{
		Config: &config.Config{Schema: config.Schema}, Schema: sv, Clock: clk, Ledger: ledger,
		Runner: &fakeRunner{}, TrustPath: filepath.Join(dir, "missing-trust.json"),
	}
}
