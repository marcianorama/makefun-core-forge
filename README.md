# makefun-core-forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun leaderboard rank](https://make.fun/badge/github-core-clone-01/marcianorama/makefun-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![make.fun leaderboard reward](https://make.fun/badge/github-core-clone-01/marcianorama/makefun-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)

Single-process GitHub-compatible forge for the public make.fun bounty `github-core-clone-01`.

Public repository: `marcianorama/makefun-core-forge`

No UI is included because the official rules require no UI.

- Bounty: https://make.fun/bounty/github-core-clone-01
- Leaderboard: https://make.fun/bounty/github-core-clone-01/leaderboard
- Referral: https://make.fun/r/3j5xzb2p

## What it is

This project runs one HTTP server process and exposes:

- Git Smart HTTP for native `git clone`, `git fetch`, `git pull`, and `git push`
- GitHub-style REST endpoints
- GraphQL endpoint
- MCP JSON-RPC endpoint
- unauthenticated `GET /healthz`

The forge implementation itself uses Node 22 standard library only, plus a bundled vendored GraphQL module under MIT (`graphql` 16.11.0, provided separately by the operator in `./vendor/graphql.mjs`, about 250 KB). There is no runtime installation step.

This is a compact challenge implementation, not a production multi-user forge. It does not claim TLS, horizontal scaling, full restart durability, or complete GitHub parity.

## Runtime

- Node 22
- Entry point: `main.ts`
- One process
- No subprocesses inside the server
- No external network calls except optional make.fun lifecycle registration
- No UI

## Authentication

All surfaces except `/healthz` require the configured token.

Set a local token:

```bash
export MAKEFUN_SHOP_TOKEN=replace-with-local-test-token
```

Accepted forms:

- `Authorization: Bearer <token>`
- `Authorization: token <token>`
- HTTP Basic with password equal to the token
- HTTP Basic with username equal to the token and blank password

The forge uses one configured login owner. Default: `adaiversen`. Override with `MAKEFUN_FORGE_LOGIN` if needed.

## Storage model

Current storage is intentionally simple:

- in-memory metadata for repos, refs, issues, pulls, labels, comments, and node mappings
- append-only Git object journal for object bytes
- shared real Git object graph in `GitStore`

Git object bytes use the real Git SHA-1 object format:

```text
<type><space><byteLength><NUL><raw bytes>
```

The append-only object journal allows object round-trip reloads for the same directory, but the full forge state is not fully restart durable. This should not be described as a production persistence layer.

## Environment

- `PORT` optional listen port for local use
- `MAKEFUN_SHOP_TOKEN` shared auth token
- `MAKEFUN_FORGE_LOGIN` optional owner/login override
- `MAKEFUN_ENV_URL` optional make.fun lifecycle base URL

The server listens on `0.0.0.0` and uses `PORT` when set, otherwise port `0`.

## Quick start

```bash
PORT=43123 MAKEFUN_SHOP_TOKEN=replace-with-local-test-token node main.ts
```

Health check:

```bash
curl http://127.0.0.1:43123/healthz
```

Expected response:

```json
{"ok":true}
```

## Complete example: create a repo, then clone it with native Git

Set local variables first:

```bash
export PORT=43123
export TOKEN=replace-with-local-test-token
export OWNER=adaiversen
export REPO=demo
```

Start the server in another shell:

```bash
PORT="$PORT" MAKEFUN_SHOP_TOKEN="$TOKEN" node main.ts
```

Create the repository:

```bash
curl \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:$PORT/api/v3/user/repos \
  -d '{"name":"demo","description":"sample repo"}'
```

Clone with native Git using HTTP Basic token auth:

```bash
git clone "http://x-access-token:$TOKEN@127.0.0.1:$PORT/$OWNER/$REPO.git"
```

You can also start from a fresh local repository and push upstream:

```bash
mkdir demo-work
cd demo-work
git init -b main
git config user.name "Local Test"
git config user.email "local@example.invalid"
printf 'hello\n' > README.md
mkdir src
printf 'export const ok = true;\n' > src/index.js
git add .
git commit -m "initial commit"
git remote add origin "http://x-access-token:$TOKEN@127.0.0.1:$PORT/$OWNER/$REPO.git"
git -c core.autocrlf=false push -u origin main
```

## Implemented surfaces

### REST

Rooted at `/api/v3` with some root aliases.

Examples:

- `GET /api/v3/user`
- `POST /api/v3/user/repos`
- `GET /api/v3/repos/:owner/:repo/branches`
- `GET /api/v3/repos/:owner/:repo/contents/:path`
- `PUT /api/v3/repos/:owner/:repo/contents/:path`
- `DELETE /api/v3/repos/:owner/:repo/contents/:path`
- `POST /api/v3/repos/:owner/:repo/issues`
- `POST /api/v3/repos/:owner/:repo/pulls`
- `PUT /api/v3/repos/:owner/:repo/pulls/:number/merge`

Intentional error cases include `401`, `404`, `409`, `422`, and `405` where appropriate.

### GraphQL

- `POST /graphql`
- `POST /api/graphql`

### MCP

- `POST /mcp`

Implemented tools:

- `create_repo`
- `get_repo`
- `create_issue`
- `list_issues`
- `create_pull_request`
- `merge_pull_request`

### Git Smart HTTP

Examples:

- `GET /owner/repo.git/info/refs?service=git-upload-pack`
- `POST /owner/repo.git/git-upload-pack`
- `GET /owner/repo.git/info/refs?service=git-receive-pack`
- `POST /owner/repo.git/git-receive-pack`

## Local tests

Run the included local tests:

```bash
node tests/unit.mjs
node tests/e2e.mjs
```

Current local status recorded during this build:

- unit tests passed
- native Git e2e tests passed

These results were measured locally on Windows during development. Official suite scores can differ on another machine or environment.

## Local official runner commands

Example SDK command variables:

```bash
export FORGE_URL=http://127.0.0.1:43123
export FORGE_TOKEN=replace-with-local-test-token
```

Run the official SDK suite with perf JSON output:

```bash
node path/to/sdk/run.ts --url "$FORGE_URL" --token "$FORGE_TOKEN" --perf --json
```

Run local grading with the process driver:

```bash
node path/to/grade-local --driver process --cmd "node main.ts" --url "$FORGE_URL" --token "$FORGE_TOKEN"
```

Replace `path/to/...` with your local checkout paths for the official tooling.

## Limitations

This repository is intentionally scoped to the bounty contract.

Examples of honest limits:

- not a full GitHub replacement
- not presented as production-ready multi-user hosting
- no TLS termination in this repository
- metadata is not fully restart durable
- behavior is targeted to the specified contract, not every Git or GitHub edge case

## License

MIT
