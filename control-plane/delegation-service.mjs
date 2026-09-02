import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped_busy']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, name, { required = false, max = 50_000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw httpError(`${name} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw httpError(`${name} is required`);
  if (normalized.length > max) throw httpError(`${name} must be at most ${max} characters`);
  return normalized;
}

function publicTask(row, { includePrompt = false } = {}) {
  if (!row) return null;
  const task = {
    id: row.id,
    traceId: row.trace_id,
    parentTaskId: row.parent_task_id,
    depth: row.depth,
    caller: {
      id: row.caller_id,
      type: row.caller_type,
      agentId: row.caller_agent_id
    },
    targetAgentId: row.target_agent_id,
    status: row.status,
    workerTaskId: row.worker_task_id,
    output: row.output_text,
    error: row.error,
    usage: parseJson(row.usage_json, null),
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
  if (includePrompt) task.prompt = row.prompt;
  return task;
}

function normalizeResult(result = {}) {
  const allowed = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped_busy']);
  return {
    status: allowed.has(result.status) ? result.status : 'failed',
    workerTaskId: result.taskId ? String(result.taskId) : null,
    output: result.output ? String(result.output).slice(0, 100_000) : null,
    error: result.error ? String(result.error).slice(0, 4_000) : null,
    usage: result.usage ?? null
  };
}

export function createDelegationService(options = {}) {
  const path = options.path ?? ':memory:';
  const clock = options.clock ?? (() => new Date());
  const dispatch = options.dispatch ?? (async () => ({ status: 'failed', error: 'No delegation dispatcher is configured' }));
  const cancelWorker = options.cancel ?? (async () => {});
  const agentExists = options.agentExists ?? (() => true);
  const maxDepth = Number(options.maxDepth ?? 4);
  const maxConcurrentPerCaller = Number(options.maxConcurrentPerCaller ?? 4);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 20) throw new Error('MCP_MAX_DELEGATION_DEPTH must be between 1 and 20');
  if (!Number.isInteger(maxConcurrentPerCaller) || maxConcurrentPerCaller < 1 || maxConcurrentPerCaller > 100) {
    throw new Error('MCP_MAX_CONCURRENT_PER_CALLER must be between 1 and 100');
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS delegation_tasks (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_task_id TEXT REFERENCES delegation_tasks(id),
      depth INTEGER NOT NULL,
      lineage_json TEXT NOT NULL,
      caller_id TEXT NOT NULL,
      caller_type TEXT NOT NULL,
      caller_agent_id TEXT,
      target_agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_task_id TEXT,
      output_text TEXT,
      error TEXT,
      usage_json TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delegation_tasks_caller_status ON delegation_tasks(caller_id, status);
    CREATE INDEX IF NOT EXISTS delegation_tasks_trace ON delegation_tasks(trace_id, depth);
    CREATE INDEX IF NOT EXISTS delegation_tasks_target ON delegation_tasks(target_agent_id, created_at);
    PRAGMA user_version = 1;
  `);

  // Delegated work is never replayed after a control-plane restart. The
  // caller can inspect the durable failure and choose whether to resubmit.
  const recoveredAt = clock().toISOString();
  db.prepare(`
    UPDATE delegation_tasks
    SET status = 'failed', error = 'Control plane restarted before delegation completed',
      finished_at = ?, updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(recoveredAt, recoveredAt);

  const active = new Set();
  let closed = false;
  let lastExecutionError = null;

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  function recordExecutionError(id, error) {
    const at = new Date().toISOString();
    const message = error?.message ?? String(error);
    lastExecutionError = { taskId: id, at, message };
    try {
      db.prepare(`
        UPDATE delegation_tasks
        SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(`Delegation completion could not be persisted: ${message}`.slice(0, 4_000), at, at, id);
    } catch (fallbackError) {
      lastExecutionError = {
        taskId: id,
        at,
        message: `${message}; fallback persistence failed: ${fallbackError?.message ?? String(fallbackError)}`
      };
    }
  }

  function requireRow(id) {
    const row = db.prepare('SELECT * FROM delegation_tasks WHERE id = ?').get(id);
    if (!row) throw httpError('Delegated task not found', 404);
    return row;
  }

  function canRead(row, caller) {
    return caller?.isAdmin
      || row.caller_id === caller?.id
      || (caller?.agentId && row.target_agent_id === caller.agentId);
  }

  function canCancel(row, caller) {
    return caller?.isAdmin || row.caller_id === caller?.id;
  }

  async function execute(id) {
    if (closed) return;
    const initial = requireRow(id);
    if (initial.status !== 'queued' || initial.cancel_requested) return;
    const startedAt = clock().toISOString();
    const claimed = db.prepare(`
      UPDATE delegation_tasks SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0
    `).run(startedAt, startedAt, id);
    if (claimed.changes !== 1) return;

    const promise = (async () => {
      let result;
      try {
        result = normalizeResult(await dispatch(publicTask(requireRow(id), { includePrompt: true }), {
          reportWorkerTaskId: (value) => {
            const workerTaskId = text(value, 'workerTaskId', { required: true, max: 200 });
            db.prepare(`
              UPDATE delegation_tasks SET worker_task_id = ?, updated_at = ?
              WHERE id = ? AND status = 'running'
            `).run(workerTaskId, clock().toISOString(), id);
          }
        }));
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        result = normalizeResult({ status: timedOut ? 'timed_out' : 'failed', error: error?.message ?? String(error) });
      }
      try {
        const current = requireRow(id);
        if (current.status !== 'running') return publicTask(current);
        const finishedAt = clock().toISOString();
        db.prepare(`
          UPDATE delegation_tasks
          SET status = ?, worker_task_id = ?, output_text = ?, error = ?, usage_json = ?,
            finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(
          result.status,
          result.workerTaskId ?? current.worker_task_id,
          result.output,
          result.error,
          result.usage === null ? null : JSON.stringify(result.usage),
          finishedAt,
          finishedAt,
          id
        );
        return publicTask(requireRow(id));
      } catch (error) {
        recordExecutionError(id, error);
        return publicTask(requireRow(id));
      }
    })();
    active.add(promise);
    promise.then(
      () => active.delete(promise),
      () => active.delete(promise)
    );
    return promise;
  }

  function submit(input, caller, policy = {}) {
    if (closed) throw httpError('Delegation service is shutting down', 503);
    if (!caller?.id) throw httpError('Delegation caller identity is required', 401);
    const targetAgentId = text(input.targetAgentId, 'targetAgentId', { required: true, max: 200 });
    const prompt = text(input.prompt, 'prompt', { required: true });
    if (!agentExists(targetAgentId)) throw httpError('Target agent not found', 404);

    const callerLimit = Math.min(maxConcurrentPerCaller, Number(policy.maxConcurrent ?? maxConcurrentPerCaller));
    if (!Number.isInteger(callerLimit) || callerLimit < 1 || callerLimit > maxConcurrentPerCaller) {
      throw httpError('Caller concurrency policy is invalid', 500);
    }
    const callerDepthLimit = Math.min(maxDepth, Number(policy.maxDepth ?? maxDepth));
    if (!Number.isInteger(callerDepthLimit) || callerDepthLimit < 1 || callerDepthLimit > maxDepth) {
      throw httpError('Caller depth policy is invalid', 500);
    }
    const id = randomUUID();
    transaction(() => {
      const activeForCaller = db.prepare(`
        SELECT COUNT(*) AS count FROM delegation_tasks
        WHERE caller_id = ? AND status IN ('queued', 'running')
      `).get(caller.id).count;
      if (activeForCaller >= callerLimit) throw httpError('Caller delegation concurrency limit reached', 429);

      let parent = null;
      let traceId = randomUUID();
      let depth = 1;
      let lineage = caller.agentId ? [caller.agentId] : [];
      if (caller.agentId) {
        const inbound = db.prepare(`
          SELECT * FROM delegation_tasks
          WHERE target_agent_id = ? AND status IN ('queued', 'running')
          ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
            started_at DESC, created_at DESC, id DESC
          LIMIT 2
        `).all(caller.agentId);
        if (inbound.length > 1) {
          throw httpError('Calling agent has ambiguous active delegation context', 409);
        }
        parent = inbound[0] ?? null;
      }
      if (input.parentTaskId) {
        const requestedId = text(input.parentTaskId, 'parentTaskId', { required: true, max: 200 });
        if (!parent || parent.id !== requestedId) {
          throw httpError('Parent task does not match the calling agent active delegation', 403);
        }
      }
      if (parent) {
        traceId = parent.trace_id;
        depth = parent.depth + 1;
        lineage = parseJson(parent.lineage_json, []);
      }
      if (depth > callerDepthLimit) throw httpError('Maximum delegation depth exceeded', 409);
      if (lineage.includes(targetAgentId)) throw httpError('Delegation cycle detected', 409);
      lineage = [...lineage, targetAgentId];

      const now = clock().toISOString();
      db.prepare(`
        INSERT INTO delegation_tasks (
          id, trace_id, parent_task_id, depth, lineage_json, caller_id, caller_type,
          caller_agent_id, target_agent_id, prompt, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(
        id,
        traceId,
        parent?.id ?? null,
        depth,
        JSON.stringify(lineage),
        caller.id,
        caller.type ?? 'unknown',
        caller.agentId ?? null,
        targetAgentId,
        prompt,
        now,
        now
      );
    });
    const submitted = publicTask(requireRow(id));
    void execute(id).catch((error) => recordExecutionError(id, error));
    return submitted;
  }

  function get(id, caller, { includePrompt = false } = {}) {
    const row = requireRow(text(id, 'taskId', { required: true, max: 200 }));
    if (!canRead(row, caller)) throw httpError('Delegated task is not visible to this caller', 403);
    return publicTask(row, { includePrompt });
  }

  async function cancel(id, caller) {
    const row = requireRow(text(id, 'taskId', { required: true, max: 200 }));
    if (!canCancel(row, caller)) throw httpError('Delegated task cannot be cancelled by this caller', 403);
    if (TERMINAL.has(row.status)) return publicTask(row);
    const now = clock().toISOString();
    if (row.status === 'queued') {
      db.prepare(`
        UPDATE delegation_tasks SET status = 'cancelled', cancel_requested = 1,
          error = 'Cancellation requested by caller', finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(now, now, row.id);
      return publicTask(requireRow(row.id));
    }
    const requested = db.prepare(`
      UPDATE delegation_tasks SET cancel_requested = 1, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, row.id);
    if (requested.changes !== 1) return publicTask(requireRow(row.id));
    try {
      await cancelWorker(publicTask(requireRow(row.id), { includePrompt: true }));
    } catch (error) {
      const current = requireRow(row.id);
      if (TERMINAL.has(current.status)) return publicTask(current);
      db.prepare(`
        UPDATE delegation_tasks SET cancel_requested = 0, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(clock().toISOString(), row.id);
      throw httpError(`Worker cancellation failed: ${error?.message ?? String(error)}`, error?.status ?? 502);
    }
    // A worker cancellation request is asynchronous. Keep the durable task in
    // running state until its stream terminates, but surface the requested bit
    // immediately so callers do not mistake acceptance for completion.
    return publicTask(requireRow(row.id));
  }

  return {
    path,
    submit,
    get,
    cancel,
    hasActiveForAgent: (agentId) => Boolean(db.prepare(`
      SELECT 1 FROM delegation_tasks
      WHERE target_agent_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(agentId)),
    status: () => ({
      healthy: lastExecutionError === null,
      activeExecutions: active.size,
      lastExecutionError
    }),
    list: ({ traceId = null, targetAgentId = null, limit = 100 } = {}) => {
      const clauses = [];
      const args = [];
      if (traceId) { clauses.push('trace_id = ?'); args.push(traceId); }
      if (targetAgentId) { clauses.push('target_agent_id = ?'); args.push(targetAgentId); }
      const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM delegation_tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, bounded).map((row) => publicTask(row));
    },
    whenIdle: async () => { await Promise.allSettled([...active]); },
    close: async () => {
      closed = true;
      await Promise.allSettled([...active]);
      db.close();
    }
  };
}
