# Security policy

ExponetDB changes databases, so its security matters. Thank you for reporting
problems responsibly.

## Reporting a vulnerability

**Do not open a public issue or pull request for a vulnerability.**

Report it privately, by either way:

- GitHub: **Security → Report a vulnerability** on
  <https://github.com/davdxpx/ExponetDB/security/advisories/new> (private
  vulnerability reporting), or
- e-mail [davdxpx@gmail.com](mailto:davdxpx@gmail.com) with the subject
  "ExponetDB security".

Please include what you found, the affected version or commit, steps to
reproduce, and the impact you see. A proof of concept helps. Do not include
real credentials or other people's data.

You can expect an acknowledgement within a few days. The project is maintained
by one person, so fixes are prioritized by severity and there is no formal
response-time guarantee. Please allow a reasonable time to fix a problem before
you publish details.

## Scope

In scope: the code in this repository, including the Control Plane, the Web
App, the REST API, the MCP server and OAuth, the CLI, the SDK, the node agent
and the migration engine.

Out of scope: third-party dependencies (report those upstream), deployments run
by other people, social engineering, denial-of-service by volume, and anything
that needs physical access.

## Good-faith research

Reading the code and running it in a local lab against synthetic data to find
vulnerabilities is allowed (see Section 9 of the [license](./LICENSE)). Do not
test deployments you do not own, do not touch other people's data, and do not
disrupt any service.

## Supported versions

ExponetDB is alpha software without stable releases. Fixes go to the `main`
branch.

## Runtime advisories

The project pins the Node.js and Bun runtimes it needs for each published
advisory (for example CVE-2026-111497, "Node2Shell", fixed in Node.js 24.22.1
and Bun 1.4.4). If you run a fork, keep your runtimes patched.
