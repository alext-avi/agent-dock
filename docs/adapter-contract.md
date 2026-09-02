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
| `POST` | `/v1/auth/refresh` | Ask the adapter to refresh or validate its managed session |
| `GET` | `/v1/workspace` | List durable workspace artifacts |
| `GET` | `/v1/usage` | Read cached request and account usage |
| `POST` | `/v1/usage/refresh` | Ask the adapter to refresh available usage sources |
| `POST` | `/v1/tasks` | Run `{ "prompt": "...", "instructions": "...", "modelPolicy": {...} }` and stream canonical NDJSON events |
| `POST` | `/v1/tasks/cancel` | Cancel the active task on this single-agent worker |
| `GET` | `/v1/conversations` | List conversations this worker can continue |
| `GET`, `DELETE` | `/v1/conversations/:id` | Read one conversation, or forget the worker's mapping for it |

Every JSON response and NDJSON event includes `apiVersion: "agent-wrapper/v1"`. Errors use the same envelope with an `error` string.

`modelPolicy` is provider-neutral: `mode` is `provider-default` or `pinned`, and a pinned policy includes a canonical `primary` model ID such as `ollama/gpt-oss:20b`. `fallbacks` and `externalFallback` are reserved policy fields, but the current wrapper rejects automatic fallback rather than silently changing providers. The control plane injects the saved policy and ignores task-level overrides from browser clients.

`GET /v1/providers` returns `connections[]` with a stable ID, type, display name, coarse location, credential mode, health, last-check time, and discoverable `models[]`. It must not return credentials or private connection URLs. For Ollama, the model data may include context length, capabilities, family, parameter size, and quantization.

MCP management uses one round-trippable `servers[]` DTO in both directions; provider configuration is never used as the control-plane data model. See [`mcp-contract.md`](./mcp-contract.md). Secret fields contain references, not values, and a reference names a connector secret rather than an arbitrary worker environment variable — see the connector-secret namespace in [`mcp-contract.md`](./mcp-contract.md).

`PUT /v1/mcp` carries an optional second field alongside `servers[]`: `credentials`, a map from credential id to `{ header, value }`, resolved by the control plane for this apply. A definition opts into it with `credentialId` instead of `secretHeaders`. The two are additive fields inside `agent-wrapper/v1`, but they are **not safely ignorable**: a worker that drops `credentials` and renders a `credentialId` definition anyway would configure a connector with no authentication at all while reporting success, turning "no secret headers" from *unauthenticated by design* into *silently unauthenticated*. So the capability is gated in both directions. A worker that understands delivery advertises `credentialDelivery: true` in the `capabilities` of `GET /v1/mcp`, and the control plane refuses to apply a `credentialId` definition to a runtime that does not. A worker that receives a `credentialId` with no matching delivery fails the apply with `missing_credential` rather than applying it bare.

`GET /v1/mcp` also reports `pendingCredentials[]`: the names of configured connectors whose credential this worker process does not hold. Delivered credentials live in memory only, so a restarted worker is in this state until the next apply, and the field is how the control plane learns its own record of "applied" is ahead of the runtime.

## Conversations

`POST /v1/tasks` accepts an optional `conversationId`. Given one, the worker continues the same exchange instead of starting a fresh one, and emits a `conversation.continued` event carrying `{ conversationId, resumed, turns }` before the task begins. Omitted, a task behaves exactly as it always has.

The field is additive but **not safely ignorable**, and is gated in both directions for the same reason `credentialId` is. An older worker would ignore it, answer without the earlier turns, and report success — which a caller reads as an agent that quietly stopped listening. So a worker advertises `capabilities.tasks.conversations`, the control plane refuses to forward a `conversationId` to a runtime that has not, and a worker handed one it cannot honour returns 409 rather than answering without context.

**Every provider's session identifier stays below the wrapper.** A conversation id is opaque and caller-chosen; the worker keeps the mapping to whatever the harness actually uses. This is what the boundary is absorbing, because no two harnesses agree:

| Adapter | Session identity | How the worker learns it |
|---|---|---|
| `claude-code` | accepts an id the worker chooses | nothing to learn — supplied as `--session-id`, resumed with `--resume` |
| `codex-cli` | mints its own | announced once as `thread_id` on `thread.started` |
| `opencode` | mints its own | stamped as `sessionID` on every event |

An adapter whose CLI cannot resume advertises `conversations: false` and is never sent a `conversationId`. Nothing is synthesized to paper over the difference.

The mapping is durable, because provider sessions are: a harness records its session on the agent's own volume and can resume it after a restart, so a worker that forgot the mapping would strand recoverable context. A conversation reports `resumable: false` until the harness has given the worker something to resume from — a first turn that failed before announcing its session leaves no continuity, and saying so is better than implying otherwise. `DELETE /v1/conversations/:id` forgets the worker's mapping only; it does not reach into the provider's own session storage.

One provider asymmetry is worth recording because it is not visible from the flags the worker passes: `codex exec resume` accepts neither `-C/--cd` nor `--sandbox`, unlike `codex exec`. The working directory comes from the spawned process instead, and a resumed thread carries the sandbox settings recorded with it. Verified against codex-cli 0.152.1.

## Status model

`GET /v1/status` returns these stable top-level concepts:

- `agent`: logical agent ID, adapter identity, provider name, display name, runtime version, and start time.
- `capabilities`: auth methods, refresh support, task streaming/cancellation, usage sources, and workspace operations actually implemented by the adapter.
- `authentication`: generic auth phase, optional device/browser challenge, safe session timestamps, and refresh state. It must never contain tokens, cookies, passwords, or account IDs. A browser authorization code submitted to `/v1/auth/complete` is forwarded once to the waiting CLI process and is never logged or persisted.
- `task.active`: the active task ID/status or `null`.
- `execution`: the isolation boundary and workspace path.
- `usage`: normalized request totals/history, `quotaWindows[]`, an optional `account` activity summary, `pollErrorKind` classifying why an account-usage source last failed, and `lastSuccessAt` recording when the quota data itself was last read successfully. `lastPollAt` advances on failed and skipped attempts, so it cannot be used to judge how old a reading is.

Provider-specific fields belong inside a future explicitly versioned extension object; the control plane must not require them.

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
| `task.started` | `executionMode`, effective `model` (`provider-default` when the harness chooses) |
| `message.completed` | `role`, `text` |
| `activity.started` / `activity.completed` | generic `kind` plus optional `name`, `command`, or `text` |
| `usage.observed` | normalized `request` token counts when the provider supplies them |
| `log` | `level`, `source`, `message` |
| `error` | `source`, `message` |
| `usage.updated` | current normalized `usage` snapshot |
| `task.completed` | `status`, `exitCode` |
| `provider.lifecycle` / `provider.event` | opaque provider event name only; the UI does not depend on it |

Normalized request usage uses `inputTokens`, `cachedInputTokens`, `outputTokens`, and `totalTokens`. Quotas use flat `quotaWindows[]` entries with `id`, `label`, `scope`, `usedPercent`, `windowDurationMinutes`, `resetsAt` (epoch seconds), and `reached`. Account activity uses provider-neutral names such as `lifetimeTokens`, `peakDailyTokens`, and `dailyUsage`. Unsupported values are zero or absent; adapters must not invent provider data.

Each adapter translates its own provider's usage envelope, exactly as it translates its own provider's events. The worker persists that envelope and normalizes it on read, so a change to a provider's usage format stays inside that adapter. An adapter must reduce the envelope to the fields its normalizer actually consumes before returning it: provider usage responses routinely carry account, billing, and organization state that no quota window uses, and persisting it retains account data at rest for no purpose.

## Telemetry-source failures

An exhausted subscription is a *successful* reading — a quota window at 100% with `reached: true`. It is never an error. A failure to read the source at all is reported separately through `usage.pollError` and a `usage.pollErrorKind` drawn from a provider-neutral set: `unauthenticated` (the harness credential was rejected), `throttled` (the telemetry source is rate limiting), `network`, `http`, `malformed` (an unfamiliar credential or payload shape), or `provider` (an error the harness itself reported).

Adapters keep the last successfully observed windows when a poll fails, and consumers must present four distinct states: "this provider exposes no such window", "the source failed and there is no reading", "this reading is retained from before a failure", and a current "0% used". A retained reading must not be shown with a live reset countdown, since that timestamp is no longer trustworthy either. Local per-request history is an independent source and continues to work when account telemetry does not.

## Experimental usage sources

A provider with no documented usage interface may expose one behind an explicit opt-in. Such a source must default to off, advertise `usage.quotaWindowSource` so consumers can label it, fail closed on any unfamiliar credential or response shape rather than guessing, and bound its polling with a floor of its own that a forced refresh cannot bypass. Where a provider's schema is migrating, an adapter reads every shape it recognizes and merges them: returning only the first shape it finds is a confident partial reading, which is worse than failing, because the fail-closed check cannot see it. `capabilities.usage.quotaWindows` reflects what the running instance actually has enabled, not merely what the adapter could do. The Claude Code adapter's OAuth usage source is the current example; see `worker/adapters/claude-usage.mjs`.

## Adapter responsibilities

A new adapter must implement the following behaviors behind the wrapper:

1. Report its manifest and capability flags.
2. Install or locate its official harness and report its version.
3. Determine authentication state without returning credentials.
4. Start its supported login flow and normalize any user-facing challenge.
5. Refresh authentication when supported, or advertise `refresh: false`.
6. Run one task, accept optional profile instructions, stream provider output, and translate it into canonical events.
7. Discover safe provider/model metadata and translate a supported model policy into harness arguments.
8. Cancel the active provider process.
9. Normalize request usage, quota windows, and account activity only where the provider exposes them.
10. Keep provider credential files, raw auth responses, raw tokens, and private connection URLs inside the worker boundary.
11. Validate, apply, inspect, and activate the canonical MCP desired state without returning resolved connector secrets.
12. Advertise `credentialDelivery` truthfully, and refuse a `credentialId` definition it cannot satisfy rather than applying it without authentication.
13. Advertise `conversations` truthfully, keep its provider's session identifier below the wrapper, and refuse a `conversationId` it cannot continue rather than answering without the earlier turns.

The Codex, Claude Code, and OpenCode translators live under `worker/adapters/`. All satisfy this contract; the control plane does not branch on provider-specific event, credential, or MCP configuration formats.

## Compatibility

Additive fields are allowed within `agent-wrapper/v1`. Renaming fields, changing event meanings, or making an optional capability mandatory requires a new protocol version. Legacy unversioned worker routes currently remain as temporary aliases, but the control plane itself uses only `/v1`.
