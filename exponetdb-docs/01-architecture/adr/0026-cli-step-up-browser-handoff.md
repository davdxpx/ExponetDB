# ADR-0026: A person's CLI steps up through a bound, single-use browser receipt

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 6 order (Part C, §46); implemented in Wave 6; part of the G6 evidence the owner accepts or rejects with G6 |
| Date | 2026-10-12 |
| Related | [ADR-0015](./0015-oauth-protected-mcp.md) (ExponetDB as authorization server), [ADR-0022](./0022-opaque-tokens.md) (opaque tokens); [`../../08-auth-and-security/authorization.md`](../../08-auth-and-security/authorization.md) §1 and §6; [`../../05-mcp/oauth.md`](../../05-mcp/oauth.md) §5; [`../../07-node-agent/control-plane.md` §4](../../07-node-agent/control-plane.md#4-enrollment) (the one-time reveal); OD-9 (approvals in the Web App); [G6 record](../../14-roadmap/gates/6.md) |

## Context

A person uses the first-party CLI with a delegated OAuth grant (client kind
`cli`, ADR-0015). Some actions need a fresh proof of presence: the
enrollment token's one-time reveal (`node.enrollment_token.reveal`,
re-authentication within 300 s), a plan whose kind requires
re-authentication at apply (`node.enroll`, access changes), and the release
of a `critical` self-approval after its cooling period (OD-9). The engine
counts a fresh proof only from a Web App session (`freshProof`): an access
token proves who granted it, not that the person is present now. Until
Wave 6 the CLI could therefore not finish these actions at all.

The order (§46) rules out the shortcuts: never cast a bearer caller to a
session, never treat `--yes` as re-authentication, never take a client's
timestamp or client-kind flag as proof, never widen bearer rights to
Web-only administration, and never add an approval endpoint with weaker
checks.

## Decision

1. **Step-up request.** A person's first-party CLI grant (identity kind
   `human`, client kind `cli`, a delegated access token, never an API key,
   a machine grant or an MCP client) may ask for a step-up:
   `POST /api/v1/step-ups` with the action it is about to call and what it
   binds to. The server builds the **binding** from its own state, never
   from the request alone: the installation id, the identity, the OAuth
   client id and grant id of the presenting token, the action id, and the
   object: for `plan.apply` the plan id and its stored plan hash; for
   `node.enrollment_token.reveal` the token id; for any other action the
   subject the action resolves to. The binding digest is
   `sha256:` over JCS of that object. The answer carries the step-up id
   (`stu_`), a `verificationUri` (`<origin>/step-up#id=<id>`), an
   eight-character `userCode` from an unambiguous alphabet, and an expiry
   of ten minutes. A step-up for an action that needs no fresh proof, or
   that the grant could not call anyway (client kind, scope, human-only),
   is refused at request time.

2. **Confirmation in the Web App.** The person opens the URI in a browser
   signed in to the same installation. The page shows the client's
   registered name, the action's title, the subject and the plan hash
   prefix, and asks for the code the CLI shows. `POST
   /api/v1/step-ups/{id}/confirm` (Web App session only, Origin and CSRF
   checked) needs: the session's identity equals the binding's identity
   (any other identity reads the step-up as not found); the typed code
   equals the stored one (compared in constant time, five attempts, then
   the step-up is refused); a fresh re-authentication of the session
   (passkey or TOTP, the action's window; a recovery session never
   confirms); the step-up still pending and unexpired; the grant still
   active. The confirmation records the re-authentication event and starts
   the **receipt**: valid for 120 seconds, once.

3. **Redemption.** The CLI repeats the bound request with the header
   `ExponetDB-Step-Up: <stu_…>`. In the transaction of that request the
   server loads the receipt, recomputes the binding from the request and
   its own state (the presenting token's grant and client, the action, the
   plan's current hash or the token or subject), and counts a fresh proof
   only if every field matches, the receipt is confirmed, unexpired and
   unredeemed, and the grant is active; it marks the receipt redeemed in
   the same transaction (a failed action rolls the redemption back with
   it). Anything else answers `REAUTH_REQUIRED`, never a hint about another
   identity's step-up. The receipt satisfies only the re-authentication of that one
   request: authorization, scopes, restrictions, policy, approvals and
   cooling periods apply unchanged.

4. **Server-side proof only.** No client timestamp, client-kind flag or
   assertion from the CLI counts. The CLI never receives a session cookie,
   a WebAuthn assertion or anything that works outside its binding.
   Revoking the grant, signing the session out or a new plan hash makes
   every pending receipt of that grant useless.

5. **Machines never step up.** A service account (API key, machine grant)
   and an MCP client cannot create or redeem a step-up. Production and
   human-only actions keep their client-kind rules; a step-up never adds a
   client kind to an action that excludes the CLI.

6. **Approvals stay in the Web App.** There is no CLI approval endpoint.
   `exponetdb approval approve` opens the operation's `approvalUrl`
   (`/approvals#operation=<op>`), where the existing approval ceremony runs
   (re-authentication, plan hash, the self-approval acknowledgement), and
   watches the operation until the approval is recorded, it is rejected,
   or the wait ends; it says which.

7. **Audit.** `step_up.requested`, `step_up.confirmed`, `step_up.redeemed`
   and `step_up.refused` (with a reason code) are audited with the binding
   digest, never the user code.

## Consequences

- The CLI finishes `node enroll` (plan, apply, reveal into a 0600 file) and
  the other re-authentication actions without a weaker path; the browser
  holds the proof of presence, the CLI only a single-use, bound receipt.
- The enrollment token's reveal allows the client kind `cli` only together
  with a redeemed receipt; its other rules (the applying identity, once,
  within 30 minutes) are unchanged.
- A new Control Store bundle (additive, `step-up`) holds step-ups; a
  step-up row keeps no secret: the user code is stored as a hash (as the
  device flow's user code) and compared in constant time. The code only
  binds the browser to the terminal; it grants nothing without the same
  person's session and a fresh proof.
- Tests cover a different signed-in browser identity, another client or
  grant, a changed plan (another plan hash),
  a replayed or expired receipt, a cross-origin confirmation, a revoked
  grant, a missing second factor, five wrong codes, a session naming a
  receipt and a machine client's attempt (G6 record).

## Implementation notes (Wave 6)

- **[DECIDED]** The receipt is redeemed only after the bound action
  succeeded, in the same transaction: an apply that the server refuses
  (a stale plan, a policy re-check) leaves the receipt confirmed and
  unredeemed; a receipt that does not match answers `REAUTH_REQUIRED`
  before anything else runs. `REAUTH_REQUIRED` carries no details.
- **[DECIDED]** A step-up for `plan.apply` exists only for an active plan
  the same person made through the CLI whose kind or policy needs a fresh
  proof; for any other plan the request is `CONFLICT`.
- **[DECIDED]** `node.enrollment_token.reveal` admits the client kinds
  `web` and `cli`; its re-authentication rule is unchanged, so the CLI
  reaches it only with a redeemed receipt.
- **[DECIDED]** Another signed-in person reads and confirms someone
  else's step-up as `NOT_FOUND` (tested with a second enrolled identity).
