# Authentication and authorization

Agent Dock has two deliberately separate identity boundaries:

1. **Platform identity** controls the web UI, REST API, and control-plane MCP server.
2. **Provider identity** belongs to a single worker container and is used only by Codex, Claude Code, or OpenCode.

A GitHub sign-in to the platform never becomes a provider credential, and provider OAuth files never leave their worker's private auth volume.

## Modes

`AUTH_MODE=trusted-local` is the default development mode. It creates an explicit local administrator principal so the existing laptop-only workflow remains convenient. Compose also publishes the UI on `127.0.0.1` by default. Trusted-local mode is not suitable when the port is exposed beyond the local machine.

`AUTH_MODE=oidc` enables OpenID Connect Authorization Code flow with PKCE. Use an OIDC authorization server that can federate GitHub identities, such as WorkOS AuthKit or Auth0. Direct GitHub OAuth is not an OIDC issuer and cannot be placed in `AUTH_OIDC_ISSUER`.

Register this callback URI with the authorization server:

```text
${AUTH_PUBLIC_ORIGIN}/auth/callback
```

The smallest shared deployment configuration is:

```dotenv
AUTH_MODE=oidc
AUTH_PUBLIC_ORIGIN=https://agents.example.com
AUTH_PROVIDER_NAME=GitHub
AUTH_OIDC_ISSUER=https://your-authorization-server.example.com/
AUTH_OIDC_CLIENT_ID=your-client-id
AUTH_OIDC_CLIENT_SECRET=your-client-secret
AUTH_SESSION_SECRET=a-random-secret-containing-at-least-32-bytes
AUTH_API_AUDIENCE=https://agents.example.com/api
AUTH_MCP_AUDIENCE=https://agents.example.com/mcp
AUTH_DEFAULT_ROLE=viewer
AUTH_ADMIN_SUBJECTS=provider-subject-for-the-first-admin
```

`AUTH_PUBLIC_ORIGIN` must be the exact browser-facing origin. If the local Compose port changes, change this value, `AUTH_API_AUDIENCE`, and `AUTH_MCP_AUDIENCE` as well.

The authorization server must issue signed JWT ID tokens, and API bearer tokens must be JWTs with `iss` equal to `AUTH_OIDC_ISSUER` and `aud` equal to `AUTH_API_AUDIENCE`. RS256, PS256, and ES256 are supported. Opaque access tokens are not accepted by this POC.

## Sessions and request protection

The browser login uses state, nonce, and PKCE S256. Agent Dock verifies the token signature against the issuer's JWKS plus its issuer, audience, expiry, and nonce claims.

After login, the browser receives an HTTP-only, SameSite=Lax signed session cookie. Only a random session identifier and expiry are in the cookie; identity and revocation state live in `/control-data/auth.sqlite`. HTTPS origins also receive the `Secure` cookie attribute. Logout revokes the server-side session.

Unsafe browser API requests must send `x-agent-dock-csrf: 1`. The bundled client adds it automatically and the server also validates `Origin` when the browser supplies one.

## Roles and permissions

Roles are computed on every request, so changes to an allowlist take effect for existing sessions:

| Role | Permissions |
|---|---|
| `viewer` | Read fleet, agent, schedule, usage, and runtime status |
| `operator` | Viewer access plus task execution, schedule management, and usage refresh |
| `admin` | All REST/UI operations, including agent, runtime, provider-auth, MCP, and workspace management |

Configure roles with comma-separated immutable OIDC subjects whenever possible:

```dotenv
AUTH_ADMIN_SUBJECTS=subject-1,subject-2
AUTH_OPERATOR_SUBJECTS=subject-3
```

Email allowlists (`AUTH_ADMIN_EMAILS`, `AUTH_OPERATOR_EMAILS`) are supported for initial setup only when the issuer marks the email claim verified, but they are still weaker identifiers because email ownership and claims can change. Everyone else receives `AUTH_DEFAULT_ROLE`, which should normally remain `viewer`.

The control-plane MCP server calls this same verifier and permission service. Tokens carrying an `agent_id` claim are scope-only and never inherit a human role. Its tool registry exposes an intentionally smaller capability set: MCP administration, provider-auth operations, runtime mutation, and storage/volume mutation are not registered as MCP tools even for a broadly scoped agent token.

## REST and MCP bearer tokens

Non-browser clients send an OIDC access token:

```http
Authorization: Bearer <audience-bound-jwt>
```

Agent Dock publishes REST protected-resource metadata at `/.well-known/oauth-protected-resource` and MCP metadata at `/.well-known/oauth-protected-resource/mcp`. Missing credentials receive `401` with a `WWW-Authenticate` challenge pointing to the corresponding document. A REST token cannot be replayed at MCP because the two resources use different audiences.

## Control-plane MCP

The Streamable HTTP endpoint is `${AUTH_PUBLIC_ORIGIN}/mcp`. It uses the official MCP TypeScript SDK, serves the current `2026-07-28` protocol, and retains its stateless compatibility path for 2025-era clients. It is deliberately unavailable in `trusted-local` mode: MCP requires `AUTH_MODE=oidc` and a bearer JWT whose audience is exactly `AUTH_MCP_AUDIENCE`.

The registered safe tools are:

| Tool | Capability |
|---|---|
| `list_agents` | List safe summaries of visible delegation targets |
| `get_agent_status` | Read an allowed agent's wrapper status |
| `submit_agent_task` | Queue work and return a durable control-plane task handle |
| `get_agent_task` | Poll an owned or assigned task and read its normalized result/usage |
| `cancel_agent_task` | Request cancellation of a task owned by the caller |

Human viewers receive only the two read tools. Operators and administrators receive the task tools as well. An agent token must carry `agent_id`, the corresponding `fleet:read` and/or `tasks:execute` scope, and an explicit entry in `MCP_AGENT_POLICIES_JSON`. Both its visible tools and target agents are the intersection of the token scopes and that policy. No policy means no agent-callable tools.

For example, this lets `researcher` inspect and delegate to two agents, with bounded fan-out and depth:

```dotenv
MCP_AGENT_POLICIES_JSON={"researcher":{"tools":["list_agents","get_agent_status","submit_agent_task","get_agent_task","cancel_agent_task"],"targetAgentIds":["analyst","writer"],"maxDepth":3,"maxConcurrent":2}}
```

Delegated task records live in `/control-data/delegations.sqlite`. Handles, caller/target identity, trace lineage, result text, normalized usage, and terminal state survive a restart. In-flight tasks are marked failed rather than replayed after a restart, preventing an autonomous side effect from being executed twice. Delegation cycles, spoofed parent ownership, excessive depth, and per-caller concurrency overflow fail closed.

The control plane does not yet mint or exchange third-party agent tokens. The configured authorization server must issue an MCP-audience JWT with the required `agent_id` and scopes. That is an identity-provider provisioning concern, separate from the provider subscription credential isolated in each worker.

## Control plane to worker authentication

Managed worker containers use `WORKER_AUTH_MODE=jwt`. The control plane creates a short-lived token for each request with audience `agent-wrapper:<worker-id>` and the minimum wrapper scope needed by that route. A token issued for one worker cannot be replayed against another worker.

The three legacy Compose bootstrap workers default to `WORKER_AUTH_MODE=hybrid`, accepting either those JWTs or their existing static token so current authenticated containers continue to work. Set `WORKER_AUTH_MODE=jwt` only after a bootstrap runtime has a control-plane path capable of minting its workload token.

This POC derives workload JWTs from each worker's private shared secret. A later multi-host deployment should move issuance to an asymmetric key or dedicated workload identity system so workers verify a public key and the signing key is not present in worker containers.

## Operational cautions

- Terminate TLS before enabling a remote deployment.
- Set `CONTROL_PLANE_BIND=0.0.0.0` only after OIDC and TLS are in place; direct Node execution also binds to loopback unless `HOST` is explicitly changed.
- Keep `AUTH_SESSION_SECRET`, OIDC client secrets, and worker secrets outside source control.
- Prefer immutable subject allowlists and a fail-closed `viewer` default.
- The in-memory login transaction is intentionally single-replica; completing an in-flight login after a control-plane restart will require starting login again.
- Changing a role allowlist applies immediately, but invalidating all sessions requires deleting/replacing `auth.sqlite` or adding an administrative revocation operation.
- Platform authentication does not reduce the authority granted by the mounted Docker socket. Production still needs a constrained runtime provisioner boundary.
