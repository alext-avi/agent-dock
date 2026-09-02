import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createDelegationService } from '../control-plane/delegation-service.mjs';

const user = { id: 'oidc:user', type: 'user', agentId: null, isAdmin: false };
const agentA = { id: 'agent:a', type: 'agent', agentId: 'a', isAdmin: false };
const agentB = { id: 'agent:b', type: 'agent', agentId: 'b', isAdmin: false };
const agentC = { id: 'agent:c', type: 'agent', agentId: 'c', isAdmin: false };

test('delegated tasks return stable handles and persist normalized results', async (t) => {
  const service = createDelegationService({
    agentExists: (id) => ['a', 'b'].includes(id),
    dispatch: async (task) => ({
      status: 'succeeded',
      taskId: `worker-${task.id}`,
      output: `completed by ${task.targetAgentId}`,
      usage: { totalTokens: 42 }
    })
  });
  t.after(() => service.close());

  const submitted = service.submit({ targetAgentId: 'a', prompt: 'Do the research' }, user);
  assert.equal(submitted.status, 'queued');
  assert.ok(submitted.id);
  assert.ok(submitted.traceId);
  assert.equal(submitted.depth, 1);

  await service.whenIdle();
  const completed = service.get(submitted.id, user, { includePrompt: true });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.workerTaskId, `worker-${submitted.id}`);
  assert.equal(completed.output, 'completed by a');
  assert.equal(completed.prompt, 'Do the research');
  assert.deepEqual(completed.usage, { totalTokens: 42 });
  assert.throws(() => service.get(submitted.id, agentB), { status: 403 });
});

test('lineage is derived from owned parent tasks and cycles fail closed', async (t) => {
  const finishes = new Map();
  const service = createDelegationService({
    agentExists: (id) => ['a', 'b', 'c'].includes(id),
    dispatch: (task) => new Promise((resolve) => finishes.set(task.id, resolve)),
    maxDepth: 4
  });
  t.after(async () => {
    for (const finish of finishes.values()) finish({ status: 'succeeded' });
    await service.close();
  });

  const root = service.submit({ targetAgentId: 'b', prompt: 'First hop' }, agentA);
  const child = service.submit({ targetAgentId: 'c', prompt: 'Second hop' }, agentB);
  const storedChild = service.get(child.id, agentC);
  assert.equal(storedChild.parentTaskId, root.id);
  assert.equal(storedChild.traceId, root.traceId);
  assert.equal(storedChild.depth, 2);

  assert.throws(
    () => service.submit({ targetAgentId: 'a', prompt: 'Cycle' }, agentC),
    /cycle/i
  );
  assert.throws(
    () => service.submit({ targetAgentId: 'a', prompt: 'Spoofed parent', parentTaskId: root.id }, agentC),
    { status: 403 }
  );
  assert.throws(() => service.submit({ targetAgentId: 'a', prompt: 'Self call' }, agentA), /cycle/i);

  finishes.get(child.id)({ status: 'succeeded' });
  finishes.get(root.id)({ status: 'succeeded' });
  await service.whenIdle();
});

test('caller concurrency and cancellation remain bounded', async (t) => {
  let finish;
  let cancelCalls = 0;
  const service = createDelegationService({
    agentExists: () => true,
    maxConcurrentPerCaller: 1,
    dispatch: (task, context) => {
      context.reportWorkerTaskId(`worker-${task.id}`);
      return new Promise((resolve) => { finish = resolve; });
    },
    cancel: async () => { cancelCalls += 1; }
  });
  t.after(async () => {
    finish?.({ status: 'cancelled' });
    await service.close();
  });

  const running = service.submit({ targetAgentId: 'a', prompt: 'Wait' }, user);
  assert.throws(
    () => service.submit({ targetAgentId: 'b', prompt: 'Too many' }, user),
    { status: 429 }
  );
  const cancelled = await service.cancel(running.id, user);
  assert.equal(cancelled.status, 'running');
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.workerTaskId, `worker-${running.id}`);
  assert.equal(cancelCalls, 1);
  finish({ status: 'cancelled' });
  await service.whenIdle();
  assert.equal(service.get(running.id, user).status, 'cancelled');
});

test('a failed worker cancellation is not reported as completed', async (t) => {
  let finish;
  const service = createDelegationService({
    dispatch: () => new Promise((resolve) => { finish = resolve; }),
    cancel: async () => { throw new Error('worker unreachable'); }
  });
  t.after(async () => {
    finish?.({ status: 'succeeded' });
    await service.close();
  });
  const running = service.submit({ targetAgentId: 'a', prompt: 'Wait' }, user);
  await assert.rejects(service.cancel(running.id, user), /worker unreachable/);
  const retained = service.get(running.id, user);
  assert.equal(retained.status, 'running');
  assert.equal(retained.cancelRequested, false);
  finish({ status: 'succeeded' });
  await service.whenIdle();
});

test('a task that finishes while cancellation is in flight keeps its real result', async (t) => {
  let finish;
  let failCancellation;
  const service = createDelegationService({
    dispatch: () => new Promise((resolve) => { finish = resolve; }),
    cancel: () => new Promise((resolve, reject) => { failCancellation = reject; })
  });
  t.after(() => service.close());

  const running = service.submit({ targetAgentId: 'a', prompt: 'Finish at the boundary' }, user);
  const cancellation = service.cancel(running.id, user);
  finish({ status: 'succeeded', output: 'real output', usage: { totalTokens: 7 } });
  await service.whenIdle();
  failCancellation(new Error('worker closed after completion'));

  const returned = await cancellation;
  assert.equal(returned.status, 'succeeded');
  assert.equal(returned.output, 'real output');
  assert.deepEqual(returned.usage, { totalTokens: 7 });
  assert.equal(service.get(running.id, user).status, 'succeeded');
});

test('completion persistence failures release the caller slot and remain observable', async (t) => {
  let clockCalls = 0;
  const service = createDelegationService({
    maxConcurrentPerCaller: 1,
    clock: () => {
      clockCalls += 1;
      if (clockCalls === 4) throw new Error('completion clock failed');
      return new Date(Date.UTC(2026, 0, 1, 0, 0, clockCalls));
    },
    dispatch: async () => ({ status: 'succeeded', output: 'would have succeeded' })
  });
  t.after(() => service.close());

  const first = service.submit({ targetAgentId: 'a', prompt: 'Trigger persistence failure' }, user);
  await service.whenIdle();
  const failed = service.get(first.id, user);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /completion could not be persisted/i);
  assert.equal(service.status().healthy, false);
  assert.match(service.status().lastExecutionError.message, /completion clock failed/);

  const second = service.submit({ targetAgentId: 'b', prompt: 'Caller slot is available' }, user);
  await service.whenIdle();
  assert.equal(service.get(second.id, user).status, 'succeeded');
});

test('durable tasks survive restart and in-flight work is never replayed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dock-delegation-'));
  const path = join(directory, 'delegations.sqlite');
  let finish;
  const first = createDelegationService({
    path,
    dispatch: () => new Promise((resolve) => { finish = resolve; })
  });
  t.after(async () => {
    finish?.({ status: 'succeeded' });
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const submitted = first.submit({ targetAgentId: 'a', prompt: 'Do not replay me' }, user);
  assert.equal(first.get(submitted.id, user).status, 'running');

  const restarted = createDelegationService({
    path,
    dispatch: async () => { throw new Error('recovered work must not dispatch'); }
  });
  const recovered = restarted.get(submitted.id, user);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /restarted/);
  await restarted.close();

  finish({ status: 'succeeded' });
  await first.whenIdle();
  assert.equal(first.get(submitted.id, user).status, 'failed', 'the old completion cannot overwrite recovery');
});
