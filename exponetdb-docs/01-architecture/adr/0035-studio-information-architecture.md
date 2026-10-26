# ADR-0035: A project level, a contextual Connect sheet and paged migration views in the Web App

| | |
|---|---|
| Status | **Proposed**, built for review under the owner's UI/UX order of 2026-10-26 (parallel to Wave 9 Part B); accepted or rejected with the owner's review before Wave 11 ([`PRE-WAVE-11-REVIEW.md`](../../14-roadmap/PRE-WAVE-11-REVIEW.md), section "UI/UX Overhaul – Parallel Session") |
| Date | 2026-10-26 |
| Amends | [`information-architecture.md`](../../11-ui/information-architecture.md) §2 (levels and routes) and §2.2 (target sections), additively: no earlier URL changes |
| Related | [ADR-0030](./0030-supabase-ui-source-adoption.md) (Supabase UI source, allowlist), [ADR-0029](./0029-approval-link-from-mcp.md), [`design-system.md`](../../11-ui/design-system.md), [`registry.md` §4.4](../../02-control-plane/registry.md#44-retiring-a-server-or-a-cluster) |

## Context

The owner reviewed the Web App against Supabase Studio on 2026-10-26 and
found three structural gaps, beyond the look of single pages:

1. **No project level.** The registry has products, projects, environments
   and targets, but the Web App jumped from the fleet (`/`, `/targets`) to one
   target (`/t/<product>/<project>/<environment>`). Supabase's project home
   is the place a person starts from; ExponetDB had none, and `/settings/projects`
   is an administration page (create, change), not a portfolio.
2. **Connect was a section, not a tool.** The header's Connect led to the
   configuration page (`#connect`), a long page of its own, and the MCP guide
   lived at `/connect`. Studio opens a wide sheet beside the page.
3. **The migrations page rendered everything at once.** A real legacy import
   produced more than 500 ledger rows, and the page stacked ledger, timeline,
   promotion, plans, drift and the import report into one endless document.

The product model must stay ExponetDB's: installation → product → project →
environment → logical target; clusters and servers are physical and
independent of projects. A product is not an organization, a cluster is not
a project.

## Decision

1. **A project level between the fleet and one target.** `/projects` is the
   portfolio (cards or a table, a search over name and path, a product
   filter, pages; every value in validated search parameters), and
   `/p/<product>/<project>` is a project's home (its environments as links to
   their targets, its migration stream per environment from the mirrors, the
   clusters its environments are placed on). It is a rail section of the
   fleet level (`Projects`, `G` then `R`); its pages are fleet pages, so the
   shell keeps three levels. `/t/<product>/<project>/<environment>` stays the
   canonical target route. `/settings/projects` stays the administration of
   projects. One URL builder (`projectHref`, beside `targetHref`) encodes the
   segments; the slugs are validated before any request; both new paths are
   sign-in return targets.
2. **Connect is a sheet with its state in the address.** On a target page the
   header's Connect opens a wide right sheet (`?connect=<mode>`, an
   allowlist: `direct`, `app`, `cli`, `mcp`, `api`); on a project's home the
   same sheet asks for the environment (`?environment=<slug>`). The sheet is
   a modal dialog (focus trapped and returned, Escape closes it, Back closes
   it when it was opened in the page); a reload or a link opens it again. Its
   direct and application modes show addresses only to `registry.manage`
   (OD-41, unchanged); no mode shows or builds a secret. `/connect` stays the
   MCP client guide.
3. **The migration centre shows one view at a time.** `?view=` chooses the
   history, the pending bundles, the timeline, promotion, plans, drift or the
   legacy import; counters of the ledger on top are links to the filtered
   history. The history is paged (`?page=`, `?size=`), searched and filtered
   in the address; the open SQL panel is `?migration=`. Pages divide one whole
   ledger read and say so: the ledger read is not paged by the server yet
   (a later additive read, see the review file).
4. **Cards that lead somewhere are links, all of them.** A whole-card link
   (`LinkCard`) replaces a card with a small underlined word at its foot; a
   card holds no other control, so an untrusted name inside a link is cut
   without a "Show all" button (`expandable={false}`); a card without a
   destination is a plain card with no pointer.
5. **Search validators return every key.** The router merges the raw search
   of parent routes into a route's validated search, so a validator sets
   every key it owns, `undefined` when the value is outside its grammar.

## Alternatives considered

- **`/projects/<id>` with ids in the address.** Rejected: target addresses
  use slugs and are stable; a project's address should read the same way,
  and an id adds nothing a person can type.
- **A fourth shell level with its own rail for a project.** Rejected for
  now: a project has a handful of pages' worth of content; the fleet rail
  with the Projects section current and a breadcrumb is enough, and a fourth
  rail would compete with the target's.
- **Copy Supabase's `ConnectSheet` and `ProjectHome` files.** Not allowed
  today (no `apps/studio` file of them is on the ADR-0030 allowlist) and not
  worth an extension: they are entangled with Studio's data layer, telemetry
  and platform keys; their structure is rebuilt natively on the existing
  primitives (`Sheet`, `Tabs`, `Card`), see the source matrix in the review
  file.
- **Virtualize the full ledger table.** Possible (`@tanstack/react-virtual`
  is in `ui-data`), but paging with filters is what a person needs for
  hundreds of rows and keeps the page printable and linkable; a server-side
  paged read is the lasting fix.

## Consequences

- New routes `/projects` and `/p/$product/$project`; new search parameters
  on target pages (`connect`, and `environment` on a project's home) and on
  the migrations page (`view`, `q`, `origin`, `verification`, `sort`,
  `page`, `size`, `migration`, `report`); every earlier URL keeps its
  behavior (`/t/…/migrations?report=` opens the legacy import view).
- The Wave 9 pages (`features/wave9/**`) are untouched; the fleet's backup
  slot and the target overview's backup fact name Wave 9 as the provider
  (integration handoff in the review file).
- Tests: the project pages, the Connect sheet (URL state, Back, focus,
  permission split, templates with hostile input), the migration centre (500
  rows render one page; filters from the address; unchecked values dropped).
