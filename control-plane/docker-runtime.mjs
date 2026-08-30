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
      CLAUDE_OAUTH_USAGE_INTERVAL_MS: process.env.CLAUDE_OAUTH_USAGE_INTERVAL_MS ?? '300000',
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

  async provision({ agentId, adapter }) {
    const template = ADAPTERS[adapter];
    if (!template) throw Object.assign(new Error(`No runtime template exists for ${adapter}`), { status: 400 });
    const runtimeId = `rt-${safeName(adapter)}-${randomUUID().slice(0, 12)}`;
    const workerId = `worker-${randomUUID()}`;
    const workerToken = randomBytes(32).toString('base64url');
    const containerName = safeName(`agent-dock-${runtimeId}`);
    const volumePrefix = safeName(`agent-dock-${runtimeId}`);
    const volumes = {
      auth: `${volumePrefix}-auth`,
      binary: `${volumePrefix}-bin`,
      telemetry: `${volumePrefix}-data`,
      workspace: `${volumePrefix}-workspace`
    };
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
        [template.versionEnv]: version,
        ...template.environment
      };
      const created = await this.request('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
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
      });
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

  async inspect(runtime) {
    if (!runtime.containerId && !runtime.containerName) return { state: runtime.state ?? 'unknown' };
    try {
      const value = await this.request('GET', `/containers/${encodeURIComponent(runtime.containerId || runtime.containerName)}/json`);
      return {
        state: value.State?.Running ? 'running' : value.State?.Status ?? 'stopped',
        health: value.State?.Health?.Status ?? null
      };
    } catch (error) {
      if (error.message.includes('Docker API 404')) return { state: 'missing', health: null };
      throw error;
    }
  }

  async stop(runtime) {
    if (!runtime.containerId && !runtime.containerName) return;
    await this.request('POST', `/containers/${encodeURIComponent(runtime.containerId || runtime.containerName)}/stop?t=10`, undefined, [204, 304, 404]);
  }

  async start(runtime) {
    if (!runtime.containerId && !runtime.containerName) throw new Error('Managed runtime has no container identity');
    await this.request('POST', `/containers/${encodeURIComponent(runtime.containerId || runtime.containerName)}/start`, undefined, [204, 304]);
  }

  async destroy(runtime) {
    if (runtime.containerId || runtime.containerName) {
      await this.request('DELETE', `/containers/${encodeURIComponent(runtime.containerId || runtime.containerName)}?force=true`, undefined, [204, 404]);
    }
    for (const name of Object.values(runtime.volumes ?? {})) {
      await this.request('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`, undefined, [204, 404]);
    }
  }
}

export function createDockerRuntimeManager(options = {}) {
  return new DockerRuntimeManager(options);
}
