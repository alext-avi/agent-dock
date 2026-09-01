# Agent Dock: containerized subscription-agent POC

This proof of concept registers independently configured agents in a small control plane and connects each one to a vendor-neutral worker API. Every newly managed agent owns an exclusive Codex CLI, Claude Code, or multi-provider OpenCode worker container plus private CLI-binary, authentication, telemetry, and workspace volumes. Each container installs its CLI on first boot and translates provider output into the versioned Agent Wrapper event protocol.

It is meant to validate the architecture—not to automate subscription creation, rotate accounts, resell access, or hide provider usage limits.

## Run it

Requirements: Docker Desktop (or Docker Engine with Compose) and an eligible Codex and/or Claude Code subscription. Ollama is optional and can run on the Docker host without provider credentials.

```bash
cp .env.example .env
# Set a long random WORKER_TOKEN in .env.
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). **Codex Worker 01** is the legacy bootstrap runtime and uses OpenAI's device flow. Creating another agent provisions a fresh isolated container. A Claude Code agent uses **Start browser login**; Claude Code may return a one-time authorization code after browser sign-in, which Agent Dock forwards to that agent's waiting CLI process without logging or persisting it. An OpenCode agent defaults to the officially supported GitHub Copilot device flow and automatically selects public GitHub.com before surfacing the provider URL/code. Nothing in this repository asks for or accepts a provider password, session cookie, API key, or stored OAuth token.

When Ollama is listening on the host's default port, the OpenCode worker discovers its models through `host.docker.internal`, generates a private OpenCode provider config in the worker's data volume, and exposes safe model metadata in the agent configuration page. Choose a model under **Instructions → Model policy** and save it to pin that agent. Choose **OpenCode provider default** to keep using the CLI's current provider. The browser-facing API does not return the Ollama endpoint, and Agent Dock never silently falls back between a local model and a subscription provider. Linux Compose uses the `host-gateway` mapping; override `OLLAMA_BASE_URL` if the Ollama service lives elsewhere.

If port 3000 is already occupied, set `CONTROL_PLANE_PORT` in `.env` before starting Compose—for example, `CONTROL_PLANE_PORT=3080` makes the UI available at `http://localhost:3080`.

The first boot of each agent can take a minute because its worker installs its own CLI at runtime. Managed runtimes deliberately do not share writable binary caches or auth homes: each receives four uniquely named volumes for its CLI installation, credentials/config, telemetry, and workspace. The `control-data` volume stores schema-v3 agent definitions, runtime bindings, MCP definitions, and per-agent MCP bindings. Set `CODEX_VERSION`, `CLAUDE_VERSION`, or `OPENCODE_VERSION` in `.env` to pin a release.

The control plane also stores scheduled jobs and their run history in SQLite on the `control-data` volume. Open **Jobs** from the top navigation to schedule a one-off job for later or choose a plain-language hourly, daily, weekday, weekly, or monthly cadence, inspect the next occurrence and history, edit the cadence, pause/resume, or run a job immediately. The UI translates recurring choices to five-field cron under the hood. Occurrence claiming is at-most-once, overlapping work is skipped for a busy agent, and each run retains duration, outcome, task ID, and normalized usage when the worker reports it. The contract and delivery semantics are documented in [`docs/scheduling.md`](./docs/scheduling.md).

Use **Tools & MCP** on an agent page to create a remote HTTP or local stdio MCP definition, attach a reusable definition, validate it against the selected harness, and apply the complete desired state. The control plane and all three workers use the same canonical payload in both directions; only the isolated worker translates it into Codex, Claude Code, or OpenCode configuration. Connector credentials are referenced by worker environment-variable name and never returned to the control plane. Local stdio MCP is denied unless its exact executable appears in `MCP_ALLOWED_COMMANDS` (comma-separated in `.env`).

Claude Code is always launched with a worker-owned strict MCP file, including an empty file before its first connector is configured. OpenCode resolves its merged configuration before task start and disables MCP entries introduced outside Agent Dock's managed set; an unreadable or invalid merged configuration prevents the task from starting.

The worker image includes the operating-system CA certificate bundle required by the Codex CLI for TLS connections during device authentication.

Artifacts created by the three legacy bootstrap workers appear in [`workspace/`](./workspace), [`claude-workspace/`](./claude-workspace), and [`opencode-workspace/`](./opencode-workspace). Newly provisioned agents use exclusive Docker workspace volumes and expose their artifact inventory through the wrapper API.

## What the POC proves

```mermaid
flowchart LR
  B["Dashboard + agent config/test UI"] -->|"same-origin HTTP"| C["Control plane + agent registry"]
  C -->|"Docker Engine API"| P["Exclusive runtime provisioner"]
  P -->|"Agent Wrapper v1"| W1["Dedicated Codex worker"]
  P -->|"same contract"| W2["Dedicated Claude Code worker"]
  P -->|"same contract"| W3["Dedicated OpenCode worker"]
  W1 --> A1["Codex adapter"]
  W2 --> A2["Claude adapter"]
  W3 --> A3["OpenCode adapter"]
  A1 -->|"device flow"| O1["OpenAI authentication"]
  A2 -->|"browser OAuth"| O2["Anthropic authentication"]
  A3 -->|"provider auth"| O3["GitHub Copilot by default"]
  A3 -->|"credentialless local inference"| O4["Host Ollama"]
  W1 --> V1["Private binary + auth + telemetry + workspace volumes"]
  W2 --> V2["Private binary + auth + telemetry + workspace volumes"]
  W3 --> V3["Private binary + auth + telemetry + workspace volumes"]
```

- The browser never receives the Docker socket, worker routing secrets, or provider credentials. In this local POC, the server-side control-plane container uses the Docker socket to provision runtimes; this is a privileged host boundary and must become a constrained provisioner service before multi-user deployment.
- The fleet dashboard supports create, read, update, and lifecycle-aware delete for agent records, then reports each reachable runtime's auth, activity, usage, and request count.
- Newly managed agents cannot share a runtime. The API rejects attaching a runtime that already has an owner.
- A managed runtime can be moved onto a rebuilt worker image without losing its credentials. Refreshing replaces the container from the currently configured image and reattaches the same CLI, auth, telemetry, and workspace volumes, so the agent stays signed in; a refresh is refused while a task is running, and never touches a bootstrap runtime.
- Deleting a managed agent explicitly chooses between stopping and retaining all isolated state for later exclusive reattachment, or destroying the container and every private volume after exact-ID confirmation.
- Fleet and agent runtime status refresh every three seconds while the browser tab is visible, with overlapping requests deduplicated.
- Each agent has a durable prompt stored by the control plane and a separate, intentionally ephemeral test conversation.
- The agent workspace puts live runtime, authentication, and usage data in its header, with separate Instructions, Tools & MCP, Data, and Test areas.
- Worker endpoints and bearer tokens are server-side connection details and are never returned in agent API responses or rendered in the browser.
- The browser cannot override durable instructions per request; the control plane injects the saved prompt when it dispatches a task.
- The browser also cannot override a saved model policy per request; model selection is a durable agent setting.
- A worker can be local or remote as long as the control plane can reach its HTTP endpoint.
- Device authentication is initiated by the unmodified Codex CLI and surfaced as a URL/code.
- The card shows safe session metadata, including access-token expiry and last refresh time, without returning credentials to the control plane.
- A user can force Codex's supported managed-session refresh through app-server; this does not run a model turn.
- The adapters convert `codex exec --json`, `claude -p --output-format stream-json`, and `opencode run --format json` output into canonical, vendor-neutral task events.
- The agent can create durable artifacts in its isolated workspace.
- Each completed request records input, cached-input, output, total-token, duration, and outcome metrics in the `agent-data` volume.
- The Codex worker polls app-server after each request for subscription quota windows and account token-activity summaries.
- Claude Code exposes per-request token telemetry in its stream but no supported subscription quota-window endpoint, so that adapter reports quota/account capabilities as unavailable rather than inventing data. An experimental, opt-in source (`CLAUDE_OAUTH_USAGE=1`) can read the CLI's own OAuth token inside the worker and report five-hour and weekly windows from Anthropic's undocumented `/api/oauth/usage` endpoint; it is off by default, labelled experimental in the UI, and fails closed.
- An exhausted subscription and a broken telemetry source are different states. A plan at its limit is a successful reading of 100%; a source that cannot be read is reported with a classified failure reason, keeps the last observed windows, and never renders as 0% used. A retained reading is labelled stale rather than shown with a live reset countdown.
- The experimental usage source bounds itself with its own interval floor that a forced refresh cannot bypass, honours `Retry-After` up to a capped ceiling, and backs off further when a credential is rejected rather than retrying a doomed request indefinitely.
- OpenCode exposes per-request token/cost events but account quotas remain provider-specific, so the adapter advertises request telemetry without inventing account windows. OpenCode is a multi-provider harness; it does not itself supply subsidized tokens.
- OpenCode discovers local Ollama models and can explicitly pin one as `ollama/<model>`. The effective model is included in task-start events and request history. Automatic cross-provider fallback is intentionally disabled.
- The control plane depends only on the versioned wrapper contract; both provider workers use the same UI and API surface.
- MCP definition CRUD and per-agent bindings persist in the control plane, while validation, vendor translation, activation, and health remain worker responsibilities. `GET` and `PUT /v1/mcp` round-trip the same `servers[]` DTO.
- Durable one-off and recurring jobs are claimed in SQLite before dispatch. Restarted claims are marked interrupted rather than run twice; cron misfires and busy-agent skips remain visible in history.
- The live Jobs screen provides scheduler health, next-run and outcome summaries, schedule CRUD, pause/resume, run-now, and five-entry per-job history without exposing worker routing credentials.

The complete system model is available as [Markdown](./docs/architecture.md), [editable Mermaid](./docs/architecture.mmd), and a [standalone SVG](./docs/architecture.svg). The provider boundary is documented in [`docs/adapter-contract.md`](./docs/adapter-contract.md).

## API

The control plane exposes fleet CRUD plus a consistent set of runtime operations scoped by agent ID:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Control-plane and worker reachability |
| `GET` | `/api/v1/scheduler` | Scheduler storage, tick health, and active execution status |
| `GET`, `POST` | `/api/v1/agents` | List or create agent records |
| `GET`, `PATCH`, `DELETE` | `/api/v1/agents/:id` | Read, edit, or delete one agent record |
| `GET` | `/api/v1/runtimes` | List safe runtime identities, lifecycle state, isolation mode, and attachment counts |
| `GET`, `POST` | `/api/v1/mcp/servers` | List or create reusable provider-neutral MCP definitions |
| `GET`, `PATCH`, `DELETE` | `/api/v1/mcp/servers/:id` | Read, update, or delete an unattached MCP definition |
| `GET` | `/api/v1/agents/:id/mcp` | Read desired bindings plus the worker's round-tripped state and sanitized health |
| `POST` | `/api/v1/agents/:id/mcp/bindings` | Attach an MCP definition to an agent |
| `PATCH`, `DELETE` | `/api/v1/agents/:id/mcp/bindings/:serverId` | Enable/disable or detach one binding |
| `POST` | `/api/v1/agents/:id/mcp/validate` | Validate a definition against the agent harness and command policy |
| `POST` | `/api/v1/agents/:id/mcp/apply` | Replace the worker's complete managed MCP desired state |
| `GET` | `/api/v1/agents/:id/status` | Adapter, capability, auth, task, execution, and usage status |
| `GET` | `/api/v1/agents/:id/providers` | Safe provider-connection health and discoverable model metadata; never credentials or private endpoint URLs |
| `POST` | `/api/v1/agents/:id/auth/login` | Start the adapter's interactive login flow |
| `POST` | `/api/v1/agents/:id/auth/complete` | Forward a provider-issued one-time browser authorization code to a waiting CLI |
| `POST` | `/api/v1/agents/:id/auth/refresh` | Ask the adapter to refresh its managed session |
| `POST` | `/api/v1/agents/:id/tasks` | Run `{ "prompt": "..." }` with saved durable instructions; returns canonical NDJSON |
| `POST` | `/api/v1/agents/:id/tasks/cancel` | Cancel the active task |
| `GET` | `/api/v1/agents/:id/workspace` | List worker artifacts (not their contents) |
| `GET` | `/api/v1/agents/:id/usage` | Read normalized request history, totals, quota windows, and account activity |
| `POST` | `/api/v1/agents/:id/usage/refresh` | Ask the adapter to refresh its available usage sources |
| `GET`, `POST` | `/api/v1/schedules` | List or create schedules; GET accepts agent filtering and batched run history |
| `GET`, `PATCH`, `DELETE` | `/api/v1/schedules/:id` | Read, edit, or soft-delete one schedule |
| `POST` | `/api/v1/schedules/:id/pause` | Pause future occurrences |
| `POST` | `/api/v1/schedules/:id/resume` | Resume a paused schedule |
| `POST` | `/api/v1/schedules/:id/run-now` | Dispatch a manual occurrence without changing the recurring cadence |
| `GET` | `/api/v1/schedules/:id/runs` | Read durable outcome, duration, task, and usage history |
| `POST` | `/api/v1/agents/:id/runtime/refresh` | Replace a managed runtime's container with one built from the current image, retaining its volumes |

The original unscoped runtime routes remain aliases for the default agent during the POC.

Creation makes runtime ownership explicit:

```json
{
  "name": "Claude Research",
  "adapter": "claude-code",
  "runtime": { "mode": "provision" }
}
```

`runtime.mode: "attach"` requires the ID of an unbound retained runtime and fails with `409` if another agent owns it. Deleting an agent with a runtime requires `{ "runtimeAction": "retain" }` to stop and preserve it, or `{ "runtimeAction": "destroy", "confirmation": "agent-id" }` to permanently remove the container and all four isolated volumes.

Example without the UI:

```bash
curl -N http://localhost:3000/api/v1/agents/worker-01/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create /workspace/hello.txt with a short greeting."}'
```

## Security boundary and limitations

The worker invokes `codex exec --dangerously-bypass-approvals-and-sandbox` by default because the Docker container is the POC's non-interactive execution boundary. The agent can modify the bind-mounted `workspace/`, run processes inside the worker, and use the worker's network. Do not mount source, SSH keys, cloud credentials, the Docker socket, or sensitive host paths into it. Set `ALLOW_UNSANDBOXED=0` to use Codex's `workspace-write` sandbox instead, understanding that unattended tool execution may be more constrained.

The included Compose file retains one bootstrap worker for each adapter so schema-v1 installations can migrate without losing logins. Those bindings are labeled `shared-legacy`, and the control plane prevents newly created agents from attaching to an already-bound bootstrap runtime. All new managed agents provision an exclusive container and complete private volume set. One-time remote-worker pairing, tool installation, and arbitrary data mounts remain distinct next capabilities.

That floor defaults to thirty minutes and is per worker process. Each agent has its own container and its own copy of the credential, so a fleet of agents signed in to one subscription still multiplies calls to that account by the number of agents; there is no shared cross-agent budget. The endpoint does throttle in practice — a fifty-four-minute `Retry-After` was observed while the floor was five minutes — so raise `CLAUDE_OAUTH_USAGE_INTERVAL_MS` further before running many Claude agents against a single account. When a backoff or the floor is in force, the agent page reports when the source will next be read rather than offering a refresh that cannot run.

This prototype deliberately omits multi-tenancy, webhooks, automatic model fallback, usage-limit routing, TLS, user authentication for the web UI, remote secret management, egress controls, and container resource limits. Scheduled jobs use a local SQLite database, but multi-replica leader election, retries beyond one attempt, webhook triggers, and an agent-facing MCP schedule surface remain follow-ons. The agent/runtime/MCP registry is still a single JSON file and the browser is vanilla JavaScript; migration of that registry behind the SQLite/Postgres-ready persistence boundary and a React/TypeScript frontend are separately tracked. Usage telemetry, agent configuration, schedules, and run history are durable; live event streams and test conversations are not.

The experimental Claude usage source is the one place a provider credential is read by Agent Dock code rather than only by the vendor CLI. That read happens inside the worker, against the worker's own private auth volume; the token is never returned, logged, persisted, or sent to the control plane or browser, and only normalized quota windows cross the wrapper. The response is reduced to the quota fields before anything is written to the telemetry volume, so the account and billing state it also carries is not retained at rest. It targets an endpoint Anthropic does not document and for which no third-party OAuth flow or scoped usage-only token exists, so it may break without notice and is disabled unless you set `CLAUDE_OAUTH_USAGE=1`. The account-profile endpoint, which returns names, email addresses, and organization identifiers, is deliberately not called.

Connector secrets for MCP servers are provisioned under the `MCP_SECRET_` namespace and are the only variables an MCP definition can resolve, so a definition cannot name the runtime's own wrapper token, a provider home, or the Ollama endpoint. Two limits are worth stating plainly rather than leaving to inference. The resolved value is readable by the agent in that container, so this scopes and makes a credential revocable without being confidentiality against the harness itself. And there is no destination allowlist yet: a definition carrying a legitimately provisioned secret can still name any `https` host, so an operator authoring or approving a definition is the only thing deciding where that credential is sent.

The control plane does not inspect or copy provider credentials, but the Docker host administrator can technically inspect container volumes. The CLI needs its auth volume to remain writable so refreshed tokens can be persisted. Each managed runtime has a unique random wrapper bearer token stored only in the server-side registry and its worker environment; it is transport authentication, not a provider credential. Mounting `/var/run/docker.sock` gives the local control plane host-level container authority. For remote deployment, isolate that authority behind a narrowly scoped provisioner, put the UI behind real authentication and TLS, replace stored bearer tokens with secret-manager references or pairing credentials, constrain network egress, run rootless containers, pin the CLI version and base image digest, and add CPU/memory/PID limits.

The planned control-plane MCP server will use an explicit safe-tool registry. It will not expose MCP definition/binding/apply operations or storage, volume, and mount mutation operations, even though the operator REST/UI uses adjacent internal services. This separation is enforced in code rather than delegated to agent instructions.

Users and operators remain responsible for complying with applicable OpenAI terms and account rules. This project does not implement automatic account rollover or subscription provisioning.

## Development and test

The application has no third-party JavaScript dependencies. Run the contract test with:

```bash
npm test
```

The browser client has its own suite, kept separate because it needs a real browser
rather than staying hermetic:

```bash
npx playwright install chromium   # once
npm run test:ui
```

Those tests cover what a person sees rather than what the API returns — that an
unavailable reading is never drawn as a confident zero, that a retained reading from
before a failed poll is marked stale rather than presented as current, that image
drift appears only for a managed runtime that is behind, that the status poll cannot
re-enable a runtime refresh mid-request, and that no worker endpoint or token reaches
the DOM.

To exercise the complete UI without authenticating or spending subscription usage, start the deterministic demo worker:

```bash
npm run demo
```

For UI-only work against a separately running worker:

```bash
WORKER_TOKEN=... WORKER_URL=http://127.0.0.1:7777 npm run dev
```
