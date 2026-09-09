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
  "headers": {
    "Authorization": "Bearer ${COMPANY_MCP_TOKEN}"
  },
  "placeholders": {
    "COMPANY_MCP_TOKEN": {
      "source": "credential",
      "credentialId": "company-docs-key"
    }
  },
  "timeoutMs": 30000,
  "createdAt": "2026-08-30T12:00:00.000Z",
  "updatedAt": "2026-08-30T12:00:00.000Z"
}
```

`transport` is `stdio` or `http`. A stdio definition uses `command`, `args`, optional `/workspace` `cwd`, and `environment`; an HTTP definition uses `url` and `headers`. Any string value in `args`, `cwd`, `environment`, `url`, or `headers` may contain `${NAME}`. Every name used in the definition must have exactly one entry in `placeholders`, and unused bindings are removed.

A placeholder binding has one of two sources. `{ "source": "credential", "credentialId": "..." }` names a stored key owned by the control plane. `{ "source": "connector-secret", "name": "..." }` names `MCP_SECRET_<NAME>` inside the isolated worker. Placement and source are therefore independent: the definition shows exactly where the value goes, while the binding shows where it comes from. The superseded top-level `credentialId`, `secretHeaders`, and `secretEnvironment` fields are rejected rather than migrated or silently ignored.

A stored credential is resolved by the control plane at apply time and delivered in a sideband `credentials` map keyed by an opaque definition-and-placeholder address. Each value is only `{ "value": "..." }`; the definition already owns placement. A worker receives only the values its own bound definitions reference, so delivery is per-agent rather than a namespace shared by every runtime. Adding or rotating a credential takes effect on the next apply with no restart. For HTTP connectors, the credential's host list is enforced at the moment of use: changing a definition's `url` to a host the credential was not issued for fails the apply instead of sending it there.

The worker holds the delivery map in memory for the life of the process and never writes values to its Agent Dock state file. Provider-owned configuration is a different boundary: Claude, OpenCode, and Codex stdio configuration may have to contain a resolved value inside that agent's private volume, while Codex HTTP bearer configuration stores an environment-variable name and receives its value again at task start. Those files are not a secret manager and are readable by the harness and Docker host administrator. A restart still leaves the wrapper naming connectors it cannot safely configure: it reports them in `pendingCredentials[]`, refuses to re-render or launch them from stale provider configuration, and fails a task that needs them with `missing_credential`. A runtime refresh re-applies automatically; any other restart needs an apply before the agent is whole again.

The contract is capability-gated in both dimensions. A worker must advertise `placeholders: true` before it receives any definition containing placeholder bindings, and `credentialDelivery: true` before it receives a stored-key binding. An older worker could otherwise ignore an additive field and configure the literal placeholder, so the control plane refuses the apply.

A connector-secret binding name is logical, not an arbitrary worker environment-variable name. The worker resolves `COMPANY_MCP_TOKEN` only from `MCP_SECRET_COMPANY_MCP_TOKEN`. Nothing outside that prefix is visible to the resolver, so a definition cannot name the runtime's own `WORKER_TOKEN`, a provider home directory, or `OLLAMA_BASE_URL` — those variables are absent from the map rather than merely rejected by a rule. An unresolvable binding produces a validation warning and fails apply rather than silently leaving a placeholder in place.

## Lifecycle

| Surface | Operation |
|---|---|
| Control plane | Reusable definition CRUD under `/api/v1/mcp/servers` |
| Control plane | Per-agent bind, unbind, validate, inspect, and apply under `/api/v1/agents/:id/mcp` |
| Worker | `POST /v1/mcp/validate` performs structural and adapter-policy validation without starting the server |
| Worker | `PUT /v1/mcp` replaces the complete managed desired state |
| Worker | `GET /v1/mcp` returns the canonical desired state plus sanitized provider health |

Each provider starts a fresh CLI process per task, so successful changes activate on the next task without restarting the container:

- Codex reconciles Agent Dock-managed names through the native `codex mcp` CLI and restores the prior managed set if a new entry is rejected. For an HTTP bearer connector it supplies the generated environment variable both while configuring the entry and to every `codex exec` task.
- Claude Code receives a worker-owned `--mcp-config` file plus `--strict-mcp-config`; the wrapper re-renders that file at every task start (including an empty first-run file), and its startup event supplies connection health.
- OpenCode receives a managed JSON configuration and high-precedence task configuration. Before each task, the wrapper resolves OpenCode's merged configuration and explicitly disables MCP names introduced by lower-precedence project or user files; if that inspection fails, the task fails closed. Its `mcp list` output is parsed through a redacting allowlist.

Local MCP commands are code execution inside the agent container. They are denied by default and must exactly match the worker's `MCP_ALLOWED_COMMANDS` allowlist. Allowlisting an interpreter such as `node`, `python`, or `bash` is equivalent to permitting arbitrary execution, because a definition's arguments are unconstrained — the allowlist bounds which binary runs, not what it does. Remote definitions reject embedded URL credentials, but there is no destination allowlist: a definition holding a legitimately provisioned connector secret can name any `https` host, and nothing but operator review decides where that credential is sent.

Connector secrets are provisioned under the `MCP_SECRET_` namespace, separately from the variables the worker uses to run. The provisioner forwards that namespace and nothing else, so adding a connector credential means setting `MCP_SECRET_<NAME>` in `.env.mcp-secrets` where the control plane runs and then provisioning or refreshing the runtime; no code change is needed for a new one. That file is separate from `.env` because the control plane holds the Docker socket and `env_file` cannot be scoped to a prefix. Bootstrap workers declared in `docker-compose.yml` need the variable added to that service explicitly, since Compose cannot forward a namespace. The namespace is forwarded to **every** managed runtime, not only to agents whose definitions reference it, because provisioning happens before an agent has any MCP binding. A connector secret is therefore present in every agent container and readable there by the harness, which can read its own environment. This makes a credential revocable in one place; it is neither per-agent isolation nor confidentiality against the harness. Per-agent delivery needs credentials to be records the control plane manages rather than variables fixed at container creation.

## Control-plane MCP privilege boundary

The control-plane MCP server calls selected internal control-plane services rather than the browser routes. Its tool registry is an explicit allowlist and does not register tools that create, update, delete, bind, unbind, or apply MCP definitions. It also omits storage, volume, and mount mutation tools. Those administrative capabilities remain available only through the authenticated operator REST/UI surface. This is a code-level capability boundary, not a prompt instruction.

## What a key's host list does, and does not do

A stored key may name the hosts it is for. That list is compared with the
connector definition's `url` in the control plane, at the moment configuration is
applied, and an apply is refused when the two disagree.

That is the whole mechanism, so it is worth being exact about its reach:

- **It is not egress control.** No DNS restriction, proxy, or network policy is
  applied to a runtime container. Once a worker holds a value it can send it
  anywhere it can reach, and an agent can read its own secrets by design.
- **It is an integrity check on the definition.** What it prevents is a
  connector's `url` being edited to point a key somewhere it was not issued for,
  which is the shape an earlier review found reachable in two calls.
- **A local process has no destination to check.** A `stdio` connector has no
  `url`, so the list is not consulted; that path is a separately named
  `resolveForLocalProcess` so the one caller that skips the check is visible.
- **An empty list means no restriction.** The allowlist is opt-in, so a key that
  names no hosts is accepted for any destination.

A hostname is resolved inside the agent's own container, which is the part most
likely to surprise. `127.0.0.1` and `localhost` mean that container, not the
machine running Agent Dock and not another container. A proxy running elsewhere
is reached by its container or service name on the shared Docker network, or by
`host.docker.internal` for the host — the same name the bundled OpenCode worker
uses to reach Ollama.
