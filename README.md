# Dev Hub

Public, configuration-driven local development tooling. Requires Node 22+ and POSIX process groups (macOS, Linux or WSL). Docker and Caddy are needed only when the consuming configuration enables them.

The package has no application names, directory layouts, process roles, framework defaults, database drivers, credentials or business logic. It executes the consuming repository's declared commands. Database setup/reset, queue provisioning, seeding and application-specific checks belong in that repository's configuration or hooks.

## Installation

Install the public, version-pinned npm archive directly from GitHub Releases. No registry login or npm credential file is needed:

```sh
npm install --save-dev https://github.com/128BitStudios/devhub/releases/download/v0.1.1/128bitstudios-devhub-0.1.1.tgz
```

The dependency lockfile records the archive URL and integrity checksum. Commit it with your manifest. Future releases publish the identical archive to GitHub Packages as well; that registry still requires authentication even for public packages. Use the public release URL for credential-free installation. Do not commit credentials or add a registry mapping just for this URL dependency.

Add `"dev": "devhub up"` to your package scripts. `up` performs setup automatically. The initial package installation itself still requires `npm ci` on a new checkout. Avoid global installations or unpinned `npx` downloads for everyday development.

## Minimal configuration

```json
{
  "$schema": "./node_modules/@128bitstudios/devhub/schema.json",
  "version": 2,
  "id": "sample",
  "processes": {
    "service": {
      "cwd": ".",
      "command": ["npm", "run", "watch"],
      "ready": "/health",
      "env": { "LISTEN_PORT": "${ports.service}" }
    }
  }
}
```

Process names and environment keys are unrestricted application choices. Each process receives an allocated port; it uses that port only through the explicit environment mapping. Commands are argument arrays, not shell strings. Optional `envFile` paths load existing local environment files.

## Commands

`devhub up`, `stop`, `status`, `logs <process> [--follow]`, `setup`, `doctor`, `trust`, `check`, `reset --confirm`, and `validate` operate on the nearest parent `devhub.json`.

`up` runs setup, optional Compose readiness, `beforeStart` hooks, and the configured watch commands. It publishes routes only when processes are ready. A repeat start reuses the active instance. Stop controls only the current checkout's authenticated supervisor and its own process groups. Existing port owners are never evicted. Startup readiness is bounded; process bind races fail cleanly and a restart reallocates ports.

`check` performs setup, optional infrastructure startup, `beforeCheck` hooks, and configured `checks` sequentially. Failure stops subsequent commands. `reset --confirm` stops this checkout and executes only its explicitly configured reset hooks. The package itself does not delete databases or volumes. Hook authors own the destructive-action scope and validation.

## Configuration reference

- `setup.dependencies`: `{ "check": "node_modules/.bin/tool", "command": ["npm", "ci"] }`; invoked only when the marker is absent. Run `npm ci` after lockfile changes.
- `setup.envFiles`: objects with `path`, `example`, and optional `generate` mappings. Generators specify `bytes` (16–256) and `encoding` (`base64` or `hex`); keys must already exist in the template. Existing files are never overwritten, and template order/comments are retained.
- `env`: global environment mappings; each process can override them through its own `env`.
- `infrastructure`: a Compose `project`, checkout-relative `file`, and a `ports` map. Each port declares its Compose `service`, container `target`, and Compose environment `variable`. Existing healthy mappings are reused; fresh mappings are allocated. No image versions or service definitions are hard-coded in this package. Keep your Compose definitions in the infrastructure-owning repository.
- `gateway`: a `primary` route name, `routes`, optional printed `links`, and optional HTTPS `ready` route/path. Each route declares a `name`, a `host` template ending in `.localhost`, and either a service-port key or ordered `paths` mapping match patterns to process names. A path without `match` is the fallback. Prefixes are preserved, not stripped.
- `hooks`: `beforeStart`, `beforeCheck`, and `reset` arrays of command objects. A hook's optional `process` selects that process's environment; `cwd` selects its checkout-relative directory.
- `checks`: sequential command objects, with optional `cwd`.

String mappings expand `${ports.PROCESS}`, `${services.KEY}`, `${instance.id}`, `${instance.hash}`, `${instance.isWorktree}`, `${host}`, `${root}`, `${url}` and `${urls.ROUTE}`. Environment mappings can additionally reference `${env.KEY}` from that process's source file. Unresolved variables fail rather than silently using a wrong endpoint.

For local connection URLs, a mapping can instead be `{ "source": "EXISTING_KEY", "url": { "port": "SERVICE_KEY", "worktreePath": "suffix" } }`. This rewrites only loopback URLs and preserves credentials/query parameters. In linked worktrees, `suffix` appends the checkout hash to the URL path; `instance` replaces the path with the instance ID. The package does not interpret the protocol or provision that resource; use a repository hook when needed.

Hooks and processes receive generic metadata: `DEVHUB_INSTANCE_ID`, `DEVHUB_INSTANCE_HASH`, `DEVHUB_WORKTREE`, `DEVHUB_ROOT`, `DEVHUB_INFRASTRUCTURE_ROOT`, `DEVHUB_SERVICES_JSON`, and `DEVHUB_URL`. Do not put credentials into command arguments or printed links. Keep runtime secrets in environment files; they are not written to route state.

## Machine state and compatibility

Machine state is private under `~/Library/Application Support/Local Dev Hub` on macOS, or `~/.local/state/devhub` on Linux. It is shared across package installations and never committed. `DEVHUB_STATE_DIR` overrides it for tests; separate state directories do not independently isolate Docker projects.

The gateway protocol is version 1 and manifest format is version 2. All installed package versions must support the same gateway protocol. Unknown protocol versions fail explicitly. Stop pre-package pilot launchers before the first migration. Different package versions must not silently rewrite incompatible shared state.

The Caddy gateway prefers 80/443 or uses 8080/8443 where privileged ports are unavailable. Machine overrides: `DEVHUB_HTTP_PORT`, `DEVHUB_HTTPS_PORT`, `DEVHUB_CADDY`. Port overrides apply when the gateway starts; its selected ports persist across app restarts. `devhub trust` installs the generated local authority into the user's keychain on macOS, or uses Caddy trust on other systems. Independent browser stores may need the same root imported. Do not disable TLS verification. Browser `.localhost` support is required; non-browser clients can use explicit loopback DNS mappings.

Linked Git worktrees receive stable path-derived instance IDs and share their main checkout's Compose owner. Moving a checkout changes its identity and never deletes its old resources. Independent primary clones need distinct application IDs when run on the same machine. This release does not consolidate service data from existing applications or choose service-version compatibility automatically.

## Release

Run `npm ci`, `npm run build`, `npm test`, and inspect `npm pack --dry-run`. Verify CI on the exact main commit before tagging. Publish an immutable `vVERSION` GitHub Release to trigger the package publishing workflow. It uses the repository's scoped `GITHUB_TOKEN`, verifies the version, reruns checks, publishes the archive to GitHub Packages and attaches the identical public archive to the GitHub Release, then verifies registry metadata and anonymous installation. App consumers upgrade their pinned versions independently.
