# Installing, upgrading and removing the CLI

| | |
|---|---|
| Status | **[DECIDED]** Wave 6 (owner order §60, §68); part of the G6 evidence |
| Artifact | `apps/cli/dist/artifacts/exponetdb-cli-<version>.tgz` and its `.sha256` file, built by `bun run --cwd apps/cli pack` |
| Proven by | `apps/cli/test/packed.install.test.ts` (`bun run --cwd apps/cli test:install`), and the server's CLI process suite run with the installed binary (`EXDB_CLI_BIN`); both in the CI job `postgres` |
| Related | [`README.md`](./README.md), [`quickstart.md`](./quickstart.md), [`reference.md`](./reference.md) |

The CLI ships as an npm tarball that works outside the monorepo. It is
never published to a public registry and never updates itself
**[DECIDED]**: a person installs a tarball they were given (or built) and
checked.

## 1. What the tarball contains

| Path | What it is |
|---|---|
| `bin/exponetdb.mjs` | the whole CLI as one ES module for Node.js 24: the workspace packages (`contracts`, `kernel`, `sdk`, the pure `migrations` subpaths) and their pure dependencies (`zod`, `yaml`, `jose`) bundled in; no `workspace:*` dependency is left to resolve |
| `node_modules/libpg-query-16`, `-17`, `-18` | PostgreSQL's parser per major (libpg-query 16.7.3, 17.7.4, 18.1.5, MIT, WASM), shipped inside the tarball (`bundleDependencies`): each loads its `libpg-query.wasm` next to its module, so installing needs no registry |
| `BUILD.json` | name, version, commit, build time, Node range and parser versions |
| `THIRD_PARTY_NOTICES.md` | the license texts of everything bundled |
| `README.md`, `LICENSE`, `package.json` | the package itself (`private: true`) |

The build embeds no path of the build machine, no user name and no secret;
the pack script refuses an artifact that contains the repository path, the
home directory, `workspace:` or an import of a workspace package, and the
install test checks it again on the installed copy. Bun is build tooling
only; the CLI runs on Node.

## 2. Versions

| Version | Where it comes from | Where you see it |
|---|---|---|
| CLI version (`0.6.0`) | `apps/cli/package.json`, equal to `CLI_VERSION` (the pack refuses a mismatch) | `exponetdb --version`, `BUILD.json` |
| Build commit | the commit packed (`EXPONETDB_BUILD_COMMIT`, else the checkout's HEAD; `-dirty` when the tree had changes) | `exponetdb --version`, `doctor` |
| Build time | the commit's time (`SOURCE_DATE_EPOCH` overrides): the same commit packs the same bundle | `exponetdb --version` |
| Server version | the installation answering at the origin (`GET /api/v1/installation`) | `doctor`, `whoami` |
| REST API contract | `v1`; the CLI refuses a server that speaks another (`incompatible_server`, exit 5) | every remote command |

A run from source (`bun apps/cli/src/main.ts`) reports the commit as
`source`.

## 3. Prerequisites

- **Node.js 24** (the package's `engines`). Node 22 and 23 still run the
  CLI and `doctor` reports them (`warn`); anything older is refused.
- npm (any version that ships with Node 24) to install the tarball.
- Platforms: Linux and Ubuntu on WSL are the supported and tested
  platforms. **[OPEN]** macOS and Windows have no install evidence yet (no
  such runner in this wave); full sign-in support on them is not claimed
  until the credential file permissions are proven there.

## 4. Build and check

From a clean checkout at the commit to ship:

```sh
bun install --frozen-lockfile
bun run --cwd apps/cli pack
cd apps/cli/dist/artifacts
sha256sum -c exponetdb-cli-0.6.0.tgz.sha256
```

The pack prints the artifact, its SHA-256 and the build identity as JSON.
Whoever receives the tarball checks the same checksum before installing.

## 5. Install

```sh
npm install --global --offline exponetdb-cli-0.6.0.tgz
exponetdb --version
exponetdb doctor
```

`--offline` is deliberate: everything the CLI needs is inside the tarball.
Without root, install below your home directory and put its `bin` on PATH:

```sh
npm install --global --offline --prefix ~/.local exponetdb-cli-0.6.0.tgz
export PATH="$HOME/.local/bin:$PATH"
```

`exponetdb doctor` checks the CLI and its runtime, the private files, all
three parsers, and (when a server is configured) the server and the
sign-in, without changing anything.

## 6. Upgrade

Install the newer tarball the same way; npm replaces the package in
place. The private files stay where they are and keep working:

| File (in `~/.config/exponetdb`, or `$XDG_CONFIG_HOME/exponetdb`, or `EXPONETDB_CONFIG_DIR`) | Format | Compatibility |
|---|---|---|
| `credentials.json` (0600) | `version: 1`, unchanged since Wave 3B | a store written by the Wave 3B CLI is read as is (tested with that CLI's own code) |
| `profiles.json` (0600) | `version: 1`, new in Wave 6 | created on first use |

**[DECIDED]** A future change of either format gets a new `version`, and
the CLI that introduces it migrates the file atomically (write a new file,
rename) the first time it reads the old one, never in place and never by
discarding a sign-in silently.

## 7. Uninstall

```sh
exponetdb auth status         # the servers this CLI holds a sign-in for
exponetdb logout --server <url>   # for each of them: revoke the grant first
npm uninstall --global @exponetdb/cli
rm -r ~/.config/exponetdb     # only after logout: the token store and profiles
```

Uninstalling the package alone leaves the private files; a sign-in that is
not revoked stays valid on the server until it expires.

## 8. Diagnosis

| Symptom | Meaning | What to do |
|---|---|---|
| `exponetdb: command not found` | the install's `bin` is not on PATH | add the prefix's `bin` to PATH |
| `parser_unavailable` (exit 1) | a parser asset of one major is missing or damaged; the other majors still work | reinstall the tarball; `doctor` lists the three parsers |
| `incompatible_server` (exit 5) | the server speaks another REST API version | use a CLI that matches the server |
| `installation_changed` (exit 5) | another installation answers at the profile's origin | check the server; re-add the profile with `--force` only if the change is intended |
| `store_insecure` (exit 1) | the token store or its directory is readable by others or not yours | fix the permissions or remove the file and sign in again |
