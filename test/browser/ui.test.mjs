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
    }
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
  await page.route(`**/api/v1/agents/${agent.id}/tasks`, async (route) => {
    requestHeaders = route.request().headers();
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: '{"type":"task.completed","taskId":"browser-csrf-test","data":{"status":"completed"}}\n'
    });
  });
  await page.waitForFunction(() => document.querySelector('#run-button')?.disabled === false);
  await page.fill('#prompt', 'Verify the authenticated streaming request.');
  await page.click('#run-button');
  await page.waitForFunction(() => document.querySelector('#run-message')?.textContent === 'Run complete');
  assert.equal(requestHeaders?.['x-agent-dock-csrf'], '1');
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

  // Healthy: the harness holds a login and there is nothing to act on.
  await page.waitForFunction(() => document.querySelector('#auth-button')?.textContent === 'Connected');
  assert.equal(await page.locator('#auth-button').isDisabled(), true);

  // The provider rejects the token while the harness still reports a login.
  // Telling someone to sign in again with every control disabled is a dead end.
  isolated.claude.healthy = false;
  await page.waitForFunction(
    () => document.querySelector('#auth-button')?.textContent === 'Sign in again',
    null,
    { timeout: 15_000 }
  );
  assert.equal(await page.locator('#auth-button').isDisabled(), false, 'the only offered remedy was not clickable');
  assert.match(await page.locator('#auth-copy').textContent(), /rejected it/);
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
