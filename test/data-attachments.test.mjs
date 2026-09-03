import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertWriteLease,
  normalizeAttachment,
  normalizeDataSource,
  normalizeRelativePath,
  parseAttachmentRoots,
  publicDataSource
} from '../control-plane/data-attachments.mjs';
import { DockerRuntimeManager } from '../control-plane/docker-runtime.mjs';

const roots = parseAttachmentRoots({
  projects: { label: 'Projects', hostPath: '/srv/projects', allowWrite: true },
  reference: { label: 'Reference', hostPath: '/srv/reference', allowWrite: false }
});

test('attachment roots and relative paths fail closed', () => {
  assert.equal(roots.get('projects').hostPath, '/srv/projects');
  assert.equal(normalizeRelativePath('team/repository'), 'team/repository');
  assert.equal(normalizeRelativePath('./team/./repository'), 'team/repository');
  for (const value of ['/etc', '../secret', 'team/../../secret', String.raw`team\secret`]) {
    assert.throws(() => normalizeRelativePath(value));
  }
  assert.throws(() => parseAttachmentRoots({ bad: { hostPath: 'relative/path' } }), /absolute/);
});

test('public data-source records never disclose host paths or managed volume names', () => {
  const host = normalizeDataSource({
    id: 'project-repo',
    name: 'Project repository',
    kind: 'host-directory',
    rootId: 'projects',
    relativePath: 'agent-dock'
  }, { roots });
  const managed = normalizeDataSource({
    id: 'scratch-volume',
    name: 'Scratch volume',
    kind: 'managed-volume'
  }, { roots });
  managed.volumeName = 'secret-engine-volume-name';

  const visibleHost = publicDataSource(host, roots);
  const visibleManaged = publicDataSource(managed, roots);
  assert.deepEqual(visibleHost.root, { id: 'projects', label: 'Projects', relativePath: 'agent-dock' });
  assert.equal(JSON.stringify(visibleHost).includes('/srv/projects'), false);
  assert.equal(JSON.stringify(visibleManaged).includes('secret-engine-volume-name'), false);
});

test('attachment validation enforces one working directory and exclusive overlapping writes', () => {
  const parent = normalizeDataSource({ id: 'parent', name: 'Parent', kind: 'host-directory', rootId: 'projects', relativePath: 'team' }, { roots });
  const child = normalizeDataSource({ id: 'child', name: 'Child', kind: 'host-directory', rootId: 'projects', relativePath: 'team/repository' }, { roots });
  const sources = new Map([[parent.id, parent], [child.id, child]]);
  const first = normalizeAttachment({ dataSourceId: parent.id, mountName: 'project', access: 'read-write', purpose: 'working-directory' }, {
    agentId: 'agent-a', source: parent
  });
  assert.throws(() => normalizeAttachment({ dataSourceId: child.id, mountName: 'other', purpose: 'working-directory' }, {
    agentId: 'agent-a', source: child, existing: [first]
  }), /only one working-directory/);
  const safeTarget = normalizeAttachment({ dataSourceId: child.id, mountName: '..', purpose: 'data' }, {
    agentId: 'agent-c', source: child
  });
  assert.equal(safeTarget.target, '/data/data', 'a dot-segment mount name escaped the /data namespace');

  const secondAgent = normalizeAttachment({ dataSourceId: child.id, mountName: 'child', access: 'read-write' }, {
    agentId: 'agent-b', source: child
  });
  assert.throws(() => assertWriteLease(secondAgent, [first], sources), /overlaps agent agent-a/);

  const sameAgent = normalizeAttachment({ dataSourceId: child.id, mountName: 'child', access: 'read-write' }, {
    agentId: 'agent-a', source: child, existing: [first]
  });
  assert.throws(() => assertWriteLease(sameAgent, [first], sources), /another attachment on this agent/);

  const aliasedRoots = parseAttachmentRoots({
    projects: { hostPath: '/srv/projects', allowWrite: true },
    team: { hostPath: '/srv/projects/team', allowWrite: true }
  });
  const aliased = normalizeDataSource({ id: 'aliased', name: 'Aliased', kind: 'host-directory', rootId: 'team', relativePath: 'repository' }, { roots: aliasedRoots });
  const aliasedSources = new Map([[parent.id, parent], [aliased.id, aliased]]);
  const aliasWriter = normalizeAttachment({ dataSourceId: aliased.id, mountName: 'alias', access: 'read-write' }, {
    agentId: 'agent-b', source: aliased
  });
  assert.throws(() => assertWriteLease(aliasWriter, [first], aliasedSources, aliasedRoots), /overlaps agent agent-a/);

  const missingSources = new Map([[child.id, child]]);
  assert.throws(
    () => assertWriteLease(secondAgent, [first], missingSources, roots),
    /Attachment .* refers to a missing data source/,
    'corrupt attachment state silently stopped holding its write lease'
  );
});

test('container specs add exact mounts and move the task working directory', async () => {
  const manager = new DockerRuntimeManager({ network: 'test-net', attachmentRoots: roots });
  const attachments = [{
    id: 'att-project',
    purpose: 'working-directory',
    target: '/data/project',
    mount: { Type: 'bind', Source: '/srv/projects/agent-dock', Target: '/data/project', ReadOnly: false }
  }, {
    id: 'att-reference',
    purpose: 'data',
    target: '/data/reference',
    mount: { Type: 'bind', Source: '/srv/reference/docs', Target: '/data/reference', ReadOnly: true }
  }];
  const { body } = await manager.containerSpec({
    adapter: 'claude-code',
    workerId: 'worker-1',
    workerToken: 'worker-token',
    volumes: { auth: 'auth', binary: 'bin', telemetry: 'telemetry', workspace: 'workspace' },
    labels: {},
    attachments
  });
  const environment = Object.fromEntries(body.Env.map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  assert.equal(environment.WORKSPACE_PATH, '/data/project');
  assert.equal(body.HostConfig.Mounts.length, 6);
  assert.deepEqual(body.HostConfig.Mounts.slice(-2), attachments.map((attachment) => attachment.mount));
});

test('managed volume names retain a collision-resistant suffix at Docker length limits', async () => {
  const manager = new DockerRuntimeManager({ attachmentRoots: {} });
  let created;
  manager.createVolume = async (name, labels) => { created = { name, labels }; };
  const name = await manager.createManagedDataVolume('a'.repeat(80));
  assert.equal(name.length, 80);
  assert.match(name, /-[0-9a-f]{8}$/);
  assert.equal(created.name, name);
  assert.equal(created.labels['com.agent-dock.data-source-id'], 'a'.repeat(80));
});

test('host validation uses a no-network, least-privilege helper and rejects symlinks', async () => {
  class RecordingManager extends DockerRuntimeManager {
    constructor(statusCode, logPayload = null) {
      super({ attachmentRoots: roots, attachmentValidatorImage: 'node:test' });
      this.statusCode = statusCode;
      this.logPayload = logPayload;
      this.calls = [];
    }
    async request(method, path, body) {
      this.calls.push({ method, path, body });
      if (method === 'POST' && path === '/containers/create') return { Id: 'validator-1' };
      if (path.includes('/wait?')) return { StatusCode: this.statusCode };
      if (path.includes('/logs?')) return this.logPayload;
      return null;
    }
  }

  const allowed = new RecordingManager(0);
  assert.equal(await allowed.validateHostDirectory({
    rootId: 'projects', relativePath: 'agent-dock', access: 'read-write', adapter: 'claude-code'
  }), '/srv/projects/agent-dock');
  const create = allowed.calls.find((call) => call.path === '/containers/create').body;
  assert.equal(create.User, '10001:10001');
  assert.equal(create.HostConfig.NetworkMode, 'none');
  assert.equal(create.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(create.HostConfig.CapDrop, ['ALL']);
  assert.equal(create.HostConfig.Memory, 128 * 1024 * 1024);
  assert.equal(create.HostConfig.PidsLimit, 64);
  assert.equal(create.HostConfig.Mounts[0].Source, '/srv/projects');
  assert.equal(create.HostConfig.Mounts[0].Target, '/source');
  assert.equal(create.HostConfig.Mounts[0].ReadOnly, false);
  assert.ok(allowed.calls.some((call) => call.method === 'DELETE' && call.path.includes('validator-1')));

  const symlink = new RecordingManager(13);
  await assert.rejects(
    symlink.validateHostDirectory({ rootId: 'projects', relativePath: 'link', access: 'read-only', adapter: 'codex-cli' }),
    /symbolic links/
  );
  assert.equal(symlink.calls.at(-1).method, 'DELETE');

  await assert.rejects(
    allowed.validateHostDirectory({ rootId: 'reference', relativePath: '.', access: 'read-write', adapter: 'claude-code' }),
    (error) => error.status === 403
  );

  const folderBrowser = new RecordingManager(0, {
    directories: ['agent-container', '../escape', 'nested/name'],
    truncated: false
  });
  const listing = await folderBrowser.listHostDirectories({ rootId: 'projects', relativePath: '.', adapter: 'claude-code' });
  assert.deepEqual(listing, {
    relativePath: '.',
    directories: [{ name: 'agent-container', relativePath: 'agent-container' }],
    truncated: false
  });
  const browserCreate = folderBrowser.calls.find((call) => call.path === '/containers/create').body;
  assert.equal(browserCreate.User, '10001:10001');
  assert.equal(browserCreate.Tty, true);
  assert.equal(browserCreate.HostConfig.NetworkMode, 'none');
  assert.equal(browserCreate.HostConfig.Mounts[0].ReadOnly, true);
  assert.equal(browserCreate.HostConfig.Mounts[0].Source, '/srv/projects');
});
