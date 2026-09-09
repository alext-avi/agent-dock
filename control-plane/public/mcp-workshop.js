const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

function placeholderMap(value, warnings, field) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  const result = {};
  for (const [name, raw] of entries) {
    const nameValid = field === 'environment' ? ENVIRONMENT_NAME.test(name) : Boolean(name) && !/\0|[\r\n]/.test(name);
    const valueValid = typeof raw === 'string' && raw.length <= 4000 && !/\0|[\r\n]/.test(raw);
    if (!nameValid || !valueValid) {
      warnings.push(`An invalid ${field} entry was discarded.`);
      continue;
    }
    if (!PLACEHOLDER.test(raw)) {
      warnings.push(`Literal ${field} values were removed; use a \${PLACEHOLDER} instead.`);
      continue;
    }
    result[name] = raw.trim();
  }
  return result;
}

function boundedString(value, fallback = null, max = 4000) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !/\0/.test(normalized) ? normalized : fallback;
}

export function buildMcpWorkshopPrompt(goal) {
  const objective = boundedString(goal, '', 12_000);
  if (!objective) throw new Error('Describe the connector or service you want the harness to investigate.');
  return `You are helping an operator prepare a reusable MCP connector for Agent Dock.

Investigate the connector using the tools and outbound network available inside your container. You may install or run software in your own workspace for a safe test, but do not call the Agent Dock control-plane API, edit its registry, change provider-native MCP configuration, or include any credential value. The operator will review and approve the final definition.

Determine the correct transport, endpoint or executable, arguments, and timeout. Before proposing a local stdio connector, confirm that its executable is installed and can actually be invoked inside this container. Do not propose docker unless the docker executable is present and usable here. Prefer a supported remote HTTP endpoint when the requested local launcher is unavailable. If neither can be verified, explain that the connector is blocked instead of presenting an unverified definition as ready.

Where the connector needs a secret, write a placeholder in the form \${NAME} at the exact position the value belongs — in an argument, URL, header, environment value, or working directory. Use a descriptive upper-case name, for example \${ACCESS_TOKEN}. Agent Dock fills a placeholder in at the moment the connector starts, so it goes exactly where the real value would go — for example an Authorization header of "Bearer \${ACCESS_TOKEN}" — not a separate secret mapping.

Only put a placeholder in environment when the executable's documented interface actually reads that environment variable; never invent an environment entry merely to give a placeholder somewhere to live. One intentional case is "docker run -e NAME": Docker reads NAME from its own environment and forwards it to the child container, so use an environment entry of "NAME": "\${NAME}" and keep the argument as NAME. This avoids placing the resolved secret in the process argument list. Explain this forwarding choice before the proposal. Do not invent a working directory such as /workspace/project; use null unless a real, required directory was verified.

Do not decide what fills it. The operator binds each placeholder to a key Agent Dock stores or to a secret provisioned inside the agent's container, and that choice is theirs. Never put a token, cookie, password or key value anywhere in the proposal — a placeholder is how you say a secret is needed. If the connector needs no secret, use no placeholders and say so.

Only when you have verified a viable definition, end your response with exactly one proposal between these tags. If the connector is blocked by a missing executable, unsupported transport, or another unresolved requirement, explain the blocker and do not emit proposal tags; an unverified proposal is worse than no proposal.
<agent-dock-mcp-proposal>
{
  "name": "lowercase_connector_name",
  "transport": "http",
  "command": null,
  "args": [],
  "cwd": null,
  "url": "https://mcp.example.com/mcp",
  "environment": {},
  "headers": { "Authorization": "Bearer \${ACCESS_TOKEN}" },
  "timeoutMs": 30000
}
</agent-dock-mcp-proposal>

If details remain uncertain, explain them before the proposal and choose conservative values that make the uncertainty obvious. Never put a token, cookie, password, or API key value in the proposal.

Operator objective:
${objective}`;
}

export function extractMcpWorkshopProposal(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('The harness did not return a proposal.');
  const tagged = output.match(/<agent-dock-mcp-proposal>\s*([\s\S]*?)\s*<\/agent-dock-mcp-proposal>/i);
  const fenced = output.match(/```(?:json|agent-dock-mcp)?\s*([\s\S]*?)\s*```/i);
  const candidate = tagged?.[1] ?? fenced?.[1];
  if (!candidate) throw new Error('The harness response did not contain an Agent Dock MCP proposal.');

  let raw;
  try {
    raw = JSON.parse(candidate);
  } catch {
    throw new Error('The harness proposal was not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The harness proposal must be a JSON object.');

  const warnings = [];
  const transport = raw.transport === 'stdio' ? 'stdio' : 'http';
  if (transport === 'http' && raw.environment && Object.keys(raw.environment).length) {
    warnings.push('Environment values were removed because HTTP connectors do not use a process environment.');
  }
  if (transport === 'stdio' && raw.headers && Object.keys(raw.headers).length) {
    warnings.push('Header values were removed because stdio connectors do not make an HTTP request.');
  }
  for (const field of ['credentialId', 'secretHeaders', 'secretEnvironment']) {
    const value = raw[field];
    if (value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length)) {
      warnings.push(`${field} was removed because placeholder bindings are the only credential mechanism.`);
    }
  }
  const args = Array.isArray(raw.args)
    ? raw.args.map((value) => boundedString(value, '', 2000)).filter(Boolean).slice(0, 64)
    : [];
  const timeout = Number(raw.timeoutMs);
  const proposal = {
    name: boundedString(raw.name, '', 64),
    transport,
    command: transport === 'stdio' ? boundedString(raw.command, '', 500) : null,
    args: transport === 'stdio' ? args : [],
    cwd: transport === 'stdio' ? boundedString(raw.cwd, null, 1000) : null,
    url: transport === 'http' ? boundedString(raw.url, '', 2000) : null,
    environment: transport === 'stdio' ? placeholderMap(raw.environment, warnings, 'environment') : {},
    headers: transport === 'http' ? placeholderMap(raw.headers, warnings, 'header') : {},
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 300_000 ? timeout : 30_000
  };
  return { proposal, warnings: [...new Set(warnings)] };
}

export function createWorkshopRunState() {
  return { taskId: null, terminalTaskId: null, terminalStatus: null, errors: 0, mixedTasks: false };
}

export function observeWorkshopRunEvent(state, event) {
  if (!state || !event || typeof event !== 'object') return state;
  if (event.type === 'task.started') {
    if (state.taskId && event.taskId !== state.taskId) state.mixedTasks = true;
    else state.taskId = event.taskId ?? null;
  }
  // Recorded so the caller can say the run was not clean, but not on its own a
  // reason to refuse: the terminal status decides that.
  if (event.type === 'error') state.errors += 1;
  if (event.type === 'task.completed') {
    state.terminalTaskId = event.taskId ?? null;
    state.terminalStatus = event.data?.status ?? null;
  }
  return state;
}

export function requireSuccessfulWorkshopRun(state) {
  if (!state?.taskId) throw new Error('The harness stream did not identify its task. No proposal was accepted.');
  if (state.terminalTaskId !== state.taskId) throw new Error('The harness stream ended without a matching terminal event. No proposal was accepted.');
  if (state.mixedTasks) {
    throw new Error('The harness stream described more than one task. No proposal was accepted.');
  }
  if (state.terminalStatus !== 'succeeded') {
    throw new Error(`The harness task ${state.terminalStatus ?? 'ended without reporting a result'}; its proposal was not accepted.`);
  }
}
