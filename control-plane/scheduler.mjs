import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MISFIRE_GRACE_MS = 60_000;
const TERMINAL_RUN_STATES = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'skipped_busy',
  'skipped_misfire',
  'interrupted'
]);
const WEEKDAYS = new Map([
  ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]
]);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw httpError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw httpError(`${field} is too long`, 413);
  return normalized;
}

function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(`${field} must be an object`);
  return value;
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw httpError(`${field} must be an integer from ${min} to ${max}`);
  }
  return number;
}

export function normalizeTimeZone(value = 'UTC') {
  const requested = requiredString(value, 'timing.timezone', 120);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: requested }).resolvedOptions().timeZone;
  } catch {
    throw httpError('timing.timezone must be a valid IANA timezone');
  }
}

function parseCronNumber(source, field, min, max, sundayAlias) {
  if (!/^\d+$/.test(source)) throw httpError(`timing.expression has an invalid ${field} value`);
  const parsed = Number(source);
  if (parsed < min || parsed > max) throw httpError(`timing.expression ${field} must be from ${min} to ${max}`);
  return sundayAlias && parsed === 7 ? 0 : parsed;
}

function parseCronField(source, field, min, max, { sundayAlias = false } = {}) {
  const values = new Set();
  const wildcard = source === '*';
  for (const segment of source.split(',')) {
    if (!segment) throw httpError(`timing.expression has an empty ${field} segment`);
    const [rangeSource, stepSource, extra] = segment.split('/');
    if (extra !== undefined) throw httpError(`timing.expression has an invalid ${field} step`);
    const step = stepSource === undefined
      ? 1
      : positiveInteger(stepSource, `timing.expression ${field} step`, { max: max - min + 1 });
    let start;
    let end;
    if (rangeSource === '*') {
      start = min;
      end = max;
    } else if (rangeSource.includes('-')) {
      const bounds = rangeSource.split('-');
      if (bounds.length !== 2) throw httpError(`timing.expression has an invalid ${field} range`);
      const rawStart = parseCronNumber(bounds[0], field, min, max, false);
      const rawEnd = parseCronNumber(bounds[1], field, min, max, false);
      if (rawStart > rawEnd) throw httpError(`timing.expression ${field} ranges cannot wrap`);
      start = rawStart;
      end = rawEnd;
    } else {
      if (stepSource !== undefined) throw httpError(`timing.expression ${field} steps require * or a range`);
      start = parseCronNumber(rangeSource, field, min, max, false);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  if (!values.size) throw httpError(`timing.expression has no ${field} values`);
  return { values, wildcard };
}

export function parseCron(expression) {
  const normalized = requiredString(expression, 'timing.expression', 240).replace(/\s+/g, ' ');
  const fields = normalized.split(' ');
  if (fields.length !== 5) throw httpError('timing.expression must contain exactly five cron fields');
  return {
    expression: normalized,
    minute: parseCronField(fields[0], 'minute', 0, 59),
    hour: parseCronField(fields[1], 'hour', 0, 23),
    dayOfMonth: parseCronField(fields[2], 'day-of-month', 1, 31),
    month: parseCronField(fields[3], 'month', 1, 12),
    dayOfWeek: parseCronField(fields[4], 'day-of-week', 0, 7, { sundayAlias: true })
  };
}

const formatterCache = new Map();

function localParts(date, timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: WEEKDAYS.get(parts.weekday)
  };
}

function cronDayMatches(parsed, month, dayOfMonthValue, dayOfWeekValue) {
  if (!parsed.month.values.has(month)) return false;
  const dayOfMonth = parsed.dayOfMonth.values.has(dayOfMonthValue);
  const dayOfWeek = parsed.dayOfWeek.values.has(dayOfWeekValue);
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dayOfWeek;
  if (parsed.dayOfWeek.wildcard) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
}

const offsetCache = new Map();

function offsetMinutesAt(date, timeZone) {
  const parts = localParts(date, timeZone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute);
  const actualUtc = Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;
  return (representedAsUtc - actualUtc) / MINUTE_MS;
}

function possibleOffsets(timeZone, startYear) {
  const key = `${timeZone}:${startYear}`;
  const cached = offsetCache.get(key);
  if (cached) return cached;
  const offsets = new Set();
  // Sampling twice per month across the search horizon captures both sides of
  // ordinary DST changes as well as zones with seasonal rules such as Morocco.
  // Candidate instants are still verified against Intl before they are used.
  for (let year = startYear - 1; year <= startYear + 8; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      offsets.add(offsetMinutesAt(new Date(Date.UTC(year, month, 1, 12)), timeZone));
      offsets.add(offsetMinutesAt(new Date(Date.UTC(year, month, 15, 12)), timeZone));
    }
  }
  const result = [...offsets];
  offsetCache.set(key, result);
  return result;
}

function resolveLocalMinute(year, month, day, hour, minute, timeZone, offsets) {
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute);
  const matches = [];
  for (const offset of offsets) {
    const candidate = new Date(localEpoch - offset * MINUTE_MS);
    const parts = localParts(candidate, timeZone);
    if (parts.year === year && parts.month === month && parts.dayOfMonth === day
      && parts.hour === hour && parts.minute === minute) matches.push(candidate);
  }
  return matches;
}

export function nextCronOccurrence(expression, timeZone, after) {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const afterDate = after instanceof Date ? after : new Date(after);
  if (!Number.isFinite(afterDate.getTime())) throw httpError('A valid reference time is required');
  const localAfter = localParts(afterDate, normalizedTimeZone);
  const firstCalendarDay = Date.UTC(localAfter.year, localAfter.month - 1, localAfter.dayOfMonth);
  const offsets = possibleOffsets(normalizedTimeZone, localAfter.year);
  const hours = [...parsed.hour.values].sort((a, b) => a - b);
  const minutes = [...parsed.minute.values].sort((a, b) => a - b);
  for (let dayOffset = 0; dayOffset <= 8 * 366; dayOffset += 1) {
    const calendar = new Date(firstCalendarDay + dayOffset * DAY_MS);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    if (!cronDayMatches(parsed, month, day, calendar.getUTCDay())) continue;
    let next = null;
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const candidate of resolveLocalMinute(year, month, day, hour, minute, normalizedTimeZone, offsets)) {
          if (candidate.getTime() > afterDate.getTime() && (!next || candidate < next)) next = candidate;
        }
      }
    }
    if (next) return next.toISOString();
  }
  throw httpError('timing.expression has no occurrence within the next eight years');
}

function normalizeTiming(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('timing is required');
  if (value.kind === 'once') {
    const at = requiredString(value.at, 'timing.at', 80);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) throw httpError('timing.at must include Z or a UTC offset');
    const timestamp = new Date(at);
    if (!Number.isFinite(timestamp.getTime())) throw httpError('timing.at must be a valid ISO 8601 timestamp');
    if (timestamp.getTime() <= now.getTime()) throw httpError('timing.at must be in the future');
    return { kind: 'once', at: timestamp.toISOString(), expression: null, timezone: null };
  }
  if (value.kind === 'cron') {
    const parsed = parseCron(value.expression);
    const timezone = normalizeTimeZone(value.timezone ?? 'UTC');
    return {
      kind: 'cron',
      at: null,
      expression: parsed.expression,
      timezone
    };
  }
  throw httpError('timing.kind must be once or cron');
}

function normalizePolicies(value = {}, current = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw httpError('policies must be an object');
  const overlap = value.overlap ?? current.overlap ?? 'skip-if-busy';
  if (overlap !== 'skip-if-busy') throw httpError('policies.overlap currently supports only skip-if-busy');
  const misfire = value.misfire ?? current.misfire ?? 'skip';
  if (misfire !== 'skip') throw httpError('policies.misfire currently supports only skip');
  const timeoutMs = value.timeoutMs === undefined
    ? (current.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : positiveInteger(value.timeoutMs, 'policies.timeoutMs', { min: 1000, max: 24 * 60 * 60 * 1000 });
  const maxAttempts = value.maxAttempts === undefined
    ? (current.maxAttempts ?? 1)
    : positiveInteger(value.maxAttempts, 'policies.maxAttempts', { max: 1 });
  const misfireGraceMs = value.misfireGraceMs === undefined
    ? (current.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS)
    : positiveInteger(value.misfireGraceMs, 'policies.misfireGraceMs', { min: 1000, max: 24 * 60 * 60 * 1000 });
  return { overlap, misfire, timeoutMs, maxAttempts, misfireGraceMs };
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    prompt: row.prompt,
    timing: row.kind === 'once'
      ? { kind: 'once', at: row.run_at }
      : { kind: 'cron', expression: row.cron_expression, timezone: row.timezone },
    state: row.state,
    nextRunAt: row.next_run_at,
    policies: {
      overlap: row.overlap_policy,
      misfire: row.misfire_policy,
      timeoutMs: row.timeout_ms,
      maxAttempts: row.max_attempts,
      misfireGraceMs: row.misfire_grace_ms
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRun(row) {
  if (!row) return null;
  let usage = null;
  if (row.usage_json) {
    try { usage = JSON.parse(row.usage_json); } catch { usage = null; }
  }
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    occurrenceAt: row.occurrence_at,
    trigger: row.trigger,
    attempt: row.attempt,
    taskId: row.task_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
    usage,
    createdAt: row.created_at
  };
}

function nextRunFor(timing, now) {
  return timing.kind === 'once'
    ? timing.at
    : nextCronOccurrence(timing.expression, timing.timezone, now);
}

export class ScheduleStore {
  constructor({ path = ':memory:', clock = () => new Date(), ownerId = randomUUID() } = {}) {
    this.path = path;
    this.clock = clock;
    this.ownerId = ownerId;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
        run_at TEXT,
        cron_expression TEXT,
        timezone TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'deleted')),
        next_run_at TEXT,
        overlap_policy TEXT NOT NULL,
        misfire_policy TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        misfire_grace_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state, next_run_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id),
        occurrence_at TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
        attempt INTEGER NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        usage_json TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(schedule_id, occurrence_at, attempt)
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_history ON schedule_runs(schedule_id, created_at DESC);
    `);
    this.db.exec('PRAGMA user_version = 1; PRAGMA optimize;');
    const recoveredAt = this.clock().toISOString();
    this.db.prepare(`
      UPDATE schedule_runs
      SET status = 'interrupted', finished_at = ?,
          duration_ms = CASE WHEN started_at IS NULL THEN 0 ELSE MAX(0, unixepoch(?) * 1000 - unixepoch(started_at) * 1000) END,
          error = 'Control plane restarted after this occurrence was claimed',
          lease_owner = NULL, lease_expires_at = NULL
      WHERE status IN ('claimed', 'running')
    `).run(recoveredAt, recoveredAt);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  require(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!row || (!includeDeleted && row.state === 'deleted')) throw httpError('Schedule not found', 404);
    return rowToSchedule(row);
  }

  list({ agentId = null, includeDeleted = false } = {}) {
    const clauses = [];
    const parameters = [];
    if (!includeDeleted) clauses.push("state != 'deleted'");
    if (agentId) { clauses.push('agent_id = ?'); parameters.push(agentId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC`).all(...parameters).map(rowToSchedule);
  }

  create(input) {
    objectValue(input, 'schedule');
    const now = this.clock();
    const timing = normalizeTiming(input.timing, now);
    const policies = normalizePolicies(input.policies);
    const schedule = {
      id: input.id === undefined ? randomUUID() : requiredString(input.id, 'id', 120),
      name: requiredString(input.name, 'name', 160),
      agentId: requiredString(input.agentId, 'agentId', 120),
      prompt: requiredString(input.prompt, 'prompt', 100_000),
      timing,
      state: 'active',
      nextRunAt: nextRunFor(timing, now),
      policies,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(schedule.id)) throw httpError('id must contain lowercase letters, numbers, and hyphens only');
    try {
      this.db.prepare(`
        INSERT INTO schedules (
          id, name, agent_id, prompt, kind, run_at, cron_expression, timezone, state, next_run_at,
          overlap_policy, misfire_policy, timeout_ms, max_attempts, misfire_grace_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        schedule.id, schedule.name, schedule.agentId, schedule.prompt, timing.kind, timing.at, timing.expression,
        timing.timezone, schedule.state, schedule.nextRunAt, policies.overlap, policies.misfire,
        policies.timeoutMs, policies.maxAttempts, policies.misfireGraceMs, schedule.createdAt, schedule.updatedAt
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw httpError('A schedule with that id already exists', 409);
      throw error;
    }
    return this.require(schedule.id);
  }

  update(id, input) {
    objectValue(input, 'schedule update');
    const current = this.require(id);
    if (current.state === 'completed') throw httpError('Completed one-off schedules cannot be edited', 409);
    const now = this.clock();
    const timing = input.timing === undefined ? {
      kind: current.timing.kind,
      at: current.timing.at ?? null,
      expression: current.timing.expression ?? null,
      timezone: current.timing.timezone ?? null
    } : normalizeTiming(input.timing, now);
    const policies = normalizePolicies(input.policies ?? {}, current.policies);
    const name = input.name === undefined ? current.name : requiredString(input.name, 'name', 160);
    const agentId = input.agentId === undefined ? current.agentId : requiredString(input.agentId, 'agentId', 120);
    const prompt = input.prompt === undefined ? current.prompt : requiredString(input.prompt, 'prompt', 100_000);
    const nextRunAt = input.timing === undefined ? current.nextRunAt : nextRunFor(timing, now);
    this.db.prepare(`
      UPDATE schedules SET name = ?, agent_id = ?, prompt = ?, kind = ?, run_at = ?, cron_expression = ?, timezone = ?,
        next_run_at = ?, overlap_policy = ?, misfire_policy = ?, timeout_ms = ?, max_attempts = ?,
        misfire_grace_ms = ?, updated_at = ? WHERE id = ?
    `).run(
      name, agentId, prompt, timing.kind, timing.at, timing.expression, timing.timezone, nextRunAt,
      policies.overlap, policies.misfire, policies.timeoutMs, policies.maxAttempts, policies.misfireGraceMs,
      now.toISOString(), id
    );
    return this.require(id);
  }

  pause(id) {
    const schedule = this.require(id);
    if (schedule.state === 'completed') throw httpError('Completed one-off schedules cannot be paused', 409);
    if (schedule.state !== 'paused') {
      this.db.prepare("UPDATE schedules SET state = 'paused', updated_at = ? WHERE id = ?").run(this.clock().toISOString(), id);
    }
    return this.require(id);
  }

  resume(id) {
    const schedule = this.require(id);
    if (schedule.state !== 'paused') return schedule;
    const now = this.clock();
    let nextRunAt = schedule.nextRunAt;
    if (schedule.timing.kind === 'once' && new Date(schedule.timing.at).getTime() <= now.getTime()) {
      throw httpError('This one-off schedule expired while paused; update its time before resuming', 409);
    }
    if (schedule.timing.kind === 'cron' && new Date(nextRunAt).getTime() <= now.getTime()) {
      nextRunAt = nextCronOccurrence(schedule.timing.expression, schedule.timing.timezone, now);
    }
    this.db.prepare("UPDATE schedules SET state = 'active', next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, now.toISOString(), id);
    return this.require(id);
  }

  delete(id) {
    this.require(id);
    this.db.prepare("UPDATE schedules SET state = 'deleted', next_run_at = NULL, updated_at = ? WHERE id = ?")
      .run(this.clock().toISOString(), id);
  }

  listRuns(scheduleId, limit = 100) {
    this.require(scheduleId, { includeDeleted: true });
    const normalizedLimit = positiveInteger(limit, 'limit', { max: 500 });
    return this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(scheduleId, normalizedLimit).map(rowToRun);
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id);
    if (!row) throw httpError('Schedule run not found', 404);
    return rowToRun(row);
  }

  claimManual(id) {
    return this.transaction(() => {
      const schedule = this.require(id);
      let occurrenceMs = this.clock().getTime();
      while (this.db.prepare('SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND occurrence_at = ? AND attempt = 1')
        .get(id, new Date(occurrenceMs).toISOString())) occurrenceMs += 1;
      return this.insertClaim(schedule, new Date(occurrenceMs).toISOString(), 'manual');
    });
  }

  claimDue(limit = 50) {
    const now = this.clock();
    const rows = this.db.prepare(`
      SELECT id FROM schedules WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT ?
    `).all(now.toISOString(), limit);
    const claims = [];
    for (const row of rows) {
      const claim = this.transaction(() => {
        const stored = this.db.prepare("SELECT * FROM schedules WHERE id = ? AND state = 'active' AND next_run_at <= ?")
          .get(row.id, now.toISOString());
        if (!stored) return null;
        const schedule = rowToSchedule(stored);
        const occurrenceAt = schedule.nextRunAt;
        const lateBy = now.getTime() - new Date(occurrenceAt).getTime();
        const misfired = schedule.timing.kind === 'cron' && lateBy > schedule.policies.misfireGraceMs;
        let nextRunAt = null;
        let nextState = 'completed';
        if (schedule.timing.kind === 'cron') {
          nextRunAt = nextCronOccurrence(
            schedule.timing.expression,
            schedule.timing.timezone,
            misfired ? now : new Date(occurrenceAt)
          );
          nextState = 'active';
        }
        this.db.prepare('UPDATE schedules SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
          .run(nextState, nextRunAt, now.toISOString(), schedule.id);
        if (misfired) {
          const claim = this.insertClaim(schedule, occurrenceAt, 'scheduled');
          this.finishRun(claim.run.id, { status: 'skipped_misfire', finishedAt: now.toISOString() });
          return null;
        }
        return this.insertClaim(schedule, occurrenceAt, 'scheduled');
      });
      if (claim) claims.push(claim);
    }
    return claims;
  }

  insertClaim(schedule, occurrenceAt, trigger) {
    const createdAt = this.clock().toISOString();
    const runId = randomUUID();
    const leaseExpiresAt = new Date(this.clock().getTime() + schedule.policies.timeoutMs + MINUTE_MS).toISOString();
    this.db.prepare(`
      INSERT INTO schedule_runs (
        id, schedule_id, occurrence_at, trigger, attempt, status, lease_owner, lease_expires_at, created_at
      ) VALUES (?, ?, ?, ?, 1, 'claimed', ?, ?, ?)
    `).run(runId, schedule.id, occurrenceAt, trigger, this.ownerId, leaseExpiresAt, createdAt);
    return { run: this.getRun(runId), schedule };
  }

  startRun(id) {
    const startedAt = this.clock().toISOString();
    this.db.prepare("UPDATE schedule_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'claimed'")
      .run(startedAt, id);
    return this.getRun(id);
  }

  finishRun(id, result) {
    const run = this.getRun(id);
    const status = result.status;
    if (!TERMINAL_RUN_STATES.has(status)) throw new Error(`Invalid terminal schedule run state: ${status}`);
    const finishedAt = result.finishedAt ?? this.clock().toISOString();
    const startedAt = run.startedAt ?? finishedAt;
    const durationMs = result.durationMs ?? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
    this.db.prepare(`
      UPDATE schedule_runs SET status = ?, task_id = ?, finished_at = ?, duration_ms = ?, error = ?, usage_json = ?,
        lease_owner = NULL, lease_expires_at = NULL WHERE id = ?
    `).run(
      status,
      result.taskId ?? run.taskId,
      finishedAt,
      durationMs,
      result.error ? String(result.error).slice(0, 4000) : null,
      result.usage === undefined || result.usage === null ? null : JSON.stringify(result.usage),
      id
    );
    return this.getRun(id);
  }

  close() {
    this.db.close();
  }
}

export function createScheduler(options = {}) {
  const store = options.store ?? new ScheduleStore(options);
  const dispatch = options.dispatch ?? (async () => ({ status: 'failed', error: 'No scheduler dispatcher is configured' }));
  const agentExists = options.agentExists ?? (() => true);
  const activeAgents = new Set();
  const activeExecutions = new Set();
  let tickInFlight = null;
  let lastTickAt = null;
  let lastTickError = null;
  let lastExecutionError = null;
  let lastClaimed = 0;

  function requireAgent(agentId) {
    if (!agentExists(agentId)) throw httpError('Agent not found', 404);
  }

  function execute(claim) {
    const promise = (async () => {
      if (activeAgents.has(claim.schedule.agentId)) {
        return store.finishRun(claim.run.id, { status: 'skipped_busy', error: 'Agent already has a scheduled task in progress' });
      }
      activeAgents.add(claim.schedule.agentId);
      try {
        store.startRun(claim.run.id);
        let result;
        try {
          result = await dispatch(claim.schedule, store.getRun(claim.run.id));
        } catch (error) {
          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
          result = {
            status: timedOut ? 'timed_out' : 'failed',
            error: error?.message ?? String(error)
          };
        }
        return store.finishRun(claim.run.id, result);
      } finally {
        activeAgents.delete(claim.schedule.agentId);
      }
    })();
    activeExecutions.add(promise);
    promise.then(
      () => {
        lastExecutionError = null;
        activeExecutions.delete(promise);
      },
      (error) => {
        lastExecutionError = error?.message ?? String(error);
        activeExecutions.delete(promise);
      }
    );
    return promise;
  }

  function startClaims(claims) {
    for (const claim of claims) void execute(claim).catch(() => {});
  }

  const service = {
    store,
    list: (filters) => store.list(filters),
    get: (id) => store.require(id),
    create(input) {
      objectValue(input, 'schedule');
      requireAgent(input.agentId);
      return store.create(input);
    },
    update(id, input) {
      objectValue(input, 'schedule update');
      if (input.agentId !== undefined) requireAgent(input.agentId);
      return store.update(id, input);
    },
    pause: (id) => store.pause(id),
    resume: (id) => store.resume(id),
    delete: (id) => store.delete(id),
    runs: (id, limit) => store.listRuns(id, limit),
    status() {
      return {
        enabled: options.enabled !== false,
        database: store.path === ':memory:' ? 'memory' : 'sqlite',
        lastTickAt,
        lastTickError,
        lastExecutionError,
        lastClaimed,
        activeExecutions: activeExecutions.size,
        activeAgents: activeAgents.size
      };
    },
    runNow(id) {
      const claim = store.claimManual(id);
      startClaims([claim]);
      return claim.run;
    },
    tick() {
      if (tickInFlight) return tickInFlight;
      tickInFlight = Promise.resolve().then(() => {
        const claims = store.claimDue();
        lastTickAt = store.clock().toISOString();
        lastTickError = null;
        lastClaimed = claims.length;
        startClaims(claims);
        return claims.map((claim) => claim.run);
      }).catch((error) => {
        lastTickAt = store.clock().toISOString();
        lastTickError = error?.message ?? String(error);
        lastClaimed = 0;
        throw error;
      }).finally(() => { tickInFlight = null; });
      return tickInFlight;
    },
    async whenIdle() {
      while (activeExecutions.size) await Promise.allSettled([...activeExecutions]);
    },
    close() { store.close(); }
  };
  return service;
}
