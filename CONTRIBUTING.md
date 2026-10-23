# Contributing to ExponetDB

Thanks for looking. Contributions are welcome, within the terms of the
[ExponetDB Source-Available License](./LICENSE).

## Before you start

- **Read the license.** By submitting a Contribution you grant the author the
  rights in [Section 8 of the license](./LICENSE) (including the right to
  relicense it, for example in a commercial license). Do not submit anything you
  are not allowed to give under those terms, and nothing that contains secrets
  or personal data.
- **Read the constitution** ([`exponetdb-docs/00-product/constitution.md`](./exponetdb-docs/00-product/constitution.md)).
  Every change is measured against it, and security articles have no exception
  path.
- **Open an issue first** for anything larger than a small fix, so you do not
  build something that conflicts with the roadmap or the scope boundary
  ([`vision-and-scope.md`](./exponetdb-docs/00-product/vision-and-scope.md)).
- Running ExponetDB beyond development and testing needs the author's
  permission. Developing a contribution locally against throw-away data is fine.

## How to work

1. Fork the repository **publicly** and create a branch (`feat/…` or `fix/…`).
2. Follow [`CLAUDE.md`](./CLAUDE.md): it applies to people as much as to AI
   sessions. Highlights:
   - behavior changes start with the documentation; contracts start in
     `packages/contracts`, generated files are never edited by hand;
   - tests prove claims against real PostgreSQL where PostgreSQL behavior
     matters; never skip or quarantine a test to get green;
   - English (US spelling) in code, identifiers, docs and commit messages;
   - no customer data, no real credentials, no production data in fixtures.
3. Run the checks:

   ```sh
   bun install --frozen-lockfile
   bun run verify
   ```

4. Use Conventional Commits (`feat:`, `fix:`, `docs:` …), keep commits atomic
   (code, tests and docs together), and open a pull request that says what
   changed and why.

## What gets declined

Changes that add a generic remote shell or arbitrary SQL execution path, move
ExponetDB into the application data path, make it depend on another product, or
loosen the safety rules in the constitution.

## Security issues

Do not open a public issue or pull request for a vulnerability. See
[`SECURITY.md`](./SECURITY.md).
