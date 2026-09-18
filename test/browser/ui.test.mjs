// Browser tests for the control-plane UI.
//
// These cover behaviour the Node contract tests cannot reach: what a person
// actually sees. Every case here corresponds to something that has regressed or
// nearly shipped broken — an unavailable reading drawn as a confident zero, a
// retained reading presented as current, a status poll re-enabling a control
// mid-request. Assertions are on rendered state, not on internals.
//
//   npm run test:ui
//
// Needs a browser: `npx playwright install chromium`. Run separately from
// `npm test`, which stays hermetic and browser-free.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createControlPlane } from '../../control-plane/server.mjs';
import { createWorkerServer } from '../../worker/server.mjs';
import { environmentKeyProvider } from '../../control-plane/credentials.mjs';

const USAGE_PAYLOAD = {
  limits: [
    { kind: 'session', percent: 12, severity: 'normal', resets_at: '2099-01-01T00:00:00Z' },
    { kind: 'weekly_all', percent: 100, severity: 'critical', resets_at: '2099-01-01T00:00:00Z' }
  ]
};

let browser;
let app;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

// Enough of the runtime manager for the UI: managed runtimes, an image the
// fleet can drift from, and a refresh whose latency the test controls.
function createFakeRuntimeManager(workers) {
  return {
    currentImage: 'agent-dock-worker:v1',
    recreateDelay: null,
    provisioned: [],
    recreated: [],
    async provision({ agentId, adapter }) {
      const worker = workers[adapter];
      const id = `runtime-${this.provisioned.length + 1}`;
      const runtime = {
        id,
        adapter,
        kind: 'managed-dedicated',
        managed: true,
        dedicated: true,
        workerId: worker.workerId,
        workerUrl: worker.url,
        workerToken: worker.token,
        containerId: `container-${id}`,
        containerName: `agent-dock-${id}`,
        image: this.currentImage,
        imageId: this.currentImage,
        volumes: { auth: `${id}-auth`, binary: `${id}-bin`, telemetry: `${id}-data`, workspace: `${id}-work` },
        appliedAttachmentIds: [],
        workingDirectory: '/workspace',
        state: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentId
      };
      this.provisioned.push(runtime);
      return runtime;
    },
    async inspect(runtime) {
      return { state: 'running', health: 'healthy', image: runtime.image, imageId: runtime.imageId, containerId: runtime.containerId };
    },
    async currentImageId() {
      return this.currentImage;
    },
    async recreate(runtime, { attachments = [], previousAttachments = attachments } = {}) {
      if (this.recreateDelay) await this.recreateDelay;
      this.recreated.push({ runtimeId: runtime.id, attachments, previousAttachments });
      return {
        containerId: `${runtime.containerId}-new`,
        containerName: runtime.containerName,
        workerUrl: runtime.workerUrl,
        image: this.currentImage,
        imageId: this.currentImage,
        volumes: runtime.volumes,
        appliedAttachmentIds: attachments.map((attachment) => attachment.id),
        workingDirectory: attachments.find((attachment) => attachment.purpose === 'working-directory')?.target ?? '/workspace',
        state: 'running',
        updatedAt: new Date().toISOString()
      };
    },
    async materializeAttachments({ attachments, sources }) {
      return attachments.map((attachment) => {
        const source = sources.get(attachment.dataSourceId);
        return {
          ...attachment,
          mount: {
            Type: source.kind === 'managed-volume' ? 'volume' : 'bind',
            Source: source.volumeName ?? `/approved/${source.rootId}/${source.relativePath}`,
            Target: attachment.target,
            ReadOnly: attachment.access === 'read-only'
          }
        };
      });
    },
    async createManagedDataVolume(id) { return `managed-${id}`; },
    async deleteManagedDataVolume() {},
    async listHostDirectories({ relativePath }) {
      const listings = {
        '.': [{ name: 'agent-container', relativePath: 'agent-container' }, { name: 'reference', relativePath: 'reference' }],
        'agent-container': [{ name: 'control-plane', relativePath: 'agent-container/control-plane' }]
      };
      return { relativePath, directories: listings[relativePath] ?? [], truncated: false };
    },
    async stop() {},
    async start() {},
    async destroy() {}
  };
}

async function startApp() {
  const token = 'browser-test-token';
  const claude = { healthy: true };
  const workers = {};

  // The worker reads a credential before it will call the usage source at all,
  // so the stub below is only reachable once one exists.
  const claudeHome = await mkdtemp(join(tmpdir(), 'agent-dock-ui-'));
  await mkdir(join(claudeHome, '.claude'), { recursive: true });
  await writeFile(
    join(claudeHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'browser-test-not-a-real-token' } })
  );

  for (const adapter of ['codex-cli', 'claude-code', 'opencode']) {
    const workerId = `worker-${adapter}`;
    const server = createWorkerServer({
      token,
      adapter,
      agentId: workerId,
      demoMode: true,
      dataPath: null,
      workspace: process.cwd(),
      ...(adapter === 'claude-code'
        ? {
            claudeOAuthUsage: true,
            claudeHome,
            usagePollIntervalMs: 0,
            claudeUsageIntervalMs: 0,
            claudeUsageFetch: () => new Response(
              JSON.stringify(claude.healthy ? USAGE_PAYLOAD : { error: 'unauthorized' }),
              { status: claude.healthy ? 200 : 401, headers: { 'content-type': 'application/json' } }
            )
          }
        : {})
    });
    workers[adapter] = { server, url: await listen(server), token, workerId };
  }

  const runtimeManager = createFakeRuntimeManager(workers);
  const control = createControlPlane({
    workerUrl: workers['codex-cli'].url,
    workerToken: token,
    runtimeManager,
    dataPath: null,
    attachmentRoots: {
      projects: { label: 'Projects', hostPath: '/Users/tester/Projects', allowWrite: true },
      reference: { label: 'Reference', hostPath: '/Users/tester/Reference', allowWrite: false }
    },
    credentialKeyProvider: environmentKeyProvider({
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
    })
  });
  const url = await listen(control);

  const agents = {};
  for (const [name, adapter] of [['Codex', 'codex-cli'], ['Claude', 'claude-code'], ['OpenCode', 'opencode']]) {
    const response = await fetch(`${url}/api/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, description: `${name} under test`, adapter, runtime: { mode: 'provision' } })
    });
    agents[adapter] = (await response.json()).agent;
  }

  return {
    url,
    agents,
    claude,
    runtimeManager,
    async close() {
      await rm(claudeHome, { recursive: true, force: true });
      await new Promise((resolve) => control.close(resolve));
      await Promise.all(Object.values(workers).map((worker) => new Promise((resolve) => worker.server.close(resolve))));
    }
  };
}

before(async () => {
  browser = await chromium.launch();
  app = await startApp();
});

after(async () => {
  await browser?.close();
  await app?.close();
});

async function openPage(path = '/') {
  const page = await browser.newPage();
  await page.goto(`${app.url}${path}`);
  return page;
}

// Collect what the browser complains about. Some of these never surface in the
// DOM at all: an input `pattern` that fails to compile is reported here and the
// constraint is then silently dropped, so the field validates nothing and looks
// completely normal.
function collectBrowserErrors(page) {
  const errors = [];
  const record = (text) => {
    if (text.includes('favicon.ico')) return;
    errors.push(text);
  };
  page.on('console', (message) => { if (message.type() === 'error') record(message.text()); });
  page.on('pageerror', (error) => record(String(error)));
  return errors;
}

test('the whole fleet card is the link into its agent', async (t) => {
  const page = await openPage('/');
  t.after(() => page.close());
  await page.waitForSelector('a.agent-card');

  const card = page.locator(`a.agent-card[data-agent-id="${app.agents['codex-cli'].id}"]`);
  // Clicking body text, not a button: the card itself must navigate.
  await card.locator('.agent-card-description').click();
  await page.waitForURL(`**/agents/${app.agents['codex-cli'].id}`);

  // The removed footer controls must not have come back.
  await page.goBack();
  await page.waitForSelector('a.agent-card');
  assert.equal(await page.locator('.card-delete').count(), 0, 'delete returned to the fleet card');
  assert.equal(await page.locator('.configure-link').count(), 0, 'the open-agent link returned to the fleet card');
});

test('the signed-in identity explains where authorization roles are configured', async (t) => {
  const page = await openPage('/');
  t.after(() => page.close());
  await page.click('#access-policy-button');
  await page.waitForFunction(() => document.querySelector('#access-policy-dialog')?.open === true);

  const text = await page.locator('#access-policy-dialog').textContent();
  assert.match(text, /not currently editable in this web interface/i);
  assert.match(text, /AUTH_DEFAULT_ROLE/);
  assert.match(text, /AUTH_OPERATOR_SUBJECTS/);
  assert.match(text, /AUTH_ADMIN_SUBJECTS/);
  assert.equal(await page.locator('#access-identity-role').textContent(), 'admin');
  assert.match(text, /Read fleet, agent, schedule, usage, and runtime status/);
});

test('fleet cards choose useful columns and keep every fragment inside the viewport', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());

  for (const width of [1180, 980, 820, 640, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${app.url}/`);
    await page.waitForSelector('a.agent-card');
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('.agent-card')].map((card) => ({
        top: Math.round(card.getBoundingClientRect().top),
        clientWidth: card.clientWidth,
        scrollWidth: card.scrollWidth
      }))
    }));
    assert.equal(layout.documentWidth, layout.viewport, `${width}px viewport has horizontal page overflow`);
    for (const card of layout.cards) {
      assert.ok(card.scrollWidth <= card.clientWidth + 1, `${width}px card contains an overflowing fragment`);
    }
    const firstRowCards = layout.cards.filter((card) => card.top === layout.cards[0].top).length;
    assert.equal(firstRowCards, width >= 980 ? 2 : 1, `${width}px selected an awkward fleet column count`);
  }
});

test('a worker 401 marks that agent offline without restarting the control-plane login flow', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const agent = app.agents['codex-cli'];
  await page.route(`**/api/v1/agents/${agent.id}/status`, (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Worker credential is stale' })
  }));
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await page.goto(`${app.url}/`);
  const card = page.locator(`a.agent-card[data-agent-id="${agent.id}"]`);
  await card.waitFor();
  await page.waitForFunction(
    (id) => document.querySelector(`a.agent-card[data-agent-id="${id}"] .status-pill`)?.textContent === 'offline',
    agent.id
  );
  // Wait across a live-update tick: a generic 401 used to navigate to /login,
  // return here, and repeat every three seconds.
  await page.waitForTimeout(3_500);

  assert.equal(page.url(), `${app.url}/`);
  assert.equal(navigations, 1, 'the worker response restarted the browser login flow');
  assert.equal(await card.locator('.status-pill').textContent(), 'offline');
});

test('the harness picker keeps selection, highlight and submitted value in step', async (t) => {
  const page = await openPage('/');
  t.after(() => page.close());
  await page.click('#new-agent');
  await page.waitForFunction(() => document.querySelector('#create-agent-dialog')?.open === true);

  const claudeOption = page.locator('#create-adapter input[value="claude-code"]');
  await claudeOption.check();

  assert.equal(await claudeOption.isChecked(), true);
  const highlighted = await page.locator('#create-adapter .runtime-option.selected input').getAttribute('value');
  assert.equal(highlighted, 'claude-code', 'the highlight did not follow the selection');
  assert.equal(
    await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#create-agent-form'))).adapter),
    'claude-code'
  );

  // Reopening resets the form. reset() fires no change event, so the highlight
  // has to be re-derived rather than driven by one.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#create-agent-dialog')?.open === false);
  await page.click('#new-agent');
  await page.waitForFunction(() => document.querySelector('#create-agent-dialog')?.open === true);
  assert.equal(await page.locator('#create-adapter input[value="codex-cli"]').isChecked(), true);
  assert.equal(
    await page.locator('#create-adapter .runtime-option.selected input').getAttribute('value'),
    'codex-cli',
    'the highlight survived a reset it should have followed'
  );
});

test('a deferred one-off job is configured without scheduling notation', async (t) => {
  const page = await openPage('/jobs');
  t.after(() => page.close());
  await page.click('#new-job');
  await page.waitForFunction(() => document.querySelector('#job-dialog')?.open === true);

  const dialogText = await page.locator('#job-dialog').textContent();
  assert.doesNotMatch(dialogText, /cron|five-field|expression/i);
  assert.equal(await page.locator('#job-cron').getAttribute('type'), 'hidden');
  assert.match(dialogText, /Run once later/);

  const name = 'Deferred browser test';
  t.after(async () => {
    const result = await (await fetch(`${app.url}/api/v1/schedules`)).json();
    await Promise.all(result.schedules.filter((schedule) => schedule.name === name)
      .map((schedule) => fetch(`${app.url}/api/v1/schedules/${schedule.id}`, { method: 'DELETE' })));
  });
  await page.fill('#job-name', name);
  await page.fill('#job-prompt', 'Run this task one time in the future.');
  await page.fill('#job-run-at', '2099-01-02T10:15');
  await page.click('#save-job');
  await page.waitForFunction((expected) => [...document.querySelectorAll('.job-card h2')].some((heading) => heading.textContent === expected), name);

  const result = await (await fetch(`${app.url}/api/v1/schedules`)).json();
  const schedule = result.schedules.find((candidate) => candidate.name === name);
  assert.equal(schedule.timing.kind, 'once');
  assert.equal(schedule.timing.at, new Date('2099-01-02T10:15').toISOString());
  assert.match(await page.locator(`.job-card[data-schedule-id="${schedule.id}"]`).textContent(), /Run once/);
});

test('the Data tab maps a chosen folder with explicit access in one flow', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#data`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#attachment-count')?.textContent === '0 attached');

  await page.click('#new-attachment');
  await page.selectOption('#attachment-root', 'projects');
  assert.match(await page.locator('#attachment-root-policy').textContent(), /choose read-only or exclusive read\/write/i);
  assert.equal(await page.locator('#attachment-access').inputValue(), 'read-only');
  await page.click('#browse-attachment');
  const projectFolder = page.locator('.folder-browser-row').filter({ hasText: 'agent-container' });
  await projectFolder.waitFor({ state: 'visible' });
  await projectFolder.click();
  await page.waitForFunction(() => document.querySelector('#folder-browser-selection')?.textContent === 'agent-container');
  assert.match(await page.locator('#folder-browser-breadcrumbs').textContent(), /Projects\/agent-container/);
  await page.click('#choose-folder');
  assert.equal(await page.locator('#attachment-path').getAttribute('readonly'), '');
  assert.equal(await page.locator('#attachment-path').inputValue(), 'agent-container');
  await page.fill('#attachment-name', 'project');
  await page.selectOption('#attachment-access', 'read-write');
  await page.selectOption('#attachment-purpose', 'working-directory');
  assert.match(await page.locator('#attachment-policy').textContent(), /exclusive/);
  await page.click('#save-attachment');
  await page.waitForFunction(() => document.querySelector('#attachment-count')?.textContent === '1 attached');

  const attachmentCard = page.locator('#attachment-list .data-record');
  assert.match(await attachmentCard.textContent(), /WORKING DIRECTORY/);
  assert.match(await attachmentCard.textContent(), /read \/ write/);
  assert.match(await attachmentCard.textContent(), /\/data\/project/);
  assert.equal(await page.locator('#workspace-root').textContent(), '/data/project');
  assert.equal(await page.locator('#workspace-access').textContent(), 'read / write');
  assert.match(await page.locator('#workspace-description').textContent(), /agent-container/);

  const attachmentState = await (await fetch(`${app.url}/api/v1/agents/${agent.id}/attachments`)).json();
  assert.equal(attachmentState.workingDirectory, '/data/project');
  assert.equal(attachmentState.attachments[0].access, 'read-write');
  assert.equal(JSON.stringify(attachmentState).includes('/Users/tester/Projects'), false);
  assert.equal(app.runtimeManager.recreated.at(-1).attachments[0].mount.ReadOnly, false);

  const attachment = attachmentState.attachments[0];
  const source = attachment.source;
  await fetch(`${app.url}/api/v1/agents/${agent.id}/attachments/${attachment.id}`, { method: 'DELETE' });
  await fetch(`${app.url}/api/v1/data-sources/${source.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}'
  });
});

test('streaming task submission uses the authenticated CSRF request path', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#test`);
  t.after(() => page.close());
  let requestHeaders;
  let requestBody;
  await page.route(`**/api/v1/agents/${agent.id}/tasks`, async (route) => {
    requestHeaders = route.request().headers();
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: '{"type":"task.completed","taskId":"browser-csrf-test","data":{"status":"completed"}}\n'
    });
  });
  await page.waitForFunction(() => document.querySelector('#run-button')?.disabled === false);
  assert.equal(await page.getByText('New conversation', { exact: true }).count(), 1);
  assert.equal(await page.locator('#prompt').getAttribute('maxlength'), '100000');
  await page.fill('#prompt', 'Verify the authenticated');
  await page.press('#prompt', 'Shift+Enter');
  await page.type('#prompt', 'streaming request.');
  assert.equal(await page.locator('#prompt').inputValue(), 'Verify the authenticated\nstreaming request.');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');
  assert.equal(requestHeaders?.['x-agent-dock-csrf'], '1');
  assert.equal(requestBody?.prompt, 'Verify the authenticated\nstreaming request.');
  assert.match(requestBody?.conversationId, /^test-/);
});

test('the Test workbench continues one harness conversation until the operator starts over', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#test`);
  t.after(() => page.close());
  const requests = [];
  await page.route(`**/api/v1/agents/${agent.id}/conversations/*`, (route) => route.fulfill({ status: 204 }));
  await page.route(`**/api/v1/agents/${agent.id}/tasks`, async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const turn = requests.filter((request) => request.conversationId === body.conversationId).length;
    const taskId = `conversation-task-${requests.length}`;
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        JSON.stringify({ type: 'conversation.continued', taskId, data: { conversationId: body.conversationId, resumed: turn > 1, turns: turn } }),
        JSON.stringify({ type: 'task.started', taskId, data: { executionMode: 'provider-sandbox', model: 'claude-test' } }),
        JSON.stringify({ type: 'activity.started', taskId, data: { kind: 'tool', name: 'Inspect files' } }),
        JSON.stringify({ type: 'message.completed', taskId, data: { role: 'assistant', text: `answer ${requests.length}` } }),
        JSON.stringify({ type: 'usage.observed', taskId, data: { request: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }),
        JSON.stringify({ type: 'task.completed', taskId, data: { status: 'succeeded', exitCode: 0 } })
      ].join('\n') + '\n'
    });
  });

  await page.waitForFunction(() => document.querySelector('#test-session-state')?.textContent === 'not started');
  await page.fill('#prompt', 'first request');
  await page.click('#run-button');
  await page.locator('.test-turn', { hasText: 'answer 1' }).waitFor();
  await page.fill('#prompt', 'follow-up request');
  await page.click('#run-button');
  await page.locator('.test-turn', { hasText: 'answer 2' }).waitFor();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].conversationId, requests[1].conversationId);
  assert.equal(await page.locator('.test-turn').count(), 2);
  assert.match(await page.locator('.test-turn').nth(1).textContent(), /resumed conversation/);
  assert.match(await page.locator('.test-turn').nth(1).textContent(), /15 tokens/);
  assert.match(await page.locator('#test-session-state').textContent(), /2 turns/);

  await page.click('#new-conversation');
  await page.locator('.conversation-empty').waitFor();
  assert.equal(await page.locator('.test-turn').count(), 0);
  assert.equal((await page.locator('#test-session-state').textContent()).trim(), 'not started');

  await page.fill('#prompt', 'fresh request');
  await page.click('#run-button');
  await page.locator('.test-turn', { hasText: 'answer 3' }).waitFor();
  assert.notEqual(requests[2].conversationId, requests[1].conversationId);
  assert.equal(await page.locator('.test-turn').count(), 1);
  assert.equal(await page.locator('#conversation').getAttribute('aria-live'), 'off');
  assert.equal(await page.locator('#test-turn-live').getAttribute('role'), 'status');
});

test('starting over does not delete a conversation the worker never established', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#test`);
  t.after(() => page.close());
  let cleanupRequests = 0;
  await page.route(`**/api/v1/agents/${agent.id}/conversations/*`, async (route) => {
    cleanupRequests += 1;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) });
  });
  await page.route(`**/api/v1/agents/${agent.id}/tasks`, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'The first turn failed before a conversation was created.' })
  }));

  await page.waitForFunction(() => document.querySelector('#run-button')?.disabled === false);
  await page.fill('#prompt', 'fail before establishing context');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent?.includes('first turn failed'));
  await page.click('#new-conversation');

  assert.equal(cleanupRequests, 0);
  assert.equal((await page.locator('#run-message').textContent()).trim(), 'New conversation ready');
});

test('a runtime without conversation support is described honestly and receives independent turns', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await browser.newPage();
  t.after(() => page.close());
  let requestBody;
  const statusResponse = await fetch(`${app.url}/api/v1/agents/${agent.id}/status`);
  const unsupportedStatus = await statusResponse.json();
  unsupportedStatus.capabilities.tasks.conversations = false;
  await page.route(`**/api/v1/agents/${agent.id}/status`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(unsupportedStatus)
  }));
  await page.route(`**/api/v1/agents/${agent.id}/tasks`, async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        JSON.stringify({ type: 'task.started', taskId: 'independent-task', data: { executionMode: 'demo' } }),
        JSON.stringify({ type: 'message.completed', taskId: 'independent-task', data: { role: 'assistant', text: 'independent answer' } }),
        JSON.stringify({ type: 'task.completed', taskId: 'independent-task', data: { status: 'succeeded', exitCode: 0 } })
      ].join('\n') + '\n'
    });
  });

  await page.goto(`${app.url}/agents/${agent.id}#test`);
  await page.waitForFunction(() => document.querySelector('#test-session-state')?.textContent === 'no continuity');
  assert.match(await page.locator('#test-session-note').textContent(), /cannot continue a conversation/i);
  await page.fill('#prompt', 'answer this independently');
  await page.press('#prompt', 'Enter');
  await page.locator('.test-turn', { hasText: 'independent answer' }).waitFor();

  assert.equal(requestBody?.conversationId, undefined);
  assert.match(await page.locator('.test-turn-context').textContent(), /independent turn/i);
});

// Uses the real demo worker (no page.route mocking) rather than a scripted
// fixture: the demo adapter genuinely streams task.started, then the answer,
// then completion over real ~120ms gaps (worker/server.mjs runDemo), which is
// what gives the operator's mid-stream scroll an actual window to land in.
test('the transcript keeps a manual scroll position during streaming and resumes on a new turn', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#test`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#run-button')?.disabled === false);

  const runTurn = async (prompt) => {
    await page.fill('#prompt', prompt);
    await page.click('#run-button');
    await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');
  };

  // Enough turns to make the transcript taller than its own viewport, or there
  // is nothing for a scroll-up to preserve.
  for (let i = 1; i <= 5; i += 1) {
    await runTurn(`seed turn ${i}: ${'enough transcript content to require scrolling. '.repeat(12)}`);
  }
  const overflowing = await page.evaluate(() => {
    const el = document.querySelector('#conversation');
    return el.scrollHeight > el.clientHeight;
  });
  assert.ok(overflowing, 'the seed turns did not make the transcript scrollable, so scroll preservation below proves nothing');

  // Start one more turn, then scroll up the instant its card appears —
  // before the streamed answer and completion events land.
  await page.fill('#prompt', 'streaming turn');
  await page.click('#run-button');
  await page.waitForFunction((count) => document.querySelectorAll('.test-turn').length === count, 6);
  await page.evaluate(() => { document.querySelector('#conversation').scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');

  const scrollTopAfterStreaming = await page.evaluate(() => document.querySelector('#conversation').scrollTop);
  assert.ok(scrollTopAfterStreaming < 20, 'a streamed event snapped the transcript back to the bottom while the operator was reading an earlier turn');

  // Sending a new turn resumes following even though the operator never
  // scrolled back down themselves.
  await runTurn('resumed turn');
  const followingAfterNewTurn = await page.evaluate(() => {
    const el = document.querySelector('#conversation');
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
  });
  assert.ok(followingAfterNewTurn, 'sending a new turn did not resume following the transcript');

  // Scrolling back down to the bottom by hand also resumes following, without
  // needing to send a turn.
  await page.fill('#prompt', 'one more turn to scroll away from');
  await page.click('#run-button');
  await page.waitForFunction((count) => document.querySelectorAll('.test-turn').length === count, 8);
  await page.evaluate(() => { document.querySelector('#conversation').scrollTop = 0; });
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    const el = document.querySelector('#conversation');
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');
  const followingAfterManualReturn = await page.evaluate(() => {
    const el = document.querySelector('#conversation');
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
  });
  assert.ok(followingAfterManualReturn, 'scrolling back to the bottom by hand did not resume following the transcript');
});

// The demo worker's fixed reply text is too short to be pathological on its
// own, so this scripts a single response carrying the shapes that have
// actually overflowed a card: a bare URL, a run-on word with no break
// opportunities, inline-code-style text, and a multi-line preformatted block,
// plus a long value in the collapsible activity panel.
test('long agent output stays inside its turn card at narrow and normal widths', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setViewportSize({ width: 1180, height: 900 });

  const longWord = 'a'.repeat(220);
  const longUrl = `https://example.test/${'b'.repeat(180)}/resource?token=${'c'.repeat(120)}`;
  const preformatted = Array.from({ length: 6 }, (_, i) => `line ${i}: ${'d'.repeat(140)}`).join('\n');
  const answerText = `Read this: ${longUrl}\nInline code like \`${longWord}\` and a run-on word ${longWord}.\n\n${preformatted}`;

  await page.route(`**/api/v1/agents/${agent.id}/tasks`, async (route) => {
    const taskId = 'overflow-task';
    const body = [
      JSON.stringify({ type: 'task.started', taskId, data: { executionMode: 'demo' } }),
      JSON.stringify({ type: 'activity.started', taskId, data: { kind: 'tool', name: 'fetch', command: longUrl } }),
      JSON.stringify({ type: 'message.completed', taskId, data: { role: 'assistant', text: answerText } }),
      JSON.stringify({ type: 'task.completed', taskId, data: { status: 'succeeded', exitCode: 0 } })
    ].join('\n') + '\n';
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
  });

  await page.goto(`${app.url}/agents/${agent.id}#test`);
  await page.waitForFunction(() => document.querySelector('#run-button')?.disabled === false);
  await page.fill('#prompt', 'produce pathological output');
  await page.click('#run-button');
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');
  // Open the activity panel so its long value is actually laid out rather
  // than sitting inert inside a closed <details>.
  await page.click('.test-turn-activity summary');

  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const doc = document.documentElement;
      const card = document.querySelector('.test-turn');
      const overflowing = [...card.querySelectorAll('*')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => ({ tag: el.tagName, cls: el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      return {
        viewport: doc.clientWidth,
        documentWidth: doc.scrollWidth,
        cardScrollWidth: card.scrollWidth,
        cardClientWidth: card.clientWidth,
        overflowing
      };
    });
    assert.equal(layout.documentWidth, layout.viewport, `${width}px viewport has horizontal page overflow`);
    assert.ok(layout.cardScrollWidth <= layout.cardClientWidth + 1, `${width}px turn card itself overflows its own bounds`);
    assert.deepEqual(layout.overflowing, [], `${width}px has a fragment overflowing its own box: ${JSON.stringify(layout.overflowing)}`);
  }
});

test('the Test agent shortcut reveals the workbench without focus scrolling past it', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}`);
  t.after(() => page.close());

  await page.click('#test-agent-button');
  await page.waitForTimeout(500);

  const layout = await page.evaluate(() => ({
    headingTop: document.querySelector('#test-panel h2')?.getBoundingClientRect().top,
    tabBottom: document.querySelector('.tab-list')?.getBoundingClientRect().bottom,
    activeElement: document.activeElement?.id,
    activeTab: document.querySelector('.tab-button.active')?.dataset.tab
  }));
  assert.equal(layout.activeTab, 'test');
  assert.equal(layout.activeElement, 'prompt');
  assert.ok(layout.headingTop >= layout.tabBottom, 'focusing the composer scrolled the workbench heading behind the tabs');
  assert.ok(layout.headingTop < 260, 'the shortcut did not bring the workbench heading near the top of the viewport');
});

test('the workspace navigator expands folders and filters nested files', async (t) => {
  const agent = app.agents['claude-code'];
  const page = await openPage(`/agents/${agent.id}#data`);
  t.after(() => page.close());
  const folder = page.locator('[data-path="control-plane"] > .file-tree-row');
  await folder.waitFor({ state: 'visible' });
  assert.equal(await folder.getAttribute('aria-expanded'), 'false');
  await folder.click();
  assert.equal(await folder.getAttribute('aria-expanded'), 'true');
  await page.locator('[data-path="control-plane/auth.mjs"] > .file-tree-row').waitFor({ state: 'visible' });

  await page.fill('#workspace-search', 'docker-runtime.mjs');
  await page.locator('[data-path="control-plane/docker-runtime.mjs"] > .file-tree-row').waitFor({ state: 'visible' });
  assert.match(await page.locator('#workspace-list-message').textContent(), /item/);
  assert.equal(await page.locator('#file-list').getAttribute('role'), 'tree');
});

test('a weekly job uses plain-language controls while the API receives cron internally', async (t) => {
  const page = await openPage('/jobs');
  t.after(() => page.close());
  await page.click('#new-job');
  await page.check('[name="jobTiming"][value="cron"]');
  await page.selectOption('#job-frequency', 'weekly');
  await page.selectOption('#job-weekday', '2');
  await page.fill('#job-repeat-time', '14:30');
  await page.selectOption('#job-timezone', 'UTC');

  assert.match(await page.locator('#job-schedule-summary').textContent(), /Every Tuesday at 2:30 PM/);
  const name = 'Tuesday browser test';
  t.after(async () => {
    const result = await (await fetch(`${app.url}/api/v1/schedules`)).json();
    await Promise.all(result.schedules.filter((schedule) => schedule.name === name)
      .map((schedule) => fetch(`${app.url}/api/v1/schedules/${schedule.id}`, { method: 'DELETE' })));
  });
  await page.fill('#job-name', name);
  await page.fill('#job-prompt', 'Run this task every Tuesday.');
  await page.click('#save-job');
  await page.waitForFunction((expected) => [...document.querySelectorAll('.job-card h2')].some((heading) => heading.textContent === expected), name);

  const result = await (await fetch(`${app.url}/api/v1/schedules`)).json();
  const schedule = result.schedules.find((candidate) => candidate.name === name);
  assert.deepEqual(schedule.timing, {
    kind: 'cron',
    expression: '30 14 * * 2',
    timezone: 'UTC'
  });
  const cardText = await page.locator(`.job-card[data-schedule-id="${schedule.id}"]`).textContent();
  assert.match(cardText, /Every Tuesday at 2:30 PM/);
  assert.doesNotMatch(cardText, /30 14 \* \* 2/);
});

test('a provider with no quota windows renders unavailable, never zero', async (t) => {
  const page = await openPage(`/agents/${app.agents.opencode.id}`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#primary-quota-summary')?.textContent !== '—');

  const summary = await page.locator('#primary-quota-summary').textContent();
  assert.equal(summary, 'Unavailable');
  assert.notEqual(summary, '0% used');

  // An empty bar reads as zero; the track has to say "no reading".
  const track = await page.locator('#primary-quota-bar').evaluate((bar) => bar.parentElement.className);
  assert.match(track, /unavailable/);
  assert.match(await page.locator('#primary-quota-reset').textContent(), /does not expose/i);
});

test('a failed poll marks retained windows stale instead of showing them as current', async (t) => {
  const page = await openPage(`/agents/${app.agents['claude-code'].id}`);
  t.after(() => page.close());

  await page.waitForFunction(() => document.querySelector('#secondary-quota-summary')?.textContent === '100% used');
  assert.equal(await page.locator('#primary-quota-summary').textContent(), '12% used');

  // The source breaks. The server keeps the last good windows on purpose, so
  // the UI must say they are no longer current rather than redraw them as live.
  app.claude.healthy = false;
  await page.waitForFunction(
    () => document.querySelector('#secondary-quota-summary')?.textContent?.includes('stale'),
    null,
    { timeout: 15_000 }
  );

  assert.match(await page.locator('#secondary-quota-summary').textContent(), /100% used · stale/);
  assert.match(await page.locator('#secondary-quota-reset').textContent(), /Last known reading/);
  // A countdown from a reset time we can no longer trust would be a fresh lie.
  assert.doesNotMatch(await page.locator('#secondary-quota-reset').textContent(), /refreshes in/);
  const track = await page.locator('#secondary-quota-bar').evaluate((bar) => bar.parentElement.className);
  assert.match(track, /stale/);

  app.claude.healthy = true;
});

test('a credential the provider rejects offers a way to sign in again', async (t) => {
  // Its own instance: a rejected credential puts the worker into an auth backoff
  // that outlives the test, so sharing one would make this depend on ordering.
  const isolated = await startApp();
  const page = await browser.newPage();
  t.after(async () => {
    await page.close();
    await isolated.close();
  });
  await page.goto(`${isolated.url}/agents/${isolated.agents['claude-code'].id}`);

  // Healthy: replacing a CLI-managed login remains an explicit operator action.
  await page.waitForFunction(() => document.querySelector('#auth-button')?.textContent === 'Re-authenticate');
  assert.equal(await page.locator('#auth-button').isDisabled(), false);

  // The provider rejects the token while the harness still reports a login.
  // Telling someone to sign in again with every control disabled is a dead end.
  isolated.claude.healthy = false;
  await page.waitForFunction(
    () => document.querySelector('#auth-copy')?.textContent?.includes('rejected it'),
    null,
    { timeout: 15_000 }
  );
  assert.equal(await page.locator('#auth-button').textContent(), 'Re-authenticate');
  assert.equal(await page.locator('#auth-button').isDisabled(), false, 'the only offered remedy was not clickable');
  assert.match(await page.locator('#auth-copy').textContent(), /rejected it/);
  assert.equal(await page.locator('#runtime-details').getAttribute('open'), '', 'the remedy stayed hidden in a collapsed disclosure');
  assert.equal(await page.locator('#refresh-auth').isVisible(), false, 'an unsupported force-refresh action was presented as a disabled remedy');
});

test('the Claude session check is explicit, warns about usage, and stays hidden for unsupported adapters', async (t) => {
  const claude = app.agents['claude-code'];
  const page = await browser.newPage();
  t.after(() => page.close());

  let checks = 0;
  await page.route(`**/api/v1/agents/${claude.id}/auth/session-check`, async (route) => {
    checks += 1;
    await route.continue();
  });
  await page.goto(`${app.url}/agents/${claude.id}`);
  const button = page.locator('#session-check');
  await button.waitFor({ state: 'visible' });
  assert.match(await button.locator('xpath=..').textContent(), /may consume.*subscription usage/i);

  // Live status polling must never turn this paid provider operation into an
  // implicit background check.
  await page.waitForTimeout(3_500);
  assert.equal(checks, 0);

  await button.click();
  await page.waitForFunction(() => document.querySelector('#session-check-message')?.textContent?.includes('Demo mode'));
  assert.equal(checks, 1);

  await page.goto(`${app.url}/agents/${app.agents['codex-cli'].id}`);
  await page.waitForFunction(() => document.querySelector('#agent-name')?.textContent === 'Codex');
  assert.equal(await page.locator('#session-check').isVisible(), false);
});

test('an interactive provider login can be cancelled from the authentication card', async (t) => {
  const claude = app.agents['claude-code'];
  const page = await browser.newPage();
  t.after(() => page.close());
  let cancellations = 0;
  let resolveCancellation;
  const cancellationObserved = new Promise((resolve) => { resolveCancellation = resolve; });

  await page.route(`**/api/v1/agents/${claude.id}/status`, async (route) => {
    const upstream = await route.fetch();
    const status = await upstream.json();
    status.authentication = {
      ...status.authentication,
      authenticated: false,
      phase: 'waiting_for_user',
      detail: 'Authentication is in progress',
      challenge: {
        verificationUri: 'https://provider.example.test/authorize',
        userCode: null,
        requiresInput: true,
        instructions: 'Paste the full code returned by the provider.'
      }
    };
    status.usage = { ...status.usage, pollError: null, pollErrorKind: null };
    await route.fulfill({ response: upstream, json: status });
  });
  await page.route(`**/api/v1/agents/${claude.id}/auth/cancel`, async (route) => {
    cancellations += 1;
    resolveCancellation();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authentication: { authenticated: true, phase: 'authenticated', challenge: {} } })
    });
  });

  await page.goto(`${app.url}/agents/${claude.id}`);
  await page.waitForFunction(() => document.querySelector('#auth-button')?.textContent === 'Cancel sign-in');
  assert.equal(await page.locator('#auth-button').isDisabled(), false);
  await page.click('#auth-button');
  await cancellationObserved;
  assert.equal(cancellations, 1);
});

test('image drift is shown only for a managed runtime that is behind', async (t) => {
  // The tag does not move when an image is rebuilt, so drift is decided by the
  // image id. Bumping it is what a rebuild looks like to the control plane.
  app.runtimeManager.currentImage = 'agent-dock-worker:v2';

  const page = await openPage('/');
  t.after(() => {
    app.runtimeManager.currentImage = 'agent-dock-worker:v1';
    return page.close();
  });
  await page.waitForSelector('a.agent-card');
  await page.waitForFunction(() => [...document.querySelectorAll('.card-outdated')].some((badge) => !badge.classList.contains('hidden')));

  for (const agent of Object.values(app.agents)) {
    const badge = page.locator(`a.agent-card[data-agent-id="${agent.id}"] .card-outdated`);
    assert.equal(await badge.isVisible(), true, `${agent.id} is behind but shows no badge`);
  }

  const agentPage = await browser.newPage();
  t.after(() => agentPage.close());
  await agentPage.goto(`${app.url}/agents/${app.agents['codex-cli'].id}`);
  await agentPage.waitForFunction(() => !document.querySelector('#runtime-drift')?.classList.contains('hidden'));
  assert.match(await agentPage.locator('#refresh-runtime').textContent(), /update available/);
});

test('a persisted runtime recovery failure remains visible on the agent page', async (t) => {
  const agent = app.agents['claude-code'];
  const runtime = app.runtimeManager.provisioned.find((candidate) => candidate.id === agent.runtime.id);
  runtime.lastError = 'MCP configuration could not be re-applied after refresh: validation failed';
  t.after(() => { runtime.lastError = null; });

  const page = await openPage(`/agents/${agent.id}`);
  t.after(() => page.close());
  const alert = page.locator('#runtime-error');
  await alert.waitFor({ state: 'visible' });
  assert.match(await alert.textContent(), /MCP configuration could not be re-applied/);
});

test('the status poll cannot re-enable a runtime refresh that is still running', async (t) => {
  const page = await openPage(`/agents/${app.agents['codex-cli'].id}`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#refresh-runtime')?.disabled === false);

  // Hold the refresh open across more than one three-second status tick. The
  // poll and the refresh handler both write this control; without a guard the
  // poll re-enables it and a second click fires a refresh the server rejects.
  let releaseRecreate;
  app.runtimeManager.recreateDelay = new Promise((resolve) => { releaseRecreate = resolve; });
  t.after(() => releaseRecreate?.());

  page.on('dialog', (dialog) => dialog.accept());
  await page.click('.agent-menu summary');
  await page.click('#refresh-runtime');

  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    await page.waitForTimeout(900);
    samples.push(await page.locator('#refresh-runtime').evaluate((button) => ({
      disabled: button.disabled,
      text: button.textContent
    })));
  }

  // Prove a poll actually ran in that window, or the samples prove nothing.
  const polls = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('/status')).length);
  assert.ok(polls > 0, 'no status poll ran during the window, so the guard was never tested');

  for (const sample of samples) {
    assert.equal(sample.disabled, true, 'the status poll re-enabled a refresh in flight');
    assert.equal(sample.text, 'Refreshing…', 'the status poll overwrote the in-flight label');
  }

  releaseRecreate();
  await page.waitForFunction(() => document.querySelector('#refresh-runtime')?.disabled === false);
});

test('no connection detail reaches the browser', async (t) => {
  const page = await openPage(`/agents/${app.agents['claude-code'].id}`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#auth-state')?.textContent !== '—');

  const html = await page.content();
  for (const secret of ['browser-test-token', 'workerToken', 'workerUrl']) {
    assert.ok(!html.includes(secret), `${secret} was rendered into the page`);
  }
  // The worker's own port must not be discoverable from the client either.
  const workerPort = new URL(app.runtimeManager.provisioned[0].workerUrl).port;
  assert.ok(!html.includes(`:${workerPort}`), 'a worker endpoint reached the DOM');
});


test('a credential can use a human-readable label and its value never comes back', async (t) => {
  const page = await openPage('/credentials');
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#credential-list')?.textContent?.includes('No credentials yet'));

  // The page states what encryption at rest actually protects, rather than
  // letting the phrase imply more than it does.
  const note = await page.locator('#credential-storage-detail').textContent();
  assert.match(note, /Anyone able to read this host can read them/);

  await page.click('#new-credential');
  await page.fill('#credential-name', 'Company docs key');
  await page.fill('#credential-hosts', 'mcp.example.com');
  await page.fill('#credential-value', 'sk-browser-secret-9999');
  await page.click('#credential-form button[type="submit"]');

  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 1);
  const row = page.locator('.credential-row').first();
  assert.match(await row.textContent(), /Company docs key/);
  assert.match(await row.textContent(), /…9999/);

  // Nothing on the page carries the value, including after a save.
  assert.ok(!(await page.content()).includes('sk-browser-secret-9999'), 'the value reached the page');

  // Reopening for edit offers to replace the value rather than showing it.
  await page.click('.credential-edit');
  assert.equal(await page.inputValue('#credential-value'), '');
  assert.match(await page.locator('#credential-value-hint').textContent(), /leave blank to keep it/);
  assert.equal(await page.inputValue('#credential-hosts'), 'mcp.example.com');
});

test('a placeholder is what asks for a key, and binds to a stored one', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-credential');

  await page.click('#new-credential');
  await page.fill('#credential-name', 'picker-key');
  await page.fill('#credential-hosts', 'mcp.example.com');
  await page.fill('#credential-value', 'sk-picker-000011112222');
  await page.click('#credential-form button[type="submit"]');
  await page.locator('.credential-row', { hasText: 'picker-key' }).waitFor();

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');

  // Nothing asks about a key while the definition needs none.
  assert.equal(await page.locator('#mcp-placeholders').isVisible(), false);

  await page.fill('#mcp-name', 'bound-connector');
  await page.fill('#mcp-url', 'https://mcp.example.com/mcp?key=${TOKEN}');

  // Writing the placeholder is what raises the question.
  const rows = page.locator('.placeholder-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /TOKEN/);
  assert.match(await rows.first().textContent(), /used in the URL/);
  assert.match(await rows.first().textContent(), /cannot be saved/);

  const choice = rows.first().locator('select');
  const option = await choice.locator('option', { hasText: 'picker-key' }).textContent();
  await choice.selectOption({ label: option.trim() });
  assert.match(await rows.first().textContent(), /Uses the stored key/);

  await page.click('#mcp-form button[type="submit"]');
  const row = page.locator('#registry-list .mcp-row', { hasText: 'bound-connector' });
  await row.waitFor();
  // The row says what fills the placeholder, by name.
  assert.match(await row.textContent(), /TOKEN ← stored key picker-key/);

  // The definition keeps the placeholder, never a value.
  const stored = await page.evaluate(async () => (await (await fetch('/api/v1/mcp/servers')).json()).servers);
  const definition = stored.find((item) => item.name === 'bound-connector');
  assert.match(definition.url, /\$\{TOKEN\}/);
  assert.equal(definition.placeholders.TOKEN.source, 'credential');
  assert.doesNotMatch(JSON.stringify(stored), /sk-picker-000011112222/);
});

test('a connector cannot be saved while a placeholder has nothing filling it', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'half-configured');
  await page.fill('#mcp-url', 'https://example.test/mcp?key=${UNFILLED}');
  await page.locator('.placeholder-row').first().waitFor();
  await page.click('#mcp-form button[type="submit"]');

  // Named, rather than a generic refusal, and the dialog stays open.
  const message = page.locator('#mcp-form-message');
  await message.waitFor({ state: 'visible' });
  assert.match(await message.textContent(), /UNFILLED/);
  assert.equal(await page.locator('#mcp-dialog').evaluate((node) => node.open), true);
});

test('every page opens its dialogs without a browser error', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = collectBrowserErrors(page);

  // Dialogs carry most of the markup that never renders until someone opens it,
  // which is exactly where a broken attribute survives a passing test suite.
  await page.goto(`${app.url}/credentials`);
  await page.click('#new-credential');
  await page.waitForSelector('#credential-dialog[open]');
  // Constraint validation is when the browser compiles a pattern attribute, so
  // a broken one is invisible until something asks the form whether it is valid.
  await page.evaluate(() => document.querySelector('#credential-form').checkValidity());
  await page.click('#close-credential-dialog');

  await page.goto(`${app.url}/agents/${app.agents['claude-code'].id}#tools`);
  await page.waitForSelector('#new-mcp');
  await page.click('#new-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.evaluate(() => document.querySelector('#mcp-form').checkValidity());

  assert.deepEqual(errors, [], `the browser reported errors: ${errors.join(' | ')}`);
});

// These share one control plane with every other test in this file, so each
// asserts on names it created rather than on the first row or an empty list.
test('credentials live inside the MCP page, not beside it in the nav', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#mcp-view:not(.hidden)');

  // Credentials only ever serve connectors, so they are a section of this page
  // rather than a peer of Fleet and Jobs.
  const nav = await page.locator('.nav-link').allTextContents();
  assert.deepEqual(nav.map((item) => item.trim()), ['Fleet', 'Jobs', 'MCP']);
  assert.ok(await page.locator('#connectors').isVisible());
  assert.ok(await page.locator('#credentials').isVisible());

  // The old address still resolves, so existing links and bookmarks survive.
  await page.goto(`${app.url}/credentials`);
  await page.waitForSelector('#mcp-view:not(.hidden)');
  assert.ok(await page.locator('#credentials').isVisible());
});

test('a connector defined from the MCP page is stored without being attached to anything', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  // With no agent in context the dialog defines only; it has nothing to attach to.
  assert.equal((await page.locator('#save-mcp').textContent()).trim(), 'Save connector');
  await page.fill('#mcp-name', 'registry-only');
  await page.fill('#mcp-url', 'https://registry-only.example.test/mcp');
  await page.click('#mcp-form button[type="submit"]');

  const row = page.locator('#registry-list .mcp-row', { hasText: 'registry-only' });
  await row.waitFor();
  assert.match(await row.textContent(), /remote HTTP/);
});

test('a refused delete is reported beside the list, not as the control plane going offline', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#credential-list');

  await page.click('#new-credential');
  await page.fill('#credential-name', 'in-use-key');
  await page.fill('#credential-hosts', 'inuse.example.com');
  await page.fill('#credential-value', 'sk-inuse-000011112222');
  await page.click('#credential-form button[type="submit"]');
  const credentialRow = page.locator('.credential-row', { hasText: 'in-use-key' });
  await credentialRow.waitFor();

  // Bind it into a connector through a placeholder, so the deletion is refused.
  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'uses-the-key');
  await page.fill('#mcp-url', 'https://inuse.example.com/mcp?key=${INUSE}');
  const row = page.locator('.placeholder-row').first();
  await row.waitFor();
  const option = await row.locator('option', { hasText: 'in-use-key' }).textContent();
  await row.locator('select').selectOption({ label: option.trim() });
  await page.click('#mcp-form button[type="submit"]');
  await page.locator('#registry-list .mcp-row', { hasText: 'uses-the-key' }).waitFor();

  page.on('dialog', (dialog) => dialog.accept());
  await credentialRow.locator('.text-button', { hasText: 'Delete' }).click();

  // Assert it is *visible*, not merely present. The first version of this test
  // checked textContent and passed while the paragraph was display:none behind a
  // duplicate id, so the fix it was written to defend did not actually work.
  const refusal = page.locator('#credential-list-message');
  await refusal.waitFor({ state: 'visible' });
  assert.match(await refusal.textContent(), /still used by/);
  // The topbar reports the control plane's health and must not be repurposed for
  // an ordinary refusal — that reads as the whole thing having gone down.
  assert.doesNotMatch(await page.locator('#connection-label').textContent(), /still used by/);
  assert.equal(await credentialRow.count(), 1, 'the credential was deleted despite being in use');

  // A failed save must report inside the dialog, not on the page behind it.
  await page.click('#new-credential');
  await page.fill('#credential-name', 'in-use-key');
  await page.fill('#credential-hosts', 'inuse.example.com');
  await page.fill('#credential-value', 'sk-duplicate-000011112222');
  await page.click('#credential-form button[type="submit"]');
  const dialogMessage = page.locator('#credential-message');
  await dialogMessage.waitFor({ state: 'visible' });
  assert.match(await dialogMessage.textContent(), /already exists/);
  assert.equal(await page.locator('#credential-dialog').evaluate((node) => node.open), true);
});

test('the workshop fills the connector form in place and keeps its conversation across corrections', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  // Asking is offered when defining something new, inside the dialog it fills —
  // and only once the harness list has loaded, so it never appears empty.
  await page.locator('#workshop').waitFor({ state: 'visible' });

  // Capture the conversation this run uses, so the assertion does not depend on
  // what any other test in this shared control plane has already created.
  const conversationIds = new Set();
  await page.route('**/api/v1/agents/*/tasks', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.conversationId) conversationIds.add(body.conversationId);
    await route.continue();
  });

  // Pick the harness explicitly rather than relying on which one sorts first.
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'a documentation connector');
  await page.click('#run-workshop');

  // The demo worker echoes the prompt back, so what returns is the example
  // proposal the prompt carries — which still exercises the whole path: stream,
  // extract, and fill the form the operator is looking at.
  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'lowercase_connector_name');
  // Assert the part that does not move with the prompt's worked example: the
  // proposal reached the form, and the placeholder it carries is being asked
  // about rather than silently pre-answered.
  await page.locator('.placeholder-row', { hasText: 'ACCESS_TOKEN' }).waitFor();
  // Not the validation verdict: that depends on the fixture's command allowlist,
  // and reporting it honestly is a separate behaviour with its own test. What
  // matters here is that the proposal reached the form.
  assert.match(await page.locator('#workshop-status').textContent(), /Filled in below/i);

  // A correction continues the same exchange rather than starting over, so the
  // harness still has everything it worked out the first time.
  await page.fill('#workshop-objective', 'no, it is the other endpoint');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelectorAll('#workshop-log p').length >= 4);

  assert.equal(conversationIds.size, 1, 'a correction started a new conversation instead of continuing one');
  const [conversationId] = [...conversationIds];
  const agentId = app.agents['claude-code'].id;
  const conversations = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/agents/${id}/conversations`);
    return response.json();
  }, agentId);
  const mine = (conversations.conversations ?? []).find((item) => item.id === conversationId);
  assert.ok(mine, 'the worker did not record the conversation this run used');
  assert.equal(mine.turns, 2);
});

test('workshop validation shows warning text and distinguishes a harness rejection', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  let run = 0;
  await page.route('**/api/v1/agents/*/tasks', (route) => {
    run += 1;
    const name = run === 1 ? 'warned-shape' : 'rejected-shape';
    const taskId = 'validation-' + run;
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId }),
        JSON.stringify({
          apiVersion: 'agent-wrapper/v1',
          type: 'message.completed',
          taskId,
          data: {
            role: 'assistant',
            text: '<agent-dock-mcp-proposal>{"name":"' + name + '","transport":"http","url":"https://slightly-off.example.test/mcp","timeoutMs":30000}</agent-dock-mcp-proposal>'
          }
        }),
        JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId, data: { status: 'succeeded' } })
      ].join('\n') + '\n'
    });
  });
  await page.route('**/api/v1/agents/*/mcp/validate', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.server?.name === 'warned-shape') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mcp: {
            validation: {
              warnings: [
                { message: 'First concrete adapter warning.' },
                { message: 'Second concrete adapter warning.' }
              ]
            }
          }
        })
      });
    }
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'This header combination is unsupported.' })
    });
  });

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.locator('#workshop').waitFor({ state: 'visible' });
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'a connector with adapter warnings');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelector('#workshop-status')?.textContent?.includes('with 2 warnings'));

  let log = await page.locator('#workshop-log').textContent();
  assert.match(log ?? '', /First concrete adapter warning/);
  assert.match(log ?? '', /Second concrete adapter warning/);

  await page.fill('#workshop-objective', 'try the rejected shape instead');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelector('#workshop-status')?.textContent?.includes('rejected the shape'));
  log = await page.locator('#workshop-log').textContent();
  assert.match(log ?? '', /This header combination is unsupported/);
});

test('editing an existing connector does not offer to ask a harness', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'already-known');
  await page.fill('#mcp-url', 'https://already-known.example.test/mcp');
  await page.click('#mcp-form button[type="submit"]');
  const row = page.locator('#registry-list .mcp-row', { hasText: 'already-known' });
  await row.waitFor();

  await row.locator('.text-button', { hasText: 'Edit' }).click();
  await page.waitForSelector('#mcp-dialog[open]');
  // Editing a known shape is a deliberate act, not a question for a harness.
  assert.equal(await page.locator('#workshop').isVisible(), false);
});

test('editing preserves every canonical connector field represented by the advanced form', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  const created = await page.evaluate(async () => {
    const create = async (body) => (await (await fetch('/api/v1/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-dock-csrf': '1' },
      body: JSON.stringify(body)
    })).json()).server;
    return Promise.all([
      create({
        name: 'preserve-http-fields',
        transport: 'http',
        url: 'https://preserve-http.example.test/mcp',
        headers: { 'X-Tenant': 'acme' },
        timeoutMs: 30_000
      }),
      create({
        name: 'preserve-stdio-fields',
        transport: 'stdio',
        command: 'node',
        args: ['/workspace/server.mjs'],
        cwd: '/workspace/project',
        environment: { LOG_LEVEL: 'warn' },
        timeoutMs: 30_000
      })
    ]);
  });
  await page.reload();

  let row = page.locator('#registry-list .mcp-row', { hasText: 'preserve-http-fields' });
  await row.locator('.text-button', { hasText: 'Edit' }).click();
  await page.waitForSelector('#mcp-dialog[open]');
  assert.equal(await page.locator('#mcp-advanced').evaluate((node) => node.open), true);
  assert.equal(await page.inputValue('#mcp-headers'), 'X-Tenant: acme');
  await page.fill('#mcp-timeout', '45');
  await page.click('#mcp-form button[type="submit"]');
  await page.locator('#mcp-dialog').waitFor({ state: 'hidden' });
  await row.waitFor();

  row = page.locator('#registry-list .mcp-row', { hasText: 'preserve-stdio-fields' });
  await row.locator('.text-button', { hasText: 'Edit' }).click();
  await page.waitForSelector('#mcp-dialog[open]');
  assert.equal(await page.inputValue('#mcp-cwd'), '/workspace/project');
  assert.equal(await page.inputValue('#mcp-environment'), 'LOG_LEVEL=warn');
  await page.fill('#mcp-timeout', '45');
  await page.click('#mcp-form button[type="submit"]');
  await page.locator('#mcp-dialog').waitFor({ state: 'hidden' });

  const stored = await page.evaluate(async () => (await (await fetch('/api/v1/mcp/servers')).json()).servers);
  const http = stored.find((server) => server.id === created[0].id);
  const stdio = stored.find((server) => server.id === created[1].id);
  assert.deepEqual(http.headers, { 'X-Tenant': 'acme' });
  assert.equal(http.timeoutMs, 45_000);
  assert.equal(stdio.cwd, '/workspace/project');
  assert.deepEqual(stdio.environment, { LOG_LEVEL: 'warn' });
  assert.equal(stdio.timeoutMs, 45_000);
});

test('a proposal from a task that failed is refused rather than filled in', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // A harness can emit a perfectly good proposal and then fail. Accepting it
  // would tell the operator to review something the wrapper reported as broken.
  await page.route('**/api/v1/agents/*/tasks', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: [
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'doomed' }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'message.completed', taskId: 'doomed', data: { role: 'assistant', text: '<agent-dock-mcp-proposal>{"name":"should-not-appear","transport":"http","url":"https://nope.example.test/mcp","timeoutMs":30000}</agent-dock-mcp-proposal>' } }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'doomed', data: { status: 'failed' } })
    ].join('\n') + '\n'
  }));

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'something that will fail');
  await page.click('#run-workshop');

  await page.waitForFunction(() => document.querySelector('#workshop-status')?.textContent?.includes('Nothing was filled in'));
  assert.equal(await page.inputValue('#mcp-name'), '', 'a failed run filled the form');
  assert.equal(await page.inputValue('#mcp-url'), '');
});

test('a runtime that cannot carry a conversation still gets a proposal, and says what was lost', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // An un-refreshed runtime refuses a conversationId. Losing follow-up
  // corrections is worth far less than losing the feature, so the ask is retried
  // without one — but the operator has to be told, or they will wonder why a
  // correction is ignored later.
  const dispatched = [];
  await page.route('**/api/v1/agents/*/tasks', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    // Record what was actually asked, not merely whether a conversation id was
    // attached. The first version of this test asserted booleans only, so it
    // passed even when the retry sent a bare objective with no instructions —
    // which is the entire reason the retry is worth having.
    dispatched.push({ conversation: Boolean(body.conversationId), instructed: /agent-dock-mcp-proposal/.test(body.prompt ?? '') });
    if (body.conversationId) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'This runtime cannot continue a conversation, and would answer without the earlier turns.' })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: [
        JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'legacy' }),
        JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'message.completed', taskId: 'legacy', data: { role: 'assistant', text: '<agent-dock-mcp-proposal>{"name":"legacy-runtime","transport":"http","url":"https://legacy.example.test/mcp","timeoutMs":30000}</agent-dock-mcp-proposal>' } }),
        JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'legacy', data: { status: 'succeeded' } })
      ].join('\n') + '\n'
    });
  });

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'a connector on an old runtime');
  await page.click('#run-workshop');

  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'legacy-runtime');
  assert.deepEqual(dispatched, [
    { conversation: true, instructed: true },
    { conversation: false, instructed: true }
  ], 'the retry must drop the conversation and keep the instructions');
  const log = await page.locator('#workshop-log').textContent();
  assert.match(log ?? '', /cannot carry a conversation/i);
});

test('a slow harness list cannot reveal the workshop inside an edit dialog', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // Define something to edit.
  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'existing-shape');
  await page.fill('#mcp-url', 'https://existing-shape.example.test/mcp');
  await page.click('#mcp-form button[type="submit"]');
  const row = page.locator('#registry-list .mcp-row', { hasText: 'existing-shape' });
  await row.waitFor();

  // Now make the harness list slow. Opening New starts that fetch; switching to
  // Edit before it resolves used to let the reveal land in the edit dialog — and
  // a run from there rewrites a saved connector into the model's proposed shape,
  // because the definition id is populated and Save becomes a PATCH.
  await page.route('**/api/v1/agents', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.click('#cancel-mcp');
  await row.locator('.text-button', { hasText: 'Edit' }).click();
  await page.waitForSelector('#mcp-dialog[open]');
  assert.equal(await page.inputValue('#mcp-name'), 'existing-shape');

  // Long enough for the earlier list request to have resolved.
  await page.waitForTimeout(4000);
  assert.equal(
    await page.locator('#workshop').isVisible(),
    false,
    'the workshop was revealed while editing a saved connector'
  );
});

test('switching harness starts a fresh exchange rather than a correction', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  const proposal = (name) => [
    JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: name }),
    JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'message.completed', taskId: name, data: { role: 'assistant', text: `<agent-dock-mcp-proposal>{"name":"${name}","transport":"http","url":"https://${name}.example.test/mcp","timeoutMs":30000}</agent-dock-mcp-proposal>` } }),
    JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: name, data: { status: 'succeeded' } })
  ].join('\n') + '\n';

  // The second harness fails its first ask, so no conversation is ever created
  // on it. The ask after that must carry the full instructions: a turn count
  // inherited from the first harness would send a bare correction into a
  // conversation this runtime has never seen, and the operator would be told
  // only that no proposal came back.
  const asks = [];
  let failNext = false;
  await page.route('**/api/v1/agents/*/tasks', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const agent = decodeURIComponent(route.request().url().split('/agents/')[1].split('/')[0]);
    asks.push({ agent, instructed: /agent-dock-mcp-proposal/.test(body.prompt ?? '') });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the harness fell over' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: proposal('ok-' + asks.length) });
  });

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.locator('#workshop').waitFor({ state: 'visible' });

  const first = app.agents['claude-code'].id;
  const second = app.agents['codex-cli'].id;

  await page.selectOption('#workshop-agent', first);
  await page.fill('#workshop-objective', 'a connector on the first harness');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value?.startsWith('ok-'));

  failNext = true;
  await page.selectOption('#workshop-agent', second);
  await page.fill('#workshop-objective', 'now try the second harness');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelector('#workshop-status')?.textContent?.includes('Nothing was filled in'));

  await page.fill('#workshop-objective', 'no, the other endpoint');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelectorAll('#workshop-log p').length >= 5);

  assert.deepEqual(asks.map((ask) => ask.agent), [first, second, second]);
  assert.deepEqual(
    asks.map((ask) => ask.instructed),
    [true, true, true],
    'an ask after switching harness was sent as a bare correction'
  );
});

test('an advisory line is not painted as a failure, and a real failure is', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // A harness probing an endpoint reports a 401 as an error and then carries on
  // to succeed. Painting that red made a working run look broken.
  await page.route('**/api/v1/agents/*/tasks', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: [
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'noisy' }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'error', taskId: 'noisy', data: { source: 'provider', message: 'probe returned 401 Unauthorized' } }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'message.completed', taskId: 'noisy', data: { role: 'assistant', text: '<agent-dock-mcp-proposal>{"name":"noisy-but-fine","transport":"http","url":"https://noisy.example.test/mcp","headers":{"X-Api-Key":"sk-should-be-stripped"},"timeoutMs":30000}</agent-dock-mcp-proposal>' } }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'noisy', data: { status: 'succeeded' } })
    ].join('\n') + '\n'
  }));

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.locator('#workshop').waitFor({ state: 'visible' });
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'a connector whose probe returns 401');
  await page.click('#run-workshop');

  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'noisy-but-fine');

  const classes = await page.locator('#workshop-log p').evaluateAll((nodes) => nodes.map((node) => node.className));
  // The probe error and the stripped-header warning are advisory; the run worked.
  assert.ok(classes.some((cls) => cls.includes('warn')), 'an advisory line was not marked as advisory');
  assert.ok(!classes.some((cls) => cls.includes('failed')), 'a successful run painted a line as a failure');
});

test('a placeholder in an argument asks what fills it, and can use a container secret', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'local-with-token');
  await page.selectOption('#mcp-transport', 'stdio');
  await page.fill('#mcp-command', 'node');
  await page.fill('#mcp-args', '/opt/mcp/server.mjs\n--token\n${ACCESS_TOKEN}');

  // An argument is the case that used to be a dead end: the interface had to
  // explain that a variable there could never be filled. Now it is just asked.
  const row = page.locator('.placeholder-row').first();
  await row.waitFor();
  assert.match(await row.textContent(), /ACCESS_TOKEN/);
  assert.match(await row.textContent(), /used in the arguments/);

  await row.locator('select').selectOption('__new');
  await row.locator('input').fill('COMPANY_API_TOKEN');
  assert.match(await row.textContent(), /MCP_SECRET_COMPANY_API_TOKEN/);
  assert.match(await row.textContent(), /control plane never sees it/i);

  await page.click('#mcp-form button[type="submit"]');
  const listed = page.locator('#registry-list .mcp-row', { hasText: 'local-with-token' });
  await listed.waitFor();
  assert.match(await listed.textContent(), /ACCESS_TOKEN ← MCP_SECRET_COMPANY_API_TOKEN/);

  // A second connector offers that name rather than asking for it again.
  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#mcp-transport', 'stdio');
  await page.fill('#mcp-args', '/opt/other.mjs\n--token\n${OTHER}');
  const second = page.locator('.placeholder-row').first();
  await second.waitFor();
  const options = await second.locator('option').allTextContents();
  assert.ok(
    options.some((text) => text.includes('COMPANY_API_TOKEN')),
    `a name already in use was not offered: ${options.join(', ')}`
  );
});

test('a proposal carrying a placeholder asks the operator what fills it', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // A harness now says "a secret goes here" by writing a placeholder, and says
  // nothing about what fills it — that choice is the operator's, so the proposal
  // must arrive unbound rather than pre-answered.
  await page.route('**/api/v1/agents/*/tasks', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: [
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'proposing' }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'message.completed', taskId: 'proposing', data: { role: 'assistant', text: '<agent-dock-mcp-proposal>{"name":"proposed-local","transport":"stdio","command":"node","args":["/opt/mcp/server.mjs","--token","${SERVICE_TOKEN}"],"timeoutMs":30000}</agent-dock-mcp-proposal>' } }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'proposing', data: { status: 'succeeded' } })
    ].join('\n') + '\n'
  }));

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.locator('#workshop').waitFor({ state: 'visible' });
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'a local connector that needs a token');
  await page.click('#run-workshop');

  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'proposed-local');
  // The placeholder reached the arguments verbatim.
  assert.match(await page.inputValue('#mcp-args'), /\$\{SERVICE_TOKEN\}/);

  // And it is being asked about, unbound.
  const row = page.locator('.placeholder-row', { hasText: 'SERVICE_TOKEN' });
  await row.waitFor();
  assert.match(await row.textContent(), /cannot be saved/);
  assert.equal(await row.locator('select').inputValue(), '');

  // The compatibility check is not attempted while a placeholder is unbound. It
  // would fail every time, because the control plane refuses to normalize a
  // definition with nothing bound — and it reported that as though the harness
  // had proposed a bad shape, which a live run actually produced.
  const status = await page.locator('#workshop-status').textContent();
  assert.match(status, /Choose what fills SERVICE_TOKEN/);
  assert.doesNotMatch(status, /rejected the shape/i);
  assert.doesNotMatch(status, /could not be completed/i);
});

test('ordinary environment secret forwarding stays concise and an unusable workshop command is not saved', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.route('**/api/v1/agents/*/tasks', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: [
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.started', taskId: 'docker-proposal' }),
      JSON.stringify({
        apiVersion: 'agent-wrapper/v1',
        type: 'message.completed',
        taskId: 'docker-proposal',
        data: {
          role: 'assistant',
          text: '<agent-dock-mcp-proposal>{"name":"docker-proposal","transport":"stdio","command":"docker","args":["run","--rm","-i","-e","GITHUB_PERSONAL_ACCESS_TOKEN","example.invalid/mcp","stdio"],"cwd":null,"environment":{"GITHUB_PERSONAL_ACCESS_TOKEN":"${GITHUB_PERSONAL_ACCESS_TOKEN}"},"timeoutMs":30000}</agent-dock-mcp-proposal>'
        }
      }),
      JSON.stringify({ apiVersion: 'agent-wrapper/v1', type: 'task.completed', taskId: 'docker-proposal', data: { status: 'succeeded' } })
    ].join('\n') + '\n'
  }));

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#workshop-agent', app.agents['claude-code'].id);
  await page.fill('#workshop-objective', 'the GitHub MCP server in Docker');
  await page.click('#run-workshop');
  await page.waitForFunction(() => document.querySelector('#mcp-name')?.value === 'docker-proposal');

  assert.equal(await page.locator('#mcp-advanced').evaluate((node) => node.open), false);
  const row = page.locator('.placeholder-row', { hasText: 'GITHUB_PERSONAL_ACCESS_TOKEN' });
  await row.waitFor();
  assert.match(await row.textContent(), /passed to the connector as an environment variable/);

  await row.locator('select').selectOption('__new');
  await row.locator('input').fill('GITHUB_PERSONAL_ACCESS_TOKEN');
  await page.click('#mcp-form button[type="submit"]');

  const message = page.locator('#mcp-form-message');
  await message.waitFor({ state: 'visible' });
  assert.match(await message.textContent(), /not allowed/i);
  assert.equal(await page.locator('#registry-list .mcp-row', { hasText: 'docker-proposal' }).count(), 0);
});

test('a key named after the placeholder is preselected', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-credential');

  // A name and a value is all a key needs now.
  await page.click('#new-credential');
  await page.fill('#credential-name', 'MATCHING_TOKEN');
  await page.fill('#credential-value', 'sk-matching-000011112222');
  await page.click('#credential-form button[type="submit"]');
  await page.locator('.credential-row', { hasText: 'MATCHING_TOKEN' }).waitFor();
  // No host list means no restriction, and the row says so rather than showing
  // an empty cell.
  assert.match(await page.locator('.credential-row', { hasText: 'MATCHING_TOKEN' }).textContent(), /any host/);

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-url', 'https://example.test/mcp?key=${MATCHING_TOKEN}');

  // The obvious answer is offered rather than looked up. A prefill, not a
  // decision: the select still shows it and can still be changed.
  const row = page.locator('.placeholder-row', { hasText: 'MATCHING_TOKEN' });
  await row.waitFor();
  assert.match(await row.locator('select').inputValue(), /^credential:/);
  assert.match(await row.textContent(), /Uses the stored key/);
  // And it describes the mechanism rather than implying an enforcement that does
  // not exist: an unrestricted key means nothing checks the destination at all.
  assert.match(await row.textContent(), /names no hosts, so nothing checks where this connector points/);
});

test('a placeholder with no key can create one to complete', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'needs-a-new-key');
  await page.fill('#mcp-url', 'https://example.test/mcp?key=${BRAND_NEW_TOKEN}');
  const row = page.locator('.placeholder-row', { hasText: 'BRAND_NEW_TOKEN' });
  await row.waitFor();

  // Writing the placeholder is enough to bring the key into existence; the value
  // is filled in afterwards, which is the point of letting it exist unfinished.
  await row.locator('select').selectOption('__create');
  await page.waitForFunction(() => {
    const text = document.querySelector('.placeholder-row')?.textContent ?? '';
    return text.includes('has no value yet');
  });
  assert.match(await row.textContent(), /Add its value under Stored keys/);

  const created = page.locator('.credential-row', { hasText: 'BRAND_NEW_TOKEN' });
  await created.waitFor();
  assert.match(await created.textContent(), /needs a value/);

  // The connector can still be saved: the binding is real, the value is simply
  // outstanding, and the apply is what refuses until it is there.
  await page.click('#mcp-form button[type="submit"]');
  await page.locator('#registry-list .mcp-row', { hasText: 'needs-a-new-key' }).waitFor();

  // Completing it is an ordinary edit, and the value is then required.
  await created.locator('.credential-edit').click();
  await page.waitForSelector('#credential-dialog[open]');
  assert.match(await page.locator('#credential-value-hint').textContent(), /no value yet/);
  assert.equal(await page.locator('#credential-value').evaluate((node) => node.required), true);
  await page.fill('#credential-value', 'sk-completed-000011112222');
  await page.click('#credential-form button[type="submit"]');
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.credential-row')].find((node) => node.textContent.includes('BRAND_NEW_TOKEN'));
    return row && !row.textContent.includes('needs a value');
  });
});

test('a local process is not described as limited by a host list', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-credential');

  await page.click('#new-credential');
  await page.fill('#credential-name', 'SCOPED_KEY');
  await page.fill('#credential-hosts', 'only.example.test');
  await page.fill('#credential-value', 'sk-scoped-000011112222');
  await page.click('#credential-form button[type="submit"]');
  await page.locator('.credential-row', { hasText: 'SCOPED_KEY' }).waitFor();

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#mcp-transport', 'stdio');
  await page.fill('#mcp-args', '/opt/mcp/server.mjs\n--token\n${SCOPED_KEY}');

  // A stdio connector has no url, so the host list is never consulted. Saying it
  // is "limited to only.example.test" here would describe a check that does not
  // happen — the value is handed to a local process either way.
  const row = page.locator('.placeholder-row', { hasText: 'SCOPED_KEY' });
  await row.waitFor();
  const text = await row.textContent();
  assert.match(text, /no URL, so its host list is not consulted/);
  assert.doesNotMatch(text, /limited to/i);
  assert.doesNotMatch(text, /only\.example\.test/);
});
