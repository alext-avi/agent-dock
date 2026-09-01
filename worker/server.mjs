import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { codexAdapterManifest, normalizeCodexEvent, normalizeCodexQuotaWindows } from './adapters/codex.mjs';
import { claudeAdapterManifest, normalizeClaudeEvent } from './adapters/claude.mjs';
import { opencodeAdapterManifest, normalizeOpenCodeEvent } from './adapters/opencode.mjs';
import { ClaudeUsageError, MAX_RETRY_AFTER_SECONDS, claudeCredentialPaths, fetchClaudeUsage, normalizeClaudeQuotaWindows } from './adapters/claude-usage.mjs';
import { normalizeTokenUsage, wrapperEvent, wrapperResponse } from './protocol.mjs';
import { connectorSecrets, createMcpManager } from './mcp/manager.mjs';

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function clean(text) {
  return text.replace(ANSI, '').replace(/\r/g, '');
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

function authorized(req, token) {
  const actual = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(actual);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 10_000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: clean(`${output}\n${error.message}`).trim() });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: clean(output).trim() });
    });
  });
}

function parseLoginTranscript(transcript) {
  const urls = transcript.match(/https:\/\/[^\s<>]+/g) ?? [];
  const codes = transcript.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/g) ?? [];
  return {
    verificationUrl: urls.at(-1)?.replace(/[),.;]+$/, '') ?? null,
    userCode: codes.at(-1) ?? null
  };
}

function jwtExpiresAt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(Number(payload.exp)) ? new Date(Number(payload.exp) * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const LEGACY_ROUTES = new Map([
  ['/health', '/v1/health'],
  ['/status', '/v1/status'],
  ['/providers', '/v1/providers'],
  ['/auth/start', '/v1/auth/login'],
  ['/auth/complete', '/v1/auth/complete'],
  ['/auth/refresh', '/v1/auth/refresh'],
  ['/workspace', '/v1/workspace'],
  ['/usage', '/v1/usage'],
  ['/usage/refresh', '/v1/usage/refresh'],
  ['/run', '/v1/tasks'],
  ['/run/cancel', '/v1/tasks/cancel']
]);

function canonicalRoute(pathname) {
  return LEGACY_ROUTES.get(pathname) ?? pathname;
}

// A non-numeric interval must not become NaN: every comparison against NaN is
// false, which would silently delete the poll floor instead of failing.
function positiveInterval(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function initialUsage() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    lastPollAt: null,
    pollError: null,
    // Distinguishes a telemetry-source failure from an exhausted plan. An
    // exhausted plan is a successful poll reporting 100% used, never an error.
    pollErrorKind: null,
    // Honours a 429 Retry-After from the usage endpoint. Deliberately reset on
    // load: a backoff deadline belongs to the process that received it, and
    // persisting one lets a single bad Retry-After outlive a restart.
    retryAfterAt: null,
    // When the quota windows themselves were last successfully read. lastPollAt
    // advances on failed and skipped attempts too, so it cannot answer "how old
    // is this number".
    lastSuccessAt: null,
    rateLimits: null,
    accountUsage: null,
    totals: {
      requests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0
    },
    history: []
  };
}

async function listWorkspace(root, maxEntries = 250) {
  const entries = [];
  async function walk(directory, relative = '') {
    if (entries.length >= maxEntries) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      // Neither is an agent artifact, and a dependency tree alone can exhaust
      // the entry cap and push the agent's real output out of the listing.
      if (child.name === '.git' || child.name === 'node_modules') continue;
      const childRelative = path.posix.join(relative, child.name);
      const full = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ path: `${childRelative}/`, type: 'directory' });
        await walk(full, childRelative);
      } else if (child.isFile()) {
        const metadata = await stat(full).catch(() => null);
        entries.push({ path: childRelative, type: 'file', size: metadata?.size ?? null });
      }
    }
  }
  await walk(root);
  return { entries, truncated: entries.length >= maxEntries };
}

export function createWorkerServer(options = {}) {
  const demoMode = options.demoMode ?? process.env.DEMO_MODE === '1';
  const adapterId = options.adapter ?? process.env.AGENT_ADAPTER ?? 'codex-cli';
  if (!['codex-cli', 'claude-code', 'opencode'].includes(adapterId)) throw new Error(`Unsupported AGENT_ADAPTER: ${adapterId}`);
  const adapterManifest = adapterId === 'claude-code'
    ? claudeAdapterManifest
    : adapterId === 'opencode' ? opencodeAdapterManifest : codexAdapterManifest;
  const normalizeProviderEvent = adapterId === 'claude-code'
    ? normalizeClaudeEvent
    : adapterId === 'opencode' ? normalizeOpenCodeEvent : normalizeCodexEvent;
  // Each adapter owns the shape of its own provider's usage envelope, exactly as
  // it owns the shape of its provider's events.
  const normalizeProviderQuotaWindows = adapterId === 'claude-code'
    ? normalizeClaudeQuotaWindows
    : adapterId === 'codex-cli' ? normalizeCodexQuotaWindows : () => [];
  const config = {
    token: options.token ?? process.env.WORKER_TOKEN ?? '',
    port: Number(options.port ?? process.env.PORT ?? 7777),
    agentId: options.agentId ?? process.env.AGENT_ID ?? 'worker-01',
    adapterId,
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? '/codex-home',
    claudeHome: options.claudeHome ?? process.env.CLAUDE_HOME ?? process.env.HOME ?? '/claude-home',
    opencodeHome: options.opencodeHome ?? process.env.OPENCODE_HOME ?? process.env.HOME ?? '/opencode-home',
    opencodeAuthProvider: options.opencodeAuthProvider ?? process.env.OPENCODE_AUTH_PROVIDER ?? 'github-copilot',
    opencodeConfigPath: options.opencodeConfigPath === null ? null : (options.opencodeConfigPath ?? process.env.OPENCODE_CONFIG ?? '/agent-data/opencode-provider.json'),
    ollamaBaseUrl: (options.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, ''),
    ollamaConnectionId: options.ollamaConnectionId ?? process.env.OLLAMA_CONNECTION_ID ?? 'ollama-local',
    ollamaDisplayName: options.ollamaDisplayName ?? process.env.OLLAMA_DISPLAY_NAME ?? 'Local Ollama',
    workspace: options.workspace ?? process.env.WORKSPACE_PATH ?? '/workspace',
    allowUnsandboxed: options.allowUnsandboxed ?? process.env.ALLOW_UNSANDBOXED === '1',
    demoMode,
    dataPath: options.dataPath === null ? null : (options.dataPath ?? process.env.AGENT_DATA_PATH ?? (demoMode ? null : '/agent-data/usage.json')),
    mcpStatePath: options.mcpStatePath === null ? null : (options.mcpStatePath ?? process.env.MCP_STATE_PATH ?? (demoMode ? null : '/agent-data/mcp/state.json')),
    mcpConfigDir: options.mcpConfigDir ?? process.env.MCP_CONFIG_DIR ?? (demoMode ? path.join('/tmp', `agent-dock-mcp-${options.agentId ?? process.env.AGENT_ID ?? 'worker-01'}`) : '/agent-data/mcp'),
    mcpAllowedCommands: options.mcpAllowedCommands ?? String(process.env.MCP_ALLOWED_COMMANDS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    // positiveInterval rather than Number: a non-numeric value would become NaN,
    // and every comparison against NaN is false, silently removing the poll floor.
    usagePollIntervalMs: positiveInterval(options.usagePollIntervalMs ?? process.env.USAGE_POLL_INTERVAL_MS, 60_000),
    // Experimental, off by default. Enables the undocumented Claude OAuth usage
    // source described in worker/adapters/claude-usage.mjs.
    claudeOAuthUsage: options.claudeOAuthUsage ?? process.env.CLAUDE_OAUTH_USAGE === '1',
    // Deliberately far slower than USAGE_POLL_INTERVAL_MS. That interval governs
    // Codex's local app-server call, which is free; this one governs an
    // undocumented remote endpoint that does rate limit in practice — a 54-minute
    // Retry-After was observed at five minutes. Thirty minutes still samples a
    // five-hour quota window ten times over, and the floor is per worker process,
    // so agents sharing one account multiply it.
    claudeUsageIntervalMs: positiveInterval(options.claudeUsageIntervalMs ?? process.env.CLAUDE_OAUTH_USAGE_INTERVAL_MS, 1_800_000),
    claudeUsageEndpoint: options.claudeUsageEndpoint ?? process.env.CLAUDE_OAUTH_USAGE_ENDPOINT ?? undefined,
    claudeUsageFetch: options.claudeUsageFetch ?? undefined
  };
  if (!config.token) throw new Error('WORKER_TOKEN is required');

  // The manifest states what the adapter implements; this states what this
  // instance actually has switched on. Claude Code has no supported quota
  // endpoint, so the window source is only advertised when the operator opts in,
  // and it is labelled experimental so the UI never presents it as supported.
  const claudeUsageEnabled = config.adapterId === 'claude-code' && config.claudeOAuthUsage;
  const capabilities = claudeUsageEnabled
    ? {
        ...adapterManifest.capabilities,
        usage: { ...adapterManifest.capabilities.usage, quotaWindows: true, quotaWindowSource: 'experimental-oauth' }
      }
    : adapterManifest.capabilities;

  const state = {
    startedAt: new Date().toISOString(),
    auth: { phase: config.demoMode ? 'authenticated' : 'unknown', transcript: '', verificationUrl: null, userCode: null },
    loginProcess: null,
    activeJob: null,
    usage: initialUsage(),
    usagePollPromise: null,
    authRefreshPromise: null,
    demoAuthLastRefreshAt: new Date().toISOString(),
    providerLastCheckedAt: null
  };

  const providerEnv = config.adapterId === 'claude-code'
    ? { ...process.env, HOME: config.claudeHome, CLAUDE_CONFIG_DIR: path.join(config.claudeHome, '.claude'), BROWSER: process.env.BROWSER ?? 'echo' }
    : config.adapterId === 'opencode'
      ? {
          ...process.env,
          HOME: config.opencodeHome,
          XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? path.join(config.opencodeHome, '.local/share'),
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(config.opencodeHome, '.config'),
          ...(config.opencodeConfigPath ? { OPENCODE_CONFIG: config.opencodeConfigPath } : {}),
          BROWSER: process.env.BROWSER ?? 'echo'
        }
      : { ...process.env, CODEX_HOME: config.codexHome };

  const mcpManager = createMcpManager({
    adapterId: config.adapterId,
    // Deliberately not providerEnv. That is the whole process environment, which
    // includes this runtime's own WORKER_TOKEN, its provider home directories,
    // and OLLAMA_BASE_URL — none of which a connector definition has any business
    // naming, and all of which it could name when the full environment was passed.
    environment: connectorSecrets(process.env),
    // The full environment a spawned harness command needs. Kept separate from
    // the resolver's map on purpose: merging them back is how the vulnerability
    // returns, and passing the narrow one here is how apply stops working.
    execEnvironment: providerEnv,
    workspace: config.workspace,
    allowedCommands: config.mcpAllowedCommands,
    statePath: config.mcpStatePath,
    configDir: config.mcpConfigDir,
    providerConfigPath: config.opencodeConfigPath,
    run: capture,
    demoMode: config.demoMode
  });

  async function loadUsage() {
    if (!config.dataPath) return;
    try {
      const stored = JSON.parse(await readFile(config.dataPath, 'utf8'));
      const defaults = initialUsage();
      state.usage = {
        ...defaults,
        ...stored,
        totals: { ...defaults.totals, ...stored.totals },
        history: Array.isArray(stored.history) ? stored.history.slice(-200) : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') state.usage.pollError = `Could not load usage history: ${error.message}`;
    }
    // A provider asked us to wait; a restart is not permission to ignore that.
    // But an absurd value must not outlive the process either, so honour the
    // deadline only as far as the cap we would have accepted in the first place.
    const stored = Number(state.usage.retryAfterAt);
    const ceiling = Date.now() + MAX_RETRY_AFTER_SECONDS * 1000;
    state.usage.retryAfterAt = Number.isFinite(stored) && stored > Date.now()
      ? Math.min(stored, ceiling)
      : null;
  }

  async function persistUsage() {
    if (!config.dataPath) return;
    await mkdir(path.dirname(config.dataPath), { recursive: true });
    const temporary = `${config.dataPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state.usage, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, config.dataPath);
  }

  const usageReady = loadUsage();

  function modelPolicy(value = {}) {
    if (value === null || value === undefined) value = {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error('modelPolicy must be an object'), { status: 400 });
    }
    const mode = value.mode ?? 'provider-default';
    if (!['provider-default', 'pinned'].includes(mode)) {
      throw Object.assign(new Error('modelPolicy.mode must be provider-default or pinned'), { status: 400 });
    }
    const primary = typeof value.primary === 'string' ? value.primary.trim() : null;
    if (mode === 'pinned' && (!primary || primary.length > 240)) {
      throw Object.assign(new Error('A valid modelPolicy.primary is required for pinned mode'), { status: 400 });
    }
    const fallbacks = Array.isArray(value.fallbacks) ? value.fallbacks.filter(Boolean) : [];
    if (fallbacks.length || value.externalFallback === true) {
      throw Object.assign(new Error('Automatic model fallback is not enabled; select one model explicitly'), { status: 409 });
    }
    return { mode, primary: mode === 'pinned' ? primary : null, fallbacks: [], externalFallback: false };
  }

  function contextLength(modelInfo = {}) {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith('.context_length') && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  }

  function normalizeOllamaModel(model, details = {}) {
    const name = typeof model === 'string' ? model : model?.name ?? model?.model;
    if (!name) return null;
    const source = typeof model === 'object' ? model : {};
    const modelDetails = details.details ?? source.details ?? {};
    const capabilities = details.capabilities ?? source.capabilities ?? [];
    return {
      id: `ollama/${name}`,
      name,
      displayName: name,
      providerId: 'ollama',
      connectionId: config.ollamaConnectionId,
      contextLength: Number(source.contextLength ?? contextLength(details.model_info)) || null,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      family: modelDetails.family ?? null,
      parameterSize: modelDetails.parameter_size ?? null,
      quantization: modelDetails.quantization_level ?? null,
      modifiedAt: source.modified_at ?? null,
      size: Number(source.size) || null
    };
  }

  async function writeOpenCodeProviderConfig(models) {
    if (!config.opencodeConfigPath || config.adapterId !== 'opencode') return;
    const modelConfig = Object.fromEntries(models.map((model) => [model.name, {
      name: model.displayName,
      ...(model.contextLength ? {
        limit: {
          context: model.contextLength,
          output: Math.min(32_768, Math.max(4_096, Math.floor(model.contextLength / 4)))
        }
      } : {})
    }]));
    let existing = {};
    try { existing = JSON.parse(await readFile(config.opencodeConfigPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const contents = {
      ...existing,
      $schema: 'https://opencode.ai/config.json',
      provider: {
        ...(existing.provider ?? {}),
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: config.ollamaDisplayName,
          options: { baseURL: `${config.ollamaBaseUrl}/v1` },
          models: modelConfig
        }
      }
    };
    await mkdir(path.dirname(config.opencodeConfigPath), { recursive: true });
    const temporary = `${config.opencodeConfigPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, config.opencodeConfigPath);
  }

  async function providerConnections() {
    state.providerLastCheckedAt = new Date().toISOString();
    if (config.adapterId !== 'opencode') {
      return {
        modelSelection: { supported: false, fallbackPolicy: 'explicit-only' },
        connections: [],
        lastCheckedAt: state.providerLastCheckedAt
      };
    }
    try {
      let models;
      if (config.demoMode && Array.isArray(options.ollamaModels)) {
        models = options.ollamaModels.map((model) => normalizeOllamaModel(model)).filter(Boolean);
      } else {
        const tagsResponse = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!tagsResponse.ok) throw new Error(`Ollama returned HTTP ${tagsResponse.status}`);
        const tags = await tagsResponse.json();
        models = await Promise.all((tags.models ?? []).slice(0, 100).map(async (model) => {
          let details = {};
          try {
            const response = await fetch(`${config.ollamaBaseUrl}/api/show`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: model.name ?? model.model }),
              signal: AbortSignal.timeout(5000)
            });
            if (response.ok) details = await response.json();
          } catch { /* Tags still provide a useful model list. */ }
          return normalizeOllamaModel(model, details);
        }));
        models = models.filter(Boolean);
      }
      await writeOpenCodeProviderConfig(models);
      return {
        modelSelection: { supported: true, defaultLabel: 'OpenCode provider default', fallbackPolicy: 'explicit-only' },
        connections: [{
          id: config.ollamaConnectionId,
          type: 'ollama',
          displayName: config.ollamaDisplayName,
          location: 'local-host',
          credentialMode: 'none',
          status: 'ready',
          models,
          lastCheckedAt: state.providerLastCheckedAt,
          error: null
        }],
        lastCheckedAt: state.providerLastCheckedAt
      };
    } catch (error) {
      return {
        modelSelection: { supported: true, defaultLabel: 'OpenCode provider default', fallbackPolicy: 'explicit-only' },
        connections: [{
          id: config.ollamaConnectionId,
          type: 'ollama',
          displayName: config.ollamaDisplayName,
          location: 'local-host',
          credentialMode: 'none',
          status: 'unavailable',
          models: [],
          lastCheckedAt: state.providerLastCheckedAt,
          error: clean(error.message).slice(-500)
        }],
        lastCheckedAt: state.providerLastCheckedAt
      };
    }
  }

  async function resolveTaskModel(value) {
    const policy = modelPolicy(value);
    if (policy.mode === 'provider-default') return { policy, model: null };
    if (config.adapterId !== 'opencode') {
      throw Object.assign(new Error(`${adapterManifest.displayName} does not support wrapper-managed model selection yet`), { status: 409 });
    }
    const providers = await providerConnections();
    const available = providers.connections.flatMap((connection) => connection.models ?? []);
    if (!available.some((model) => model.id === policy.primary)) {
      throw Object.assign(new Error(`Pinned model ${policy.primary} is not available`), { status: 409 });
    }
    return { policy, model: policy.primary };
  }

  function normalizedAccountUsage(accountUsage, { includeDaily = false } = {}) {
    if (!accountUsage) return null;
    const summary = accountUsage.summary ?? {};
    return {
      lifetimeTokens: Number(summary.lifetimeTokens ?? 0),
      peakDailyTokens: Number(summary.peakDailyTokens ?? 0),
      longestRunningTaskSeconds: Number(summary.longestRunningTurnSec ?? 0),
      currentStreakDays: Number(summary.currentStreakDays ?? 0),
      longestStreakDays: Number(summary.longestStreakDays ?? 0),
      dailyUsage: includeDaily && Array.isArray(accountUsage.dailyUsageBuckets)
        ? accountUsage.dailyUsageBuckets.map((bucket) => ({ date: bucket.startDate, tokens: Number(bucket.tokens ?? 0) }))
        : undefined
    };
  }

  function usagePollFloorMs() {
    return claudeUsageEnabled
      ? Math.max(config.usagePollIntervalMs, config.claudeUsageIntervalMs)
      : config.usagePollIntervalMs;
  }

  function nextUsageAttemptMs() {
    const lastPoll = state.usage.lastPollAt ? Date.parse(state.usage.lastPollAt) : 0;
    const floorEnds = lastPoll ? lastPoll + usagePollFloorMs() : 0;
    return Math.max(state.usage.retryAfterAt ?? 0, floorEnds);
  }

  function nextUsageAttemptAt() {
    const at = nextUsageAttemptMs();
    return at > Date.now() ? new Date(at).toISOString() : null;
  }

  function nextUsageAttemptReason() {
    if (nextUsageAttemptMs() <= Date.now()) return null;
    return state.usage.retryAfterAt && state.usage.retryAfterAt > Date.now() ? 'provider-backoff' : 'poll-floor';
  }

  function publicUsage({ includeDaily = false, includeHistory = false } = {}) {
    const allHistory = state.usage.history.slice().reverse();
    const history = includeHistory ? allHistory : allHistory.slice(0, 10);
    const supportsAccountUsage = capabilities.usage.accountActivity || capabilities.usage.quotaWindows;
    return {
      updatedAt: state.usage.updatedAt,
      lastPollAt: supportsAccountUsage ? state.usage.lastPollAt : null,
      lastSuccessAt: supportsAccountUsage ? (state.usage.lastSuccessAt ?? null) : null,
      // The earliest the source will actually be read again, whichever reason
      // applies: a provider Retry-After, or our own poll floor. Null when a
      // refresh would go through right now.
      nextAttemptAt: nextUsageAttemptAt(),
      // Which of the two is holding it, so a client can word it honestly.
      nextAttemptReason: nextUsageAttemptReason(),
      pollError: state.usage.pollError,
      pollErrorKind: state.usage.pollErrorKind ?? null,
      quotaWindows: normalizeProviderQuotaWindows(state.usage.rateLimits),
      account: normalizedAccountUsage(state.usage.accountUsage, { includeDaily }),
      totals: state.usage.totals,
      lastRequest: history[0] ?? null,
      history
    };
  }

  async function readClaudeAuthStatus() {
    const result = await capture('claude', ['auth', 'status'], { env: providerEnv, cwd: config.workspace, timeout: 15_000 });
    let status = null;
    try { status = JSON.parse(result.output); }
    catch { /* Older releases may return text despite the documented JSON default. */ }
    const authenticated = result.code === 0 && (status ? Boolean(status.loggedIn ?? status.authenticated ?? status.isAuthenticated) : !/not logged in|logged out|authentication required/i.test(result.output));
    const method = status?.authMethod && status.authMethod !== 'none' ? status.authMethod : 'Claude Code';
    return { authenticated, status, detail: authenticated ? `Authenticated with ${method}` : 'Not authenticated' };
  }

  async function readOpenCodeAuthStatus() {
    const result = await capture('opencode', ['auth', 'list'], { env: providerEnv, cwd: config.workspace, timeout: 15_000 });
    const empty = /(?:0\s+credentials|no\s+(?:stored\s+)?credentials|not\s+authenticated)/i.test(result.output);
    const providerLines = result.output
      .split('\n')
      .map((line) => line.replace(/^[\s│└├─●○◆◇▪•]+/, '').trim())
      .filter((line) => line && !/credentials|authentication|auth\.json|\.local\/share/i.test(line));
    const authenticated = result.code === 0 && !empty && providerLines.length > 0;
    return {
      authenticated,
      providers: authenticated ? providerLines.slice(0, 8) : [],
      detail: authenticated
        ? `${providerLines.length} provider connection${providerLines.length === 1 ? '' : 's'} configured`
        : 'No provider connections configured'
    };
  }

  async function authSessionMetadata() {
    if (config.demoMode) {
      return {
        authMode: config.adapterId === 'claude-code' ? 'claude.ai' : config.adapterId === 'opencode' ? 'provider-connections' : 'chatgpt',
        storage: 'demo',
        credentialStored: true,
        hasRefreshToken: config.adapterId === 'codex-cli' ? true : null,
        canForceRefresh: capabilities.authentication.refresh,
        lastRefreshAt: state.demoAuthLastRefreshAt,
        accessTokenExpiresAt: config.adapterId === 'codex-cli'
          ? new Date(Date.parse(state.demoAuthLastRefreshAt) + 10 * 24 * 60 * 60 * 1000).toISOString()
          : null,
        error: null
      };
    }

    if (config.adapterId === 'claude-code') {
      const login = await readClaudeAuthStatus();
      return {
        authMode: login.status?.authMethod ?? login.status?.authMode ?? 'claude.ai',
        storage: 'cli-managed',
        credentialStored: login.authenticated,
        hasRefreshToken: null,
        canForceRefresh: false,
        lastRefreshAt: null,
        accessTokenExpiresAt: null,
        error: null
      };
    }

    if (config.adapterId === 'opencode') {
      const login = await readOpenCodeAuthStatus();
      return {
        authMode: 'provider-connections',
        storage: 'cli-managed',
        credentialStored: login.authenticated,
        hasRefreshToken: null,
        canForceRefresh: false,
        lastRefreshAt: null,
        accessTokenExpiresAt: null,
        error: null
      };
    }

    try {
      const stored = JSON.parse(await readFile(path.join(config.codexHome, 'auth.json'), 'utf8'));
      const managed = stored.auth_mode === 'chatgpt';
      return {
        authMode: stored.auth_mode ?? null,
        storage: 'file',
        credentialStored: true,
        hasRefreshToken: Boolean(stored.tokens?.refresh_token),
        canForceRefresh: managed && Boolean(stored.tokens?.refresh_token),
        lastRefreshAt: typeof stored.last_refresh === 'string' ? stored.last_refresh : null,
        accessTokenExpiresAt: jwtExpiresAt(stored.tokens?.access_token),
        error: null
      };
    } catch (error) {
      return {
        authMode: null,
        storage: 'file',
        credentialStored: false,
        hasRefreshToken: false,
        canForceRefresh: false,
        lastRefreshAt: null,
        accessTokenExpiresAt: null,
        error: error.code === 'ENOENT' ? null : clean(error.message).slice(-500)
      };
    }
  }

  function queryCodexAccount({ refreshToken = false } = {}) {
    if (config.demoMode) {
      return Promise.resolve({
        account: { account: { type: 'chatgpt', planType: 'demo' }, requiresOpenaiAuth: true },
        rateLimits: {
          rateLimits: {
            limitId: 'codex',
            limitName: 'Demo quota',
            primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: null,
            rateLimitReachedType: null
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null
        },
        accountUsage: {
          summary: { lifetimeTokens: state.usage.totals.totalTokens, peakDailyTokens: state.usage.totals.totalTokens },
          dailyUsageBuckets: null
        },
        accountError: null,
        errors: []
      });
    }

    return new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        cwd: config.workspace,
        env: providerEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdoutBuffer = '';
      let stderr = '';
      let initialized = false;
      let settled = false;
      const responses = { account: null, accountError: null, rateLimits: null, accountUsage: null, errors: [] };
      const waiting = new Set([1, 2, 3]);
      const timeout = setTimeout(() => finish(new Error('Codex usage polling timed out')), 20_000);

      function send(message) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }

      function finish(error = null) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill('SIGTERM');
        if (error) reject(error);
        else resolve(responses);
      }

      function consumeLine(line) {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); }
        catch { return; }
        if (message.id === 0 && !initialized) {
          if (message.error) return finish(new Error(message.error.message || 'Codex app-server initialization failed'));
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ method: 'account/read', id: 1, params: { refreshToken } });
          send({ method: 'account/rateLimits/read', id: 2 });
          send({ method: 'account/usage/read', id: 3 });
          return;
        }
        if (message.id === 1 || message.id === 2 || message.id === 3) {
          waiting.delete(message.id);
          if (message.error) {
            const errorMessage = message.error.message || `Account request ${message.id} failed`;
            responses.errors.push(errorMessage);
            if (message.id === 1) responses.accountError = errorMessage;
          } else if (message.id === 1) responses.account = message.result;
          else if (message.id === 2) responses.rateLimits = message.result;
          else responses.accountUsage = message.result;
          if (!waiting.size) finish();
        }
      }

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        lines.forEach(consumeLine);
      });
      child.stderr.on('data', (chunk) => { stderr = clean(`${stderr}${chunk}`).slice(-4000); });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (!settled) finish(new Error(`Codex app-server exited before returning usage (${code ?? -1}): ${stderr}`));
      });
      send({
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'agent_dock', title: 'Agent Dock', version: '0.1.0' } }
      });
    });
  }

  // Bounded polling against an undocumented endpoint: never more often than the
  // configured interval even when a caller forces a refresh, and never before a
  // 429's Retry-After has elapsed. On any failure the previously observed windows
  // are kept and the failure is classified, so the UI can say why the source is
  // stale instead of showing a confident zero.
  async function pollClaudeUsage() {
    if (state.usage.retryAfterAt && Date.now() < state.usage.retryAfterAt) {
      // Keep the existing classification and deadline visible instead of
      // pretending the attempt happened.
      return;
    }
    // Demo mode must never reach a provider. queryCodexAccount stubs itself the
    // same way; without this a demo worker with an inherited credential would
    // make a real call to an undocumented endpoint.
    if (config.demoMode && !config.claudeUsageFetch) {
      state.usage.rateLimits = {
        limits: [
          { kind: 'session', percent: 18, severity: 'normal', resets_at: new Date(Date.now() + 3_600_000).toISOString() },
          { kind: 'weekly_all', percent: 64, severity: 'normal', resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() }
        ]
      };
      state.usage.pollError = null;
      state.usage.pollErrorKind = null;
      state.usage.lastSuccessAt = new Date().toISOString();
      return;
    }
    try {
      state.usage.rateLimits = await fetchClaudeUsage({
        credentialPaths: claudeCredentialPaths(config.claudeHome, providerEnv.CLAUDE_CONFIG_DIR),
        endpoint: config.claudeUsageEndpoint,
        fetchImpl: config.claudeUsageFetch
      });
      state.usage.pollError = null;
      state.usage.pollErrorKind = null;
      state.usage.retryAfterAt = null;
      state.usage.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      const kind = error instanceof ClaudeUsageError ? error.kind : 'unknown';
      state.usage.pollError = clean(error.message).slice(-1000);
      state.usage.pollErrorKind = kind;
      if (kind === 'throttled') {
        const seconds = error.retryAfterSeconds ?? Math.ceil(config.usagePollIntervalMs / 1000);
        state.usage.retryAfterAt = Date.now() + seconds * 1000;
      } else if (kind === 'unauthenticated') {
        // A revoked credential will not fix itself. Retrying every interval is a
        // doomed request loop against an endpoint whose operators may read
        // repeated failed auth as abuse; back off until something changes.
        state.usage.retryAfterAt = Date.now() + Math.max(config.claudeUsageIntervalMs, 900_000);
      }
    }
  }

  async function refreshAccountUsage({ force = false } = {}) {
    await usageReady;
    if (state.usagePollPromise) return state.usagePollPromise;
    const lastPoll = state.usage.lastPollAt ? Date.parse(state.usage.lastPollAt) : 0;
    // The dashboard polls /v1/status every few seconds per agent, and each
    // authenticated status read asks for a usage refresh, so this floor is what
    // actually determines how hard the provider gets hit.
    const minimumInterval = claudeUsageEnabled
      ? Math.max(config.usagePollIntervalMs, config.claudeUsageIntervalMs)
      : config.usagePollIntervalMs;
    const bounded = !force || claudeUsageEnabled;
    if (bounded && lastPoll && Date.now() - lastPoll < minimumInterval) return publicUsage();

    state.usagePollPromise = (async () => {
      if (config.adapterId === 'codex-cli') {
        try {
          const snapshot = await queryCodexAccount();
          if (snapshot.rateLimits) state.usage.rateLimits = snapshot.rateLimits;
          if (snapshot.accountUsage) state.usage.accountUsage = snapshot.accountUsage;
          state.usage.pollError = snapshot.errors.length ? snapshot.errors.join('; ') : null;
          state.usage.pollErrorKind = snapshot.errors.length ? 'provider' : null;
        } catch (error) {
          state.usage.pollError = clean(error.message).slice(-1000);
          state.usage.pollErrorKind = 'provider';
        }
      } else if (claudeUsageEnabled) {
        await pollClaudeUsage();
      } else {
        return publicUsage();
      }
      state.usage.lastPollAt = new Date().toISOString();
      await persistUsage().catch((error) => { state.usage.pollError = `Could not persist usage: ${error.message}`; });
      return publicUsage();
    })();

    try { return await state.usagePollPromise; }
    finally { state.usagePollPromise = null; }
  }

  async function forceAuthenticationRefresh() {
    if (!capabilities.authentication.refresh) {
      throw Object.assign(new Error(`${adapterManifest.displayName} does not expose an explicit session-refresh operation`), { status: 409 });
    }
    if (state.authRefreshPromise) return state.authRefreshPromise;
    state.authRefreshPromise = (async () => {
      if (state.usagePollPromise) await state.usagePollPromise;
      const before = await authSessionMetadata();
      if (config.demoMode) state.demoAuthLastRefreshAt = new Date().toISOString();
      const snapshot = await queryCodexAccount({ refreshToken: true });
      if (snapshot.accountError || !snapshot.account?.account) {
        throw new Error(snapshot.accountError || 'Codex did not return an authenticated account after refresh');
      }
      if (snapshot.rateLimits) state.usage.rateLimits = snapshot.rateLimits;
      if (snapshot.accountUsage) state.usage.accountUsage = snapshot.accountUsage;
      state.usage.lastPollAt = new Date().toISOString();
      state.usage.pollError = snapshot.errors.length ? snapshot.errors.join('; ') : null;
      await persistUsage().catch((error) => { state.usage.pollError = `Could not persist usage: ${error.message}`; });
      const after = await authSessionMetadata();
      return {
        ok: true,
        refreshed: before.lastRefreshAt !== after.lastRefreshAt,
        session: after,
        usage: publicUsage()
      };
    })();

    try { return await state.authRefreshPromise; }
    finally { state.authRefreshPromise = null; }
  }

  function observeUsage(job, event) {
    if (event?.type === 'usage.observed' && event.data?.request) job.tokenUsage = normalizeTokenUsage(event.data.request);
  }

  async function finalizeJobUsage(job) {
    await usageReady;
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(job.startedAt));
    const tokens = job.tokenUsage ?? normalizeTokenUsage();
    const record = {
      id: job.id,
      model: job.model ?? null,
      startedAt: job.startedAt,
      finishedAt,
      durationMs,
      status: job.status,
      ...tokens
    };
    state.usage.history.push(record);
    state.usage.history = state.usage.history.slice(-200);
    state.usage.totals.requests += 1;
    state.usage.totals.inputTokens += tokens.inputTokens;
    state.usage.totals.cachedInputTokens += tokens.cachedInputTokens;
    state.usage.totals.outputTokens += tokens.outputTokens;
    state.usage.totals.totalTokens += tokens.totalTokens;
    state.usage.totals.durationMs += durationMs;
    state.usage.updatedAt = finishedAt;
    await persistUsage().catch((error) => { state.usage.pollError = `Could not persist usage: ${error.message}`; });
    return refreshAccountUsage({ force: true });
  }

  async function authStatus() {
    if (config.demoMode) return { authenticated: true, detail: 'Demo mode' };
    const result = config.adapterId === 'claude-code'
      ? await readClaudeAuthStatus()
      : config.adapterId === 'opencode'
        ? await readOpenCodeAuthStatus()
        : await capture('codex', ['login', 'status'], { env: providerEnv, cwd: config.workspace });
    const authenticated = config.adapterId === 'codex-cli'
      ? result.code === 0 && !/not logged in/i.test(result.output)
      : result.authenticated;
    if (authenticated) state.auth.phase = 'authenticated';
    else if (!state.loginProcess && state.auth.phase !== 'failed') state.auth.phase = 'needs_auth';
    return { authenticated, detail: result.detail ?? result.output ?? 'No login status returned' };
  }

  function publicAuthentication({ login = null, session = null } = {}) {
    const authenticated = login?.authenticated ?? state.auth.phase === 'authenticated';
    return {
      authenticated,
      phase: state.auth.phase,
      method: config.adapterId === 'claude-code' ? 'browser_oauth' : config.adapterId === 'opencode' ? 'provider_device_code' : 'device_code',
      detail: login?.detail ?? null,
      refreshing: Boolean(state.authRefreshPromise),
      session,
      challenge: {
        verificationUri: authenticated ? null : state.auth.verificationUrl,
        userCode: authenticated ? null : state.auth.userCode,
        requiresInput: !authenticated && config.adapterId === 'claude-code' && state.auth.phase === 'waiting_for_user',
        instructions: authenticated ? '' : state.auth.transcript.slice(-6000)
      }
    };
  }

  function startLogin() {
    if (config.demoMode) return publicAuthentication();
    if (state.loginProcess) return publicAuthentication();
    state.auth = { phase: 'waiting_for_user', transcript: '', verificationUrl: null, userCode: null };
    const openCodeGitHub = config.adapterId === 'opencode' && config.opencodeAuthProvider === 'github-copilot';
    const command = config.adapterId === 'claude-code'
      ? 'claude'
      : config.adapterId === 'opencode' ? (openCodeGitHub ? 'script' : 'opencode') : 'codex';
    const args = config.adapterId === 'claude-code'
      ? ['auth', 'login']
      : config.adapterId === 'opencode'
        ? openCodeGitHub
          ? ['-qefc', 'opencode auth login --provider github-copilot', '/dev/null']
          : ['auth', 'login', '--provider', config.opencodeAuthProvider]
        : ['login', '--device-auth'];
    const child = spawn(command, args, {
      cwd: config.workspace,
      env: providerEnv,
      stdio: [['claude-code', 'opencode'].includes(config.adapterId) ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    state.loginProcess = child;
    let openCodePromptStarted = false;
    let openCodeDeploymentSelected = false;
    const consume = (chunk) => {
      const cleanedChunk = clean(chunk.toString('utf8'));
      const repetitiveOpenCodeSpinner = config.adapterId === 'opencode'
        && state.auth.verificationUrl
        && /Waiting for authorization/i.test(cleanedChunk)
        && !/https:\/\//i.test(cleanedChunk);
      if (!repetitiveOpenCodeSpinner) {
        state.auth.transcript = `${state.auth.transcript}${cleanedChunk}`.slice(-12_000);
      }
      const challenge = parseLoginTranscript(state.auth.transcript);
      if (challenge.verificationUrl) state.auth.verificationUrl = challenge.verificationUrl;
      if (challenge.userCode) state.auth.userCode = challenge.userCode;
      if (
        config.adapterId === 'opencode'
        && config.opencodeAuthProvider === 'github-copilot'
        && !openCodePromptStarted
        && /Add credential/i.test(state.auth.transcript)
      ) {
        openCodePromptStarted = true;
        setTimeout(() => {
          if (!child.killed && child.stdin.writable) child.stdin.write('\r');
        }, 300);
      }
      if (
        config.adapterId === 'opencode'
        && config.opencodeAuthProvider === 'github-copilot'
        && !openCodeDeploymentSelected
        && /GitHub Enterprise/i.test(state.auth.transcript)
      ) {
        openCodeDeploymentSelected = true;
        setTimeout(() => {
          if (!child.killed && child.stdin.writable) child.stdin.write('\r');
        }, 700);
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => {
      consume(`\n${error.message}`);
      state.auth.phase = 'failed';
      state.auth.verificationUrl = null;
      state.auth.userCode = null;
      state.loginProcess = null;
    });
    child.once('close', (code) => {
      state.auth.phase = code === 0 ? 'authenticated' : 'failed';
      state.auth.verificationUrl = null;
      state.auth.userCode = null;
      if (code === 0) state.auth.transcript = '';
      state.loginProcess = null;
    });
    return publicAuthentication();
  }

  function completeLogin(code) {
    if (config.adapterId !== 'claude-code') {
      throw Object.assign(new Error(`${adapterManifest.displayName} does not require a browser authorization code`), { status: 409 });
    }
    if (!state.loginProcess || state.auth.phase !== 'waiting_for_user') {
      throw Object.assign(new Error('Start Claude Code login before submitting an authorization code'), { status: 409 });
    }
    if (typeof code !== 'string' || !code.trim() || code.length > 8192 || /[\r\n]/.test(code)) {
      throw Object.assign(new Error('code must be a single non-empty line'), { status: 400 });
    }
    state.loginProcess.stdin.end(`${code.trim()}\n`);
    return publicAuthentication();
  }

  function emitCanonical(res, type, { taskId = null, data = {} } = {}) {
    res.write(`${JSON.stringify(wrapperEvent(type, { taskId, data }))}\n`);
  }

  function emitProviderEvent(res, event, job) {
    mcpManager.observe(event).catch(() => {});
    const normalized = normalizeProviderEvent(event);
    if (!normalized) return;
    observeUsage(job, normalized);
    emitCanonical(res, normalized.type, { taskId: job.id, data: normalized.data });
  }

  async function runDemo(res, job, prompt) {
    emitCanonical(res, 'task.started', { taskId: job.id, data: { executionMode: 'demo', model: job.model ?? 'provider-default' } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    emitCanonical(res, 'message.completed', { taskId: job.id, data: { role: 'assistant', text: `Demo worker received: ${prompt}` } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    job.tokenUsage = normalizeTokenUsage({ input_tokens: 12, cached_input_tokens: 3, output_tokens: 8 });
    emitCanonical(res, 'usage.observed', { taskId: job.id, data: { request: job.tokenUsage } });
    job.status = 'succeeded';
    job.exitCode = 0;
  }

  async function runCodex(res, job, prompt, instructions) {
    const fullPrompt = instructions
      ? `Agent profile instructions:\n${instructions}\n\nTask:\n${prompt}`
      : prompt;
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', config.workspace];
    if (config.allowUnsandboxed) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write');
    args.push('-');

    const child = spawn('codex', args, {
      cwd: config.workspace,
      env: providerEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    job.child = child;
    emitCanonical(res, 'task.started', {
      taskId: job.id,
      data: { executionMode: config.allowUnsandboxed ? 'container' : 'provider-sandbox' }
    });
    child.stdin.end(fullPrompt);

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitProviderEvent(res, JSON.parse(line), job);
        } catch {
          emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: line } });
        }
      }
    });
    child.stderr.on('data', (chunk) => emitCanonical(res, 'log', {
      taskId: job.id,
      data: { level: 'warning', source: 'provider', message: clean(chunk.toString('utf8')) }
    }));
    const code = await new Promise((resolve) => {
      child.once('error', (error) => {
        emitCanonical(res, 'error', { taskId: job.id, data: { source: 'wrapper', message: error.message } });
        resolve(-1);
      });
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });
    if (stdoutBuffer.trim()) {
      try { emitProviderEvent(res, JSON.parse(stdoutBuffer), job); }
      catch { emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: stdoutBuffer } }); }
    }
    job.status = code === 0 ? 'succeeded' : job.cancelled ? 'cancelled' : 'failed';
    job.exitCode = code;
  }

  async function runClaude(res, job, prompt, instructions) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const mcpContext = await mcpManager.taskContext(providerEnv);
    args.push(...mcpContext.args);
    if (instructions) args.push('--append-system-prompt', instructions);
    if (config.allowUnsandboxed) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'dontAsk');

    const child = spawn('claude', args, {
      cwd: config.workspace,
      env: mcpContext.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    job.child = child;
    emitCanonical(res, 'task.started', {
      taskId: job.id,
      data: { executionMode: config.allowUnsandboxed ? 'container' : 'provider-permissions' }
    });
    child.stdin.end(prompt);

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { emitProviderEvent(res, JSON.parse(line), job); }
        catch { emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: line } }); }
      }
    });
    child.stderr.on('data', (chunk) => emitCanonical(res, 'log', {
      taskId: job.id,
      data: { level: 'warning', source: 'provider', message: clean(chunk.toString('utf8')) }
    }));
    const code = await new Promise((resolve) => {
      child.once('error', (error) => {
        emitCanonical(res, 'error', { taskId: job.id, data: { source: 'wrapper', message: error.message } });
        resolve(-1);
      });
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });
    if (stdoutBuffer.trim()) {
      try { emitProviderEvent(res, JSON.parse(stdoutBuffer), job); }
      catch { emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: stdoutBuffer } }); }
    }
    job.status = code === 0 ? 'succeeded' : job.cancelled ? 'cancelled' : 'failed';
    job.exitCode = code;
  }

  async function runOpenCode(res, job, prompt, instructions) {
    const fullPrompt = instructions
      ? `Agent profile instructions:\n${instructions}\n\nTask:\n${prompt}`
      : prompt;
    const args = ['run', '--format', 'json', '--dir', config.workspace];
    const mcpContext = await mcpManager.taskContext(providerEnv);
    if (job.model) args.push('--model', job.model);
    if (config.allowUnsandboxed) args.push('--auto');
    args.push(fullPrompt);

    const child = spawn('opencode', args, {
      cwd: config.workspace,
      env: mcpContext.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    job.child = child;
    emitCanonical(res, 'task.started', {
      taskId: job.id,
      data: { executionMode: config.allowUnsandboxed ? 'container' : 'provider-permissions', model: job.model ?? 'provider-default' }
    });

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { emitProviderEvent(res, JSON.parse(line), job); }
        catch { emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: line } }); }
      }
    });
    child.stderr.on('data', (chunk) => emitCanonical(res, 'log', {
      taskId: job.id,
      data: { level: 'warning', source: 'provider', message: clean(chunk.toString('utf8')) }
    }));
    const code = await new Promise((resolve) => {
      child.once('error', (error) => {
        emitCanonical(res, 'error', { taskId: job.id, data: { source: 'wrapper', message: error.message } });
        resolve(-1);
      });
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });
    if (stdoutBuffer.trim()) {
      try { emitProviderEvent(res, JSON.parse(stdoutBuffer), job); }
      catch { emitCanonical(res, 'log', { taskId: job.id, data: { level: 'info', source: 'provider', message: stdoutBuffer } }); }
    }
    job.status = code === 0 ? 'succeeded' : job.cancelled ? 'cancelled' : 'failed';
    job.exitCode = code;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker.local');
      const route = canonicalRoute(url.pathname);
      if (req.method === 'GET' && route === '/v1/health') {
        return json(res, 200, wrapperResponse({
          ok: true,
          service: 'agent-wrapper',
          adapter: { id: adapterManifest.id, provider: adapterManifest.provider }
        }));
      }
      if (!authorized(req, config.token)) return json(res, 401, wrapperResponse({ error: 'Unauthorized' }));

      if (req.method === 'GET' && route === '/v1/providers') {
        return json(res, 200, wrapperResponse(await providerConnections()));
      }

      if (req.method === 'GET' && route === '/v1/mcp') {
        return json(res, 200, wrapperResponse({ mcp: await mcpManager.inspect({ probe: url.searchParams.get('probe') === '1' }) }));
      }

      if (req.method === 'POST' && route === '/v1/mcp/validate') {
        const body = await readJson(req);
        const servers = Array.isArray(body.servers) ? body.servers : null;
        const validation = mcpManager.validate(servers ?? body.servers);
        return json(res, validation.valid ? 200 : 400, wrapperResponse({ mcp: { servers: servers ?? [], validation } }));
      }

      if (req.method === 'PUT' && route === '/v1/mcp') {
        if (state.activeJob) return json(res, 409, wrapperResponse({ error: 'Wait for the active task to finish before changing MCP configuration' }));
        const body = await readJson(req);
        if (!Array.isArray(body.servers)) return json(res, 400, wrapperResponse({ error: 'servers must be an array' }));
        return json(res, 200, wrapperResponse({ mcp: await mcpManager.apply(body.servers, body.credentials) }));
      }

      if (req.method === 'GET' && route === '/v1/status') {
        await usageReady;
        const [login, version] = await Promise.all([
          authStatus(),
          config.demoMode
            ? Promise.resolve({ output: `${adapterManifest.id} demo` })
            : capture(config.adapterId === 'claude-code' ? 'claude' : config.adapterId === 'opencode' ? 'opencode' : 'codex', ['--version'], { env: providerEnv })
        ]);
        if (login.authenticated && !state.activeJob) await refreshAccountUsage();
        const session = await authSessionMetadata();
        return json(res, 200, wrapperResponse({
          service: 'agent-wrapper',
          agent: {
            id: config.agentId,
            adapter: {
              id: adapterManifest.id,
              provider: adapterManifest.provider,
              displayName: adapterManifest.displayName
            },
            version: version.output,
            startedAt: state.startedAt
          },
          capabilities,
          authentication: publicAuthentication({ login, session }),
          task: {
            active: state.activeJob
              ? { id: state.activeJob.id, status: state.activeJob.status, startedAt: state.activeJob.startedAt, model: state.activeJob.model ?? null }
              : null
          },
          execution: {
            boundary: config.allowUnsandboxed ? 'container' : 'provider-workspace-sandbox',
            workspace: config.workspace
          },
          usage: publicUsage()
        }));
      }

      if (req.method === 'POST' && route === '/v1/auth/login') {
        startLogin();
        await new Promise((resolve) => setTimeout(resolve, 350));
        return json(res, 202, wrapperResponse({ authentication: publicAuthentication() }));
      }

      if (req.method === 'POST' && route === '/v1/auth/complete') {
        const body = await readJson(req, 16 * 1024);
        return json(res, 202, wrapperResponse({ authentication: completeLogin(body.code) }));
      }

      if (req.method === 'POST' && route === '/v1/auth/refresh') {
        if (state.activeJob) return json(res, 409, wrapperResponse({ error: 'Wait for the active task to finish before refreshing authentication' }));
        if (state.loginProcess) return json(res, 409, wrapperResponse({ error: 'Finish the current device login before refreshing authentication' }));
        const login = await authStatus();
        if (!login.authenticated) return json(res, 409, wrapperResponse({ error: 'Authenticate this agent before refreshing its session' }));
        try {
          const refreshed = await forceAuthenticationRefresh();
          return json(res, 200, wrapperResponse({
            authentication: {
              ...publicAuthentication({ login, session: refreshed.session }),
              refreshed: refreshed.refreshed
            },
            usage: refreshed.usage
          }));
        } catch (error) {
          error.status ??= 502;
          throw error;
        }
      }

      if (req.method === 'GET' && route === '/v1/workspace') {
        return json(res, 200, wrapperResponse({
          workspace: { root: config.workspace, ...await listWorkspace(config.workspace) }
        }));
      }

      if (req.method === 'GET' && route === '/v1/usage') {
        await usageReady;
        return json(res, 200, wrapperResponse({ usage: publicUsage({ includeDaily: true, includeHistory: true }) }));
      }

      if (req.method === 'POST' && route === '/v1/usage/refresh') {
        const login = await authStatus();
        if (!login.authenticated) return json(res, 409, wrapperResponse({ error: 'Authenticate this agent before refreshing account usage' }));
        return json(res, 200, wrapperResponse({ usage: await refreshAccountUsage({ force: true }) }));
      }

      if (req.method === 'POST' && route === '/v1/tasks') {
        if (state.activeJob) return json(res, 409, wrapperResponse({ error: 'This agent is already running a task' }));
        const body = await readJson(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
        if (!prompt) return json(res, 400, wrapperResponse({ error: 'prompt is required' }));
        if (prompt.length > 100_000 || instructions.length > 50_000) return json(res, 413, wrapperResponse({ error: 'Prompt or instructions are too large' }));
        const resolvedModel = await resolveTaskModel(body.modelPolicy);
        const login = await authStatus();
        const localCredentiallessModel = resolvedModel.model?.startsWith('ollama/');
        if (!login.authenticated && !localCredentiallessModel) return json(res, 409, wrapperResponse({
          error: 'Authenticate this agent before running a task',
          authentication: publicAuthentication({ login })
        }));

        const job = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), child: null, cancelled: false, tokenUsage: null, exitCode: null, model: resolvedModel.model };
        state.activeJob = job;
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        try {
          if (config.demoMode) await runDemo(res, job, prompt);
          else if (config.adapterId === 'claude-code') await runClaude(res, job, prompt, instructions);
          else if (config.adapterId === 'opencode') await runOpenCode(res, job, prompt, instructions);
          else await runCodex(res, job, prompt, instructions);
          const usage = await finalizeJobUsage(job);
          emitCanonical(res, 'usage.updated', { taskId: job.id, data: { usage } });
          emitCanonical(res, 'task.completed', { taskId: job.id, data: { status: job.status, exitCode: job.exitCode } });
        } catch (error) {
          job.status = job.cancelled ? 'cancelled' : 'failed';
          emitCanonical(res, 'error', { taskId: job.id, data: { source: 'wrapper', message: error.message } });
          const usage = await finalizeJobUsage(job);
          emitCanonical(res, 'usage.updated', { taskId: job.id, data: { usage } });
          emitCanonical(res, 'task.completed', { taskId: job.id, data: { status: job.status, exitCode: job.exitCode ?? -1 } });
        } finally {
          state.activeJob = null;
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && route === '/v1/tasks/cancel') {
        if (!state.activeJob) return json(res, 404, wrapperResponse({ error: 'No active task' }));
        state.activeJob.cancelled = true;
        state.activeJob.child?.kill('SIGTERM');
        return json(res, 202, wrapperResponse({ task: { id: state.activeJob.id, status: 'cancelling' } }));
      }

      return json(res, 404, wrapperResponse({ error: 'Not found' }));
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, wrapperResponse({ error: error.message }));
      else res.end(`${JSON.stringify(wrapperEvent('error', { data: { source: 'wrapper', message: error.message } }))}\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createWorkerServer();
  const port = Number(process.env.PORT ?? 7777);
  server.listen(port, '0.0.0.0', () => console.log(`[worker] listening on :${port}`));
}
