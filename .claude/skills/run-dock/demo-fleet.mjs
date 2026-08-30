// Launches a full Agent Dock fleet against demo workers: no Docker, no provider
// credentials, no subscription usage. Every adapter is represented, so all three
// quota states are visible in one browser session.
//
//   Codex     - a populated provider quota window
//   Claude    - the experimental OAuth windows, fed a recorded fixture
//   OpenCode  - an adapter exposing no windows, i.e. the "unavailable" state
//
//   node .claude/skills/run-dock/demo-fleet.mjs
//   CONTROL_PLANE_PORT=8900 node .claude/skills/run-dock/demo-fleet.mjs
//   CONTROL_PLANE_HOST=::1 node .claude/skills/run-dock/demo-fleet.mjs
//
// Both default to loopback. Set CONTROL_PLANE_HOST=::1 when `localhost` resolves
// to IPv6 first and something else already holds the IPv6 wildcard on your port —
// otherwise the browser reaches that process instead of this one.
//
// `npm run demo` is the lighter path when one Codex agent is enough.

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlane } from '../../../control-plane/server.mjs';
import { createWorkerServer } from '../../../worker/server.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const uiPort = Number(process.env.CONTROL_PLANE_PORT ?? 3000);
const host = process.env.CONTROL_PLANE_HOST ?? '127.0.0.1';
// Workers sit above the UI port so overriding one override moves the whole set.
const workerPort = (offset) => uiPort + 4777 + offset;
// IPv6 literals need brackets in a URL.
const authority = (port) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);
const token = 'local-demo-worker';

// The Claude worker reads a credential file before calling the usage endpoint.
// Give it a throwaway one outside the repo; the endpoint itself is stubbed, so
// the value is never sent anywhere.
const claudeHome = await mkdtemp(join(tmpdir(), 'agent-dock-demo-'));
await mkdir(join(claudeHome, '.claude'), { recursive: true });
await writeFile(
  join(claudeHome, '.claude', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'demo-not-a-real-token' } })
);

const usagePayload = JSON.parse(await readFile(join(repo, 'test/fixtures/claude-usage-limits.json'), 'utf8'));

const workers = [
  { name: 'codex', adapter: 'codex-cli', options: {} },
  {
    name: 'claude',
    adapter: 'claude-code',
    options: {
      claudeHome,
      claudeOAuthUsage: true,
      claudeUsageFetch: () => new Response(JSON.stringify(usagePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  },
  { name: 'opencode', adapter: 'opencode', options: {} }
];

const urls = {};
for (const [index, worker] of workers.entries()) {
  const port = workerPort(index);
  const server = createWorkerServer({
    token,
    adapter: worker.adapter,
    demoMode: true,
    dataPath: null,
    workspace: join(repo, 'workspace'),
    ...worker.options
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  urls[worker.name] = `http://${authority(port)}`;
  console.log(`[worker:${worker.name}] ${urls[worker.name]}`);
}

const control = createControlPlane({
  workerUrl: urls.codex,
  workerToken: token,
  claudeWorkerUrl: urls.claude,
  claudeWorkerToken: token,
  opencodeWorkerUrl: urls.opencode,
  opencodeWorkerToken: token,
  dataPath: null
});
await new Promise((resolve) => control.listen(uiPort, host, resolve));

// The registry seeds only the default Codex agent; attach one per adapter so the
// fleet dashboard has something to compare.
for (const [name, adapter, runtimeId] of [
  ['Claude · experimental quota', 'claude-code', 'legacy-claude-code'],
  ['OpenCode · no quota source', 'opencode', 'legacy-opencode']
]) {
  const response = await fetch(`http://${authority(uiPort)}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, adapter, runtime: { mode: 'attach', id: runtimeId } })
  });
  const body = await response.json();
  console.log(`[agent] ${response.status} ${body.agent?.id ?? JSON.stringify(body)}`);
}

console.log(`\n[demo-ui] http://${authority(uiPort)}\n`);

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
