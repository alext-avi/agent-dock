# Agent Dock — working notes for Claude

Agent Dock is a proof of concept: a vendor-neutral control plane that provisions one isolated
container per agent, and a worker wrapper that translates each provider CLI (Codex, Claude Code,
OpenCode) into a single versioned protocol. It exists to validate an architecture, not to automate
subscription creation, resell access, or hide provider usage limits.

Repository: `alext-avi/agent-dock`.

## Layout

| Path | What it is |
|---|---|
| `control-plane/server.mjs` | HTTP API, agent/runtime registry, NDJSON task proxy. Provider-agnostic. |
| `control-plane/docker-runtime.mjs` | Docker Engine client: provisions the container + 4 private volumes per agent. |
| `control-plane/public/` | Browser UI — hand-written HTML/CSS and vanilla ES modules. No build step. |
| `worker/server.mjs` | The `agent-wrapper/v1` worker: installs its CLI, runs tasks, owns credentials. |
| `worker/adapters/*.mjs` | Pure event/usage translators, one per provider. |
| `worker/protocol.mjs` | Protocol version constant, event envelope, token normalization. |
| `docs/adapter-contract.md` | The authoritative wrapper contract. Read it before touching a boundary. |
| `docs/architecture.{md,mmd,svg}` | System model. `.mmd` is the editable source; `.svg` is exported. |
| `test/poc.test.mjs` | Contract tests against in-process fake workers and a fake runtime manager. |

## Commands

```bash
npm test                # node --test — no network, no Docker, no provider credentials needed
npm run demo            # deterministic fake worker, exercises the whole UI without spending usage
npm run dev             # control plane only, against a separately running worker
WORKER_TOKEN=... WORKER_URL=http://127.0.0.1:7777 npm run dev
docker compose up --build   # the real thing; needs Docker and a provider subscription
```

`npm test` is the gate for every change. It is fast and hermetic — run it before reporting done.

## Invariants

These are the things the POC is trying to prove. Breaking one silently defeats the point of the repo.

**The adapter boundary.** The control plane must never branch on a provider. No `if (adapter === 'claude-code')`
in `control-plane/`, no provider-specific event names, credential formats, or CLI flags above the wrapper.
Everything provider-shaped lives in `worker/adapters/` behind `agent-wrapper/v1`.

**The protocol is versioned.** Additive fields are fine inside `agent-wrapper/v1`. Renaming a field, changing
an event's meaning, or making an optional capability mandatory needs a new version — and an update to
`docs/adapter-contract.md` in the same change.

**Never invent provider data.** If a provider exposes no quota window or account activity, the adapter
advertises the capability as `false` and returns zero or absent values. Claude Code reports
`quotaWindows: false` for exactly this reason. Fabricating telemetry is worse than reporting nothing.

**No automatic cross-provider fallback.** A pinned model policy is honored or it fails. The wrapper rejects
silently switching between a local model and a subscription provider.

**Secrets stop at the server.** `workerUrl`, `workerToken`, the Docker socket, provider credentials, raw
auth responses, and private connection URLs (including `OLLAMA_BASE_URL`) must never appear in an
`/api/v1` response, in the DOM, or in a log line. A browser OAuth completion code is forwarded once to the
waiting CLI and is neither logged nor persisted.

**Instructions and model policy are durable, not per-request.** The control plane injects the saved prompt
and saved model policy when it dispatches a task, and ignores browser attempts to override them.

**Runtimes are exclusive.** A managed runtime has exactly one owner; attaching a bound runtime returns 409.
Deleting an agent must explicitly choose `retain` or `destroy` (destroy requires exact-ID confirmation).
The `shared-legacy` bootstrap runtimes in `docker-compose.yml` are a migration affordance, not a pattern.

## Style

- Node 22+, ESM only, and `node:`-prefixed builtins. Runtime dependencies are intentionally limited to the
  official MCP SDK packages and Zod; review lockfile changes and do not add packages for built-in behavior.
- Two-space indent, semicolons, single quotes, no trailing-comma noise. Small pure functions at module top,
  factories (`createControlPlane`, `createWorkerServer`) that return a server.
- Errors carry an HTTP status: `throw Object.assign(new Error('...'), { status: 409 })`.
- Adapters export a frozen manifest plus a pure `normalize<Provider>Event(event)` function. Keep them pure —
  that is what makes them testable without a container.
- The UI uses `$`/`$$` helpers, a single `ui` element map, and visibility-aware 3-second polling with
  overlapping requests deduplicated. No framework, no bundler, no CDN script tags.

## Tests

`test/poc.test.mjs` is the model to copy. Tests stand up the real `createControlPlane` and
`createWorkerServer` in-process on port 0, plus `createStatusWorker` fakes and a `FakeRuntimeManager`,
then assert on the wire format. Adapter translators are tested by calling `normalize*Event` directly
with a recorded provider event. Never require Docker, network, or a real subscription in a test.

When you change the contract, add the test that would have caught the regression — exclusivity, secret
non-disclosure, prompt injection-by-the-server, migration from schema v1 — those all have precedents.

## Documentation debt is real here

The README and `docs/` are unusually precise about what the POC does and does not prove, and are expected
to stay that way. A change that alters behavior updates, in the same commit: `docs/adapter-contract.md` for
protocol changes, `docs/architecture.md` + `.mmd` (and re-export `.svg`) for structural changes, and the
README's "What the POC proves" / "Security boundary and limitations" sections for anything user-visible.

## Git and GitHub

Branches are named after the work they carry, e.g. `issue-1-mcp-management`.

Commit subjects are imperative, sentence case, one line, no `feat:`/`fix:` prefix and usually no body —
"Provision isolated runtime per agent", "Add Ollama model policies and clarify runtime isolation".

Work is tracked as GitHub issues labeled `area:architecture`, `area:runtime`, `area:frontend`,
`area:telemetry`, `area:mcp`, `area:scheduling`, `area:data-access`, plus `security` and `enhancement`.
The GitHub MCP server is available for reading issues and opening PRs. Commit and push only when asked.
