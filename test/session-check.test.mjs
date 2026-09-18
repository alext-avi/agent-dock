// Manual, vendor-neutral session check/renew (issue #50). These tests exercise
// the real worker and control plane — no Docker, no network, no real provider
// credentials — following the pattern in test/claude-usage.test.mjs for faking
// the `claude` CLI process.

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import { claudeAdapterManifest } from '../worker/adapters/claude.mjs';
import { codexAdapterManifest } from '../worker/adapters/codex.mjs';
import { opencodeAdapterManifest } from '../worker/adapters/opencode.mjs';

const ACCESS_TOKEN = 'sk-ant-oat-session-check-do-not-disclose';
const REFRESH_TOKEN = 'sk-ant-ort-session-check-do-not-disclose';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function claudeHomeWithCredential(t, credential) {
  const home = await mkdtemp(join(tmpdir(), 'agent-dock-session-check-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  if (credential !== null) {
    await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify(credential));
  }
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

// A controllable fake `claude` process. Each scenario supplies `onSessionCheck`
// to decide what the fake `-p` invocation returns; `--version` and `auth
// status` answer with fixed, uninteresting values so they never block a check.
function fakeClaudeSpawn({ onSessionCheck, holdLogin = false } = {}) {
  const calls = [];
  let announceSpawned;
  const spawned = new Promise((resolve) => { announceSpawned = resolve; });
  let releaseHang = null;

  function makeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setImmediate(() => child.emit('close', 143));
    };
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
    });
    child.stdinText = () => Buffer.concat(chunks).toString('utf8');
    return child;
  }

  return {
    calls,
    spawned,
    releaseHang: () => releaseHang?.(),
    spawn(command, args, options) {
      const child = makeChild();
      calls.push({ command, args: [...args], options, child });
      if (command !== 'claude') {
        setImmediate(() => child.emit('error', new Error(`Unexpected command: ${command}`)));
        return child;
      }
      if (args.length === 1 && args[0] === '--version') {
        setImmediate(() => { child.stdout.write('Claude Code test-version'); child.emit('close', 0); });
        return child;
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'oauth' }));
          child.emit('close', 0);
        });
        return child;
      }
      if (args[0] === 'auth' && args[1] === 'login' && holdLogin) {
        return child;
      }
      if (args[0] === '-p') {
        announceSpawned({ args, child });
        // Invoked for both a real task's `-p` call and a session check's: both
        // begin with `-p`, and the fake stays simple by not distinguishing them.
        // May return a promise, so a scenario can await a side effect (such as
        // rotating the credential file) before the process "exits".
        const pending = onSessionCheck ? onSessionCheck(args, child) : { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) };
        Promise.resolve(pending).then((outcome) => {
          if (outcome?.hang) {
            releaseHang = () => setImmediate(() => child.emit('close', outcome.code ?? 0));
            return;
          }
          setImmediate(() => {
            if (outcome.stdout) child.stdout.write(outcome.stdout);
            if (outcome.stderr) child.stderr.write(outcome.stderr);
            child.emit('close', outcome.code ?? 0);
          });
        });
        return child;
      }
      setImmediate(() => child.emit('error', new Error(`Unexpected Claude arguments: ${args.join(' ')}`)));
      return child;
    }
  };
}

function successResult(text = 'ok') {
  return { type: 'result', subtype: 'success', is_error: false, result: text };
}

async function sessionCheck(workerUrl, token) {
  const response = await fetch(`${workerUrl}/v1/auth/session-check`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}'
  });
  return { status: response.status, body: await response.json() };
}

test('capabilities advertise sessionCheck support and mayConsumeUsage per adapter', () => {
  assert.deepEqual(claudeAdapterManifest.capabilities.authentication.sessionCheck, { supported: true, mayConsumeUsage: true });
  assert.deepEqual(codexAdapterManifest.capabilities.authentication.sessionCheck, { supported: false, mayConsumeUsage: false });
  assert.deepEqual(opencodeAdapterManifest.capabilities.authentication.sessionCheck, { supported: false, mayConsumeUsage: false });
});

test('a Claude session check runs the exact fixed, minimal, safe argument vector', async (t) => {
  const token = 'session-check-args';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ code: 0, stdout: JSON.stringify(successResult()) }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.apiVersion, 'agent-wrapper/v1');
  assert.equal(body.sessionCheck.result, 'current');

  const call = fake.calls.find((c) => c.args[0] === '-p');
  assert.deepEqual(call.args, [
    '-p',
    '--output-format', 'json',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--disable-slash-commands'
  ]);
  assert.ok(!call.args.includes('--bare'), '--bare bypasses the OAuth/keychain credential path this operation exercises');
  assert.ok(!call.args.includes('--append-system-prompt'), 'no durable agent instructions may be injected');
  assert.ok(!call.args.includes('--mcp-config'), 'no MCP servers may be loaded');
  assert.ok(!call.args.includes('--resume') && !call.args.includes('--session-id'), 'no existing conversation may be loaded or resumed');
  assert.equal(call.child.stdinText(), 'Reply with the single word "ok" and nothing else.');
});

test('a successful check reports renewed only when the credential file actually rotated', async (t) => {
  // Unchanged credential file: current, not renewed.
  const unchangedToken = 'session-check-current';
  const unchangedHome = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const unchangedFake = fakeClaudeSpawn({ onSessionCheck: () => ({ code: 0, stdout: JSON.stringify(successResult()) }) });
  const unchangedWorker = createWorkerServer({
    token: unchangedToken, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(unchangedHome, 'mcp'), claudeHome: unchangedHome, spawn: unchangedFake.spawn
  });
  const unchangedUrl = await listen(unchangedWorker);
  t.after(() => new Promise((resolve) => unchangedWorker.close(resolve)));
  const current = await sessionCheck(unchangedUrl, unchangedToken);
  assert.equal(current.status, 200);
  assert.equal(current.body.sessionCheck.result, 'current');

  // The credential file rotates as a side effect of the request itself, exactly
  // as a real `claude -p` rotating an OAuth access token would: the fake
  // rewrites the file from inside the same handler that answers the spawn.
  const renewedToken = 'session-check-renewed';
  const renewedHome = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const credentialPath = join(renewedHome, '.claude', '.credentials.json');
  const renewedFake = fakeClaudeSpawn({
    onSessionCheck: async () => {
      await writeFile(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: 'rotated-token', refreshToken: REFRESH_TOKEN } }));
      return { code: 0, stdout: JSON.stringify(successResult()) };
    }
  });
  const renewedWorker = createWorkerServer({
    token: renewedToken, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(renewedHome, 'mcp'), claudeHome: renewedHome, spawn: renewedFake.spawn
  });
  const renewedUrl = await listen(renewedWorker);
  t.after(() => new Promise((resolve) => renewedWorker.close(resolve)));
  const renewed = await sessionCheck(renewedUrl, renewedToken);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.sessionCheck.result, 'renewed');
  assert.match(renewed.body.sessionCheck.detail, /rotated/i);
});

test('a quota-limit response is distinguished from an authentication failure', async (t) => {
  const token = 'session-check-quota';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({
    onSessionCheck: () => ({ code: 1, stderr: "You've hit your limit · resets later" })
  });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'quota_exhausted');
  assert.doesNotMatch(body.sessionCheck.detail, /not logged in|reauthenticate/i);
});

test('a failed check that revokes the stored credential reports reauth_required', async (t) => {
  const token = 'session-check-reauth';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const credentialPath = join(home, '.claude', '.credentials.json');
  const fake = fakeClaudeSpawn({
    onSessionCheck: async () => {
      // Claude Code clears its own credential file when the refresh token
      // itself is rejected. The worker must notice this from the file, not
      // from parsing CLI text alone.
      await writeFile(credentialPath, JSON.stringify({}));
      return { code: 1, stderr: 'Invalid API key · please run /login' };
    }
  });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'reauth_required');
});

test('no stored credential short-circuits to reauth_required without spawning Claude', async (t) => {
  const token = 'session-check-no-credential';
  const home = await claudeHomeWithCredential(t, null);
  const fake = fakeClaudeSpawn();
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'reauth_required');
  assert.equal(fake.calls.length, 0, 'a missing credential must not spawn a Claude process');
});

test('an unrecognized failure falls to check_failed rather than guessing a cause', async (t) => {
  const token = 'session-check-unrecognized';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ code: 1, stderr: 'An unexpected internal error occurred (code 500)' }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'check_failed');
});

test('malformed JSON output from a successful Claude process is treated as check_failed, not a current session', async (t) => {
  const token = 'session-check-malformed';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ code: 0, stdout: 'not json at all' }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'check_failed');
});

test('a session check timeout terminates the provider process and releases the exclusive slot', async (t) => {
  const token = 'session-check-timeout';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ hang: true }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home,
    sessionCheckTimeoutMs: 5, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const first = await sessionCheck(workerUrl, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.sessionCheck.result, 'check_failed');
  assert.match(first.body.sessionCheck.detail, /timeout/i);
  assert.equal(fake.calls.find((call) => call.args[0] === '-p').child.killed, true);

  const second = await sessionCheck(workerUrl, token);
  assert.equal(second.status, 200, 'the timed-out process left the exclusive slot claimed');
});

test('demo mode reports current without touching disk or spawning a process', async (t) => {
  const token = 'session-check-demo';
  const worker = createWorkerServer({ token, adapter: 'claude-code', demoMode: true, workspace: process.cwd() });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  assert.equal(body.sessionCheck.result, 'current');
  assert.match(body.sessionCheck.detail, /demo/i);
});

test('adapters with no session-check request path return a normalized unsupported result, not a Claude-specific error', async (t) => {
  for (const adapter of ['codex-cli', 'opencode']) {
    const token = `session-check-unsupported-${adapter}`;
    const worker = createWorkerServer({ token, adapter, demoMode: true, workspace: process.cwd() });
    const workerUrl = await listen(worker);
    const { status, body } = await sessionCheck(workerUrl, token);
    assert.equal(status, 200);
    assert.equal(body.sessionCheck.result, 'unsupported');
    assert.equal(body.sessionCheck.session, null);
    await new Promise((resolve) => worker.close(resolve));
  }
});

test('a session check is refused while a task is active, and a task is refused while a check is active', async (t) => {
  const token = 'session-check-vs-task';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ hang: true }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}` };

  // Start a task and hold it open by never finishing the fake Claude process.
  const taskResponse = fetch(`${workerUrl}/v1/tasks`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'stay busy' })
  });
  await fake.spawned;
  const duringTask = await sessionCheck(workerUrl, token);
  assert.equal(duringTask.status, 409);
  assert.equal(fake.calls.filter((c) => c.args[0] === '-p').length, 1, 'the refused check must not spawn its own Claude process');

  fake.releaseHang();
  await taskResponse.then((r) => r.text());

  // Now hold a session check open and confirm a task is refused in turn.
  const holdingFake = fakeClaudeSpawn({ onSessionCheck: () => ({ hang: true }) });
  const holdingWorker = createWorkerServer({
    token: 'session-check-vs-task-2', adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp3'), claudeHome: home, spawn: holdingFake.spawn
  });
  const holdingUrl = await listen(holdingWorker);
  t.after(() => new Promise((resolve) => holdingWorker.close(resolve)));
  const holdingHeaders = { authorization: 'Bearer session-check-vs-task-2' };

  const checkResponse = sessionCheck(holdingUrl, 'session-check-vs-task-2');
  await holdingFake.spawned;
  const duringCheck = await fetch(`${holdingUrl}/v1/tasks`, {
    method: 'POST',
    headers: { ...holdingHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'must wait' })
  });
  assert.equal(duringCheck.status, 409);
  const loginDuringCheck = await fetch(`${holdingUrl}/v1/auth/login`, { method: 'POST', headers: holdingHeaders });
  assert.equal(loginDuringCheck.status, 409);

  holdingFake.releaseHang();
  const settled = await checkResponse;
  assert.equal(settled.status, 200);
});

test('a session check is refused while an interactive login is in progress', async (t) => {
  const token = 'session-check-vs-login';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ holdLogin: true });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}` };

  const login = await fetch(`${workerUrl}/v1/auth/login`, { method: 'POST', headers });
  assert.equal(login.status, 202);
  const { status } = await sessionCheck(workerUrl, token);
  assert.equal(status, 409);
  assert.equal(fake.calls.filter((c) => c.args[0] === '-p').length, 0, 'a login in progress must not let a check spawn a Claude process');
});

test('Claude login keeps stdin open so an invalid authorization code can be corrected', async (t) => {
  const token = 'login-code-retry';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ holdLogin: true });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${workerUrl}/v1/auth/login`, { method: 'POST', headers })).status, 202);
  const loginChild = fake.calls.find((call) => call.args[0] === 'auth' && call.args[1] === 'login').child;

  const first = await fetch(`${workerUrl}/v1/auth/complete`, {
    method: 'POST', headers, body: JSON.stringify({ code: 'mistyped-code' })
  });
  assert.equal(first.status, 202);
  loginChild.stderr.write('Invalid code. Please make sure the full code was copied.\n');
  assert.equal(loginChild.stdin.writableEnded, false, 'the first code submission closed Claude stdin');

  const second = await fetch(`${workerUrl}/v1/auth/complete`, {
    method: 'POST', headers, body: JSON.stringify({ code: 'corrected-full-code' })
  });
  assert.equal(second.status, 202);
  assert.equal(loginChild.stdinText(), 'mistyped-code\ncorrected-full-code\n');

  loginChild.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve));
  const status = await (await fetch(`${workerUrl}/v1/status`, { headers })).json();
  assert.equal(status.authentication.authenticated, true);
  assert.equal(status.authentication.phase, 'authenticated');
});

test('an abandoned provider login can be cancelled without invalidating the stored session', async (t) => {
  const token = 'login-cancel';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ holdLogin: true });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${workerUrl}/v1/auth/login`, { method: 'POST', headers })).status, 202);
  const loginChild = fake.calls.find((call) => call.args[0] === 'auth' && call.args[1] === 'login').child;
  const cancelled = await fetch(`${workerUrl}/v1/auth/cancel`, { method: 'POST', headers, body: '{}' });
  assert.equal(cancelled.status, 200);
  const body = await cancelled.json();
  assert.equal(loginChild.killed, true);
  assert.equal(body.authentication.authenticated, true);
  assert.equal(body.authentication.phase, 'authenticated');

  const status = await (await fetch(`${workerUrl}/v1/status`, { headers })).json();
  assert.equal(status.authentication.authenticated, true);
  assert.equal(status.authentication.challenge.requiresInput, false);
});

test('the control plane proxies interactive-login cancellation through the vendor-neutral auth route', async (t) => {
  const token = 'login-cancel-control-plane';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ holdLogin: true });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, claudeWorkerUrl: workerUrl, claudeWorkerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const login = await fetch(`${controlUrl}/api/v1/agents/worker-01/auth/login`, { method: 'POST' });
  assert.equal(login.status, 202);
  const cancelled = await fetch(`${controlUrl}/api/v1/agents/worker-01/auth/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).authentication.authenticated, true);
});

test('two concurrent session checks do not both spawn a Claude process', async (t) => {
  const token = 'session-check-concurrent';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ hang: true }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const first = sessionCheck(workerUrl, token);
  await fake.spawned;
  const statusDuringCheck = await (await fetch(`${workerUrl}/v1/status`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.equal(statusDuringCheck.task.active, null, 'a session check was exposed as a cancellable task');
  assert.equal(statusDuringCheck.authentication.checking, true);
  const cancelDuringCheck = await fetch(`${workerUrl}/v1/tasks/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(cancelDuringCheck.status, 409, 'task cancellation claimed to cancel a session check');
  const second = await sessionCheck(workerUrl, token);
  assert.equal(second.status, 409);
  assert.equal(fake.calls.filter((c) => c.args[0] === '-p').length, 1);

  fake.releaseHang();
  const settled = await first;
  assert.equal(settled.status, 200);
});

test('a session check never appears in status-polling logic on its own', async (t) => {
  const token = 'session-check-not-polled';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn();
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const headers = { authorization: `Bearer ${token}` };

  for (let i = 0; i < 5; i += 1) {
    const status = await (await fetch(`${workerUrl}/v1/status`, { headers })).json();
    assert.equal(status.authentication.authenticated, true);
  }
  assert.equal(fake.calls.filter((c) => c.args[0] === '-p').length, 0, 'status polling must never spawn the session-check Claude process');
});

test('a session check never returns or logs a raw token', async (t) => {
  const token = 'session-check-secrets';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({
    onSessionCheck: () => ({ code: 0, stdout: JSON.stringify({ ...successResult(), raw_response: { access_token: ACCESS_TOKEN } }) })
  });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { status, body } = await sessionCheck(workerUrl, token);
  assert.equal(status, 200);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(serialized, new RegExp(REFRESH_TOKEN));

  // The credential file itself must be untouched by inspection.
  const stored = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
  assert.equal(stored.claudeAiOauth.accessToken, ACCESS_TOKEN);
});

test('the control plane proxies the session check without a Claude-specific route', async (t) => {
  const token = 'session-check-control-plane';
  const home = await claudeHomeWithCredential(t, { claudeAiOauth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } });
  const fake = fakeClaudeSpawn({ onSessionCheck: () => ({ code: 0, stdout: JSON.stringify(successResult()) }) });
  const worker = createWorkerServer({
    token, adapter: 'claude-code', workspace: process.cwd(), dataPath: null,
    mcpStatePath: null, mcpConfigDir: join(home, 'mcp'), claudeHome: home, spawn: fake.spawn
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, claudeWorkerUrl: workerUrl, claudeWorkerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const response = await fetch(`${controlUrl}/api/v1/agents/worker-01/auth/session-check`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, 'agent-wrapper/v1');
  assert.equal(body.sessionCheck.result, 'current');

  // The generic fleet-wide alias for the sole default agent also works.
  const alias = await fetch(`${controlUrl}/api/v1/auth/session-check`, { method: 'POST' });
  assert.equal(alias.status, 200);
});
