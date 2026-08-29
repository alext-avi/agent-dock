# Agent Dock architecture

Open the rendered [SVG architecture diagram](./architecture.svg), or edit the standalone [Mermaid source](./architecture.mmd).

```mermaid
flowchart TB
  subgraph Client["Current web client · HTML5 + CSS + vanilla JavaScript ES modules"]
    UI["Fleet dashboard\nAgent config + test UI\nVisibility-aware 3s live status polling"]
  end

  subgraph Plane["Control plane · Node.js 22 built-in HTTP server"]
    API["REST/JSON + NDJSON proxy\nAgent CRUD and runtime operations"]
    Registry["JSON agent registry\nDurable prompts + private worker routing"]
  end

  subgraph Docker["Docker Compose · isolated service network"]
    subgraph CodexWorker["Codex worker · Node.js 22 wrapper"]
      CW["agent-wrapper/v1"]
      CA["Codex adapter"]
      CC["Official @openai/codex CLI"]
      CV["Named volumes\nCLI auth · binary cache · telemetry"]
      CWS["Bind-mounted /workspace"]
      CW --> CA --> CC
      CW --- CV
      CW --- CWS
    end

    subgraph ClaudeWorker["Claude worker · Node.js 22 wrapper · non-root user"]
      AW["agent-wrapper/v1"]
      AA["Claude adapter"]
      AC["Official @anthropic-ai/claude-code CLI"]
      AV["Named volumes\nCLI auth · binary cache · telemetry"]
      AWS["Bind-mounted /workspace"]
      AW --> AA --> AC
      AW --- AV
      AW --- AWS
    end


    subgraph OpenCodeWorker["OpenCode worker · Node.js 22 wrapper · non-root user"]
      OW["agent-wrapper/v1"]
      OA["OpenCode adapter"]
      OC["Official opencode-ai CLI"]
      OV["Named volumes\nProvider auth · binary cache · telemetry"]
      OWS["Bind-mounted /workspace"]
      OW --> OA --> OC
      OW --- OV
      OW --- OWS
    end
  end

  OpenAI["OpenAI subscription service\nDevice authorization + Codex execution"]
  Anthropic["Anthropic subscription service\nBrowser OAuth + Claude execution"]
  Providers["Supported OpenCode providers\nGitHub Copilot device authorization by default"]
  MCP["Future MCP/tool recipes"]
  Data["Future attached data volumes"]
  React["Planned web client\nReact + TypeScript + Vite"]
  Database["Planned transactional persistence\nSQLite local · Postgres-ready repository"]

  UI <-->|"Same-origin HTTP"| API
  API <--> Registry
  API -->|"Bearer-authenticated agent-wrapper/v1\nJSON status + NDJSON task events"| CW
  API -->|"Identical contract"| AW
  API -->|"Identical contract"| OW
  CC <--> OpenAI
  AC <--> Anthropic
  OC <--> Providers
  UI -.->|"staged migration"| React
  Registry -.->|"data migration"| Database
  MCP -.-> CW
  MCP -.-> AW
  MCP -.-> OW
  Data -.-> CWS
  Data -.-> AWS
  Data -.-> OWS
```

| Layer | Current stack |
|---|---|
| Browser | Current: semantic HTML5, hand-written CSS, vanilla JavaScript ES modules, Fetch API, visibility-aware 3-second status polling. Planned: React + TypeScript + Vite after an explicit React/Vue spike. |
| Control plane | Node.js 22, built-in `http`, filesystem-backed JSON registry, streaming Fetch proxy |
| Worker wrapper | Node.js 22, built-in `http`, `child_process`, filesystem persistence |
| Provider harnesses | Official `@openai/codex`, `@anthropic-ai/claude-code`, and `opencode-ai` CLI distributions |
| Internal protocol | `agent-wrapper/v1`; REST/JSON for control and NDJSON for task streams |
| Runtime/isolation | Dockerfiles + Docker Compose private network; one process boundary per provider identity |
| Persistence | Current: JSON registry plus Docker named volumes for CLI auth, installed binaries, and request telemetry. Planned: SQLite locally behind a Postgres-ready repository boundary. |
| Authentication | Codex device authorization; Claude browser OAuth with an ephemeral, non-persisted completion-code handoff; OpenCode provider auth with GitHub Copilot device authorization as the POC default |
| Tests | Node.js built-in test runner plus live Docker/API/browser smoke tests |

The control plane never parses provider credential files. Provider-specific commands, auth behavior, event formats, and supported usage telemetry stop at the adapter boundary.
