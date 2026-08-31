import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControlPlane } from '../control-plane/server.mjs';
import { createScheduler, nextCronOccurrence, parseCron, ScheduleStore } from '../control-plane/scheduler.mjs';

function mutableClock(initial) {
  let current = new Date(initial);
  return {
    clock: () => new Date(current),
    set(value) { current = new Date(value); }
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('five-field cron supports ranges, lists, steps, and standard day matching', () => {
  const parsed = parseCron('*/15 8-18 * * 1-5');
  assert.equal(parsed.expression, '*/15 8-18 * * 1-5');
  assert.deepEqual([...parsed.minute.values], [0, 15, 30, 45]);
  assert.equal(nextCronOccurrence(parsed, 'America/New_York', '2026-08-28T22:46:00Z'), '2026-08-31T12:00:00.000Z');
  assert.throws(() => parseCron('0 9 * *'), /exactly five/);
  assert.throws(() => parseCron('60 9 * * *'), /minute must be from 0 to 59/);
});

test('cron calculation follows IANA timezone DST transitions deterministically', () => {
  assert.equal(
    nextCronOccurrence('30 2 * * *', 'America/New_York', '2026-03-07T07:31:00Z'),
    '2026-03-09T06:30:00.000Z',
    'the nonexistent spring-forward 02:30 is skipped'
  );
  assert.equal(
    nextCronOccurrence('30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z'),
    '2026-11-01T06:30:00.000Z',
    'both real instants in the repeated fall-back hour are occurrences'
  );
  assert.throws(
    () => nextCronOccurrence('0 9 * * *', 'Mars/Olympus_Mons', '2026-01-01T00:00:00Z'),
    /valid IANA timezone/
  );
});

test('a claimed one-off occurrence is not dispatched again after restart', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'agent-dock-schedule-restart-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, 'scheduler.sqlite');
  const time = mutableClock('2026-08-30T12:00:00Z');
  let store = new ScheduleStore({ path, clock: time.clock, ownerId: 'first-process' });
  const schedule = store.create({
    id: 'restart-once',
    name: 'Restart safety',
    agentId: 'worker-01',
    prompt: 'Do this once',
    timing: { kind: 'once', at: '2026-08-30T12:01:00Z' }
  });
  time.set('2026-08-30T12:01:05Z');
  const [claim] = store.claimDue();
  assert.equal(claim.schedule.id, schedule.id);
  assert.equal(claim.run.status, 'claimed');
  store.close();

  store = new ScheduleStore({ path, clock: time.clock, ownerId: 'second-process' });
  assert.deepEqual(store.claimDue(), []);
  assert.equal(store.require(schedule.id).state, 'completed');
  const [run] = store.listRuns(schedule.id);
  assert.equal(run.status, 'interrupted');
  assert.match(run.error, /restarted/);
  store.close();
});

test('scheduler prevents overlapping jobs for one agent and records the skipped occurrence', async () => {
  const time = mutableClock('2026-08-30T12:00:10Z');
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let dispatches = 0;
  const scheduler = createScheduler({
    clock: time.clock,
    agentExists: (id) => id === 'worker-01',
    dispatch: async () => {
      dispatches += 1;
      await blocker;
      return { status: 'succeeded', taskId: 'task-1', usage: { totalTokens: 12 } };
    }
  });
  const base = {
    agentId: 'worker-01',
    prompt: 'Run safely',
    timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }
  };
  const first = scheduler.create({ ...base, id: 'first', name: 'First' });
  const second = scheduler.create({ ...base, id: 'second', name: 'Second' });
  time.set('2026-08-30T12:01:05Z');
  await scheduler.tick();
  release();
  await scheduler.whenIdle();

  assert.equal(dispatches, 1);
  const runs = [...scheduler.runs(first.id), ...scheduler.runs(second.id)];
  assert.deepEqual(runs.map((run) => run.status).sort(), ['skipped_busy', 'succeeded']);
  assert.equal(runs.find((run) => run.status === 'succeeded').usage.totalTokens, 12);
  scheduler.close();
});

test('scheduler contains persistence failures without leaking an unhandled execution', async () => {
  const store = {
    path: ':memory:',
    clock: () => new Date('2026-08-30T12:00:00Z'),
    claimManual: () => ({
      run: { id: 'run-1' },
      schedule: { id: 'schedule-1', agentId: 'worker-01' }
    }),
    startRun() {},
    getRun: () => ({ id: 'run-1' }),
    finishRun() { throw new Error('scheduler database unavailable'); },
    close() {}
  };
  const scheduler = createScheduler({
    store,
    dispatch: async () => ({ status: 'succeeded' })
  });

  scheduler.runNow('schedule-1');
  await scheduler.whenIdle();

  assert.equal(scheduler.status().activeExecutions, 0);
  assert.match(scheduler.status().lastExecutionError, /database unavailable/);
  scheduler.close();
});

test('a transient success persistence failure is not rewritten as a failed task', async () => {
  const finishAttempts = [];
  const store = {
    path: ':memory:',
    clock: () => new Date('2026-08-30T12:00:00Z'),
    claimManual: () => ({
      run: { id: 'run-1' },
      schedule: { id: 'schedule-1', agentId: 'worker-01' }
    }),
    startRun() {},
    getRun: () => ({ id: 'run-1' }),
    finishRun(id, result) {
      finishAttempts.push({ id, result });
      if (finishAttempts.length === 1) throw new Error('transient sqlite failure');
      return { id, ...result };
    },
    close() {}
  };
  const scheduler = createScheduler({
    store,
    dispatch: async () => ({ status: 'succeeded', taskId: 'task-1' })
  });

  scheduler.runNow('schedule-1');
  await scheduler.whenIdle();

  assert.deepEqual(finishAttempts, [{
    id: 'run-1',
    result: { status: 'succeeded', taskId: 'task-1' }
  }]);
  assert.match(scheduler.status().lastExecutionError, /transient sqlite failure/);
  scheduler.close();
});

test('cron misfires are skipped once and advance directly to the next future occurrence', async () => {
  const time = mutableClock('2026-08-30T12:00:10Z');
  let dispatches = 0;
  const scheduler = createScheduler({
    clock: time.clock,
    agentExists: () => true,
    dispatch: async () => { dispatches += 1; return { status: 'succeeded' }; }
  });
  const schedule = scheduler.create({
    id: 'misfire',
    name: 'Misfire',
    agentId: 'worker-01',
    prompt: 'Do not catch up in a burst',
    timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    policies: { misfireGraceMs: 30_000 }
  });
  time.set('2026-08-30T12:05:00Z');
  await scheduler.tick();
  await scheduler.whenIdle();
  assert.equal(dispatches, 0);
  assert.equal(scheduler.runs(schedule.id)[0].status, 'skipped_misfire');
  assert.equal(scheduler.get(schedule.id).nextRunAt, '2026-08-30T12:06:00.000Z');
  scheduler.close();
});

test('control-plane schedule API supports CRUD, lifecycle, manual run, and history', async (t) => {
  const time = mutableClock('2026-08-30T12:00:00Z');
  const control = createControlPlane({
    workerToken: 'test-worker-secret',
    dataPath: null,
    schedulerEnabled: false,
    clock: time.clock,
    scheduleDispatch: async () => ({ status: 'succeeded', taskId: 'scheduled-task' })
  });
  const controlUrl = await listen(control);
  t.after(() => new Promise((resolve) => control.close(resolve)));

  const jobsPage = await fetch(`${controlUrl}/jobs`);
  assert.equal(jobsPage.status, 200);
  const jobsHtml = await jobsPage.text();
  assert.match(jobsHtml, /id="jobs-view"/);
  assert.match(jobsHtml, /id="job-dialog"/);

  let response = await fetch(`${controlUrl}/api/v1/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'weekday-brief',
      name: 'Weekday brief',
      agentId: 'worker-01',
      prompt: 'Prepare the brief',
      timing: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' }
    })
  });
  assert.equal(response.status, 201);
  let schedule = (await response.json()).schedule;
  assert.equal(schedule.id, 'weekday-brief');
  assert.equal(schedule.nextRunAt, '2026-08-31T13:00:00.000Z');

  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief/pause`, { method: 'POST' });
  assert.equal((await response.json()).schedule.state, 'paused');
  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief/resume`, { method: 'POST' });
  assert.equal((await response.json()).schedule.state, 'active');
  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Prepare the updated brief' })
  });
  schedule = (await response.json()).schedule;
  assert.equal(schedule.prompt, 'Prepare the updated brief');

  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief/run-now`, { method: 'POST' });
  assert.equal(response.status, 202);
  await control.scheduler.whenIdle();
  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief/runs`);
  const [run] = (await response.json()).runs;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.taskId, 'scheduled-task');

  response = await fetch(`${controlUrl}/api/v1/schedules?includeRuns=5`);
  const listed = await response.json();
  assert.equal(listed.schedules.length, 1);
  assert.equal(listed.runs['weekday-brief'][0].taskId, 'scheduled-task');

  response = await fetch(`${controlUrl}/api/v1/schedules?includeRuns=0`);
  assert.equal(response.status, 400);

  response = await fetch(`${controlUrl}/api/v1/agents/worker-01`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /scheduled job/);

  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  response = await fetch(`${controlUrl}/api/v1/schedules/weekday-brief`);
  assert.equal(response.status, 404);
});

test('schedule creation cannot race an agent runtime deletion', async (t) => {
  let signalStop;
  let releaseStop;
  const stopStarted = new Promise((resolve) => { signalStop = resolve; });
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const runtimeManager = {
    async provision({ agentId, adapter }) {
      return {
        id: 'runtime-race',
        agentId,
        adapter,
        kind: 'managed-dedicated',
        managed: true,
        workerId: 'worker-race',
        workerUrl: 'http://127.0.0.1:9',
        workerToken: 'runtime-secret',
        state: 'running'
      };
    },
    async stop() {
      signalStop();
      await stopGate;
    },
    async start() {},
    async inspect() { return { state: 'running', health: 'healthy' }; },
    async destroy() {}
  };
  const control = createControlPlane({
    workerToken: 'test-worker-secret',
    dataPath: null,
    schedulerEnabled: false,
    runtimeManager
  });
  const controlUrl = await listen(control);
  t.after(() => {
    releaseStop();
    return new Promise((resolve) => control.close(resolve));
  });

  let response = await fetch(`${controlUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Deletion race', adapter: 'codex-cli', runtime: { mode: 'provision' } })
  });
  const agent = (await response.json()).agent;
  const deletion = fetch(`${controlUrl}/api/v1/agents/${agent.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeAction: 'retain' })
  });
  await stopStarted;

  response = await fetch(`${controlUrl}/api/v1/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'orphan-race',
      name: 'Must not be orphaned',
      agentId: agent.id,
      prompt: 'Do not accept this job',
      timing: { kind: 'once', at: '2099-01-01T00:00:00Z' }
    })
  });
  assert.equal(response.status, 404);
  releaseStop();
  assert.equal((await deletion).status, 204);
  assert.deepEqual(control.scheduler.list(), []);
});

test('scheduled dispatch uses durable agent configuration and captures wrapper task usage', async (t) => {
  const token = 'scheduled-worker-secret';
  let taskRequest = null;
  const worker = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.method === 'GET' && req.url === '/v1/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ task: { active: null } }));
    }
    if (req.method === 'POST' && req.url === '/v1/tasks') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      taskRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ type: 'task.started', taskId: 'wrapper-task' })}\n`);
      res.write(`${JSON.stringify({ type: 'usage.updated', taskId: 'wrapper-task', data: { usage: { totalTokens: 42, durationMs: 1250 } } })}\n`);
      return res.end(`${JSON.stringify({ type: 'task.completed', taskId: 'wrapper-task', data: { status: 'succeeded', exitCode: 0 } })}\n`);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const workerUrl = await listen(worker);
  const control = createControlPlane({ workerUrl, workerToken: token, dataPath: null, schedulerEnabled: false });
  const controlUrl = await listen(control);
  t.after(() => Promise.all([
    new Promise((resolve) => control.close(resolve)),
    new Promise((resolve) => worker.close(resolve))
  ]));

  await fetch(`${controlUrl}/api/v1/agents/worker-01`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ durablePrompt: 'Use the approved operating procedure.' })
  });
  let response = await fetch(`${controlUrl}/api/v1/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'wrapper-dispatch',
      name: 'Wrapper dispatch',
      agentId: 'worker-01',
      prompt: 'Prepare the report.',
      timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }
    })
  });
  assert.equal(response.status, 201);
  response = await fetch(`${controlUrl}/api/v1/schedules/wrapper-dispatch/run-now`, { method: 'POST' });
  assert.equal(response.status, 202);
  await control.scheduler.whenIdle();

  assert.deepEqual(taskRequest, {
    prompt: 'Prepare the report.',
    instructions: 'Use the approved operating procedure.',
    modelPolicy: { mode: 'provider-default', primary: null, fallbacks: [], externalFallback: false }
  });
  response = await fetch(`${controlUrl}/api/v1/schedules/wrapper-dispatch/runs`);
  const [run] = (await response.json()).runs;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.taskId, 'wrapper-task');
  assert.deepEqual(run.usage, { totalTokens: 42, durationMs: 1250 });
});
