# MCP management contract

Agent Dock stores one provider-neutral MCP server definition and sends the same `servers[]` payload to every worker. `PUT /v1/mcp` applies that payload; `GET /v1/mcp` returns it unchanged alongside capabilities, generation metadata, and sanitized health. The control plane can therefore display and edit desired state without parsing Codex, Claude Code, or OpenCode configuration.

```json
{
  "id": "company-docs",
  "name": "company_docs",
  "transport": "http",
  "command": null,
  "args": [],
  "cwd": null,
  "url": "https://mcp.example.com/mcp",
  "environment": {},
  "secretEnvironment": {},
  "headers": {},
  "secretHeaders": {
    "Authorization": {
      "sourceEnv": "COMPANY_MCP_TOKEN",
      "prefix": "Bearer "
    }
  },
  "timeoutMs": 30000,
  "createdAt": "2026-08-30T12:00:00.000Z",
  "updatedAt": "2026-08-30T12:00:00.000Z"
}
```

`transport` is `stdio` or `http`. A stdio definition uses `command`, `args`, optional `/workspace` `cwd`, `environment`, and `secretEnvironment`; an HTTP definition uses `url`, `headers`, and `secretHeaders`. Secret maps contain worker-environment references only. Resolved credential values exist only in the isolated worker while it renders provider configuration and are never persisted in the control-plane registry or returned by either API.

## Lifecycle

| Surface | Operation |
|---|---|
| Control plane | Reusable definition CRUD under `/api/v1/mcp/servers` |
| Control plane | Per-agent bind, unbind, validate, inspect, and apply under `/api/v1/agents/:id/mcp` |
| Worker | `POST /v1/mcp/validate` performs structural and adapter-policy validation without starting the server |
| Worker | `PUT /v1/mcp` replaces the complete managed desired state |
| Worker | `GET /v1/mcp` returns the canonical desired state plus sanitized provider health |

Each provider starts a fresh CLI process per task, so successful changes activate on the next task without restarting the container:

- Codex reconciles Agent Dock-managed names through the native `codex mcp` CLI and restores the prior managed set if a new entry is rejected.
- Claude Code receives a worker-owned `--mcp-config` file plus `--strict-mcp-config`; the wrapper re-renders that file at every task start (including an empty first-run file), and its startup event supplies connection health.
- OpenCode receives a managed JSON configuration and high-precedence task configuration. Before each task, the wrapper resolves OpenCode's merged configuration and explicitly disables MCP names introduced by lower-precedence project or user files; if that inspection fails, the task fails closed. Its `mcp list` output is parsed through a redacting allowlist.

Local MCP commands are code execution inside the agent container. They are denied by default and must exactly match the worker's `MCP_ALLOWED_COMMANDS` allowlist. Remote definitions reject embedded URL credentials. Connector secrets must be injected into that one agent container by a separate secret-provisioning path.

## Registry and harness workshop

The standalone `/mcp` view is the operator-facing registry for reusable definitions. It lists the same canonical objects returned by `/api/v1/mcp/servers`; it does not introduce a second configuration format or provider-specific registry records.

The MCP workshop delegates connector research to one selected agent through the normal `/api/v1/agents/:id/tasks` stream. The task asks the harness to investigate documentation, optionally test inside its isolated workspace, and return a canonical proposal. The browser extracts only the bounded MCP fields, drops all literal environment variables and headers, retains valid worker-environment secret references, and submits the result to that agent's existing `/mcp/validate` endpoint.

Validation proves payload and adapter-policy compatibility, not connectivity or correct credentials. A proposal is accepted only after a matching `task.completed` event reports `succeeded`; failed, cancelled, errored, or incomplete streams cannot reach review. The proposal remains an unsaved browser draft until an operator reviews the complete canonical payload and explicitly saves it. Fields outside the compact editor are displayed and preserved losslessly. The harness is never given a registry mutation endpoint, and attaching or applying the saved definition remains a separate operator action on an agent page. The selected agent's durable instructions still apply to the workshop task, so the operator should choose a suitable harness and never place secret values in the objective.

## Control-plane MCP privilege boundary

The future control-plane MCP server will call selected internal control-plane services rather than the browser routes. Its tool registry is an explicit allowlist and will not register tools that create, update, delete, bind, unbind, or apply MCP definitions. It will also omit storage, volume, and mount mutation tools. Those administrative capabilities remain available only through the authenticated operator REST/UI surface. This is a code-level capability boundary, not a prompt instruction.
