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
  const service = createDelegationService({
    agentExists: (id) => ['a', 'b', 'c'].includes(id),
    dispatch: async () => ({ status: 'succeeded' }),
    maxDepth: 4
  });
  t.after(() => service.close());

  const root = service.submit({ targetAgentId: 'b', prompt: 'First hop' }, agentA);
  await service.whenIdle();
  const child = service.submit({ targetAgentId: 'c', prompt: 'Second hop', parentTaskId: root.id }, agentB);
  await service.whenIdle();
  const storedChild = service.get(child.id, agentC);
  assert.equal(storedChild.parentTaskId, root.id);
  assert.equal(storedChild.traceId, root.traceId);
  assert.equal(storedChild.depth, 2);

  assert.throws(
    () => service.submit({ targetAgentId: 'a', prompt: 'Cycle', parentTaskId: child.id }, agentC),
    /cycle/i
  );
  assert.throws(
    () => service.submit({ targetAgentId: 'a', prompt: 'Spoofed parent', parentTaskId: root.id }, agentC),
    { status: 403 }
  );
  assert.throws(() => service.submit({ targetAgentId: 'a', prompt: 'Self call' }, agentA), /cycle/i);
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
