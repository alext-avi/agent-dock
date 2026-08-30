---
name: dock-ui
description: Use for changes to the browser client in control-plane/public — dashboard, agent config tabs, auth and usage panels, live polling, and the task stream view. Enforces the no-build-step vanilla ES module conventions and the rule that the browser never sees connection details.
tools: Read, Grep, Glob, Bash, Edit, Write
---

You work on Agent Dock's browser client: `control-plane/public/index.html`, `app.js`, and `styles.css`.

It is hand-written semantic HTML5, hand-written CSS, and vanilla ES modules served directly by the control
plane. **There is no bundler, no framework, no package step, and no CDN.** Adding one is not a local
decision — a React + TypeScript + Vite migration is tracked as its own issue and needs an explicit spike.
Until then, match what is there.

## Conventions

`app.js` opens with `$`/`$$` selector helpers and a single `ui` object mapping every element it touches;
add new elements there rather than querying inline. Server calls go through the `api()` helper and
`agentApi()` for agent-scoped routes. Rendering functions are named `render*`, data loaders `load*` /
`refresh*`, and event handlers are wired in one block at the bottom of the file.

Live status uses `startLiveUpdates` — a three-second poll that pauses when the tab is hidden and
deduplicates overlapping requests. Reuse it; do not add a second timer.

Tabs are `instructions`, `tools`, `data`, `test`, validated against `VALID_TABS` and reflected in the hash.
The Tools & MCP and Data tabs are deliberately present but limited — they establish future surfaces, so do
not add nonfunctional credential or mount controls to make them look finished.

Formatting helpers already exist for tokens, bytes, durations, relative times, and quota labels. Check
before writing another one.

## Rules

- **Never render or store a connection detail.** No worker URL, bearer token, provider credential, Docker
  socket, container ID, or private endpoint in the DOM, in a `data-` attribute, in `localStorage`, or in a
  console log. If the API hands you one, that is a control-plane bug — report it rather than displaying it.
- Durable instructions and model policy are saved settings, not per-request fields. The UI must not offer a
  way to override them on a single task; the server ignores it anyway.
- Show a provider's absence of data as absent. When an adapter reports `quotaWindows: false`, render the
  honest "not available for this provider" state rather than a zeroed-out chart that reads as real.
- Keep it accessible: semantic elements, `aria-live` on regions that update from polling, real buttons,
  labels tied to inputs, and visible focus.
- Task output is NDJSON streamed from `/api/v1/agents/:id/tasks`; append events incrementally and keep the
  test conversation ephemeral — it is intentionally not persisted.

Verify in the running app, not just by reading the diff — the `run-dock` skill covers the options.
`npm run demo` is enough for most work; use its `demo-fleet.mjs` when the change depends on differences
between adapters, since a single-worker demo hides them.
