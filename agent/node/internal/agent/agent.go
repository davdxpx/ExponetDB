// Package agent is the node agent's main loop (architecture.md §3,
// protocol.md §2 to §4): hello, heartbeats, claiming jobs, the verification
// pipeline, journaling before every step, executing a capability, signing
// (nr1) and buffering the completion until the gateway acknowledges it.
// After a restart, jobs that started without completing are reported in
// hello and never resumed.
package agent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/enroll"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/transport"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// HelperCaller calls the root helper with a signed job envelope.
type HelperCaller interface {
	Call(ctx context.Context, op string, envelope canon.Object) (canon.Object, error)
}

// Options configure an agent.
type Options struct {
	Config  *config.Config
	Store   *state.Store
	Version string
	Clock   clock.Clock
	Host    Host
	Schema  *schema.Validator
	Logger  *slog.Logger
	// Capabilities beyond the built-in ones (Phase 5).
	Capabilities []Capability
	// Helper is the root helper; config.update@1 updates its trust first.
	// nil only in tests without a helper.
	Helper HelperCaller
	// Inventory reports the local PostgreSQL instances for hello (Phase 5);
	// nil reports none.
	Inventory func() []protocol.LocalCluster
	// Test settings; zero values are the protocol's.
	ClaimWait         int
	HeartbeatInterval time.Duration
	ProgressInterval  time.Duration
	StartDeadline     time.Duration
	// RunLimit overrides every capability's run limit (tests only).
	RunLimit time.Duration
	// Dial overrides the gateway URL of the state (tests only).
	Dial string
	// Boundary is called at a job's consequential boundaries (end-to-end
	// builds only, for failure injection; nil in a release): "accepted"
	// (journaled, start not yet acknowledged), "effect" (the effect step
	// journaled, the host not yet changed), "executed" (the capability
	// returned, its statement not yet stored) and "stored" (the statement
	// stored, the completion not yet journaled).
	Boundary func(capability, point string)
}

// Agent is a running node agent.
type Agent struct {
	o        Options
	version  string
	log      *slog.Logger
	registry *Registry
	journal  *journal.Journal
	nonces   *journal.Nonces
	buffer   *Buffer
	broken   error
	// lastCompaction survives sessions, so a forced reconnect does not
	// compact again (compaction is daily).
	lastCompaction time.Time

	mu     sync.Mutex
	st     *state.State
	id     *state.Identity
	client *transport.Client
	skewMs int64
	errs   []string
	renew  bool
	redial bool
}

// New loads the state and opens the journal. A journal that fails its check,
// or replay state that is missing after enrollment initialized it, does not
// stop the agent: it keeps reporting, and refuses every job with
// journal_corrupt until a local operator repairs it. Never is a missing
// replay file created here (architecture.md §4).
func New(o Options) (*Agent, error) {
	if o.ClaimWait == 0 {
		o.ClaimWait = 25
	}
	if o.HeartbeatInterval == 0 {
		o.HeartbeatInterval = 15 * time.Second
	}
	if o.ProgressInterval == 0 {
		o.ProgressInterval = 15 * time.Second
	}
	if o.StartDeadline == 0 {
		o.StartDeadline = 60 * time.Second
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	st, err := o.Store.LoadState()
	if err != nil {
		return nil, err
	}
	id, err := o.Store.LoadIdentity()
	if err != nil {
		return nil, err
	}
	a := &Agent{o: o, version: o.Version, log: o.Logger, st: st, id: id,
		buffer: &Buffer{dir: o.Store.Path(state.BufferDir)}}
	dir := o.Store.Path(state.JournalDir)
	var jerr, nerr error
	a.journal, jerr = journal.Open(dir, o.Clock.Now)
	a.nonces, nerr = journal.OpenNonces(dir, o.Clock.Now)
	a.broken = errors.Join(jerr, nerr)
	switch {
	case errors.Is(a.broken, journal.ErrMissing):
		a.log.Error("replay state missing: the node is enrolled, so its journal or nonce cache was lost; every job is refused "+
			"(exponetdb-node journal init only for a node that never accepted a job, otherwise enroll again; node-runbook.md)",
			"error", a.broken.Error())
		a.note(a.broken)
	case a.broken != nil:
		a.log.Error("journal check failed; every job is refused until a local operator repairs it", "error", a.broken.Error())
		a.note(a.broken)
	default:
		a.recover()
	}
	a.lastCompaction = o.Clock.Now()
	a.registry = NewRegistry(o.Config, append([]Capability{diagnostics{a}, configUpdate{a}}, o.Capabilities...)...)
	if err := a.connect(); err != nil {
		return nil, err
	}
	return a, nil
}

// recover closes what a crash or stop left open (protocol.md §4.4): a job
// accepted but never started is abandoned and gets its one statement
// (rejected, start_unacknowledged), delivered by the first session; a job
// that started is closed as interrupted and reported in hello. Nothing is
// resumed. The caller holds the state directory lock.
func (a *Agent) recover() {
	unstarted, interrupted, err := a.journal.Recover(a.storedOutcome)
	if err != nil {
		a.note(err)
		return
	}
	for _, id := range unstarted {
		if err := a.journal.Abandon(id); err != nil {
			a.note(err)
			return
		}
		a.statement(nil, id, a.journal.ArgsHash(id), "rejected", verify.StartUnacknowledged, nil, nil, nil)
	}
	// A job cut off by the crash gets its one statement too: failed, with the
	// steps it journaled, so the Control Plane learns that this run is over
	// and, from the effect step, whether the host may have changed
	// (control-plane.md §9.4). It is never resumed.
	for _, id := range interrupted {
		var steps []protocol.JobStep
		for _, s := range a.journal.Steps(id) {
			steps = append(steps, protocol.JobStep{Index: int64(s.Index), Name: s.Name, State: s.State, At: s.At})
		}
		msg := "interrupted: the agent stopped while running this job; it is never resumed"
		a.statement(nil, id, a.journal.ArgsHash(id), "failed", "", nil, steps, &msg)
	}
}

// storedOutcome reports the outcome of a job's stored statement, if any.
func (a *Agent) storedOutcome(jobID string) (string, bool) {
	if !a.buffer.Has(jobID) {
		return "", false
	}
	data, err := a.buffer.Get(jobID)
	if err != nil {
		return "", false
	}
	var req struct {
		Outcome string `json:"outcome"`
	}
	if json.Unmarshal(data, &req) != nil || req.Outcome == "" {
		return "", false
	}
	return req.Outcome, true
}

func (a *Agent) boundary(capability, point string) {
	if a.o.Boundary != nil {
		a.o.Boundary(capability, point)
	}
}

func (a *Agent) connect() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	rootDER, _ := nodecrypto.FromB64U(a.st.RootCertificate)
	root, err := x509.ParseCertificate(rootDER)
	if err != nil {
		return fmt.Errorf("agent: stored root: %w", err)
	}
	cert, err := enroll.TLSCertificate(a.id)
	if err != nil {
		return err
	}
	url := a.st.GatewayURL
	if a.o.Dial != "" {
		url = a.o.Dial
	}
	if a.client != nil {
		a.client.Close()
	}
	a.client, err = transport.NewSessionClient(url, a.st.GatewayServerName, root, cert, a.version, a.o.Schema)
	return err
}

func (a *Agent) currentState() *state.State {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.st
}

func (a *Agent) replaceState(next *state.State) error {
	if err := a.o.Store.SaveState(next); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.redial = a.redial || next.GatewayURL != a.st.GatewayURL || next.GatewayServerName != a.st.GatewayServerName
	a.st = next
	return nil
}

// clean makes host-derived text safe to sign and send: control characters
// other than newline and tab become spaces (U+0000 cannot be stored by the
// Control Plane), invalid UTF-8 is replaced, and the text is cut to max
// bytes on a character boundary.
func clean(msg string, max int) string {
	msg = strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(msg, "\uFFFD"))
	if len(msg) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut]
	}
	return msg
}

func (a *Agent) note(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.errs = append(a.errs, clean(err.Error(), 512))
	if len(a.errs) > 16 {
		a.errs = a.errs[len(a.errs)-16:]
	}
}

func (a *Agent) lastErrors() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string{}, a.errs...)
}

func (a *Agent) conn() *transport.Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client
}

func (a *Agent) now() time.Time { return a.o.Clock.Now() }

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// Run keeps a session with the gateway until ctx ends, reconnecting with
// exponential backoff and jitter (1 s to 60 s).
func (a *Agent) Run(ctx context.Context) error {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := a.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			a.note(err)
			a.log.Warn("session ended", "error", err.Error())
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		backoff = min(backoff*2, time.Minute)
	}
	return nil
}

func (a *Agent) session(ctx context.Context) error {
	if a.takeRedial() {
		if err := a.connect(); err != nil {
			return err
		}
	}
	if err := a.hello(ctx); err != nil {
		return err
	}
	a.deliverBuffered(ctx)
	sctx, stop := context.WithCancel(ctx)
	defer stop()
	go a.heartbeats(sctx)
	for sctx.Err() == nil {
		if err := a.maybeRenew(sctx); err != nil {
			return err
		}
		if now := a.now(); now.Sub(a.lastCompaction) > 24*time.Hour || now.Before(a.lastCompaction) {
			a.compact()
			a.lastCompaction = now
		}
		envelope, err := a.claim(sctx)
		if err != nil {
			return err
		}
		if envelope != nil {
			a.handle(sctx, envelope)
		}
		a.deliverBuffered(sctx)
		if a.takeRedialPeek() {
			return errors.New("agent: the gateway address changed; reconnecting")
		}
	}
	return nil
}

func (a *Agent) takeRedial() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := a.redial
	a.redial = false
	return r
}

func (a *Agent) takeRedialPeek() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.redial
}

// compact forgets what lies before the cutoff, which follows the highest
// accepted issuedAt (signed by the worker), never the host clock alone.
func (a *Agent) compact() {
	if a.broken != nil {
		return
	}
	highest := a.highestIssuedAt()
	if err := a.journal.Compact(journal.Retention, highest); err != nil {
		a.note(err)
	}
	if err := a.nonces.Compact(highest); err != nil {
		a.note(err)
	}
}

func (a *Agent) highestIssuedAt() time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.st.HighestIssuedAt == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, a.st.HighestIssuedAt)
	return t
}

func (a *Agent) hello(ctx context.Context) error {
	facts, err := a.o.Host.Facts()
	if err != nil {
		return err
	}
	inFlight := []protocol.HelloRequestJournalInFlightItem{}
	if a.broken == nil {
		for _, j := range a.journal.InFlight() {
			inFlight = append(inFlight, protocol.HelloRequestJournalInFlightItem{JobID: j.JobID, State: "started", LastStep: int64(j.LastStep)})
		}
	}
	clusters := []protocol.LocalCluster{}
	if a.o.Inventory != nil {
		clusters = a.o.Inventory()
	}
	st := a.currentState()
	var resp protocol.HelloResponse
	if err := a.conn().Post(ctx, transport.EndpointHello, "HelloRequest", protocol.HelloRequest{
		NodeID: st.NodeID, AgentVersion: a.version, ProtocolMajors: []int64{1},
		Capabilities: a.registry.Reported(), Clusters: clusters, Host: facts,
		Clock:   protocol.HelloRequestClock{AgentTime: stamp(a.now())},
		Journal: protocol.HelloRequestJournal{InFlight: inFlight},
	}, "HelloResponse", &resp, transport.MaxRequestBytes); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	if resp.ProtocolMajor != 1 {
		return fmt.Errorf("hello: the gateway chose protocol major %d", resp.ProtocolMajor)
	}
	a.observeServerTime(resp.ServerTime)
	if resp.Instructions.RenewCertificate {
		a.mu.Lock()
		a.renew = true
		a.mu.Unlock()
	}
	return nil
}

// observeServerTime records the skew to the gateway's clock; it is reported,
// never used to judge a job (ADR-0024 §5).
func (a *Agent) observeServerTime(s string) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		a.mu.Lock()
		a.skewMs = t.Sub(a.now()).Milliseconds()
		a.mu.Unlock()
	}
}

func (a *Agent) maybeRenew(ctx context.Context) error {
	a.mu.Lock()
	id, st, asked := a.id, a.st, a.renew
	a.mu.Unlock()
	due, err := enroll.DueForRenewal(id, a.now())
	if err != nil || (!due && !asked) {
		return err
	}
	next, err := enroll.Renew(ctx, a.conn(), st, id, a.now(), nil)
	if err != nil {
		a.note(err)
		return nil // retried at the next turn; the node turns degraded on the control plane if it keeps failing
	}
	if err := a.o.Store.SaveIdentity(next); err != nil {
		return err
	}
	cert, err := enroll.TLSCertificate(next)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.id, a.renew = next, false
	a.mu.Unlock()
	a.conn().SetCertificate(cert)
	a.log.Info("certificate renewed", "expiresAt", next.CertificateExpiresAt)
	return nil
}

func (a *Agent) heartbeats(ctx context.Context) {
	t := time.NewTicker(a.o.HeartbeatInterval)
	defer t.Stop()
	for {
		if err := a.heartbeat(ctx); err != nil && ctx.Err() == nil {
			a.note(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (a *Agent) heartbeat(ctx context.Context) error {
	st := a.currentState()
	mounts := []string{"/", a.o.Config.StateDirectory}
	for _, in := range a.o.Config.Instances {
		mounts = append(mounts, in.DataDirectory)
	}
	host, err := a.o.Host.Metrics(mounts)
	if err != nil {
		return err
	}
	inFlight := []string{}
	if a.broken == nil {
		for _, j := range a.journal.InFlight() {
			inFlight = append(inFlight, j.JobID)
		}
	}
	a.mu.Lock()
	skew, expires := a.skewMs, a.id.CertificateExpiresAt
	a.mu.Unlock()
	errs := a.lastErrors()
	var resp protocol.HeartbeatResponse
	if err := a.conn().Post(ctx, transport.EndpointHeartbeat, "HeartbeatRequest", protocol.HeartbeatRequest{
		NodeID: st.NodeID, SentAt: stamp(a.now()), Host: host, Clusters: []protocol.HeartbeatRequestCluster{},
		NodeCertificateExpiresAt: expires, ClockSkewMs: skew, InFlightJobs: inFlight,
		Agent: protocol.HeartbeatRequestAgent{QueueSize: 0, BufferedResults: int64(a.buffer.Len()), LastErrors: errs},
	}, "HeartbeatResponse", &resp, transport.MaxHeartbeatBytes); err != nil {
		return err
	}
	a.observeServerTime(resp.ServerTime)
	if resp.Instructions.RenewCertificate {
		a.mu.Lock()
		a.renew = true
		a.mu.Unlock()
	}
	return nil
}

// claim long-polls for one job and returns its envelope as received.
func (a *Agent) claim(ctx context.Context) (canon.Object, error) {
	st := a.currentState()
	data, err := a.conn().PostRaw(ctx, transport.EndpointClaim, "ClaimRequest",
		protocol.ClaimRequest{NodeID: st.NodeID, WaitSeconds: int64(a.o.ClaimWait)}, "", transport.MaxRequestBytes)
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}
	v, _ := canon.Parse(data)
	o, ok := v.(canon.Object)
	if !ok || len(o) != 1 {
		return nil, errors.New("claim: the response is not {job}")
	}
	job, present := o.Get("job")
	if !present {
		return nil, errors.New("claim: the response is not {job}")
	}
	switch j := job.(type) {
	case canon.Null:
		return nil, nil
	case canon.Object:
		return j, nil
	}
	return nil, errors.New("claim: job is neither null nor an object")
}

// trustedState are the verifier's inputs from the current state.
func (a *Agent) verifier() *verify.Verifier {
	highest := a.highestIssuedAt()
	a.mu.Lock()
	st, id := a.st, a.id
	a.mu.Unlock()
	var j verify.Journal = brokenStore{a.broken}
	var n verify.Nonces = brokenStore{a.broken}
	if a.broken == nil {
		j, n = a.journal, a.nonces
	}
	return &verify.Verifier{
		InstallationID: st.InstallationID, NodeID: st.NodeID, Trusted: st.Trusted(),
		Clock: a.o.Clock, HighestIssuedAt: highest, Journal: j, Nonces: n,
		Capabilities: a.registry, Schema: a.o.Schema,
		Sealed:               sealedFields(a.o.Schema),
		NodeEncryptionSecret: state.Seed(id.NodeEncryptionSecret),
		Precondition: func(key string, args canon.Object) error {
			c, _ := a.registry.Get(key)
			return c.Precondition(args)
		},
	}
}

// brokenStore stands in for a journal or nonce cache that failed its check.
type brokenStore struct{ err error }

func (b brokenStore) Err() error      { return b.err }
func (brokenStore) Known(string) bool { return true }
func (brokenStore) Seen(string) bool  { return true }

// sealedFields reads the catalog's sealed fields from the schema document.
func sealedFields(v *schema.Validator) func(string) []verify.SealedField {
	return func(key string) []verify.SealedField {
		var out []verify.SealedField
		for _, f := range v.SealedFields(key) {
			out = append(out, verify.SealedField{Path: f[0], Field: f[1]})
		}
		return out
	}
}

// handle judges one delivered envelope. The node signs at most one statement
// per job id (protocol.md §4.2): the completion of a job it executed, or the
// rejection of a signed envelope it journaled as rejected or abandoned. That
// statement is stored once and never replaced; a re-delivery of a job the
// journal knows gets the stored statement again, if it is still pending, and
// nothing new. A delivery the node cannot attribute to the worker (its
// signature fails) or cannot record (journal_corrupt) gets a delivery
// rejection: signed, sent once, never stored, and by the protocol's rule no
// evidence about the job.
func (a *Agent) handle(ctx context.Context, envelope canon.Object) {
	d := a.verifier().Verify(envelope)
	argsHash, _ := envelope.Get("argsHash")
	hash, _ := argsHash.(canon.String)
	if d.JobID == "" {
		a.note(errors.New("dropped a job envelope without a readable job id"))
		return
	}
	switch {
	case !d.Signed, d.Reason == verify.JournalCorrupt, a.broken != nil:
		reason := d.Reason
		if reason == "" || (d.Signed && a.broken != nil) {
			reason = verify.JournalCorrupt
		}
		a.log.Warn("delivery rejected", "jobId", d.JobID, "reason", reason)
		a.note(fmt.Errorf("delivery of %s rejected: %s", d.JobID, reason))
		a.deliveryRejection(ctx, d.JobID, string(hash), reason)
	case a.journal.Known(d.JobID):
		a.log.Warn("job delivered again", "jobId", d.JobID, "state", a.journal.State(d.JobID))
		a.note(fmt.Errorf("job %s delivered again; nothing new is signed", d.JobID))
		if a.buffer.Has(d.JobID) {
			a.deliver(ctx, d.JobID)
		}
	case d.Reason != "":
		if err := a.journal.Reject(d.JobID, d.Reason); err != nil {
			a.note(err)
			a.deliveryRejection(ctx, d.JobID, string(hash), verify.JournalCorrupt)
			return
		}
		a.log.Warn("job rejected", "jobId", d.JobID, "reason", d.Reason)
		a.statement(ctx, d.JobID, string(hash), "rejected", d.Reason, nil, nil, nil)
	default:
		a.execute(ctx, d.Job)
	}
}

// unstarted ends an accepted job that will never run: abandoned in the
// journal, then its one statement.
func (a *Agent) unstarted(ctx context.Context, job *verify.Job, reason string) {
	if err := a.journal.Abandon(job.JobID); err != nil {
		a.note(err)
		a.deliveryRejection(ctx, job.JobID, job.ArgsHash, verify.JournalCorrupt)
		return
	}
	a.statement(ctx, job.JobID, job.ArgsHash, "rejected", reason, nil, nil, nil)
}

func (a *Agent) execute(ctx context.Context, job *verify.Job) {
	if err := a.journal.Accept(journal.Accepted{
		JobID: job.JobID, OperationID: job.OperationID, Capability: job.Capability, ArgsHash: job.ArgsHash,
		Nonce: job.Nonce, IssuedAt: stamp(job.IssuedAt), ExpiresAt: stamp(job.ExpiresAt),
	}); err != nil {
		// Not journaled (a full or broken journal): nothing about the job is
		// stated.
		a.note(err)
		a.deliveryRejection(ctx, job.JobID, job.ArgsHash, verify.JournalCorrupt)
		return
	}
	if err := a.nonces.Record(job.Nonce, job.JobID); err != nil {
		a.note(fmt.Errorf("recording job %s: %v", job.JobID, err))
		a.unstarted(ctx, job, verify.JournalCorrupt)
		return
	}
	if err := a.raiseIssuedAt(job.IssuedAt); err != nil {
		a.note(fmt.Errorf("recording job %s: %v", job.JobID, err))
		a.unstarted(ctx, job, verify.JournalCorrupt)
		return
	}
	a.boundary(job.Capability, "accepted")
	if err := a.start(ctx, job); err != nil {
		// Never acknowledged: never executed. A re-delivery is a replay.
		a.note(err)
		a.unstarted(ctx, job, verify.StartUnacknowledged)
		return
	}
	if err := a.journal.Start(job.JobID); err != nil {
		// The journal cannot record the start, so nothing runs; the
		// control plane holds the job as running and reconciles it.
		a.note(err)
		a.deliveryRejection(ctx, job.JobID, job.ArgsHash, verify.JournalCorrupt)
		return
	}
	c, _ := a.registry.Get(job.Capability)
	run := &Run{effect: c.EffectStep(), now: a.now, onStep: func(index int, name, state string) error {
		return a.journal.Step(job.JobID, index, name, state)
	}, onEffect: func() { a.boundary(job.Capability, "effect") }}
	a.mu.Lock()
	installationID, secret := a.st.InstallationID, state.Seed(a.id.NodeEncryptionSecret)
	a.mu.Unlock()
	run.Open = func(field string, value canon.Value) ([]byte, bool) {
		return verify.OpenSealed(secret, installationID, job, field, value)
	}
	pctx, stopProgress := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.progress(pctx, job, run)
	}()
	// The capability runs at most its run limit (contracts runSeconds): the
	// Control Plane counts on a job being over by then.
	limit, _ := a.o.Schema.Limits(job.Capability)
	if a.o.RunLimit > 0 {
		limit = a.o.RunLimit
	}
	if limit <= 0 {
		limit = defaultRunLimit
	}
	rctx, stopRun := context.WithTimeout(ctx, limit)
	result, err := c.Run(rctx, job, run)
	overran := errors.Is(rctx.Err(), context.DeadlineExceeded)
	stopRun()
	stopProgress()
	<-done
	a.boundary(job.Capability, "executed")

	outcome, excerpt := "succeeded", (*string)(nil)
	switch {
	case errors.Is(err, ErrCanceled) && !run.EffectPassed():
		outcome = "canceled"
	case err != nil:
		outcome = "failed"
		msg := err.Error()
		if errors.Is(err, ErrCanceled) {
			msg = "stopped on a cancel request after the effect point: " + msg
		}
		if overran {
			msg = "stopped at the job's run limit: " + msg
		}
		msg = clean(msg, 32*1024)
		excerpt = &msg
	case a.o.Schema.ValidateResult(job.Capability, result) != nil:
		outcome = "failed"
		msg := "the capability produced a result outside its schema"
		excerpt, result = &msg, nil
	}
	if outcome != "succeeded" {
		result = nil
	}
	// The statement is stored before the completion is journaled: a crash in
	// between leaves a started job with its statement, which the next start
	// completes from that statement and delivers (never interrupted).
	stored := a.store(job.JobID, job.ArgsHash, outcome, "", result, run.Steps(), excerpt)
	a.boundary(job.Capability, "stored")
	if err := a.journal.Complete(job.JobID, outcome); err != nil {
		a.note(err)
	}
	if stored {
		a.deliver(ctx, job.JobID)
	}
}

// defaultRunLimit applies to a capability the schema gives no limit (never
// one of the catalog's).
const defaultRunLimit = 5 * time.Minute

func (a *Agent) raiseIssuedAt(issued time.Time) error {
	a.mu.Lock()
	st := *a.st
	a.mu.Unlock()
	if st.HighestIssuedAt != "" {
		if cur, err := time.Parse(time.RFC3339Nano, st.HighestIssuedAt); err == nil && !issued.After(cur) {
			return nil
		}
	}
	st.HighestIssuedAt = stamp(issued)
	return a.replaceState(&st)
}

// start acknowledges the start within the start deadline and the job's expiry.
func (a *Agent) start(ctx context.Context, job *verify.Job) error {
	deadline := a.now().Add(a.o.StartDeadline)
	if job.ExpiresAt.Before(deadline) {
		deadline = job.ExpiresAt
	}
	st := a.currentState()
	wait := 500 * time.Millisecond
	for {
		var resp protocol.JobStartResponse
		err := a.conn().Post(ctx, transport.JobEndpoint(job.JobID, "start"), "JobStartRequest",
			protocol.JobStartRequest{JobID: job.JobID, NodeID: st.NodeID, StartedAt: stamp(a.now())},
			"JobStartResponse", &resp, transport.MaxRequestBytes)
		if err == nil {
			return nil
		}
		var pe *transport.ProtocolError
		if errors.As(err, &pe) && !pe.Retryable {
			return fmt.Errorf("start %s refused: %w", job.JobID, err)
		}
		if !a.now().Add(wait).Before(deadline) {
			return fmt.Errorf("start %s not acknowledged: %w", job.JobID, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, 10*time.Second)
	}
}

func (a *Agent) progress(ctx context.Context, job *verify.Job, run *Run) {
	t := time.NewTicker(a.o.ProgressInterval)
	defer t.Stop()
	st := a.currentState()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		var resp protocol.JobProgressResponse
		err := a.conn().Post(ctx, transport.JobEndpoint(job.JobID, "progress"), "JobProgressRequest",
			protocol.JobProgressRequest{JobID: job.JobID, NodeID: st.NodeID, SentAt: stamp(a.now()), Steps: lastSteps(run.Steps(), 64)},
			"JobProgressResponse", &resp, transport.MaxRequestBytes)
		if err != nil {
			if ctx.Err() == nil {
				a.note(err)
			}
			continue
		}
		if resp.CancelRequested {
			run.Cancel()
		}
	}
}

func lastSteps(steps []protocol.JobStep, n int) []protocol.JobStep {
	if len(steps) > n {
		return steps[len(steps)-n:]
	}
	return steps
}

// maxSteps is the contract's limit on a completion's steps; a longer run keeps
// its last steps (the journal holds all of them).
const maxSteps = 256

// build signs a completion (nr1). A completion that cannot be built as asked
// (a result that does not canonicalize) is built without result and excerpt
// instead, as failed, keeping its steps: the job still gets its statement,
// and the statement still says whether the effect point was passed.
func (a *Agent) build(jobID, argsHash, outcome, reason string, result canon.Object, steps []protocol.JobStep, excerpt *string) ([]byte, error) {
	data, err := a.sign(jobID, argsHash, outcome, reason, result, steps, excerpt)
	if err == nil || outcome == "rejected" {
		return data, err
	}
	a.note(fmt.Errorf("completion of %s: %v", jobID, err))
	msg := "the agent could not build this job's completion"
	return a.sign(jobID, argsHash, "failed", "", nil, steps, &msg)
}

func (a *Agent) sign(jobID, argsHash, outcome, reason string, result canon.Object, steps []protocol.JobStep, excerpt *string) ([]byte, error) {
	st := a.currentState()
	a.mu.Lock()
	nskSeed := state.Seed(a.id.NodeSigningSeed)
	a.mu.Unlock()
	req := protocol.JobCompleteRequest{
		JobID: jobID, NodeID: st.NodeID, FinishedAt: stamp(a.now()), Outcome: outcome,
		Steps: lastSteps(steps, maxSteps), OutputExcerpt: excerpt, Result: json.RawMessage("null"),
	}
	if req.Steps == nil {
		req.Steps = []protocol.JobStep{}
	}
	if reason != "" {
		req.RejectionReason = &reason
	}
	if result != nil {
		raw, err := canon.Canonicalize(result)
		if err != nil {
			return nil, err
		}
		req.Result = raw
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	v, err := canon.Parse(data)
	if err != nil {
		return nil, err
	}
	signature, err := nodecrypto.SignResult(nskSeed, nodecrypto.ResultContext{
		InstallationID: st.InstallationID, NodeID: st.NodeID, JobID: jobID, ArgsHash: argsHash,
	}, nodecrypto.UnsignedCompletion(v.(canon.Object)))
	if err != nil {
		return nil, err
	}
	req.NodeSignature = protocol.JobCompleteRequestNodeSignature{Alg: "Ed25519", Value: signature}
	return json.Marshal(req)
}

// statement signs the job's one statement, stores it durably (never over an
// existing one) and tries to deliver it; a nil ctx only stores it.
func (a *Agent) statement(ctx context.Context, jobID, argsHash, outcome, reason string, result canon.Object, steps []protocol.JobStep, excerpt *string) {
	if a.store(jobID, argsHash, outcome, reason, result, steps, excerpt) && ctx != nil {
		a.deliver(ctx, jobID)
	}
}

// store signs a job's statement and stores it durably; false when it could
// not (noted).
func (a *Agent) store(jobID, argsHash, outcome, reason string, result canon.Object, steps []protocol.JobStep, excerpt *string) bool {
	data, err := a.build(jobID, argsHash, outcome, reason, result, steps, excerpt)
	if err != nil {
		a.log.Error("could not sign a job statement", "jobId", jobID, "error", err.Error())
		a.note(err)
		return false
	}
	if err := a.buffer.Put(jobID, data); err != nil {
		a.log.Error("job statement not stored", "jobId", jobID, "error", err.Error())
		a.note(err)
		return false
	}
	return true
}

// deliveryRejection answers a delivery once: signed, never stored, so it
// cannot replace a job's statement or fill the disk.
func (a *Agent) deliveryRejection(ctx context.Context, jobID, argsHash, reason string) {
	data, err := a.sign(jobID, argsHash, "rejected", reason, nil, nil, nil)
	if err != nil {
		a.note(err)
		return
	}
	var req protocol.JobCompleteRequest
	if err := json.Unmarshal(data, &req); err != nil {
		a.note(err)
		return
	}
	var resp protocol.JobCompleteResponse
	if err := a.conn().Post(ctx, transport.JobEndpoint(jobID, "complete"), "JobCompleteRequest", req,
		"JobCompleteResponse", &resp, transport.MaxRequestBytes); err != nil {
		a.note(fmt.Errorf("delivery rejection for %s: %v", jobID, err))
	}
}

func (a *Agent) deliverBuffered(ctx context.Context) {
	for _, id := range a.buffer.Pending() {
		if ctx.Err() != nil {
			return
		}
		a.deliver(ctx, id)
	}
}

func (a *Agent) deliver(ctx context.Context, jobID string) {
	data, err := a.buffer.Get(jobID)
	if err != nil {
		a.note(err)
		return
	}
	var req protocol.JobCompleteRequest
	if err := json.Unmarshal(data, &req); err != nil {
		a.note(err)
		return
	}
	var resp protocol.JobCompleteResponse
	err = a.conn().Post(ctx, transport.JobEndpoint(jobID, "complete"), "JobCompleteRequest", req,
		"JobCompleteResponse", &resp, transport.MaxRequestBytes)
	var pe *transport.ProtocolError
	switch {
	case err == nil && (resp.Accepted || resp.Duplicate):
		if err := a.buffer.Remove(jobID); err != nil {
			a.note(err)
		}
	case err == nil, errors.As(err, &pe) && !pe.Retryable, errors.Is(err, transport.ErrRequestInvalid):
		a.log.Error("completion refused by the gateway; parked for the local operator", "jobId", jobID)
		if err := a.buffer.Park(jobID); err != nil {
			a.note(err)
		}
	default:
		a.note(fmt.Errorf("delivering %s: %v", jobID, err))
	}
}
