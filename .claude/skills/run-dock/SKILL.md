---
name: run-dock
description: Launch Agent Dock locally and drive it — the control-plane UI, the wrapper API, or a full multi-adapter fleet — without Docker, provider credentials, or subscription usage. Use when asked to run, start, demo, or screenshot the app, or to confirm a change works in the real UI rather than only in tests.
---

# Running Agent Dock

Three ways in, cheapest first. Pick by what the change actually touches.

## 1. One Codex agent — `npm run demo`

```bash
npm run demo    # UI on http://127.0.0.1:3000, worker on 7777
```

The repo's own deterministic demo. A single Codex worker in demo mode: tasks
return canned events, the quota window reports a fixed 18%, and nothing reaches a
provider. Enough for most UI work.

## 2. Every adapter at once — `demo-fleet.mjs`

```bash
node .claude/skills/run-dock/demo-fleet.mjs
CONTROL_PLANE_PORT=3100 node .claude/skills/run-dock/demo-fleet.mjs   # if 3000 is taken
```

Stands up one worker per adapter and attaches an agent to each, so the fleet
dashboard has something to compare and all three quota states are visible in one
session:

| Agent | What it demonstrates |
|---|---|
| `worker-01` (Codex) | A populated provider quota window |
| `claude-experimental-quota` | The experimental OAuth windows, fed `test/fixtures/claude-usage-limits.json` — Session 0%, Weekly 100% and `reached`, Weekly · Fable 57%, plus the experimental-source note |
| `opencode-no-quota-source` | An adapter that exposes no windows — the hatched "unavailable" state and its explanation |

The Claude worker's credential read and usage endpoint are both stubbed: it gets
a throwaway credential file in a temp directory and a fixture instead of a network
call. No token is read from your machine and nothing is sent to Anthropic.

Use this for anything touching usage, quota rendering, capability flags, or the
fleet dashboard — the differences between adapters are the point, and a
single-worker demo hides them.

## 3. The real thing — Docker

```bash
cp .env.example .env      # set a long random WORKER_TOKEN
docker compose up --build
```

Needs Docker and a real subscription, and first boot takes a minute per worker
while each installs its CLI. Only worth it for provisioning, container isolation,
volume, or genuine end-to-end auth work. Never reach for it to check a UI change.

## Drive it, don't just start it

Launching proves the entrypoint resolves. Check the thing you changed:

```bash
# Fleet and per-agent state
curl -s localhost:3000/api/v1/agents | python3 -m json.tool
curl -s localhost:3000/api/v1/agents/<id>/status | python3 -m json.tool

# Usage, quota windows, and failure classification
curl -s -X POST localhost:3000/api/v1/agents/<id>/usage/refresh | python3 -m json.tool

# A task, streamed as canonical NDJSON
curl -N localhost:3000/api/v1/agents/<id>/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create /workspace/hello.txt with a short greeting."}'
```

For visual changes, open the UI and look at it. The Playwright MCP server can
drive it (`browser_navigate`, `browser_snapshot`, `browser_click`) when it is
available; a blank screenshot means the app failed to start, not that the change
is fine.

## Notes

- Everything runs on `127.0.0.1` only.
- Ports: UI on `CONTROL_PLANE_PORT` (default 3000); `demo-fleet.mjs` derives its
  worker ports from it, so overriding one override moves the whole set.
- Demo mode keeps no state — `dataPath: null`, no registry file, no usage file.
  Restart to get a clean fleet.
- The bootstrap agent is always `worker-01`; the fleet script prints the IDs it
  creates.
- Stop with Ctrl-C. If a port stays busy, `lsof -ti tcp:3000 | xargs kill`.
