const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function secretEnvironment(value, warnings) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  const result = {};
  for (const [target, reference] of entries) {
    const sourceEnv = typeof reference === 'string' ? reference : reference?.sourceEnv;
    if (!ENVIRONMENT_NAME.test(target) || !ENVIRONMENT_NAME.test(sourceEnv ?? '')) {
      warnings.push('An invalid secret environment reference was discarded.');
      continue;
    }
    result[target] = { sourceEnv };
  }
  return result;
}

function secretHeaders(value, warnings) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  const result = {};
  for (const [header, reference] of entries) {
    const sourceEnv = typeof reference === 'string' ? reference : reference?.sourceEnv;
    const prefix = typeof reference === 'object' && typeof reference?.prefix === 'string' ? reference.prefix : '';
    if (!header || !ENVIRONMENT_NAME.test(sourceEnv ?? '') || /\0|[\r\n]/.test(header) || /\0|[\r\n]/.test(prefix)) {
      warnings.push('An invalid secret header reference was discarded.');
      continue;
    }
    result[header] = { sourceEnv, prefix };
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

Determine the correct transport, endpoint or executable, arguments, timeout, and environment-variable names. Use worker environment-variable references for credentials. For a bearer-authenticated HTTP connector, use secretHeaders.Authorization with a sourceEnv and the prefix "Bearer ". For a local process, use secretEnvironment to map the connector variable to a worker source variable. Literal environment and header values are not accepted by this workshop.

End your response with exactly one proposal between these tags:
<agent-dock-mcp-proposal>
{
  "name": "lowercase_connector_name",
  "transport": "http",
  "command": null,
  "args": [],
  "cwd": null,
  "url": "https://example.com/mcp",
  "environment": {},
  "secretEnvironment": {},
  "headers": {},
  "secretHeaders": {
    "Authorization": { "sourceEnv": "CONNECTOR_TOKEN", "prefix": "Bearer " }
  },
  "timeoutMs": 30000
}
</agent-dock-mcp-proposal>

If details remain uncertain, explain them before the proposal and choose conservative placeholders that make the uncertainty obvious. Never put a token, cookie, password, or API key value in the proposal.

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
  if (raw.environment && Object.keys(raw.environment).length) warnings.push('Literal environment values were removed; use worker secret references.');
  if (raw.headers && Object.keys(raw.headers).length) warnings.push('Literal header values were removed; use worker secret references.');
  const transport = raw.transport === 'stdio' ? 'stdio' : 'http';
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
    environment: {},
    secretEnvironment: transport === 'stdio' ? secretEnvironment(raw.secretEnvironment, warnings) : {},
    headers: {},
    secretHeaders: transport === 'http' ? secretHeaders(raw.secretHeaders, warnings) : {},
    timeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 300_000 ? timeout : 30_000
  };
  return { proposal, warnings: [...new Set(warnings)] };
}

function cloneMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry && typeof entry === 'object' ? { ...entry } : entry]))
    : {};
}

export function mergeMcpQuickEdit(base = {}, quick = {}) {
  const transport = quick.transport === 'stdio' ? 'stdio' : 'http';
  const sameTransport = base.transport === transport;
  const environment = sameTransport ? cloneMap(base.environment) : {};
  const headers = sameTransport ? cloneMap(base.headers) : {};
  const secretEnvironmentMap = sameTransport ? cloneMap(base.secretEnvironment) : {};
  const secretHeadersMap = sameTransport ? cloneMap(base.secretHeaders) : {};

  if (transport === 'stdio') {
    const original = Object.entries(secretEnvironmentMap)[0];
    if (original) delete secretEnvironmentMap[original[0]];
    if (quick.secretTarget && quick.secretSource) {
      secretEnvironmentMap[quick.secretTarget] = { sourceEnv: quick.secretSource };
    }
  } else {
    const original = Object.entries(secretHeadersMap).find(([header, value]) => (
      header.toLowerCase() === 'authorization' && value?.prefix === 'Bearer '
    ));
    if (original) delete secretHeadersMap[original[0]];
    if (quick.bearerEnv) {
      secretHeadersMap.Authorization = { sourceEnv: quick.bearerEnv, prefix: 'Bearer ' };
    }
  }

  return {
    name: quick.name ?? '',
    transport,
    command: transport === 'stdio' ? quick.command ?? '' : null,
    args: transport === 'stdio' ? quick.args ?? [] : [],
    cwd: transport === 'stdio' && sameTransport ? base.cwd ?? null : null,
    url: transport === 'http' ? quick.url ?? '' : null,
    environment: transport === 'stdio' ? environment : {},
    secretEnvironment: transport === 'stdio' ? secretEnvironmentMap : {},
    headers: transport === 'http' ? headers : {},
    secretHeaders: transport === 'http' ? secretHeadersMap : {},
    timeoutMs: quick.timeoutMs ?? 30_000
  };
}

export function createWorkshopRunState() {
  return { taskId: null, terminalTaskId: null, terminalStatus: null, sawError: false };
}

export function observeWorkshopRunEvent(state, event) {
  if (!state || !event || typeof event !== 'object') return state;
  if (event.type === 'task.started') {
    if (state.taskId && event.taskId !== state.taskId) state.sawError = true;
    else state.taskId = event.taskId ?? null;
  }
  if (event.type === 'error') state.sawError = true;
  if (event.type === 'task.completed') {
    state.terminalTaskId = event.taskId ?? null;
    state.terminalStatus = event.data?.status ?? null;
  }
  return state;
}

export function requireSuccessfulWorkshopRun(state) {
  if (!state?.taskId) throw new Error('The harness stream did not identify its task. No proposal was accepted.');
  if (state.terminalTaskId !== state.taskId) throw new Error('The harness stream ended without a matching terminal event. No proposal was accepted.');
  if (state.terminalStatus !== 'succeeded' || state.sawError) {
    throw new Error(`The harness task ${state.terminalStatus ?? 'failed'}; its proposal was not accepted.`);
  }
}
