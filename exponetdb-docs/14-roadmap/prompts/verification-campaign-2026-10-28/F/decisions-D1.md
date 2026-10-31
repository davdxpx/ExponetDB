# Open decisions raised by the authorization matrix and agent-safety review (agent D1)


- **D-D1-1** Re-authentication for `critical` plans (identity.md:83 vs authorization.md:458) and the G5 item 16 note: add an approval rule for critical classes on nonprod, and decide whether critical needs a fresh proof by itself.
- **D-D1-2** Service accounts reach class-low consequential actions on production with no approval requirement: `connections.cancel`, `backup.verify`, `backup.catalog.refresh`, `node.inspect`. Documented (only terminate needs approval); decide if cancel on production should too.
- **D-D1-3** Plan and operation ids at apply, withdraw, approve and reject answer 404 for unknown and 403 for foreign ids; documented as a residual (error-model.md:365). Decide whether to conceal them as `plan.get` does.
- **D-D1-4** The CLI is classified "a person" for `data.read` (`facts.ts:46`): an AI agent that shells out to the first-party CLI with the user's token is not an agent for policy. The CLI grant defaults to nonprod and `data.read:prod` needs explicit consent, so exposure is by consent; decide if `data.read:prod` should be refused to the CLI client kind.

