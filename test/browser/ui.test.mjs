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
    async recreate(runtime) {
      if (this.recreateDelay) await this.recreateDelay;
      return {
        containerId: `${runtime.containerId}-new`,
        containerName: runtime.containerName,
        workerUrl: runtime.workerUrl,
        image: this.currentImage,
        imageId: this.currentImage,
        volumes: runtime.volumes,
        state: 'running',
        updatedAt: new Date().toISOString()
      };
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


test('a credential can be added from the UI and its value never comes back', async (t) => {
  const page = await openPage('/credentials');
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelector('#credential-list')?.textContent?.includes('No credentials yet'));

  // The page states what encryption at rest actually protects, rather than
  // letting the phrase imply more than it does.
  const note = await page.locator('#credential-storage-detail').textContent();
  assert.match(note, /Anyone able to read this host can read them/);

  await page.click('#new-credential');
  await page.fill('#credential-name', 'company-docs');
  await page.fill('#credential-header', 'X-Api-Key');
  await page.fill('#credential-hosts', 'mcp.example.com');
  await page.fill('#credential-value', 'sk-browser-secret-9999');
  await page.click('#credential-form button[type="submit"]');

  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 1);
  const row = page.locator('.credential-row').first();
  assert.match(await row.textContent(), /company-docs/);
  assert.match(await row.textContent(), /…9999/);

  // Nothing on the page carries the value, including after a save.
  assert.ok(!(await page.content()).includes('sk-browser-secret-9999'), 'the value reached the page');

  // Reopening for edit offers to replace the value rather than showing it.
  await page.click('.credential-edit');
  assert.equal(await page.inputValue('#credential-value'), '');
  assert.match(await page.locator('#credential-value-hint').textContent(), /leave blank to keep it/);
  assert.equal(await page.inputValue('#credential-hosts'), 'mcp.example.com');
});

test('a connector offers stored credentials instead of asking for a variable name', async (t) => {
  const page = await openPage('/credentials');
  t.after(() => page.close());
  await page.waitForSelector('#new-credential');

  await page.click('#new-credential');
  await page.fill('#credential-name', 'picker-key');
  await page.fill('#credential-header', 'X-Api-Key');
  await page.fill('#credential-hosts', 'mcp.example.com');
  await page.fill('#credential-value', 'sk-picker-000011112222');
  await page.click('#credential-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length >= 1);

  const agentPage = await browser.newPage();
  t.after(() => agentPage.close());
  await agentPage.goto(`${app.url}/agents/${app.agents['claude-code'].id}#tools`);
  await agentPage.waitForSelector('#new-mcp');
  await agentPage.click('#new-mcp');

  // The picker lists the stored credential with the hosts it is limited to, so
  // the operator can see where it would be sent before choosing it.
  await agentPage.waitForFunction(() => [...document.querySelectorAll('#mcp-credential option')].some((o) => o.textContent.includes('picker-key')));
  const option = await agentPage.locator('#mcp-credential option', { hasText: 'picker-key' }).textContent();
  assert.match(option, /X-Api-Key/);
  assert.match(option, /mcp\.example\.com/);

  // Once attached, the row has to say which credential it uses. It read "no
  // credential references" on a connector that plainly had one, which reads as a
  // bug in the thing the operator just configured.
  await agentPage.fill('#mcp-name', 'picker-connector');
  await agentPage.fill('#mcp-url', 'https://mcp.example.com/mcp');
  await agentPage.selectOption('#mcp-credential', { label: option.trim() });
  await agentPage.click('#mcp-form button[type="submit"]');
  await agentPage.waitForFunction(() => document.querySelectorAll('.mcp-row').length >= 1);

  const meta = await agentPage.locator('.mcp-row .mcp-meta').first().textContent();
  assert.match(meta, /picker-key/);
  assert.doesNotMatch(meta, /no credential references/);
  // Still never the value itself.
  assert.doesNotMatch(await agentPage.content(), /sk-picker-000011112222/);
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
  await page.fill('#credential-header', 'X-Api-Key');
  await page.fill('#credential-hosts', 'inuse.example.com');
  await page.fill('#credential-value', 'sk-inuse-000011112222');
  await page.click('#credential-form button[type="submit"]');
  const credentialRow = page.locator('.credential-row', { hasText: 'in-use-key' });
  await credentialRow.waitFor();

  // Attach it to a connector so the deletion has to be refused.
  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'uses-the-key');
  await page.fill('#mcp-url', 'https://inuse.example.com/mcp');
  const option = await page.locator('#mcp-credential option', { hasText: 'in-use-key' }).textContent();
  await page.selectOption('#mcp-credential', { label: option.trim() });
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
  await page.fill('#credential-header', 'X-Api-Key');
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
  assert.equal(await page.inputValue('#mcp-url'), 'https://example.com/mcp');
  assert.match(await page.locator('#workshop-status').textContent(), /review before saving/i);

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

test('a variable in the arguments is named, and says it is not substituted', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#mcp-transport', 'stdio');
  await page.fill('#mcp-args', '/opt/mcp/server.mjs\n--token\n${COMPANY_TOKEN}');

  // Arguments reach the server verbatim; only the environment mapping is
  // resolved. Leaving that implicit is what made the relationship unclear.
  const note = page.locator('#mcp-args-variables');
  await note.waitFor({ state: 'visible' });
  const text = await note.textContent();
  assert.match(text, /COMPANY_TOKEN/);
  assert.match(text, /passed to the server as written/i);

  // And it offers to close the loop, which is the part that was invisible: the
  // argument variable and the mapped environment name are the same idea.
  await note.locator('button', { hasText: 'use COMPANY_TOKEN' }).click();
  assert.equal(await page.inputValue('#mcp-secret-target'), 'COMPANY_TOKEN');
  assert.match(await note.textContent(), /the variable mapped below/i);

  await page.fill('#mcp-args', '/opt/mcp/server.mjs');
  await note.waitFor({ state: 'hidden' });
});

test('a connector secret is chosen from names already in use, or added by name', async (t) => {
  const page = await openPage('/connectors');
  t.after(() => page.close());
  await page.waitForSelector('#new-registry-mcp');

  // Define one connector that references a secret, so there is something to
  // choose the second time rather than a name to remember and retype.
  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.fill('#mcp-name', 'first-stdio');
  await page.selectOption('#mcp-transport', 'stdio');
  await page.fill('#mcp-command', 'node');
  await page.fill('#mcp-args', '/opt/mcp/server.mjs');
  await page.fill('#mcp-secret-target', 'API_TOKEN');
  await page.selectOption('#mcp-secret-source-choice', '__new');
  await page.fill('#mcp-secret-source', 'COMPANY_API_TOKEN');
  await page.click('#mcp-form button[type="submit"]');
  await page.locator('#registry-list .mcp-row', { hasText: 'first-stdio' }).waitFor();

  await page.click('#new-registry-mcp');
  await page.waitForSelector('#mcp-dialog[open]');
  await page.selectOption('#mcp-transport', 'stdio');
  const options = await page.locator('#mcp-secret-source-choice option').allTextContents();
  assert.ok(options.includes('COMPANY_API_TOKEN'), `the known secret was not offered: ${options.join(', ')}`);
  assert.ok(options.includes('Add a new name…'));

  // The free-text field only appears when adding a name.
  assert.equal(await page.locator('#mcp-secret-source').isVisible(), false);
  await page.selectOption('#mcp-secret-source-choice', '__new');
  await page.locator('#mcp-secret-source').waitFor({ state: 'visible' });
});
