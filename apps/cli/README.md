# @exponetdb/cli

The `exponetdb` command-line client. Wave 3B ships sign-in only
([`oauth.md` §5](../../exponetdb-docs/05-mcp/oauth.md),
[G3B record](../../exponetdb-docs/14-roadmap/gates/3b.md)); the commands that
manage targets and migrations arrive with their waves.

```sh
exponetdb login  [--server URL] [--scope "a b"] [--device] [--no-browser]
exponetdb logout [--server URL]
exponetdb whoami [--server URL]
```

The server comes from `--server`, else `EXPONETDB_URL`, else the only server
with stored credentials. It must be an `https` origin (plain `http` only on a
loopback host).

## Behavior

- `login` uses the first-party client `exponetdb-cli`: the authorization code
  flow with PKCE S256 and a loopback redirect on `127.0.0.1` with an
  ephemeral port, or with `--device` the device authorization grant (the
  person types the shown code in the Web App). Discovery must name the chosen
  server as issuer with same-origin endpoints; `state` and `iss` of the
  response are checked; the loopback page reflects nothing.
- Tokens live in `$XDG_CONFIG_HOME/exponetdb/credentials.json` (or
  `EXPONETDB_CONFIG_DIR`): 0600 in a 0700 directory, written atomically,
  refused when others can read it. A refresh runs under an exclusive lock so
  two processes never rotate the same refresh token twice.
- `logout` revokes the refresh token (which ends the grant) before it deletes
  the local copy and says so when the server did not confirm.
- No token is ever printed or logged.

## Tests

`bun run test` (against a fake authorization server) and the browser suite
`bun run test:e2e` at the root, which runs the built CLI (`dist/main.js`)
with Node against the real `serve` role.

## Allowed dependencies

`@exponetdb/contracts` only ([package-architecture.md §1.5](../../exponetdb-docs/01-architecture/package-architecture.md#15-state-during-wave-3b)).
