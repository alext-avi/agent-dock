import { isAbsolute, posix, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SOURCE_KINDS = new Set(['host-directory', 'managed-volume']);
const ACCESS_MODES = new Set(['read-only', 'read-write']);
const PURPOSES = new Set(['data', 'working-directory']);

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, name, { required = false, max = 240 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${name} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw bad(`${name} is required`);
  if (normalized.length > max) throw bad(`${name} is too long`, 413);
  if (normalized.includes('\0')) throw bad(`${name} contains an unsupported character`);
  return normalized;
}

function slug(value, fallback = 'data') {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized;
}

export function normalizeRelativePath(value) {
  const candidate = text(value ?? '.', 'relativePath', { required: true, max: 1000 });
  if (candidate.includes('\\')) throw bad('relativePath must use forward slashes');
  if (isAbsolute(candidate) || posix.isAbsolute(candidate)) throw bad('relativePath must stay beneath its configured root');
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '..')) throw bad('relativePath cannot traverse to a parent directory');
  const normalized = posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) throw bad('relativePath cannot escape its configured root');
  return normalized === '' ? '.' : normalized;
}

export function parseAttachmentRoots(value = {}) {
  if (value instanceof Map) value = Object.fromEntries(value);
  if (typeof value === 'string') {
    if (!value.trim()) return new Map();
    try { value = JSON.parse(value); }
    catch { throw new Error('ATTACHMENT_ROOTS_JSON must be valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ATTACHMENT_ROOTS_JSON must be an object keyed by root id');
  }
  const roots = new Map();
  for (const [id, definition] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) throw new Error(`Attachment root id ${id} is invalid`);
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`Attachment root ${id} must be an object`);
    }
    const hostPath = text(definition.hostPath, `attachment root ${id}.hostPath`, { required: true, max: 2000 });
    if (!isAbsolute(hostPath)) throw new Error(`Attachment root ${id}.hostPath must be absolute`);
    roots.set(id, {
      id,
      label: text(definition.label ?? id, `attachment root ${id}.label`, { required: true, max: 120 }),
      hostPath: resolve(hostPath),
      allowWrite: definition.allowWrite === true
    });
  }
  return roots;
}

export function publicAttachmentRoots(roots) {
  return [...roots.values()].map(({ id, label, allowWrite }) => ({ id, label, allowWrite }));
}

export function normalizeDataSource(input, { existingIds = new Set(), roots = new Map(), defaults = {}, allowUnconfiguredRoot = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Data source must be an object');
  const now = new Date().toISOString();
  const name = text(input.name ?? defaults.name, 'name', { required: true, max: 120 });
  const kind = text(input.kind ?? defaults.kind ?? 'host-directory', 'kind', { required: true, max: 40 });
  if (!SOURCE_KINDS.has(kind)) throw bad('kind must be host-directory or managed-volume');
  const requestedId = text(input.id ?? defaults.id, 'id', { max: 80 });
  if (requestedId && !/^[a-z0-9][a-z0-9-]*$/.test(requestedId)) throw bad('id must contain lowercase letters, numbers, and hyphens only');
  const base = requestedId || slug(name, 'data-source');
  let id = base;
  while (existingIds.has(id) && id !== defaults.id) id = `${base.slice(0, 67)}-${randomUUID().slice(0, 8)}`;

  const normalized = {
    id,
    name,
    description: text(input.description ?? defaults.description ?? '', 'description', { max: 1000 }),
    kind,
    scope: defaults.scope === 'attachment' ? 'attachment' : 'shared',
    rootId: null,
    relativePath: null,
    volumeName: defaults.volumeName ?? null,
    createdAt: defaults.createdAt ?? now,
    updatedAt: now
  };
  if (kind === 'host-directory') {
    normalized.rootId = text(input.rootId ?? defaults.rootId, 'rootId', { required: true, max: 80 });
    if (!allowUnconfiguredRoot && !roots.has(normalized.rootId)) throw bad(`Attachment root ${normalized.rootId} is not configured`);
    normalized.relativePath = normalizeRelativePath(input.relativePath ?? defaults.relativePath ?? '.');
    normalized.volumeName = null;
  }
  return normalized;
}

export function publicDataSource(source, roots = new Map()) {
  return {
    id: source.id,
    name: source.name,
    description: source.description ?? '',
    kind: source.kind,
    root: source.kind === 'host-directory' ? {
      id: source.rootId,
      label: roots.get(source.rootId)?.label ?? source.rootId,
      relativePath: source.relativePath
    } : null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

export function normalizeAttachment(input, { agentId, source, existing = [], defaults = {} } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Attachment must be an object');
  if (!agentId || !source) throw new Error('normalizeAttachment requires an agent and data source');
  const now = new Date().toISOString();
  const access = text(input.access ?? defaults.access ?? 'read-only', 'access', { required: true, max: 30 });
  if (!ACCESS_MODES.has(access)) throw bad('access must be read-only or read-write');
  const purpose = text(input.purpose ?? defaults.purpose ?? 'data', 'purpose', { required: true, max: 40 });
  if (!PURPOSES.has(purpose)) throw bad('purpose must be data or working-directory');
  const mountName = slug(text(input.mountName ?? defaults.mountName ?? source.name, 'mountName', { required: true, max: 80 }), 'data');
  const id = defaults.id ?? `att-${randomUUID()}`;
  const target = `/data/${mountName}`;
  const others = existing.filter((attachment) => attachment.id !== id);
  if (others.some((attachment) => attachment.dataSourceId === source.id)) throw bad('This data source is already attached to the agent', 409);
  if (others.some((attachment) => attachment.target === target)) throw bad(`Another attachment already uses ${target}`, 409);
  if (purpose === 'working-directory' && others.some((attachment) => attachment.purpose === 'working-directory')) {
    throw bad('An agent can have only one working-directory attachment', 409);
  }
  return {
    id,
    agentId,
    dataSourceId: source.id,
    mountName,
    target,
    access,
    purpose,
    createdAt: defaults.createdAt ?? now,
    updatedAt: now
  };
}

export function publicAttachment(attachment, source, roots = new Map()) {
  return {
    id: attachment.id,
    agentId: attachment.agentId,
    dataSourceId: attachment.dataSourceId,
    source: publicDataSource(source, roots),
    mountName: attachment.mountName,
    target: attachment.target,
    access: attachment.access,
    purpose: attachment.purpose,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  };
}

function hostIntervalsOverlap(left, right, roots) {
  const leftRoot = roots?.get(left.rootId)?.hostPath;
  const rightRoot = roots?.get(right.rootId)?.hostPath;
  if ((!leftRoot || !rightRoot) && left.rootId !== right.rootId) return false;
  const a = leftRoot
    ? resolve(leftRoot, left.relativePath)
    : (left.relativePath === '.' ? '' : left.relativePath.replace(/\/$/, ''));
  const b = rightRoot
    ? resolve(rightRoot, right.relativePath)
    : (right.relativePath === '.' ? '' : right.relativePath.replace(/\/$/, ''));
  return a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function assertWriteLease(candidate, attachments, sources, roots = null) {
  if (candidate.access !== 'read-write') return;
  const source = sources.get(candidate.dataSourceId);
  for (const other of attachments) {
    if (other.id === candidate.id || other.access !== 'read-write') continue;
    const otherSource = sources.get(other.dataSourceId);
    // An attachment without its source is corrupt registry state, not evidence
    // that the mounted path is safe. Skipping it would erase that writer from
    // the overlap check and could grant a second agent the same writable tree.
    if (!otherSource) throw bad(`Attachment ${other.id} refers to a missing data source`, 409);
    const overlaps = source.kind === 'managed-volume'
      ? otherSource.kind === 'managed-volume' && otherSource.id === source.id
      : otherSource.kind === 'host-directory' && hostIntervalsOverlap(source, otherSource, roots);
    if (overlaps) {
      const owner = other.agentId === candidate.agentId ? 'another attachment on this agent' : `agent ${other.agentId}`;
      throw bad(`Read-write access overlaps ${owner}`, 409);
    }
  }
}
