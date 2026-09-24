# Agent wrapper adapter contract

The control plane talks only to the versioned Agent Wrapper API. A provider adapter owns every provider-specific command, credential format, auth flow, usage query, and event shape.

Current protocol version: `agent-wrapper/v1`.

## Control-plane surface

| Method | Worker route | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Unauthenticated liveness and adapter identity |
| `GET` | `/v1/status` | Agent, capability, authentication, task, execution, and cached usage state |
| `GET` | `/v1/providers` | Safe provider-connection health and model discovery metadata |
| `GET` | `/v1/mcp` | Read the canonical managed MCP payload, generation, capabilities, pending credential deliveries, and sanitized health |
| `POST` | `/v1/mcp/validate` | Validate a canonical MCP payload against adapter and worker policy without executing it |
| `PUT` | `/v1/mcp` | Atomically replace the worker's complete managed MCP desired state |
| `POST` | `/v1/auth/login` | Start the adapter's supported interactive authentication flow |
| `POST` | `/v1/auth/complete` | Submit a provider-issued one-time browser authorization code when the adapter requires it |
| `POST` | `/v1/auth/cancel` | Cancel the current interactive authentication flow without deleting stored provider credentials |
| `POST` | `/v1/auth/refresh` | Ask the adapter to refresh or validate its managed session |
| `POST` | `/v1/auth/session-check` | Manually check/renew the provider session with one minimal request; never invoked by polling |
| `GET` | `/v1/workspace` | List durable workspace artifacts |
| `GET` | `/v1/usage` | Read cached request and account usage |
| `POST` | `/v1/usage/refresh` | Ask the adapter to refresh available usage sources |
| `POST` | `/v1/tasks` | Run `{ "prompt": "...", "instructions": "...", "modelPolicy": {...}, "runtimeLimits": {...} }` and stream canonical NDJSON events |
| `POST` | `/v1/tasks/cancel` | Cancel `{ "taskId": "..." }` only when it still identifies the active task |
| `GET` | `/v1/conversations` | List conversations this worker can continue |
| `GET`, `DELETE` | `/v1/conversations/:id` | Read one conversation, or forget the worker's mapping for it |

Every JSON response and NDJSON event includes `apiVersion: "agent-wrapper/v1"`. Errors use the same envelope with an `error` string.

`modelPolicy` is provider-neutral: `mode` is `provider-default` or `pinned`, and a pinned policy includes a canonical `primary` model ID such as `ollama/gpt-oss:20b`. `fallbacks` and `externalFallback` are reserved policy fields, but the current wrapper rejects automatic fallback rather than silently changing providers. The control plane injects the saved policy and ignores task-level overrides from browser clients.

`GET /v1/providers` returns `connections[]` with a stable ID, type, display name, coarse location, credential mode, health, last-check time, and discoverable `models[]`. It must not return credentials or private connection URLs. For Ollama, the model data may include context length, capabilities, family, parameter size, and quantization.

MCP management uses one round-trippable `servers[]` DTO in both directions; provider configuration is never used as the control-plane data model. See [`mcp-contract.md`](./mcp-contract.md). A definition writes `${NAME}` exactly where a dynamic value belongs and binds that name to either a stored credential or the worker-local connector-secret namespace.

`PUT /v1/mcp` may carry `credentials` beside `servers[]`: an ephemeral map from opaque definition-and-placeholder addresses to `{ value }`, resolved by the control plane for that apply. The map and the canonical definitions are **not safely ignorable**. A worker advertises `placeholders: true` before it receives any placeholder definition and `credentialDelivery: true` before it receives a stored-key binding. A worker handed a stored-key binding with no matching delivery fails with `missing_credential` rather than applying a literal placeholder or starting unauthenticated. The sideband map remains in memory and is never returned by `GET /v1/mcp`; an adapter may still have to write a resolved value into its provider-owned configuration inside that agent's private volume.

`GET /v1/mcp` also reports `pendingCredentials[]`: the names of configured connectors whose credential this worker process does not hold. Sideband deliveries live in memory only, so a restarted worker is in this state until the next apply, and the field is how the control plane learns its own record of "applied" is ahead of the runtime. A stale value in provider-owned configuration does not satisfy this state: the wrapper refuses the task before relying on it.

## Conversations

`POST /v1/tasks` accepts an optional `conversationId`. Given one, the worker continues the same exchange instead of starting a fresh one, and emits a `conversation.continued` event carrying `{ conversationId, resumed, turns }` before the task begins. Omitted, a task behaves exactly as it always has.

The field is additive but **not safely ignorable**, and is gated in both directions for the same reason placeholder delivery is. An older worker would ignore it, answer without the earlier turns, and report success — which a caller reads as an agent that quietly stopped listening. So a worker advertises `capabilities.tasks.conversations`, the control plane refuses to forward a `conversationId` to a runtime that has not, and a worker handed one it cannot honour returns 409 rather than answering without context.

**Every provider's session identifier stays below the wrapper.** A conversation id is opaque and caller-chosen; the worker keeps the mapping to whatever the harness actually uses. This is what the boundary is absorbing, because no two harnesses agree:

| Adapter | Session identity | How the worker learns it |
|---|---|---|
| `claude-code` | accepts an id the worker chooses | nothing to learn — supplied as `--session-id`, resumed with `--resume` |
| `codex-cli` | mints its own | announced once as `thread_id` on `thread.started` |
| `opencode` | mints its own | stamped as `sessionID` on every event |

An adapter whose CLI cannot resume advertises `conversations: false` and is never sent a `conversationId`. Nothing is synthesized to paper over the difference.

The mapping is durable, because provider sessions are: a harness records its session on the agent's own volume and can resume it after a restart, so a worker that forgot the mapping would strand recoverable context. A conversation reports `resumable: false` until the harness has given the worker something to resume from — a first turn that failed before announcing its session leaves no continuity, and saying so is better than implying otherwise. `DELETE /v1/conversations/:id` forgets the worker's mapping only; it does not reach into the provider's own session storage.

One provider asymmetry is worth recording because it is not visible from the flags the worker passes: `codex exec resume` accepts neither `-C/--cd` nor `--sandbox`, unlike `codex exec`. The working directory comes from the spawned process instead, and a resumed thread carries the sandbox settings recorded with it. Verified against codex-cli 0.152.1.

## Runtime limits and process supervision

Two different things bound a task, and the contract keeps them apart because conflating them is how an operator ends up believing a limit is in force when nothing enforces it.

**Agent Dock process supervision** applies to every adapter, because the wrapper owns it rather than the harness:

- `taskWallTimeoutMs` — the longest a task may run at all.
- `taskIdleTimeoutMs` — the longest a task may go without producing meaningful stdout/stderr or a normalized event. Whitespace-only output is not activity; treating it as activity is how an idle bound silently stops meaning anything.
- `terminationGraceMs` — how long a graceful signal is given before the forced one.

**Provider-native limits** are enforced only by a harness that exposes a control for them: `maxHarnessTurns`, `childCommandTimeoutMs`, `childCommandMaxTimeoutMs`, `maxConcurrentSubagents`, `maxSubagentDepth`, and `allowBackgroundTasks`.

`runtimeLimits` is provider-neutral, durable, and injected by the control plane with every task alongside the saved instructions and model policy; a task-level value from a browser is overwritten, exactly as those are. An omitted field inherits the worker's own default. Two supplied values that contradict each other (an idle bound above the wall bound, a default child timeout above its ceiling) are rejected with 400; a supplied value that contradicts an *inherited* default clamps the inherited side, so tightening one bound never fails because of the other's default.

`capabilities.runtimeLimits` reports both halves:

```json
{
  "supervision": { "wallTimeout": true, "idleTimeout": true, "processTreeTermination": true, "gracefulThenForced": true },
  "support": { "maxHarnessTurns": { "supported": true, "enforcedBy": "harness", "reason": null } },
  "observes": ["subagent", "childCommand"],
  "observedSubagentDepth": 1,
  "defaults": { "taskWallTimeoutMs": 1800000 }
}
```

`enforcedBy` is `wrapper`, `harness`, or `null`. A control the harness cannot honour is reported `supported: false` with a reason, and `task.started` carries `limits.configured`, `limits.effective`, and `limits.support`; the unsupported control remains configured so it survives a move to a capable runtime, but is `null` in the effective policy so nothing can mistake it for a bound that is in force. Inventing enforcement is the same failure as inventing telemetry.

The current matrix, with the provider-side mechanism recorded here because it is not visible from the neutral names:

| Neutral control | Claude Code | Codex | OpenCode |
|---|---|---|---|
| `maxHarnessTurns` | `--max-turns` | none | none |
| `childCommandTimeoutMs` | `BASH_DEFAULT_TIMEOUT_MS` | none | none |
| `childCommandMaxTimeoutMs` | `BASH_MAX_TIMEOUT_MS` | none | none |
| `maxConcurrentSubagents` | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | none | none |
| `maxSubagentDepth` | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | none | none |
| `allowBackgroundTasks` | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` when false | none | none |

Those strings live in `worker/adapters/claude.mjs` and nowhere above it. Allowing background tasks means the disable switch is absent, not set to zero: the harness's own default is the honest expression of "no policy from us".

Three Claude Code affordances were considered and deliberately not used. A spend budget is not a runtime limit and would need a usage model this POC does not have. `SubagentStart`/`SubagentStop` hooks and forwarded subagent stream events would deepen observability below the first level, but both require writing provider hook configuration into the agent's private volume, which is a larger change than this contract addition. The Agent SDK's in-process task cancellation is not reachable from a CLI wrapper, and process-group termination is the stronger guarantee anyway, because it also reaches descendants the SDK never knew about.

Only Claude Code announces subagent and child-command lifecycle on its main stream, and only at the first level, so `observedSubagentDepth` is 1 for Claude Code and 0 elsewhere. Deeper nesting is bounded by `maxSubagentDepth` but is not observed, and the contract does not pretend otherwise.

**Termination reaches the process tree, not the CLI.** The harness is spawned into its own process group. A cancel, either timeout, or a worker shutdown sends the graceful signal to that whole group and escalates to `SIGKILL` once `terminationGraceMs` is spent. The group is also reaped after a task ends normally, because a harness can exit while a descendant it started keeps running — the failure this exists to prevent. Detaching the harness is what makes the signal reach descendants, and it is also what stops the harness dying with the worker, so a worker asked to shut down terminates the tree deliberately. A runtime restart destroys the container and with it the tree; there is nothing to recover.

## Status model

`GET /v1/status` returns these stable top-level concepts:

- `agent`: logical agent ID, adapter identity, provider name, display name, runtime version, and start time.
- `capabilities`: auth methods, refresh support, manual session-check support, task streaming/cancellation, usage sources, and workspace operations actually implemented by the adapter.
- `authentication`: generic auth phase, optional device/browser challenge, safe session timestamps, and refresh state. It must never contain tokens, cookies, passwords, or account IDs. A browser authorization code submitted to `/v1/auth/complete` is forwarded to the waiting CLI process and is never logged or persisted. The input remains open until the CLI accepts a code or the operator calls `/v1/auth/cancel`, so a rejected or partially copied code can be corrected without wedging the worker.
- `task.active`: the active task ID/status or `null`. When a task is running it also reports `lifecycle` (`starting`, `running`, `stalled`, `terminating`, `force-terminated`, `completed`), `startedAt`, `lastActivityAt`, `elapsedMs`, `idleMs`, `stalled`, `terminalReason`, `forceTerminated`, the `limits` actually in force, and counts of open subagents and child commands. None of it discloses a prompt, an environment value, or a provider payload.
- `task.last`: why the most recent task ended, kept after its stream closed — `{ id, status, reason, forceTerminated, startedAt, endedAt, exitCode, peakSubagents }`. "Cancelled", "timed out at the idle bound", and "force-terminated" are what an operator looks for once the connection they were watching is gone.
- `execution`: the isolation boundary and workspace path.
- `usage`: normalized request totals/history, `quotaWindows[]`, an optional `account` activity summary, `pollErrorKind` classifying why an account-usage source last failed, and `lastSuccessAt` recording when the quota data itself was last read successfully. `lastPollAt` advances on failed and skipped attempts, so it cannot be used to judge how old a reading is.

Provider-specific fields belong inside a future explicitly versioned extension object; the control plane must not require them.

Safe targeted cancellation is advertised as `capabilities.tasks.targetedCancellation: true`. A control plane must read status, require that positive capability, and confirm `task.active.id` before posting the same ID to `/v1/tasks/cancel`. It must not send an ID-bearing cancellation to an older worker that omits the flag: older wrappers may interpret cancellation as "kill whatever is active."

## Canonical task stream

Each line is an event shaped as:

```json
{
  "apiVersion": "agent-wrapper/v1",
  "at": "2026-08-28T00:00:00.000Z",
  "type": "message.completed",
  "taskId": "uuid",
  "data": {}
}
```

Stable event types:

| Type | Required data |
|---|---|
| `task.started` | `executionMode`, effective `model` (`provider-default` when the harness chooses), `limits` (`configured`, `effective`, and `support`) |
| `message.completed` | `role`, `text` |
| `activity.started` / `activity.completed` | generic `kind` plus optional `name`, `command`, or `text` |
| `usage.observed` | normalized `request` token counts when the provider supplies them |
| `log` | `level`, `source`, `message` |
| `error` | `source`, `message` |
| `usage.updated` | current normalized `usage` snapshot |
| `runtime.stalled` / `runtime.resumed` | `idleMs`; the stalled form also carries `since`, `idleTimeoutMs`, and open subagent/child counts |
| `runtime.termination` | `reason`, `phase` (`graceful` then `force`), `signal`, `delivered`, `processGroup`, `graceMs` |
| `subagent.started` / `subagent.completed` | `subagentId`, `name`, `depth`, `active`; the completed form adds `status` and `durationMs` |
| `child.started` / `child.completed` | `childId`, `kind`, `name`, `active`; started adds `timeoutMs`, completed adds `status` and `durationMs` |
| `task.completed` | `status`, `exitCode`, `reason`, `forceTerminated`, `durationMs` |
| `provider.lifecycle` / `provider.event` | opaque provider event name only; the UI does not depend on it |

Lifecycle events are metadata only: an id, a tool or agent-type name, a status, a duration. They never carry a delegated prompt, a command line, or a tool result — a lifecycle event is read by operators who are not entitled to the caller's data, and those values are available on the existing activity events for consumers that are.

`task.completed.reason` is additive: an older consumer keeps reading `status` and `exitCode`, a current one can tell `wall_timeout` or `idle_timeout` from a plain `exit_code` failure. A terminal reason always wins over the exit code, because a harness killed at a bound can still exit 0, and reporting that as success is how a bounded task silently stops being bounded.

Normalized request usage uses `inputTokens`, `cachedInputTokens`, `outputTokens`, and `totalTokens`. Quotas use flat `quotaWindows[]` entries with `id`, `label`, `scope`, `usedPercent`, `windowDurationMinutes`, `resetsAt` (epoch seconds), and `reached`. Account activity uses provider-neutral names such as `lifetimeTokens`, `peakDailyTokens`, and `dailyUsage`. Unsupported values are zero or absent; adapters must not invent provider data.

Each adapter translates its own provider's usage envelope, exactly as it translates its own provider's events. The worker persists that envelope and normalizes it on read, so a change to a provider's usage format stays inside that adapter. An adapter must reduce the envelope to the fields its normalizer actually consumes before returning it: provider usage responses routinely carry account, billing, and organization state that no quota window uses, and persisting it retains account data at rest for no purpose.

## Telemetry-source failures

An exhausted subscription is a *successful* reading — a quota window at 100% with `reached: true`. It is never an error. A failure to read the source at all is reported separately through `usage.pollError` and a `usage.pollErrorKind` drawn from a provider-neutral set: `unauthenticated` (the harness credential was rejected), `throttled` (the telemetry source is rate limiting), `network`, `http`, `malformed` (an unfamiliar credential or payload shape), or `provider` (an error the harness itself reported).

Adapters keep the last successfully observed windows when a poll fails, and consumers must present four distinct states: "this provider exposes no such window", "the source failed and there is no reading", "this reading is retained from before a failure", and a current "0% used". A retained reading must not be shown with a live reset countdown, since that timestamp is no longer trustworthy either. Local per-request history is an independent source and continues to work when account telemetry does not.

## Experimental usage sources

A provider with no documented usage interface may expose one behind an explicit opt-in. Such a source must default to off, advertise `usage.quotaWindowSource` so consumers can label it, fail closed on any unfamiliar credential or response shape rather than guessing, and bound its polling with a floor of its own that a forced refresh cannot bypass. Where a provider's schema is migrating, an adapter reads every shape it recognizes and merges them: returning only the first shape it finds is a confident partial reading, which is worse than failing, because the fail-closed check cannot see it. `capabilities.usage.quotaWindows` reflects what the running instance actually has enabled, not merely what the adapter could do. The Claude Code adapter's OAuth usage source is the current example; see `worker/adapters/claude-usage.mjs`.

## Manual session check

`POST /v1/auth/session-check` is a manual, user-triggered probe distinct from `/v1/auth/refresh`: instead of calling a dedicated refresh endpoint, it exercises the adapter's supported request path with one deliberately tiny, fixed request and observes whether the session was renewed. It must never run from status polling or any live-update loop, and it is serialized through the same exclusive provider-process slot as `/v1/tasks` and `/v1/auth/login` — it rejects with 409 while either is active, exactly as they reject while it is active.

An adapter advertises `capabilities.authentication.sessionCheck: { supported, mayConsumeUsage }`. An unsupported adapter still answers 200 with a normalized `unsupported` result rather than an error, because "this adapter cannot do this" is a legitimate outcome a caller needs to render, not a failure. `mayConsumeUsage` tells a caller whether invoking this operation can spend real subscription quota, so a UI can warn before the request is sent.

The response is `{ sessionCheck: { result, detail, checkedAt, session } }`, where `result` is one of `renewed`, `current`, `quota_exhausted`, `reauth_required`, `check_failed`, or `unsupported`, and `detail` is safe, human-readable text explaining the outcome. `session` is the same safe session metadata shape returned elsewhere — never a raw token, a token hash, or the provider's raw response. An adapter classifies failures from what its own request actually reported; an ambiguous or unrecognized failure must fall to `check_failed` rather than guessing between quota exhaustion and a re-authentication requirement.

The Claude Code adapter is the current example: it runs one `claude -p` request with a fixed minimal prompt and safe non-interactive flags (`--safe-mode`, `--strict-mcp-config`, `--tools` empty, `--permission-mode dontAsk`, `--no-session-persistence`, `--disable-slash-commands`), loading no MCP servers, no injected agent instructions, and no existing conversation, and never `--bare`, because `--bare` bypasses the OAuth/keychain credential path this operation exists to exercise. It compares only safe credential metadata (a filesystem change marker, expiry, and presence flags) from before and after the request to tell `renewed` apart from `current`.

## Adapter responsibilities

A new adapter must implement the following behaviors behind the wrapper:

1. Report its manifest and capability flags.
2. Install or locate its official harness and report its version.
3. Determine authentication state without returning credentials.
4. Start its supported login flow and normalize any user-facing challenge.
5. Refresh authentication when supported, or advertise `refresh: false`.
5a. Support a manual session check when the provider has a request path worth exercising, or advertise `sessionCheck: { supported: false }`; never run it from polling.
6. Run one task, accept optional profile instructions, stream provider output, and translate it into canonical events.
7. Discover safe provider/model metadata and translate a supported model policy into harness arguments.
8. Cancel the active provider process.
9. Normalize request usage, quota windows, and account activity only where the provider exposes them.
10. Keep provider credential files, raw auth responses, raw tokens, and private connection URLs inside the worker boundary.
11. Validate, apply, inspect, and activate the canonical MCP desired state without returning resolved connector secrets.
12. Advertise `placeholders` and `credentialDelivery` truthfully, and refuse any binding the worker cannot satisfy rather than applying a literal placeholder or omitting authentication.
13. Advertise `conversations` truthfully, keep its provider's session identifier below the wrapper, and refuse a `conversationId` it cannot continue rather than answering without the earlier turns.
14. Declare exactly which provider-neutral runtime limits its harness natively enforces, translate only those into the harness's own flags and environment, and report every other control as unsupported rather than accepting it silently. Where the harness announces subagent or child-command lifecycle, translate it into metadata-only canonical events; where it does not, advertise `observes: []`.

The Codex, Claude Code, and OpenCode translators live under `worker/adapters/`. All satisfy this contract; the control plane does not branch on provider-specific event, credential, or MCP configuration formats.

## Compatibility

Additive fields are allowed within `agent-wrapper/v1`. Renaming fields, changing event meanings, or making an optional capability mandatory requires a new protocol version. Legacy unversioned worker routes currently remain as temporary aliases, but the control plane itself uses only `/v1`.
