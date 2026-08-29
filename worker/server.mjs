import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { codexAdapterManifest, normalizeCodexEvent } from './adapters/codex.mjs';
import { claudeAdapterManifest, normalizeClaudeEvent } from './adapters/claude.mjs';
import { normalizeTokenUsage, wrapperEvent, wrapperResponse } from './protocol.mjs';

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

function initialUsage() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    lastPollAt: null,
    pollError: null,
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
      if (child.name === '.git') continue;
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
  if (!['codex-cli', 'claude-code'].includes(adapterId)) throw new Error(`Unsupported AGENT_ADAPTER: ${adapterId}`);
  const adapterManifest = adapterId === 'claude-code' ? claudeAdapterManifest : codexAdapterManifest;
  const normalizeProviderEvent = adapterId === 'claude-code' ? normalizeClaudeEvent : normalizeCodexEvent;
  const config = {
    token: options.token ?? process.env.WORKER_TOKEN ?? '',
    port: Number(options.port ?? process.env.PORT ?? 7777),
    agentId: options.agentId ?? process.env.AGENT_ID ?? 'worker-01',
    adapterId,
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? '/codex-home',
    claudeHome: options.claudeHome ?? process.env.CLAUDE_HOME ?? process.env.HOME ?? '/claude-home',
    workspace: options.workspace ?? process.env.WORKSPACE_PATH ?? '/workspace',
    allowUnsandboxed: options.allowUnsandboxed ?? process.env.ALLOW_UNSANDBOXED === '1',
    demoMode,
    dataPath: options.dataPath === null ? null : (options.dataPath ?? process.env.AGENT_DATA_PATH ?? (demoMode ? null : '/agent-data/usage.json')),
    usagePollIntervalMs: Number(options.usagePollIntervalMs ?? process.env.USAGE_POLL_INTERVAL_MS ?? 60_000)
  };
  if (!config.token) throw new Error('WORKER_TOKEN is required');

  const state = {
    startedAt: new Date().toISOString(),
    auth: { phase: config.demoMode ? 'authenticated' : 'unknown', transcript: '', verificationUrl: null, userCode: null },
    loginProcess: null,
    activeJob: null,
    usage: initialUsage(),
    usagePollPromise: null,
    authRefreshPromise: null,
    demoAuthLastRefreshAt: new Date().toISOString()
  };

  const providerEnv = config.adapterId === 'claude-code'
    ? { ...process.env, HOME: config.claudeHome, CLAUDE_CONFIG_DIR: path.join(config.claudeHome, '.claude'), BROWSER: process.env.BROWSER ?? 'echo' }
    : { ...process.env, CODEX_HOME: config.codexHome };

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
  }

  async function persistUsage() {
    if (!config.dataPath) return;
    await mkdir(path.dirname(config.dataPath), { recursive: true });
    const temporary = `${config.dataPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state.usage, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, config.dataPath);
  }

  const usageReady = loadUsage();

  function normalizedQuotaWindows(envelope) {
    const bucketMap = envelope?.rateLimitsByLimitId;
    const buckets = bucketMap && Object.keys(bucketMap).length
      ? Object.values(bucketMap)
      : envelope?.rateLimits ? [envelope.rateLimits] : [];
    const windows = [];
    for (const bucket of buckets) {
      const baseLabel = bucket.limitName || bucket.limitId || 'Provider quota';
      for (const scope of ['primary', 'secondary']) {
        const window = bucket[scope];
        if (!window) continue;
        windows.push({
          id: `${bucket.limitId || 'quota'}:${scope}`,
          label: scope === 'primary' ? baseLabel : `${baseLabel} · secondary`,
          scope,
          usedPercent: Number(window.usedPercent ?? 0),
          windowDurationMinutes: Number(window.windowDurationMins ?? 0) || null,
          resetsAt: Number(window.resetsAt ?? 0) || null,
          reached: bucket.rateLimitReachedType === scope
        });
      }
    }
    return windows;
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

  function publicUsage({ includeDaily = false, includeHistory = false } = {}) {
    const allHistory = state.usage.history.slice().reverse();
    const history = includeHistory ? allHistory : allHistory.slice(0, 10);
    return {
      updatedAt: state.usage.updatedAt,
      lastPollAt: state.usage.lastPollAt,
      pollError: state.usage.pollError,
      quotaWindows: normalizedQuotaWindows(state.usage.rateLimits),
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
    return { authenticated, status, detail: result.output || 'No authentication status returned' };
  }

  async function authSessionMetadata() {
    if (config.demoMode) {
      return {
        authMode: config.adapterId === 'claude-code' ? 'claude.ai' : 'chatgpt',
        storage: 'demo',
        credentialStored: true,
        hasRefreshToken: config.adapterId === 'codex-cli',
        canForceRefresh: adapterManifest.capabilities.authentication.refresh,
        lastRefreshAt: state.demoAuthLastRefreshAt,
        accessTokenExpiresAt: new Date(Date.parse(state.demoAuthLastRefreshAt) + 10 * 24 * 60 * 60 * 1000).toISOString(),
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

  async function refreshAccountUsage({ force = false } = {}) {
    await usageReady;
    if (state.usagePollPromise) return state.usagePollPromise;
    const lastPoll = state.usage.lastPollAt ? Date.parse(state.usage.lastPollAt) : 0;
    if (!force && lastPoll && Date.now() - lastPoll < config.usagePollIntervalMs) return publicUsage();

    state.usagePollPromise = (async () => {
      if (config.adapterId === 'claude-code') {
        state.usage.lastPollAt = new Date().toISOString();
        state.usage.pollError = null;
        await persistUsage().catch((error) => { state.usage.pollError = `Could not persist usage: ${error.message}`; });
        return publicUsage();
      }
      try {
        const snapshot = await queryCodexAccount();
        if (snapshot.rateLimits) state.usage.rateLimits = snapshot.rateLimits;
        if (snapshot.accountUsage) state.usage.accountUsage = snapshot.accountUsage;
        state.usage.pollError = snapshot.errors.length ? snapshot.errors.join('; ') : null;
      } catch (error) {
        state.usage.pollError = clean(error.message).slice(-1000);
      }
      state.usage.lastPollAt = new Date().toISOString();
      await persistUsage().catch((error) => { state.usage.pollError = `Could not persist usage: ${error.message}`; });
      return publicUsage();
    })();

    try { return await state.usagePollPromise; }
    finally { state.usagePollPromise = null; }
  }

  async function forceAuthenticationRefresh() {
    if (!adapterManifest.capabilities.authentication.refresh) {
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
      : await capture('codex', ['login', 'status'], { env: providerEnv, cwd: config.workspace });
    const authenticated = config.adapterId === 'claude-code'
      ? result.authenticated
      : result.code === 0 && !/not logged in/i.test(result.output);
    if (authenticated) state.auth.phase = 'authenticated';
    else if (!state.loginProcess && state.auth.phase !== 'failed') state.auth.phase = 'needs_auth';
    return { authenticated, detail: result.detail ?? result.output ?? 'No login status returned' };
  }

  function publicAuthentication({ login = null, session = null } = {}) {
    return {
      authenticated: login?.authenticated ?? state.auth.phase === 'authenticated',
      phase: state.auth.phase,
      method: config.adapterId === 'claude-code' ? 'browser_oauth' : 'device_code',
      detail: login?.detail ?? null,
      refreshing: Boolean(state.authRefreshPromise),
      session,
      challenge: {
        verificationUri: state.auth.verificationUrl,
        userCode: state.auth.userCode,
        requiresInput: config.adapterId === 'claude-code' && state.auth.phase === 'waiting_for_user',
        instructions: state.auth.transcript.slice(-6000)
      }
    };
  }

  function startLogin() {
    if (config.demoMode) return publicAuthentication();
    if (state.loginProcess) return publicAuthentication();
    state.auth = { phase: 'waiting_for_user', transcript: '', verificationUrl: null, userCode: null };
    const command = config.adapterId === 'claude-code' ? 'claude' : 'codex';
    const args = config.adapterId === 'claude-code' ? ['auth', 'login'] : ['login', '--device-auth'];
    const child = spawn(command, args, {
      cwd: config.workspace,
      env: providerEnv,
      stdio: [config.adapterId === 'claude-code' ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    state.loginProcess = child;
    const consume = (chunk) => {
      state.auth.transcript = clean(`${state.auth.transcript}${chunk}`).slice(-12_000);
      Object.assign(state.auth, parseLoginTranscript(state.auth.transcript));
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
      if (code !== 0) {
        state.auth.verificationUrl = null;
        state.auth.userCode = null;
      }
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
    const normalized = normalizeProviderEvent(event);
    if (!normalized) return;
    observeUsage(job, normalized);
    emitCanonical(res, normalized.type, { taskId: job.id, data: normalized.data });
  }

  async function runDemo(res, job, prompt) {
    emitCanonical(res, 'task.started', { taskId: job.id, data: { executionMode: 'demo' } });
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
    if (instructions) args.push('--append-system-prompt', instructions);
    if (config.allowUnsandboxed) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'dontAsk');

    const child = spawn('claude', args, {
      cwd: config.workspace,
      env: providerEnv,
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

      if (req.method === 'GET' && route === '/v1/status') {
        await usageReady;
        const [login, version] = await Promise.all([
          authStatus(),
          config.demoMode
            ? Promise.resolve({ output: `${adapterManifest.id} demo` })
            : capture(config.adapterId === 'claude-code' ? 'claude' : 'codex', ['--version'], { env: providerEnv })
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
          capabilities: adapterManifest.capabilities,
          authentication: publicAuthentication({ login, session }),
          task: {
            active: state.activeJob
              ? { id: state.activeJob.id, status: state.activeJob.status, startedAt: state.activeJob.startedAt }
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
        const login = await authStatus();
        if (!login.authenticated) return json(res, 409, wrapperResponse({
          error: 'Authenticate this agent before running a task',
          authentication: publicAuthentication({ login })
        }));

        const job = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), child: null, cancelled: false, tokenUsage: null, exitCode: null };
        state.activeJob = job;
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        try {
          if (config.demoMode) await runDemo(res, job, prompt);
          else if (config.adapterId === 'claude-code') await runClaude(res, job, prompt, instructions);
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
