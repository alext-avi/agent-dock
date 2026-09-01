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

`transport` is `stdio` or `http`. A stdio definition uses `command`, `args`, optional `/workspace` `cwd`, `environment`, and `secretEnvironment`; an HTTP definition uses `url`, `headers`, and `secretHeaders`. Secret maps contain references only. Resolved credential values exist only in the isolated worker while it renders provider configuration and are never persisted in the control-plane registry or returned by either API.

A `sourceEnv` is a **logical connector-secret name, not a worker environment variable**. The worker resolves it from the `MCP_SECRET_` namespace: a definition referencing `COMPANY_MCP_TOKEN` reads `MCP_SECRET_COMPANY_MCP_TOKEN`. Nothing outside that prefix is visible to the resolver, so a definition cannot name the runtime's own `WORKER_TOKEN`, a provider home directory, or `OLLAMA_BASE_URL` — those variables are absent from the map rather than merely rejected by a rule. An unresolvable reference fails the definition rather than applying it with the secret silently absent.

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

Local MCP commands are code execution inside the agent container. They are denied by default and must exactly match the worker's `MCP_ALLOWED_COMMANDS` allowlist. Allowlisting an interpreter such as `node`, `python`, or `bash` is equivalent to permitting arbitrary execution, because a definition's arguments are unconstrained — the allowlist bounds which binary runs, not what it does. Remote definitions reject embedded URL credentials, but there is no destination allowlist: a definition holding a legitimately provisioned connector secret can name any `https` host, and nothing but operator review decides where that credential is sent.

Connector secrets are provisioned into that one agent container under the `MCP_SECRET_` namespace, separately from the variables the worker uses to run. The provisioner forwards that namespace and nothing else, so adding a connector credential means setting `MCP_SECRET_<NAME>` where the control plane runs and then provisioning or refreshing the runtime; no code change is needed for a new one. Bootstrap workers declared in `docker-compose.yml` need the variable added to that service explicitly, since Compose cannot forward a namespace. They are readable by the agent in that container: this design keeps a credential scoped to a single agent and revocable, but it is not confidentiality against the harness itself.

## Control-plane MCP privilege boundary

The future control-plane MCP server will call selected internal control-plane services rather than the browser routes. Its tool registry is an explicit allowlist and will not register tools that create, update, delete, bind, unbind, or apply MCP definitions. It will also omit storage, volume, and mount mutation tools. Those administrative capabilities remain available only through the authenticated operator REST/UI surface. This is a code-level capability boundary, not a prompt instruction.
