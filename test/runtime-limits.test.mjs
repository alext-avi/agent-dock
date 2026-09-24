// Runtime limits and subagent/child observability (issue #44).
//
// Two kinds of test live here, deliberately in one file because they are two
// halves of one claim:
//
//   * Pure tests of the provider-neutral policy, the per-adapter support matrix,
//     and the Claude translation — no processes, no timing.
//   * Process-tree tests against test/fixtures/fake-harness.mjs, which starts a
//     real grandchild. Those assert on the operating system: after a cancel, a
//     wall timeout, an idle timeout, or a worker shutdown, no descendant PID is
//     still alive. A mocked kill() would pass while the real bug — signalling
//     the CLI and leaving its subtree running — shipped.
//
// Hermetic: no Docker, no network, no provider credentials. The only real
// processes are node running the fake harness.

import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { normalizeRuntimeLimits } from '../control-plane/runtime-limits.mjs';
import { createWorkerServer } from '../worker/server.mjs';
import {
  RUNTIME_POLICY_DEFAULTS,
  describeRuntimeLimits,
  effectiveRuntimePolicy,
  normalizeRuntimePolicy,
  runtimePolicyFromEnv,
  runtimePolicySupport
} from '../worker/runtime-policy.mjs';
import { isMeaningfulOutput } from '../worker/supervisor.mjs';
import {
  claudeAdapterManifest,
  claudeRuntimeLimitArgs,
  claudeRuntimeLimitEnv,
  observeClaudeLifecycle
} from '../worker/adapters/claude.mjs';
import { codexAdapterManifest } from '../worker/adapters/codex.mjs';
import { opencodeAdapterManifest } from '../worker/adapters/opencode.mjs';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-harness.mjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

// A signalled-but-unreaped descendant still answers kill(pid, 0), so a test that
// only asked that question would pass while a zombie subtree accumulated. The
// process state in /proc is the answer that matches what an operator means by
// "still running". Linux-only, like the containers this runs in.
function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  // Linux keeps a killed process addressable until it is reaped, so distinguish
  // zombies from running work there. Other supported development hosts do not
  // expose /proc; a PID that still accepts signal 0 must be treated as alive,
  // not optimistically declared dead because a Linux-only file is absent.
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim()[0] !== 'Z';
  } catch {
    return false;
  }
}

async function until(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function claudeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-dock-runtime-limits-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-not-a-real-token' } }));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

// Redirects the three commands the Claude adapter runs at the real `spawn`, so
// the worker's own spawn options — including `detached: true` — reach the
// operating system unchanged. Faking spawn itself would test the fake.
function harnessSpawn({ mode, pidFile }) {
  const taskCalls = [];
  return {
    taskCalls,
    spawn(command, args, options) {
      if (command !== 'claude') throw new Error(`Unexpected command: ${command}`);
      if (args.length === 1 && args[0] === '--version') {
        return realSpawn(process.execPath, ['-e', 'process.stdout.write("Claude Code test-version")'], options);
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        return realSpawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "oauth" }))'], options);
      }
      taskCalls.push({ args: [...args], options });
      return realSpawn(process.execPath, [HARNESS, mode, pidFile], options);
    }
  };
}

async function startWorker(t, { mode, runtimeLimits, token = 'runtime-limit-token' }) {
  const home = await claudeHome(t);
  const pidFile = join(home, 'pids.json');
  const fake = harnessSpawn({ mode, pidFile });
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    workspace: home,
    dataPath: null,
    mcpStatePath: null,
    mcpConfigDir: join(home, 'mcp'),
    claudeHome: home,
    claudeOAuthUsage: false,
    runtimeLimits,
    spawn: fake.spawn
  });
  const url = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  return { worker, url, token, fake, pidFile, home };
}

// Reads the NDJSON task stream to completion and returns every event.
async function runTask(url, token, body = {}) {
  const response = await fetch(`${url}/v1/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'do the thing', ...body })
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text,
    events: text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : []
  };
}

async function readPids(pidFile) {
  return until(async () => {
    try { return JSON.parse(await readFile(pidFile, 'utf8')); }
    catch { return null; }
  }, 'the fake harness never reported its process tree');
}

async function status(url, token) {
  return (await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json();
}

// ---------------------------------------------------------------- validation

test('the runtime policy validates every field and rejects contradictory bounds', () => {
  assert.deepEqual(normalizeRuntimePolicy({}), RUNTIME_POLICY_DEFAULTS);
  assert.equal(normalizeRuntimePolicy({ taskWallTimeoutMs: 60_000 }).taskWallTimeoutMs, 60_000);
  // An omitted field keeps its default rather than becoming unbounded.
  assert.equal(normalizeRuntimePolicy({ taskWallTimeoutMs: 60_000 }).maxHarnessTurns, RUNTIME_POLICY_DEFAULTS.maxHarnessTurns);

  const rejects = [
    [{ taskWallTimeoutMs: 'soon' }, /whole number/],
    [{ taskWallTimeoutMs: 1.5 }, /whole number/],
    [{ taskWallTimeoutMs: 999_999_999 }, /between/],
    [{ maxHarnessTurns: 0 }, /between/],
    [{ maxSubagentDepth: -1 }, /between/],
    [{ allowBackgroundTasks: 'yes' }, /true or false/],
    [{ nonsense: 1 }, /not a runtime limit/],
    [[], /must be an object/],
    // An idle bound above the wall bound can never fire, and a default child
    // timeout above the ceiling is a contradiction the harness would resolve
    // silently in whichever direction it happened to prefer.
    [{ taskWallTimeoutMs: 1_000, taskIdleTimeoutMs: 2_000 }, /must not exceed/],
    [{ childCommandTimeoutMs: 600_000, childCommandMaxTimeoutMs: 60_000 }, /must not exceed/]
  ];
  for (const [value, pattern] of rejects) {
    assert.throws(() => normalizeRuntimePolicy(value), pattern, `accepted ${JSON.stringify(value)}`);
  }
  assert.equal(normalizeRuntimePolicy({}, { defaults: { taskWallTimeoutMs: 5_000 } }).taskWallTimeoutMs, 5_000);

  // Tightening one bound must not fail on the default of the other. An operator
  // asking for a 30-second wall limit means the idle limit is at most that too,
  // not that the request is invalid because the idle default is five minutes.
  const tightened = normalizeRuntimePolicy({ taskWallTimeoutMs: 30_000 });
  assert.equal(tightened.taskIdleTimeoutMs, 30_000);
  assert.equal(normalizeRuntimePolicy({ childCommandMaxTimeoutMs: 30_000 }).childCommandTimeoutMs, 30_000);
  assert.equal(normalizeRuntimeLimits({ taskWallTimeoutMs: 30_000 }).taskIdleTimeoutMs, 30_000);
});

test('the control plane validates the same shape the wrapper does', () => {
  assert.deepEqual(normalizeRuntimeLimits({}), { ...RUNTIME_POLICY_DEFAULTS });
  assert.throws(() => normalizeRuntimeLimits({ maxConcurrentSubagents: 99 }), /between/);
  assert.throws(() => normalizeRuntimeLimits({ taskIdleTimeoutMs: 10_000, taskWallTimeoutMs: 1_000 }), /must not exceed/);
  // A PATCH sends only the fields its form rendered; the rest keep their saved
  // bound instead of reverting to the shipped default.
  const saved = normalizeRuntimeLimits({ taskWallTimeoutMs: 60_000, maxHarnessTurns: 5 });
  assert.equal(normalizeRuntimeLimits({ maxHarnessTurns: 9 }, saved).taskWallTimeoutMs, 60_000);
});

test('a malformed environment default is rejected rather than silently unbounding a task', () => {
  assert.equal(runtimePolicyFromEnv({ RUNTIME_TASK_WALL_TIMEOUT_MS: '60000' }).taskWallTimeoutMs, 60_000);
  assert.equal(runtimePolicyFromEnv({ RUNTIME_ALLOW_BACKGROUND_TASKS: '1' }).allowBackgroundTasks, true);
  assert.equal(runtimePolicyFromEnv({ RUNTIME_ALLOW_BACKGROUND_TASKS: '0' }).allowBackgroundTasks, false);
  assert.deepEqual(runtimePolicyFromEnv({}), RUNTIME_POLICY_DEFAULTS);
  assert.throws(() => runtimePolicyFromEnv({ RUNTIME_TASK_WALL_TIMEOUT_MS: 'ten minutes' }), /whole number/);
  assert.throws(() => runtimePolicyFromEnv({ RUNTIME_ALLOW_BACKGROUND_TASKS: 'yes' }), /must be 0 or 1/);
});

// ------------------------------------------------------------- support matrix

test('each adapter reports which limits it enforces, and never claims one it cannot', () => {
  const claude = runtimePolicySupport(claudeAdapterManifest.capabilities.runtimeLimits);
  // Wrapper supervision is the same for every adapter.
  for (const field of ['taskWallTimeoutMs', 'taskIdleTimeoutMs', 'terminationGraceMs']) {
    assert.deepEqual(claude[field], { supported: true, enforcedBy: 'wrapper', reason: null });
  }
  assert.equal(claude.maxHarnessTurns.enforcedBy, 'harness');
  assert.equal(claude.maxConcurrentSubagents.supported, true);

  for (const manifest of [codexAdapterManifest, opencodeAdapterManifest]) {
    const support = runtimePolicySupport(manifest.capabilities.runtimeLimits);
    assert.equal(support.taskWallTimeoutMs.supported, true, `${manifest.id} lost wrapper supervision`);
    for (const field of ['maxHarnessTurns', 'childCommandTimeoutMs', 'maxConcurrentSubagents', 'maxSubagentDepth', 'allowBackgroundTasks']) {
      assert.equal(support[field].supported, false, `${manifest.id} claims a control it has no flag for`);
      assert.equal(support[field].enforcedBy, null);
      assert.match(support[field].reason, /exposes no control/);
    }
  }
});

test('an unsupported control is reported as not effective, never dropped', () => {
  const policy = normalizeRuntimePolicy({ maxHarnessTurns: 7 });
  const codex = describeRuntimeLimits(policy, codexAdapterManifest.capabilities.runtimeLimits);
  // Kept, so it survives a move to a runtime that can honour it...
  assert.equal(codex.configured.maxHarnessTurns, 7);
  // ...but null, so nothing can read it as a bound that is in force.
  assert.equal(codex.effective.maxHarnessTurns, null);
  assert.equal(codex.effective.taskWallTimeoutMs, policy.taskWallTimeoutMs);
  const claude = describeRuntimeLimits(policy, claudeAdapterManifest.capabilities.runtimeLimits);
  assert.equal(claude.effective.maxHarnessTurns, 7);
  assert.deepEqual(
    effectiveRuntimePolicy(policy, runtimePolicySupport({ harnessControls: [] })).maxConcurrentSubagents,
    null
  );
});

// --------------------------------------------------------- claude translation

test('the Claude adapter maps only the controls Claude Code actually exposes', () => {
  const effective = describeRuntimeLimits(
    normalizeRuntimePolicy({
      maxHarnessTurns: 12,
      childCommandTimeoutMs: 90_000,
      childCommandMaxTimeoutMs: 300_000,
      maxConcurrentSubagents: 3,
      maxSubagentDepth: 2,
      allowBackgroundTasks: false
    }),
    claudeAdapterManifest.capabilities.runtimeLimits
  ).effective;
  assert.deepEqual(claudeRuntimeLimitArgs(effective), ['--max-turns', '12']);
  assert.deepEqual(claudeRuntimeLimitEnv(effective), {
    BASH_DEFAULT_TIMEOUT_MS: '90000',
    BASH_MAX_TIMEOUT_MS: '300000',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'
  });
  // Background tasks allowed means the disable switch is absent, not set to 0.
  assert.equal('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS' in claudeRuntimeLimitEnv({ ...effective, allowBackgroundTasks: true }), false);
  // A null is an unsupported control, and must produce no flag at all.
  assert.deepEqual(claudeRuntimeLimitArgs({ maxHarnessTurns: null }), []);
  assert.deepEqual(claudeRuntimeLimitEnv({ childCommandTimeoutMs: null, allowBackgroundTasks: null }), {});
});

test('Claude lifecycle observation carries metadata and never the prompt or command line', () => {
  const started = observeClaudeLifecycle({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_sub', name: 'Task', input: { subagent_type: 'code-reviewer', prompt: 'SECRET DELEGATED PROMPT' } },
        { type: 'tool_use', id: 'toolu_cmd', name: 'Bash', input: { command: 'curl -H "authorization: Bearer SECRET" https://example.test' } },
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/etc/passwd' } }
      ]
    }
  });
  assert.deepEqual(started, [
    { phase: 'started', scope: 'subagent', id: 'toolu_sub', name: 'code-reviewer' },
    { phase: 'started', scope: 'child', id: 'toolu_cmd', name: 'Bash' }
  ]);
  const serialized = JSON.stringify(started);
  assert.doesNotMatch(serialized, /SECRET|curl|passwd/);

  assert.deepEqual(
    observeClaudeLifecycle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_cmd', is_error: true, content: 'SECRET OUTPUT' }] } }),
    [{ phase: 'completed', id: 'toolu_cmd', status: 'failed' }]
  );
  assert.deepEqual(observeClaudeLifecycle({ type: 'system', subtype: 'init' }), []);
});

test('only meaningful output counts as activity', () => {
  assert.equal(isMeaningfulOutput('working'), true);
  assert.equal(isMeaningfulOutput('\n'), false);
  assert.equal(isMeaningfulOutput('   \r\n\t'), false);
  assert.equal(isMeaningfulOutput(''), false);
  assert.equal(isMeaningfulOutput(undefined), false);
});

// ------------------------------------------------------------ wrapper surface

test('the wrapper advertises its supervision and its per-control support', async (t) => {
  const { url, token } = await startWorker(t, { mode: 'burst' });
  const payload = await status(url, token);
  assert.deepEqual(payload.capabilities.runtimeLimits.supervision, {
    wallTimeout: true,
    idleTimeout: true,
    processTreeTermination: true,
    gracefulThenForced: true
  });
  assert.equal(payload.capabilities.tasks.runtimeLimits, true);
  assert.equal(payload.capabilities.runtimeLimits.support.maxHarnessTurns.enforcedBy, 'harness');
  assert.deepEqual(payload.capabilities.runtimeLimits.defaults, { ...RUNTIME_POLICY_DEFAULTS });
  assert.deepEqual(payload.capabilities.runtimeLimits.observes, ['subagent', 'childCommand']);
  assert.equal(payload.task.active, null);
  assert.equal(payload.task.last, null);
});

test('a task announces the bounds it runs under and passes them to the harness', async (t) => {
  const { url, token, fake } = await startWorker(t, {
    mode: 'burst',
    runtimeLimits: { maxHarnessTurns: 6, childCommandTimeoutMs: 45_000 }
  });
  const { events } = await runTask(url, token);
  const started = events.find((event) => event.type === 'task.started');
  assert.equal(started.data.limits.configured.maxHarnessTurns, 6);
  assert.equal(started.data.limits.effective.maxHarnessTurns, 6);
  assert.equal(started.data.limits.support.maxSubagentDepth.enforcedBy, 'harness');
  const call = fake.taskCalls.at(-1);
  assert.deepEqual(call.args.slice(-2), ['--max-turns', '6']);
  assert.equal(call.options.env.BASH_DEFAULT_TIMEOUT_MS, '45000');
  assert.equal(call.options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  // Own process group, or a signal reaches the CLI and nothing it started.
  assert.equal(call.options.detached, true);

  const completed = events.at(-1);
  assert.equal(completed.type, 'task.completed');
  assert.equal(completed.data.status, 'succeeded');
  assert.equal(completed.data.reason, 'completed');
  assert.equal(completed.data.forceTerminated, false);
});

test('an invalid runtime policy is refused before anything is spawned', async (t) => {
  const { url, token, fake } = await startWorker(t, { mode: 'burst' });
  const response = await fetch(`${url}/v1/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'go', runtimeLimits: { maxHarnessTurns: 0 } })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /maxHarnessTurns/);
  assert.equal(fake.taskCalls.length, 0);
  // The exclusive task slot is released, not left claimed by the rejected task.
  assert.equal((await status(url, token)).task.active, null);
});

// --------------------------------------------------------------- process tree

test('a wall-clock timeout ends the task and leaves no descendant running', async (t) => {
  const { url, token, pidFile } = await startWorker(t, {
    mode: 'chatty',
    runtimeLimits: { taskWallTimeoutMs: 300, taskIdleTimeoutMs: 300, terminationGraceMs: 50 }
  });
  const running = runTask(url, token);
  const pids = await readPids(pidFile);
  const { events } = await running;

  const completed = events.at(-1);
  assert.equal(completed.type, 'task.completed');
  assert.equal(completed.data.status, 'failed');
  // A harness killed at the wall bound can still exit 0; the reason is what
  // keeps that from being reported as success.
  assert.equal(completed.data.reason, 'wall_timeout');
  const termination = events.find((event) => event.type === 'runtime.termination');
  assert.equal(termination.data.reason, 'wall_timeout');
  assert.equal(termination.data.processGroup, true);

  await until(() => !isAlive(pids.harness) && !isAlive(pids.grandchild), 'the timed-out process tree survived');
});

test('meaningful output resets the idle clock, and silence still ends the task', async (t) => {
  // Chatty: the harness speaks every 40 ms, so a 250 ms idle bound must never
  // fire even though the task runs far longer than that.
  const chatty = await startWorker(t, {
    mode: 'chatty',
    runtimeLimits: { taskWallTimeoutMs: 900, taskIdleTimeoutMs: 250, terminationGraceMs: 50 }
  });
  const chattyRun = await runTask(chatty.url, chatty.token);
  assert.equal(chattyRun.events.at(-1).data.reason, 'wall_timeout', 'a talking harness was killed for being idle');
  assert.equal(chattyRun.events.some((event) => event.type === 'runtime.stalled'), false);

  // Silent: the same bound, nothing to say, and the idle timeout is what fires.
  const silent = await startWorker(t, {
    mode: 'silent',
    runtimeLimits: { taskWallTimeoutMs: 10_000, taskIdleTimeoutMs: 250, terminationGraceMs: 50 }
  });
  const silentRun = await runTask(silent.url, silent.token);
  const completed = silentRun.events.at(-1);
  assert.equal(completed.data.reason, 'idle_timeout');
  // The stall is announced before it is acted on, which is the whole point:
  // an operator can see a stalled subtree while it is still recoverable.
  const stalled = silentRun.events.find((event) => event.type === 'runtime.stalled');
  assert.ok(stalled, 'a silent harness was terminated without ever being reported stalled');
  assert.ok(stalled.data.idleMs >= 100);
  const pids = await readPids(silent.pidFile);
  await until(() => !isAlive(pids.harness) && !isAlive(pids.grandchild), 'the stalled process tree survived');
});

test('an explicit cancel terminates the whole process tree', async (t) => {
  const { url, token, pidFile } = await startWorker(t, {
    mode: 'silent',
    runtimeLimits: { taskWallTimeoutMs: 30_000, taskIdleTimeoutMs: 30_000, terminationGraceMs: 50 }
  });
  const running = runTask(url, token);
  const pids = await readPids(pidFile);
  const active = await until(async () => (await status(url, token)).task.active, 'the task never became active');
  assert.equal(active.lifecycle, 'running');
  assert.equal(active.limits.configured.taskWallTimeoutMs, 30_000);
  assert.equal(active.limits.effective.taskWallTimeoutMs, 30_000);
  assert.equal(active.limits.support.maxHarnessTurns.enforcedBy, 'harness');
  assert.ok(active.lastActivityAt);
  assert.ok(Number.isFinite(active.elapsedMs));
  assert.equal(active.terminalReason, null);

  const cancelled = await fetch(`${url}/v1/tasks/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: active.id })
  });
  assert.equal(cancelled.status, 202);

  const { events } = await running;
  const completed = events.at(-1);
  assert.equal(completed.data.status, 'cancelled');
  assert.equal(completed.data.reason, 'cancelled');
  await until(() => !isAlive(pids.harness) && !isAlive(pids.grandchild), 'a cancelled process tree survived');

  const after = await status(url, token);
  assert.equal(after.task.active, null);
  assert.equal(after.task.last.reason, 'cancelled');
  assert.equal(after.task.last.id, active.id);
});

test('a harness that ignores the graceful signal is force-killed with its tree', async (t) => {
  const { url, token, pidFile } = await startWorker(t, {
    mode: 'stubborn',
    runtimeLimits: { taskWallTimeoutMs: 30_000, taskIdleTimeoutMs: 200, terminationGraceMs: 100 }
  });
  const running = runTask(url, token);
  const pids = await readPids(pidFile);
  const { events } = await running;

  const phases = events.filter((event) => event.type === 'runtime.termination').map((event) => event.data.phase);
  assert.deepEqual(phases, ['graceful', 'force'], 'the wrapper escalated without trying a graceful stop first');
  const completed = events.at(-1);
  assert.equal(completed.data.forceTerminated, true);
  assert.equal(completed.data.reason, 'idle_timeout');
  await until(() => !isAlive(pids.harness) && !isAlive(pids.grandchild), 'a force-killed process tree survived');

  const after = await status(url, token);
  assert.equal(after.task.last.forceTerminated, true);
});

test('a normally completed task leaves no orphaned descendant behind', async (t) => {
  // The fake harness exits cleanly on its own but is written to leave its
  // grandchild running, which is exactly the shape issue #44 reported: the
  // parent looks healthy and finished while a subtree keeps going.
  const { url, token, pidFile } = await startWorker(t, { mode: 'burst' });
  const running = runTask(url, token);
  const pids = await readPids(pidFile);
  const { events } = await running;
  assert.equal(events.at(-1).data.status, 'succeeded');
  await until(() => !isAlive(pids.grandchild), 'a finished task left its grandchild running');
});

test('worker shutdown tears down the detached process tree it created', async (t) => {
  const { worker, url, token, pidFile } = await startWorker(t, {
    mode: 'silent',
    runtimeLimits: { taskWallTimeoutMs: 30_000, taskIdleTimeoutMs: 30_000, terminationGraceMs: 50 }
  });
  const running = runTask(url, token);
  const pids = await readPids(pidFile);
  await until(async () => (await status(url, token)).task.active, 'the task never became active');

  // Detaching the harness is what makes a signal reach its descendants, and it
  // is also what stops the harness dying with the worker. Shutdown has to be
  // deliberate or a container stop leaves a subtree billing an account.
  const result = await worker.shutdownRuntime({ reason: 'worker_shutdown' });
  assert.equal(result.terminated, true);
  const { events } = await running;
  assert.equal(events.at(-1).data.reason, 'worker_shutdown');
  await until(() => !isAlive(pids.harness) && !isAlive(pids.grandchild), 'shutdown left the process tree running');
});

// ------------------------------------------------------------- observability

test('subagent and child-command lifecycle reaches the stream without leaking inputs', async (t) => {
  const token = 'lifecycle-token';
  const home = await claudeHome(t);
  const script = join(home, 'lifecycle-harness.mjs');
  // Emits one subagent and one child command, then answers both, using the exact
  // Claude stream-json shapes the adapter translates.
  await writeFile(script, `
    const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
    emit({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_a', name: 'Task', input: { subagent_type: 'reviewer', prompt: 'SECRET DELEGATED PROMPT' } },
      { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'echo SECRET_COMMAND' } }
    ] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'SECRET OUTPUT' }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', is_error: true, content: 'SECRET OUTPUT' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
  `);
  const worker = createWorkerServer({
    token,
    adapter: 'claude-code',
    workspace: home,
    dataPath: null,
    mcpStatePath: null,
    mcpConfigDir: join(home, 'mcp'),
    claudeHome: home,
    claudeOAuthUsage: false,
    spawn(command, args, options) {
      if (args.length === 1 && args[0] === '--version') return realSpawn(process.execPath, ['-e', 'process.stdout.write("v")'], options);
      if (args[0] === 'auth') return realSpawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ loggedIn: true }))'], options);
      return realSpawn(process.execPath, [script], options);
    }
  });
  const url = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const { events } = await runTask(url, token, { prompt: 'PROMPT THAT MUST NOT COME BACK' });
  const byType = (type) => events.filter((event) => event.type === type);

  assert.deepEqual(byType('subagent.started').map((event) => event.data), [
    { subagentId: 'toolu_a', name: 'reviewer', depth: 1, active: 1 }
  ]);
  const childStarted = byType('child.started');
  assert.equal(childStarted.length, 1);
  assert.equal(childStarted[0].data.childId, 'toolu_b');
  assert.equal(childStarted[0].data.kind, 'command');
  assert.equal(childStarted[0].data.timeoutMs, RUNTIME_POLICY_DEFAULTS.childCommandTimeoutMs);

  assert.equal(byType('child.completed')[0].data.status, 'succeeded');
  const subagentDone = byType('subagent.completed')[0].data;
  assert.equal(subagentDone.status, 'failed');
  assert.equal(subagentDone.active, 0);
  assert.ok(Number.isFinite(subagentDone.durationMs));

  // The lifecycle events are metadata. Whatever the activity events already
  // carried is unchanged, but nothing new may disclose a prompt or a command.
  const lifecycleOnly = JSON.stringify(events.filter((event) => event.type.startsWith('subagent.') || event.type.startsWith('child.')));
  assert.doesNotMatch(lifecycleOnly, /SECRET|PROMPT THAT MUST NOT COME BACK|echo/);
});

test('an unsupported adapter reports the gap and is still bounded by the wrapper', async (t) => {
  const token = 'codex-limits-token';
  const home = await mkdtemp(join(tmpdir(), 'agent-dock-codex-limits-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const worker = createWorkerServer({
    token,
    adapter: 'codex-cli',
    demoMode: true,
    workspace: home,
    dataPath: null,
    mcpStatePath: null,
    mcpConfigDir: join(home, 'mcp'),
    runtimeLimits: { maxHarnessTurns: 9 }
  });
  const url = await listen(worker);
  t.after(() => new Promise((resolve) => worker.close(resolve)));

  const payload = await status(url, token);
  assert.equal(payload.capabilities.runtimeLimits.support.maxHarnessTurns.supported, false);
  assert.equal(payload.capabilities.runtimeLimits.supervision.wallTimeout, true);
  assert.deepEqual(payload.capabilities.runtimeLimits.observes, []);

  const { events } = await runTask(url, token);
  const limits = events.find((event) => event.type === 'task.started').data.limits;
  assert.equal(limits.effective.maxHarnessTurns, null, 'Codex advertised a turn cap it cannot enforce');
  assert.equal(limits.effective.taskWallTimeoutMs, RUNTIME_POLICY_DEFAULTS.taskWallTimeoutMs);
});

// -------------------------------------------------------------- control plane

test('the control plane stores runtime limits and injects them into every task', async (t) => {
  let received = null;
  const token = 'cp-limits-token';
  const workerEvents = [
    { apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'task-1', data: {} },
    { apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'task-1', data: { status: 'succeeded', exitCode: 0, reason: 'completed' } }
  ];
  const { createServer } = await import('node:http');
  const worker = createServer(async (req, res) => {
    if (req.url === '/v1/tasks') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return res.end(workerEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ apiVersion: 'agent-wrapper/v1', agent: { id: 'worker-01' }, capabilities: {}, task: { active: null } }));
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, dataPath: null });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  const initial = (await (await fetch(`${controlUrl}/api/v1/agents`)).json()).agents[0];
  assert.deepEqual(initial.runtimeLimits, { ...RUNTIME_POLICY_DEFAULTS });

  const patched = await fetch(`${controlUrl}/api/v1/agents/${initial.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeLimits: { taskIdleTimeoutMs: 60_000, maxConcurrentSubagents: 1 } })
  });
  assert.equal(patched.status, 200);
  const saved = (await patched.json()).agent.runtimeLimits;
  assert.equal(saved.taskIdleTimeoutMs, 60_000);
  assert.equal(saved.maxConcurrentSubagents, 1);
  assert.equal(saved.taskWallTimeoutMs, RUNTIME_POLICY_DEFAULTS.taskWallTimeoutMs);

  const rejected = await fetch(`${controlUrl}/api/v1/agents/${initial.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeLimits: { maxSubagentDepth: 99 } })
  });
  assert.equal(rejected.status, 400);

  // Durable, not per-request: a browser asking for a wider bound is overwritten
  // with the saved one, exactly as it is for instructions and model policy.
  await fetch(`${controlUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'go', runtimeLimits: { taskIdleTimeoutMs: 86_400_000 } })
  });
  assert.equal(received.runtimeLimits.taskIdleTimeoutMs, 60_000);
  assert.equal(received.runtimeLimits.maxConcurrentSubagents, 1);
});

test('an agent stored before runtime limits existed adopts the conservative defaults', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-limits-migration-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataPath = join(temporary, 'registry.json');
  await writeFile(dataPath, JSON.stringify({
    schemaVersion: 4,
    agents: [{ id: 'legacy', name: 'Legacy', adapter: 'codex-cli', description: '', durablePrompt: '', runtimeId: null, runtimeBinding: 'unprovisioned' }],
    runtimes: []
  }));
  const control = createControlPlane({ dataPath, workerToken: 'x', runtimeManager: null });
  const controlUrl = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));

  const agent = (await (await fetch(`${controlUrl}/api/v1/agents/legacy`)).json()).agent;
  assert.deepEqual(agent.runtimeLimits, { ...RUNTIME_POLICY_DEFAULTS });
  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.equal(persisted.agents[0].runtimeLimits.taskIdleTimeoutMs, RUNTIME_POLICY_DEFAULTS.taskIdleTimeoutMs);
});

test('a cancellation that arrives before the task has an id is refused, not crashed into', async (t) => {
  const { url, token } = await startWorker(t, { mode: 'burst' });
  // No active task at all: the pre-existing 404 must survive the new termination
  // path, which now dereferences a policy the claim placeholder does not have.
  const response = await fetch(`${url}/v1/tasks/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /No active task/);
});
