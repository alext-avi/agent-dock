import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { hostname } from 'node:os';

const ADAPTERS = {
  'codex-cli': {
    imageEnv: 'CODEX_WORKER_IMAGE',
    defaultImage: 'agent-dock-worker-codex:local',
    authTarget: '/codex-home',
    binTarget: '/opt/codex',
    versionEnv: 'CODEX_VERSION',
    version: 'latest',
    environment: {
      AGENT_ADAPTER: 'codex-cli',
      CODEX_HOME: '/codex-home'
    }
  },
  'claude-code': {
    imageEnv: 'CLAUDE_WORKER_IMAGE',
    defaultImage: 'agent-dock-worker-claude:local',
    authTarget: '/claude-home',
    binTarget: '/opt/claude',
    versionEnv: 'CLAUDE_VERSION',
    version: 'latest',
    environment: {
      AGENT_ADAPTER: 'claude-code',
      HOME: '/claude-home',
      CLAUDE_HOME: '/claude-home',
      CLAUDE_CONFIG_DIR: '/claude-home/.claude',
      CLAUDE_OAUTH_USAGE: process.env.CLAUDE_OAUTH_USAGE ?? '0',
      CLAUDE_OAUTH_USAGE_INTERVAL_MS: process.env.CLAUDE_OAUTH_USAGE_INTERVAL_MS ?? '1800000',
      DISABLE_AUTOUPDATER: '1',
      BROWSER: 'echo'
    }
  },
  opencode: {
    imageEnv: 'OPENCODE_WORKER_IMAGE',
    defaultImage: 'agent-dock-worker-opencode:local',
    authTarget: '/opencode-home',
    binTarget: '/opt/opencode',
    versionEnv: 'OPENCODE_VERSION',
    version: 'latest',
    environment: {
      AGENT_ADAPTER: 'opencode',
      HOME: '/opencode-home',
      XDG_DATA_HOME: '/opencode-home/.local/share',
      XDG_CONFIG_HOME: '/opencode-home/.config',
      OPENCODE_AUTH_PROVIDER: 'github-copilot',
      OPENCODE_CONFIG: '/agent-data/opencode-provider.json',
      OLLAMA_BASE_URL: 'http://host.docker.internal:11434',
      OLLAMA_CONNECTION_ID: 'ollama-local',
      OLLAMA_DISPLAY_NAME: 'Local Ollama'
    },
    extraHosts: ['host.docker.internal:host-gateway']
  }
};

function dockerError(status, body, path) {
  let message = body;
  try {
    message = JSON.parse(body).message ?? body;
  } catch {}
  const error = new Error(`Docker API ${status} for ${path}: ${message || 'request failed'}`);
  error.status = status === 404 ? 409 : 502;
  return error;
}

// Two ways to name the same container, with opposite failure modes. The id is
// immutable and refers to exactly one container ever, but goes stale the moment
// the container is replaced. The name survives replacement, but Docker lets a
// name be reused, so it can resolve to an unrelated container.
//
// Resolution therefore tries the id first — a stale id 404s, which is a loud,
// safe failure — and falls back to the name only when the id no longer resolves.
// Whatever it lands on is then checked against the runtime-id label before any
// destructive call, so a reused name cannot get an unrelated container deleted.
function containerRef(runtime) {
  return runtime.containerId || runtime.containerName || '';
}

const RUNTIME_ID_LABEL = 'com.agent-dock.runtime-id';

function runtimeVolumes(runtimeId) {
  const prefix = safeName(`agent-dock-${runtimeId}`);
  return {
    auth: `${prefix}-auth`,
    binary: `${prefix}-bin`,
    telemetry: `${prefix}-data`,
    workspace: `${prefix}-workspace`
  };
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export class DockerRuntimeManager {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
    this.network = options.network ?? process.env.RUNTIME_NETWORK ?? '';
    this.controlContainer = options.controlContainer ?? process.env.HOSTNAME ?? hostname();
    this.imageOverrides = options.images ?? {};
    this.versionOverrides = options.versions ?? {};
    this.usagePollIntervalMs = String(options.usagePollIntervalMs ?? process.env.USAGE_POLL_INTERVAL_MS ?? '60000');
    this.allowUnsandboxed = String(options.allowUnsandboxed ?? process.env.ALLOW_UNSANDBOXED ?? '1');
    this.busyRuntimes = new Map();
    this.mcpAllowedCommands = String(options.mcpAllowedCommands ?? process.env.MCP_ALLOWED_COMMANDS ?? '');
  }

  // Held for the whole of a destructive operation. Checked and set synchronously
  // before the first await, so two callers cannot both win.
  claimRuntime(runtimeId, operation) {
    if (!runtimeId) return () => {};
    if (this.busyRuntimes.has(runtimeId)) {
      throw Object.assign(
        new Error(`Runtime is already being ${this.busyRuntimes.get(runtimeId)}; wait for that to finish`),
        { status: 409 }
      );
    }
    this.busyRuntimes.set(runtimeId, operation);
    return () => this.busyRuntimes.delete(runtimeId);
  }

  async request(method, path, body, accepted = [200, 201, 204]) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const result = await new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path,
        method,
        headers: payload ? {
          'content-type': 'application/json',
          'content-length': payload.length
        } : undefined
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (payload) req.end(payload);
      else req.end();
    });
    if (!accepted.includes(result.status)) throw dockerError(result.status, result.body, path);
    if (!result.body) return null;
    try {
      return JSON.parse(result.body);
    } catch {
      return result.body;
    }
  }

  // Returns the container that genuinely belongs to this runtime, or null.
  // `requireIdentity` is set for destructive calls: a container that does not
  // carry this runtime's label is not ours to stop, replace, or delete, even if
  // it answers to the right name.
  async resolveContainer(runtime, { requireIdentity = false } = {}) {
    const candidates = [runtime.containerId, runtime.containerName].filter(Boolean);
    for (const reference of candidates) {
      let value;
      try {
        value = await this.request('GET', `/containers/${encodeURIComponent(reference)}/json`);
      } catch (error) {
        if (error.status === 409 || String(error.message).includes('404')) continue;
        throw error;
      }
      const label = value?.Config?.Labels?.[RUNTIME_ID_LABEL] ?? null;
      if (label && label !== runtime.id) continue;
      // An unlabelled container answering to our name is not provably ours.
      if (requireIdentity && label !== runtime.id) continue;
      return { id: value.Id, inspected: value };
    }
    return null;
  }

  // The image id currently behind an adapter's configured tag. Compared against
  // what a container is actually running, this is what makes staleness a fact
  // rather than a guess.
  async currentImageId(adapter) {
    const template = ADAPTERS[adapter];
    if (!template) return null;
    const reference = this.imageOverrides[adapter] ?? process.env[template.imageEnv] ?? template.defaultImage;
    try {
      const value = await this.request('GET', `/images/${encodeURIComponent(reference)}/json`);
      return value?.Id ?? null;
    } catch {
      // An image that is not present locally cannot be compared against.
      return null;
    }
  }

  async resolveNetwork() {
    if (this.network) return this.network;
    const inspected = await this.request('GET', `/containers/${encodeURIComponent(this.controlContainer)}/json`);
    const networks = Object.keys(inspected?.NetworkSettings?.Networks ?? {});
    const selected = networks.find((name) => name !== 'bridge') ?? networks[0];
    if (!selected) throw new Error('Could not determine the control-plane Docker network');
    this.network = selected;
    return selected;
  }

  async createVolume(name, labels) {
    await this.request('POST', '/volumes/create', { Name: name, Labels: labels });
  }

  // One definition of what a runtime's container is, shared by provisioning and
  // by replacing one. Two copies would drift, and the whole point of a refresh is
  // that the replacement matches what a fresh provision would produce.
  async containerSpec({ adapter, workerId, workerToken, volumes, labels }) {
    const template = ADAPTERS[adapter];
    const network = await this.resolveNetwork();
    const image = this.imageOverrides[adapter] ?? process.env[template.imageEnv] ?? template.defaultImage;
    const version = this.versionOverrides[adapter] ?? process.env[template.versionEnv] ?? template.version;
    const environment = {
      PORT: '7777',
      WORKER_TOKEN: workerToken,
      AGENT_ID: workerId,
      ALLOW_UNSANDBOXED: this.allowUnsandboxed,
      AGENT_DATA_PATH: '/agent-data/usage.json',
      USAGE_POLL_INTERVAL_MS: this.usagePollIntervalMs,
      MCP_ALLOWED_COMMANDS: this.mcpAllowedCommands,
      [template.versionEnv]: version,
      ...template.environment
    };
    return {
      image,
      body: {
        Image: image,
        Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        Labels: labels,
        ExposedPorts: { '7777/tcp': {} },
        Healthcheck: {
          Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:7777/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
          Interval: 3_000_000_000,
          Timeout: 2_000_000_000,
          Retries: 60,
          StartPeriod: 5_000_000_000
        },
        HostConfig: {
          Init: true,
          NetworkMode: network,
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          ExtraHosts: template.extraHosts ?? [],
          Mounts: [
            { Type: 'volume', Source: volumes.auth, Target: template.authTarget },
            { Type: 'volume', Source: volumes.binary, Target: template.binTarget },
            { Type: 'volume', Source: volumes.telemetry, Target: '/agent-data' },
            { Type: 'volume', Source: volumes.workspace, Target: '/workspace' }
          ]
        }
      }
    };
  }

  async provision({ agentId, adapter }) {
    const template = ADAPTERS[adapter];
    if (!template) throw Object.assign(new Error(`No runtime template exists for ${adapter}`), { status: 400 });
    const runtimeId = `rt-${safeName(adapter)}-${randomUUID().slice(0, 12)}`;
    const workerId = `worker-${randomUUID()}`;
    const workerToken = randomBytes(32).toString('base64url');
    const containerName = safeName(`agent-dock-${runtimeId}`);
    const volumes = runtimeVolumes(runtimeId);
    const labels = {
      'com.agent-dock.managed': 'true',
      'com.agent-dock.agent-id': agentId,
      'com.agent-dock.runtime-id': runtimeId,
      'com.agent-dock.adapter': adapter
    };
    const createdVolumes = [];
    let containerId = '';
    try {
      for (const name of Object.values(volumes)) {
        await this.createVolume(name, labels);
        createdVolumes.push(name);
      }
      const { image, body } = await this.containerSpec({ adapter, workerId, workerToken, volumes, labels });
      const created = await this.request('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, body);
      containerId = created.Id;
      await this.request('POST', `/containers/${encodeURIComponent(containerId)}/start`);
      return {
        id: runtimeId,
        adapter,
        kind: 'managed-dedicated',
        managed: true,
        dedicated: true,
        workerId,
        workerUrl: `http://${containerName}:7777`,
        workerToken,
        containerId,
        containerName,
        image,
        volumes,
        state: 'starting',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (containerId) await this.request('DELETE', `/containers/${encodeURIComponent(containerId)}?force=true`, undefined, [204, 404]).catch(() => {});
      for (const name of createdVolumes.reverse()) {
        await this.request('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`, undefined, [204, 404]).catch(() => {});
      }
      throw error;
    }
  }

  // Replace a runtime's container with one built from the currently configured
  // image, keeping its identity, its worker token, and all four volumes. The
  // volumes are never deleted, so the agent stays authenticated: this is the
  // difference between picking up new worker code and re-running an OAuth flow.
  async recreate(runtime, { agentId = null } = {}) {
    const template = ADAPTERS[runtime.adapter];
    if (!template) throw Object.assign(new Error(`No runtime template exists for ${runtime.adapter}`), { status: 400 });
    if (!runtime.containerName) {
      throw Object.assign(new Error('Runtime has no stable container name to replace'), { status: 409 });
    }
    const release = this.claimRuntime(runtime.id, 'refreshed');
    try {
      return await this.#recreate(runtime, agentId);
    } finally {
      release();
    }
  }

  async #recreate(runtime, agentId) {
    const volumes = runtime.volumes ?? runtimeVolumes(runtime.id);
    const labels = {
      'com.agent-dock.managed': 'true',
      'com.agent-dock.agent-id': agentId ?? '',
      'com.agent-dock.runtime-id': runtime.id,
      'com.agent-dock.adapter': runtime.adapter
    };
    // Build the spec before removing anything: an unresolvable network or image
    // should fail while the existing container is still running.
    const { image, body } = await this.containerSpec({
      adapter: runtime.adapter,
      workerId: runtime.workerId,
      workerToken: runtime.workerToken,
      volumes,
      labels
    });
    const resolved = await this.resolveContainer(runtime, { requireIdentity: true });
    if (resolved) {
      await this.request('DELETE', `/containers/${encodeURIComponent(resolved.id)}?force=true`, undefined, [204, 404]);
    } else {
      // Nothing of ours is there. If something unrelated holds the name, say so
      // rather than deleting it or failing obscurely on create.
      const squatter = await this.resolveContainer({ containerName: runtime.containerName, id: runtime.id });
      if (squatter) {
        throw Object.assign(
          new Error(`Container name ${runtime.containerName} is held by a container that is not this runtime`),
          { status: 409 }
        );
      }
    }
    const created = await this.request('POST', `/containers/create?name=${encodeURIComponent(runtime.containerName)}`, body);
    await this.request('POST', `/containers/${encodeURIComponent(created.Id)}/start`);
    return {
      containerId: created.Id,
      containerName: runtime.containerName,
      workerUrl: `http://${runtime.containerName}:7777`,
      image,
      volumes,
      state: 'starting',
      updatedAt: new Date().toISOString()
    };
  }

  async inspect(runtime) {
    if (!containerRef(runtime)) return { state: runtime.state ?? 'unknown' };
    const resolved = await this.resolveContainer(runtime);
    if (!resolved) return { state: 'missing', health: null, image: null };
    const value = resolved.inspected;
    return {
      state: value.State?.Running ? 'running' : value.State?.Status ?? 'stopped',
      health: value.State?.Health?.Status ?? null,
      image: value.Config?.Image ?? null,
      // The tag is a mutable pointer; the resolved image id is what actually
      // says which build this container is running.
      imageId: value.Image ?? null,
      // The id moves whenever a container is replaced, including out of band.
      containerId: value.Id
    };
  }

  async stop(runtime) {
    if (!containerRef(runtime)) return;
    const resolved = await this.resolveContainer(runtime, { requireIdentity: true });
    if (!resolved) return;
    await this.request('POST', `/containers/${encodeURIComponent(resolved.id)}/stop?t=10`, undefined, [204, 304, 404]);
  }

  async start(runtime) {
    if (!containerRef(runtime)) throw new Error('Managed runtime has no container identity');
    const resolved = await this.resolveContainer(runtime, { requireIdentity: true });
    if (!resolved) throw Object.assign(new Error('Runtime container no longer exists'), { status: 409 });
    await this.request('POST', `/containers/${encodeURIComponent(resolved.id)}/start`, undefined, [204, 304]);
  }

  async destroy(runtime) {
    const release = this.claimRuntime(runtime.id, 'destroyed');
    try {
      await this.#destroy(runtime);
    } finally {
      release();
    }
  }

  async #destroy(runtime) {
    if (containerRef(runtime)) {
      const resolved = await this.resolveContainer(runtime, { requireIdentity: true });
      if (resolved) {
        await this.request('DELETE', `/containers/${encodeURIComponent(resolved.id)}?force=true`, undefined, [204, 404]);
      }
    }
    for (const name of Object.values(runtime.volumes ?? {})) {
      await this.request('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`, undefined, [204, 404]);
    }
  }
}

export function createDockerRuntimeManager(options = {}) {
  return new DockerRuntimeManager(options);
}
