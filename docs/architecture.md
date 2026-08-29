# Agent Dock architecture

```mermaid
flowchart TB
  subgraph Client["Browser · HTML5 + CSS + vanilla JavaScript ES modules"]
    UI["Fleet dashboard\nAgent config + test UI"]
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
  end

  OpenAI["OpenAI subscription service\nDevice authorization + Codex execution"]
  Anthropic["Anthropic subscription service\nBrowser OAuth + Claude execution"]
  MCP["Future MCP/tool recipes"]
  Data["Future attached data volumes"]

  UI <-->|"Same-origin HTTP"| API
  API <--> Registry
  API -->|"Bearer-authenticated agent-wrapper/v1\nJSON status + NDJSON task events"| CW
  API -->|"Identical contract"| AW
  CC <--> OpenAI
  AC <--> Anthropic
  MCP -.-> CW
  MCP -.-> AW
  Data -.-> CWS
  Data -.-> AWS
```

| Layer | Current stack |
|---|---|
| Browser | Semantic HTML5, hand-written CSS, vanilla JavaScript ES modules, Fetch API |
| Control plane | Node.js 22, built-in `http`, filesystem-backed JSON registry, streaming Fetch proxy |
| Worker wrapper | Node.js 22, built-in `http`, `child_process`, filesystem persistence |
| Provider harnesses | Official `@openai/codex` and `@anthropic-ai/claude-code` CLI distributions |
| Internal protocol | `agent-wrapper/v1`; REST/JSON for control and NDJSON for task streams |
| Runtime/isolation | Dockerfiles + Docker Compose private network; one process boundary per provider identity |
| Persistence | Docker named volumes for CLI auth, installed binaries, request telemetry, and registry; host bind mounts for workspaces |
| Authentication | Codex device authorization; Claude browser OAuth with an ephemeral, non-persisted completion-code handoff |
| Tests | Node.js built-in test runner plus live Docker/API/browser smoke tests |

The control plane never parses provider credential files. Provider-specific commands, auth behavior, event formats, and supported usage telemetry stop at the adapter boundary.
