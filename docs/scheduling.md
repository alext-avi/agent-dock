# Scheduled jobs

Agent Dock's first scheduler slice is a control-plane service backed by SQLite. It supports durable one-off jobs and standard five-field cron schedules, dispatches through the same provider-neutral Agent Wrapper API as an interactive task, and records every claimed occurrence before contacting a worker.

## Schedule contract

A one-off job requires an ISO 8601 timestamp with an explicit `Z` or UTC offset:

```json
{
  "id": "quarterly-prep",
  "name": "Quarterly prep",
  "agentId": "worker-01",
  "prompt": "Prepare the quarterly planning packet in /workspace.",
  "timing": {
    "kind": "once",
    "at": "2026-09-30T13:00:00-04:00"
  }
}
```

A recurring job uses a five-field cron expression and an IANA timezone:

```json
{
  "name": "Weekday brief",
  "agentId": "claude-worker-01",
  "prompt": "Create today's operating brief.",
  "timing": {
    "kind": "cron",
    "expression": "0 9 * * 1-5",
    "timezone": "America/New_York"
  },
  "policies": {
    "overlap": "skip-if-busy",
    "misfire": "skip",
    "misfireGraceMs": 60000,
    "timeoutMs": 3600000,
    "maxAttempts": 1
  }
}
```

Cron fields support `*`, comma-separated values, ranges, and steps. Day-of-month and day-of-week use traditional cron OR semantics when both are restricted. Sunday is `0` or `7`.

Timezone calculation uses the runtime's IANA database. A nonexistent local minute during spring-forward does not run. Both real instants represented by a repeated local minute during fall-back are occurrences; overlap protection still prevents two tasks from running on the same agent simultaneously.

## Delivery and concurrency semantics

Before dispatch, the scheduler writes a run row and atomically advances the schedule. The schedule occurrence and attempt number are unique in SQLite. If the control plane exits after claiming an occurrence, startup marks the run `interrupted` and does not dispatch it again. This deliberately provides **at-most-once dispatch**, not guaranteed execution.

For a recurring schedule that is later than its misfire grace period, the missed occurrence is recorded as `skipped_misfire` and the schedule advances directly to its next future time. A delayed one-off remains eligible and is claimed once.

The first execution for an agent owns an in-process agent lease. Another scheduled occurrence targeting that agent becomes `skipped_busy`. The dispatcher also checks the worker's live task state before starting, so an interactive or externally started task produces the same result. This first slice is single-control-plane only; multi-replica leader election is not yet implemented.

Run states are `claimed`, `running`, `succeeded`, `failed`, `timed_out`, `skipped_busy`, `skipped_misfire`, and `interrupted`. Terminal rows include the occurrence, trigger (`scheduled` or `manual`), task ID when available, duration, error, and the last normalized `usage.updated` payload emitted by the worker.

Retries are intentionally fixed at one attempt in this slice. A later retry implementation must preserve the occurrence identity, add a bounded attempt number, and define which provider and transport failures are retryable before `maxAttempts` can be raised.

## Operator UI

Open `/jobs` from the top navigation. The working surface keeps the scheduler state, active-job count, next occurrence, and recent success rate above the queue. Every job card shows its agent, timing rule, next run, current state, last result, duration, usage, task ID, and five most recent durable run records.

The create/edit dialog keeps cron out of the operator experience. A person can choose **Run once later** with a browser-local date and time, or select an hourly, daily, weekday, weekly, or monthly cadence with contextual time/day controls and a plain-language summary. The UI translates recurring choices into the API's cron representation. An advanced expression created directly through the API is preserved without exposing its notation; choosing a standard cadence replaces it. Run-now, pause, resume, edit, and delete are available from the queue; completed one-off jobs can be manually rerun or deleted but their original timing is immutable. The page refreshes every three seconds while visible and preserves the same empty, error, and offline language as the fleet dashboard.

## Operator API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/scheduler` | Read scheduler enablement, storage mode, last tick/error, and active counts |
| `GET`, `POST` | `/api/v1/schedules` | List schedules or create one; GET accepts `?agentId=...&includeRuns=1..500` |
| `GET`, `PATCH`, `DELETE` | `/api/v1/schedules/:id` | Read, edit, or soft-delete a schedule |
| `POST` | `/api/v1/schedules/:id/pause` | Pause future occurrences |
| `POST` | `/api/v1/schedules/:id/resume` | Resume; expired one-off jobs require a new time |
| `POST` | `/api/v1/schedules/:id/run-now` | Claim an immediate manual occurrence and return `202` |
| `GET` | `/api/v1/schedules/:id/runs` | Read durable run history; accepts `?limit=1..500` |

`GET /api/v1/schedules?agentId=...` filters by agent. Add `includeRuns=5` to return a `runs` object keyed by schedule ID and avoid one history request per schedule. Manual runs do not change the next recurring occurrence and are allowed while a schedule is paused. Deletion is soft so run audit rows remain in SQLite. An agent cannot be deleted while non-deleted schedules still target it; delete or reassign those jobs first.

## Storage and operation

Compose stores `/control-data/scheduler.sqlite` in the existing `control-data` volume. Override it with `SCHEDULER_DB_PATH`; change the one-second due-work poll with `SCHEDULER_INTERVAL_MS` (minimum 100 milliseconds), or set `SCHEDULER_ENABLED=0` to leave the API available without automatic dispatch. Scheduler status is also included in the control-plane health response so a failed tick is visible instead of silently stopping autonomous work.

The scheduler itself requires Node.js 22 or newer for the built-in `node:sqlite` module and adds no scheduler-specific package. The application also carries the official MCP SDK and Zod for the separate control-plane MCP transport; those packages are locked and installed without lifecycle scripts in the production image.

The REST API currently has the same operator trust boundary as the rest of this POC. Scheduled-job MCP tools must wait for control-plane authentication and will be exposed through a narrow allowlist; MCP administration and storage/mount mutation remain explicitly excluded from that agent-facing surface.
