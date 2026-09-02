// Conversations: the wrapper's provider-neutral idea of "keep talking to the
// same agent about the same thing".
//
// Every supported harness can resume a prior exchange, but no two agree on how.
// Claude Code accepts a session id we choose. Codex and OpenCode mint their own
// and announce it in their event stream. That difference is exactly what the
// adapter boundary exists to absorb: above the wrapper there is one opaque
// conversation id, and the provider's own session identifier never crosses it.
//
// The map is durable because the provider's sessions are. A harness records its
// session on the agent's own volume and can resume it after a restart, so a
// worker that forgot which session belonged to which conversation would strand
// recoverable context and silently start a fresh exchange — which reads to a
// caller as an agent that stopped listening.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_CONVERSATIONS = 200;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// A caller-supplied id, so it is validated like anything else off the wire.
export function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw failure('conversationId must be a string');
  const id = value.trim();
  if (!id) return null;
  if (!ID_PATTERN.test(id)) throw failure('conversationId must be alphanumeric with dots, dashes, or underscores');
  return id;
}

// What a caller may see. Deliberately not the provider session id: that is
// provider-shaped, and nothing above the wrapper has any use for it.
export function publicConversation(record) {
  return {
    id: record.id,
    turns: record.turns,
    // Whether the harness has actually given us something to resume from. A
    // conversation whose first turn failed before the session was announced has
    // no continuity to offer, and saying so is better than implying otherwise.
    resumable: Boolean(record.providerSession),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTaskId: record.lastTaskId ?? null
  };
}

// This file lives on a volume the agent itself can write, and the agent may be
// prompt-injected. publicConversation chooses which fields are returned; this
// decides what those fields are allowed to contain, so a written-in value cannot
// be echoed back through the API or crash the listing on a missing timestamp.
function isoOr(value, fallback) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function sanitize(item) {
  const now = new Date(0).toISOString();
  const createdAt = isoOr(item.createdAt, now);
  return {
    id: item.id,
    providerSession: typeof item.providerSession === 'string' && item.providerSession.length <= 200
      ? item.providerSession
      : null,
    turns: Number.isInteger(item.turns) && item.turns >= 0 ? item.turns : 0,
    createdAt,
    updatedAt: isoOr(item.updatedAt, createdAt),
    lastTaskId: typeof item.lastTaskId === 'string' && /^[0-9a-f-]{36}$/.test(item.lastTaskId)
      ? item.lastTaskId
      : null
  };
}

export function createConversationStore({ statePath = null, clock = () => new Date() } = {}) {
  let records = new Map();

  async function persist() {
    if (!statePath) return;
    await mkdir(path.dirname(statePath), { recursive: true });
    // A millisecond clock is not unique enough: two persists in the same
    // millisecond wrote the same temp path, truncating each other, and rename
    // then installed the partial document as the state file — losing every
    // mapping on the agent, not just the one being written.
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = { schemaVersion: 1, conversations: [...records.values()] };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  }

  async function load() {
    if (!statePath) return;
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      if (!Array.isArray(stored.conversations)) return;
      records = new Map(stored.conversations
        .filter((item) => item && typeof item.id === 'string' && ID_PATTERN.test(item.id))
        .map((item) => [item.id, sanitize(item)]));
    } catch (error) {
      // A missing file is the normal first-run case. A corrupt one is not worth
      // failing a whole worker over: the cost of starting from empty is losing
      // continuity, not losing work.
      if (error.code !== 'ENOENT') records = new Map();
    }
  }

  const ready = load();

  // Oldest-first eviction, so a long-lived worker cannot grow this without
  // bound. Evicting only drops our mapping; the harness's own session files are
  // its business and are untouched.
  function evict() {
    if (records.size <= MAX_CONVERSATIONS) return;
    const ordered = [...records.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const record of ordered.slice(0, records.size - MAX_CONVERSATIONS)) {
      records.delete(record.id);
    }
  }

  return {
    ready,

    async list() {
      await ready;
      return [...records.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(publicConversation);
    },

    async get(id) {
      await ready;
      const record = records.get(id);
      return record ? publicConversation(record) : null;
    },

    // The worker's own view, carrying the provider session. Never serialized to
    // a response.
    async resolve(id) {
      await ready;
      return records.get(id) ?? null;
    },

    // Called before a task runs. Creates the record on first use so that a
    // caller can pick its own conversation id up front and does not have to
    // round-trip to learn one.
    async open(id, { taskId = null } = {}) {
      await ready;
      const now = clock().toISOString();
      let record = records.get(id);
      if (!record) {
        record = { id, providerSession: null, turns: 0, createdAt: now, updatedAt: now, lastTaskId: null };
        records.set(id, record);
      }
      record.turns += 1;
      record.updatedAt = now;
      if (taskId) record.lastTaskId = taskId;
      evict();
      await persist();
      return record;
    },

    // Called when an adapter observes the harness announcing its session, or
    // when the worker minted one itself. First writer wins: a harness that
    // repeats the id every event must not be able to repoint an established
    // conversation at a different session mid-run.
    async attachSession(id, providerSession) {
      await ready;
      const record = records.get(id);
      if (!record || !providerSession || record.providerSession) return record ?? null;
      record.providerSession = providerSession;
      record.updatedAt = clock().toISOString();
      await persist();
      return record;
    },

    async forget(id) {
      await ready;
      if (!records.delete(id)) throw failure('Conversation not found', 404);
      await persist();
    },

    // For a harness that lets us choose. Kept here so the id has one origin.
    mintSession() {
      return randomUUID();
    }
  };
}
