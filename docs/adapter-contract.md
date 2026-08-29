# Agent wrapper adapter contract

The control plane talks only to the versioned Agent Wrapper API. A provider adapter owns every provider-specific command, credential format, auth flow, usage query, and event shape.

Current protocol version: `agent-wrapper/v1`.

## Control-plane surface

| Method | Worker route | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Unauthenticated liveness and adapter identity |
| `GET` | `/v1/status` | Agent, capability, authentication, task, execution, and cached usage state |
| `POST` | `/v1/auth/login` | Start the adapter's supported interactive authentication flow |
| `POST` | `/v1/auth/refresh` | Ask the adapter to refresh or validate its managed session |
| `GET` | `/v1/workspace` | List durable workspace artifacts |
| `GET` | `/v1/usage` | Read cached request and account usage |
| `POST` | `/v1/usage/refresh` | Ask the adapter to refresh available usage sources |
| `POST` | `/v1/tasks` | Run `{ "prompt": "...", "instructions": "..." }` and stream canonical NDJSON events |
| `POST` | `/v1/tasks/cancel` | Cancel the active task on this single-agent worker |

Every JSON response and NDJSON event includes `apiVersion: "agent-wrapper/v1"`. Errors use the same envelope with an `error` string.

## Status model

`GET /v1/status` returns these stable top-level concepts:

- `agent`: logical agent ID, adapter identity, provider name, display name, runtime version, and start time.
- `capabilities`: auth methods, refresh support, task streaming/cancellation, usage sources, and workspace operations actually implemented by the adapter.
- `authentication`: generic auth phase, optional device challenge, safe session timestamps, and refresh state. It must never contain tokens, cookies, passwords, or account IDs.
- `task.active`: the active task ID/status or `null`.
- `execution`: the isolation boundary and workspace path.
- `usage`: normalized request totals/history, `quotaWindows[]`, and an optional `account` activity summary.

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
| `task.started` | `executionMode` |
| `message.completed` | `role`, `text` |
| `activity.started` / `activity.completed` | generic `kind` plus optional `name`, `command`, or `text` |
| `usage.observed` | normalized `request` token counts when the provider supplies them |
| `log` | `level`, `source`, `message` |
| `error` | `source`, `message` |
| `usage.updated` | current normalized `usage` snapshot |
| `task.completed` | `status`, `exitCode` |
| `provider.lifecycle` / `provider.event` | opaque provider event name only; the UI does not depend on it |

Normalized request usage uses `inputTokens`, `cachedInputTokens`, `outputTokens`, and `totalTokens`. Quotas use flat `quotaWindows[]` entries with `label`, `scope`, `usedPercent`, `windowDurationMinutes`, and `resetsAt`. Account activity uses provider-neutral names such as `lifetimeTokens`, `peakDailyTokens`, and `dailyUsage`. Unsupported values are zero or absent; adapters must not invent provider data.

## Adapter responsibilities

A new adapter must implement the following behaviors behind the wrapper:

1. Report its manifest and capability flags.
2. Install or locate its official harness and report its version.
3. Determine authentication state without returning credentials.
4. Start its supported login flow and normalize any user-facing challenge.
5. Refresh authentication when supported, or advertise `refresh: false`.
6. Run one task, accept optional profile instructions, stream provider output, and translate it into canonical events.
7. Cancel the active provider process.
8. Normalize request usage, quota windows, and account activity only where the provider exposes them.
9. Keep provider credential files, raw auth responses, and raw tokens inside the worker boundary.

The current Codex translator lives in `worker/adapters/codex.mjs`. A Claude adapter should satisfy this contract with its own install/auth/run/usage implementation while leaving `control-plane/` unchanged.

## Compatibility

Additive fields are allowed within `agent-wrapper/v1`. Renaming fields, changing event meanings, or making an optional capability mandatory requires a new protocol version. Legacy unversioned worker routes currently remain as temporary aliases, but the control plane itself uses only `/v1`.
