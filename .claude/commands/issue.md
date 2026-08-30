---
description: Start work on a GitHub issue
argument-hint: <issue-number>
---

Start work on issue #$1 in `alext-avi/agent-dock`.

1. Read the issue with the GitHub MCP server (`issue_read`) — title, body, labels, and any comments.
2. Create a branch named after it: `issue-$1-<slug>`.
3. Read `CLAUDE.md` and, for anything crossing the wrapper, `docs/adapter-contract.md` before editing.
4. Implement, add the test in `test/` that would have caught the regression, and run `npm test`.
5. Update the docs the change implies: `docs/adapter-contract.md` for protocol changes, `docs/architecture.md`
   and `.mmd` for structural ones, the README for anything user-visible.
6. Summarize what changed and what you left out. Do not commit or push unless asked.
