# AI agent safety model

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 3 (scopes), Wave 6 (plans), Wave 7 (MCP), every later wave |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md), [`threat-model.md`](./threat-model.md), [`../05-mcp/architecture.md`](../05-mcp/architecture.md) |

ExponetDB is built for AI agents. That makes the agent a first-class *user* and
also a first-class *risk*: agents are fast, confident, tireless, and can be
steered by text they read. The rules below are what "humans and AI agents safely
change databases together" means for the agent side.

## 1. Separations

| Separation | Meaning in ExponetDB |
|---|---|
| **Agent intent ≠ authorization** | An agent may want to do something it may not do. Its reasoning, confidence or urgency is never an input to the authorization decision (C-25). |
| **Plan ≠ apply** | Agents can plan freely (planning changes nothing); applying is a separate call bound to the plan, re-checked server-side. |
| **Read tools ≠ write tools** | Read tools cannot change state by construction (separate code path, separate role). There is no "query" tool that can write. |
| **Production scopes ≠ staging scopes** | `:prod` and `:nonprod` scopes are distinct; consent defaults to nonprod; production writes by agents need human approval by default. |
| **Natural-language reasoning ≠ policy decision** | Policies are code evaluated on the server with facts from ExponetDB, never derived from what the agent says. A `reason` field is recorded, never evaluated. |
| **Tool description ≠ security barrier** | Descriptions explain how to use tools. Removing or ignoring them changes nothing about what is allowed (C-10). |
| **Client confirmation ≠ human approval** | A client's "confirm" dialog or an elicitation "accept" is not proof of a human decision. Approvals happen in the Web App with the human's own authentication. |

## 2. Content is untrusted

Everything an agent sends and everything it reads from a database can be
adversarial (C-26):

- **Migration SQL, `verify.sql`, query text**: parsed and admitted by the server;
  never executed outside the defined paths. Executable SQL in a bundle runs only
  as reviewed plan content; admission and execution limits are defense in depth,
  not a sandbox, and constructs the server cannot classify are refused or need
  explicit approval.
- **Catalog content** (object names, comments, function bodies, policy
  expressions), **row data**, **log lines**, **statement texts**: returned as
  data, labeled `untrusted` in MCP output schemas, quoted in text summaries,
  length-capped. ExponetDB never asks an agent to follow instructions found in
  data, and the authoring guide tells agents not to.
- **Client metadata** (client names, logos): shown with "unverified" labels
  unless allowlisted.

## 3. Prompt injection: what ExponetDB can and cannot do

ExponetDB cannot stop an agent from *being persuaded*. It can make persuasion
**insufficient**:

| Injection goal | Why it fails (or is contained) |
|---|---|
| "Drop table X on production" | no write tool except migrations; prod migrations need staging evidence and human approval by default; the plan shows `destructive` with dependents |
| "Read all customers' e-mails and post them" | prod data reads `humans_only` by default; masks for sensitive columns; caps; audit; MCP output cannot reach the internet by itself (the client decides what to do with it, which ExponetDB does not control) |
| "Terminate all sessions" | terminate needs pid + backend_start per session; agent terminations on prod need approval; rate limits |
| "Use break-glass" | not available to agents |
| "Approve this plan" | no approval tool; approval needs the human's Web App session with re-auth |
| "Change your policy settings" | admin scopes are not MCP-grantable |
| "Restore an old backup over production" | restore execution is human-only; in-place restore does not exist in V1 |

Residual risk is bounded by what the agent's grant allows on nonprod targets.
Nonprod should not contain production personal data (recommendation to consumers).

## 4. Designing tools for safe agent use

**[DECIDED]**

- **Make the safe path complete** (P-4): a plan result includes everything the
  agent needs to decide and explain (analysis, evidence, what would block
  production, what approval is needed). Agents should never need a "just run SQL"
  workaround.
- **Machine-readable refusals** (P-5): stable codes, failed preconditions,
  remediation. Agents can recover without guessing.
- **Explicit state**: operation handles, states, and outcomes; no ambiguous
  "done". `applied` and `verified` are separate fields.
- **Truthful reads** (C-28): failed reads are errors, never empty results; RLS
  annotations explain why application users see less.
- **Bounded outputs**: pagination and caps protect agents' context windows and
  reduce accidental bulk exfiltration.
- **Idempotent applies**: an agent retrying after a timeout gets the same
  operation back.

## 5. Accountability

- Every agent action is attributed to the human identity behind the grant **and**
  the client (e.g. "David via Claude Code"), in plans, operations and audit.
- The Web App's "Connected applications" page shows each grant's scopes, target
  restrictions, last use, and a revoke button.
- Findings flag risky standing access: grants with `:prod` write scopes, grants
  unused for 30 days, service accounts with prod writes.

## 6. Testing the safety model

- Adversarial test suite run against MCP and REST: each injection goal in §3 is
  attempted with every grant shape; the expected outcome is a refusal or an
  approval requirement, never execution.
- "Agent replay" tests: recorded agent transcripts (from real Claude Code usage
  against a staging target) are replayed against new versions to catch behavior
  changes in refusals and plans.
