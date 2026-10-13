# ADR-0029: The approval link from an MCP conversation is the existing approvals page, hardened

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 7 order (§24, owner decision 5); part of the G7 evidence the owner accepts or rejects with G7 |
| Date | 2026-10-12 |
| Related | [ADR-0026](./0026-cli-step-up-browser-handoff.md) (the approvals page and step-up receipts), OD-9 (agents propose, humans approve); [`../../05-mcp/architecture.md` §6](../../05-mcp/architecture.md#6-human-approval-from-inside-an-mcp-conversation), [`../../11-ui/information-architecture.md`](../../11-ui/information-architecture.md) |

## Context

When `plan_apply` accepts a plan whose policy decision requires a human
approval, the agent must hand a link to its human; the human decides on a
page of the Web App. The documents named the plan review page
`/changes/plans/<id>`, which belongs to the Wave 8 redesign; the page that
exists is `/approvals#operation=<op>` (ADR-0026). That page showed kind,
class, plan hash and the raw JSON of the change, and nothing about the
change of a migration or node plan. A person decides on what the page
shows, so the page is part of the security boundary: published attacks
forge exactly these dialogs with filler and harmless-looking summaries.

## Decision

1. **The link.** `approvalUrl` = `<EXPONETDB_PUBLIC_URL>/approvals#operation=op_…`:
   the operation id in the fragment (no `Referer` leak), no token, no plan
   text, nothing pre-authenticated. It is worthless to anyone who is not
   signed in and entitled to approve: the page checks that, not the link.
   Wave 8 moves the plan review to `/changes/plans/<id>`; the old link
   stays valid as a redirect.
2. **Delivery.** The link is always in the tool result's text block and in
   `structuredContent`. On the modern era, when the request declared
   `elicitation.url`, `plan_apply` also returns an `input_required` result
   with one URL elicitation (`message` is a fixed server text built from
   checked facts: tier, target path, plan kind, shortened plan hash; never
   agent, plan or database text) and a sealed `requestState` (ADR-0027
   §7). The retry returns the normal result (the operation in
   `awaiting_approval`) without waiting for the decision. An elicitation
   answer is never a decision; form elicitation is never used for
   approvals.
3. **The page shows server facts first**, computed from the stored plan:
   target path and tier, kind and class, policy decision with rule names
   and requirements, expiry, the full plan hash (copyable), who planned it
   with which client (the client name marked unverified, `via: mcp`), and
   for migration plans per bundle the statements with line numbers, class
   and lock level, compatibility, reversibility and staging evidence; for
   node plans the capability, the node and the change. `changeOf` in
   `packages/auth/src/approvals.ts` gains these kinds.
4. **Foreign text is data.** SQL, names, comments and notes render as
   text only (`textContent`), with control, bidirectional, tag and
   zero-width characters made visible, length caps with a visible "shows
   N of M bytes", and a separation between "computed by ExponetDB" and
   "raw text of the plan". An agent's note appears last, in its own block
   labeled "Agent note (not checked)".
5. **Authority stays where it is.** Only a person with `plans.approve` at a
   scope covering the plan sees the operation (others get the same answer
   as for an unknown id); approval needs a fresh re-authentication in the
   Web App, binds to plan hash, target, principal and policy version, and
   is single use. A changed hash is `PLAN_STALE`. Agent client kinds can
   never approve (engine and database). Self-approval keeps OD-9's rules.
6. **Page protection**: `frame-ancestors 'none'`, the existing CSP, Origin
   and CSRF checks on its POSTs, no third-party script.

The G7 criterion "approval links via URL elicitation land on the plan
review page" is met by the hardened approvals page; literally it is met
only with Wave 8. The G7 record lists it as partial by design and the
owner decides.

**Implemented** (Wave 7 Phase 7; `apps/web/src/review.ts`,
`Application.approvals` with `review`, `ApprovalReviewSchema` in the
contracts). As decided, with these honest limits: node plans show the
generic facts and the stored change as data (no dedicated node rendering);
plans carry no agent note in Wave 7, so no such block exists yet; the
newest backup reads "not known" until Wave 9; drift is shown as the schema
fingerprint the plan binds (any change before the apply makes it stale),
not as a separate drift check. Self-approval follows OD-9 as accepted with
G3A (case 1): a person approving the plan their own agent made is not a
self-approval of their own plan, so no acknowledgement box is shown; the
card states that an agent proposed it. The order's §24 wording ("the
self-approval by the person the agent works for stays allowed with an
explicit confirmation") reads differently; the G7 record names it for the
owner.

## Consequences

- No new route; the page stays in the Wave 3A Web App without a new
  design system (Wave 8 replaces it).
- A Playwright end-to-end test drives the whole chain: agent plans and
  applies over MCP, the human opens the link, approves with a virtual
  authenticator, the agent observes the verified result.
