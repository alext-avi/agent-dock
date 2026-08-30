const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const API_ROOT = '/api/v1';
const VALID_TABS = new Set(['instructions', 'tools', 'data', 'test']);
let currentUsageCapability = { quotaWindows: false, accountActivity: false, source: null };

const ui = {
  dashboardView: $('#dashboard-view'),
  agentView: $('#agent-view'),
  connectionDot: $('#connection-dot'),
  connectionLabel: $('#connection-label'),
  agentGrid: $('#agent-grid'),
  emptyFleet: $('#empty-fleet'),
  agentCount: $('#agent-count'),
  createDialog: $('#create-agent-dialog'),
  createForm: $('#create-agent-form'),
  createMessage: $('#create-message'),
  createAdapter: $('#create-adapter'),
  createAdapterRadios: $$('#create-adapter input[name="adapter"]'),
  attachRuntimeOption: $('#attach-runtime-option'),
  attachRuntimeRadio: $('#attach-runtime-radio'),
  attachRuntimeField: $('#attach-runtime-field'),
  attachRuntimeSelect: $('#attach-runtime-select'),
  configForm: $('#agent-config-form'),
  configName: $('#config-name'),
  configDescription: $('#config-description'),
  durablePrompt: $('#durable-prompt'),
  modelPolicySection: $('#model-policy-section'),
  modelSelect: $('#model-select'),
  modelPolicyCopy: $('#model-policy-copy'),
  providerStatus: $('#provider-status'),
  providerModels: $('#provider-models'),
  saveAgent: $('#save-agent'),
  saveMessage: $('#save-message'),
  pageAgentName: $('#page-agent-name'),
  pageAgentDescription: $('#page-agent-description'),
  agentIdLabel: $('#agent-id-label'),
  workerState: $('#worker-state'),
  agentName: $('#agent-name'),
  runtimeIcon: $('#runtime-icon'),
  runtimeLocation: $('#runtime-location'),
  cliVersion: $('#cli-version'),
  runtimeModel: $('#runtime-model'),
  authState: $('#auth-state'),
  jobState: $('#job-state'),
  primaryQuotaSummary: $('#primary-quota-summary'),
  secondaryQuotaSummary: $('#secondary-quota-summary'),
  primaryQuotaLabel: $('#primary-quota-label'),
  secondaryQuotaLabel: $('#secondary-quota-label'),
  primaryQuotaBar: $('#primary-quota-bar'),
  secondaryQuotaBar: $('#secondary-quota-bar'),
  primaryQuotaReset: $('#primary-quota-reset'),
  secondaryQuotaReset: $('#secondary-quota-reset'),
  agentTotalSummary: $('#agent-total-summary'),
  runtimeDetails: $('#runtime-details'),
  runtimeDetailsHint: $('#runtime-details-hint'),
  authBox: $('#auth-box'),
  authButton: $('#auth-button'),
  deviceFlow: $('#device-flow'),
  authLink: $('#auth-link'),
  authCode: $('#auth-code'),
  authCompleteForm: $('#auth-complete-form'),
  authCompletionCode: $('#auth-completion-code'),
  authCompleteButton: $('#auth-complete-button'),
  authCompleteMessage: $('#auth-complete-message'),
  authTranscript: $('#auth-transcript'),
  authTitle: $('#auth-title'),
  authCopy: $('#auth-copy'),
  authSession: $('#auth-session'),
  authExpiry: $('#auth-expiry'),
  authExpiryDetail: $('#auth-expiry-detail'),
  authLastRefresh: $('#auth-last-refresh'),
  authLastRefreshDetail: $('#auth-last-refresh-detail'),
  refreshAuth: $('#refresh-auth'),
  authRefreshMessage: $('#auth-refresh-message'),
  quotaWindows: $('#quota-windows'),
  lastRequestTokens: $('#last-request-tokens'),
  lastRequestTime: $('#last-request-time'),
  agentTotalTokens: $('#agent-total-tokens'),
  agentRequestCount: $('#agent-request-count'),
  lifetimeTokens: $('#lifetime-tokens'),
  usagePolledAt: $('#usage-polled-at'),
  usageError: $('#usage-error'),
  refreshUsage: $('#refresh-usage'),
  prompt: $('#prompt'),
  runButton: $('#run-button'),
  cancelButton: $('#cancel-button'),
  runMessage: $('#run-message'),
  conversation: $('#conversation'),
  rawOutput: $('#raw-output'),
  fileList: $('#file-list'),
  testAgentButton: $('#test-agent-button'),
  agentMenu: $('.agent-menu'),
  tabList: $('.tab-list'),
  tabButtons: $$('.tab-button'),
  tabPanels: $$('.tab-panel')
};

let running = false;
let authPolling = null;
let refreshingAuth = false;
let currentAgent = null;
let currentHarnessName = 'Agent';
let dashboardAgents = [];
let dashboardFingerprint = '';
let dashboardRefreshInFlight = false;
let statusRefreshInFlight = false;
let liveUpdateTimer = null;
let retainedRuntimes = [];

function setConnection(state, label) {
  ui.connectionDot.className = `dot ${state}`;
  ui.connectionLabel.textContent = label;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function agentApi(operation = '') {
  return `${API_ROOT}/agents/${encodeURIComponent(currentAgent.id)}${operation ? `/${operation}` : ''}`;
}

function adapterLabel(adapter) {
  if (adapter === 'codex-cli') return 'Codex CLI';
  if (adapter === 'claude-code') return 'Claude Code';
  if (adapter === 'opencode') return 'OpenCode';
  return adapter || 'Agent runtime';
}

function runtimeLabel(runtime = {}) {
  if (runtime.binding === 'dedicated') return 'isolated runtime';
  if (runtime.binding === 'attached') return 'reattached isolated runtime';
  if (runtime.binding === 'shared-legacy') return 'legacy shared runtime';
  if (runtime.binding === 'retained') return 'retained runtime';
  return 'unprovisioned';
}

function formatTokens(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { notation: Number(value) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value));
}

function relativeTime(iso) {
  if (!iso) return 'Not polled';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function timeUntil(iso) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 'Expiry unavailable';
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'Expired; refresh required';
  const hours = Math.floor(delta / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h`;
  return `in ${Math.max(1, Math.floor(delta / 60_000))}m`;
}

function formatQuotaDuration(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 6.5 * 24 * 60) return `${Math.max(1, Math.round(value / (7 * 24 * 60)))}w`;
  if (value >= 24 * 60) return `${Math.max(1, Math.round(value / (24 * 60)))}d`;
  if (value >= 60) {
    const hours = value / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, '')}h`;
  }
  return `${Math.round(value)}m`;
}

function quotaWindowLabel(window, fallback = 'Quota window') {
  const duration = formatQuotaDuration(window?.windowDurationMinutes);
  return duration ? `${duration} limit` : fallback;
}

function quotaRefreshLabel(epochSeconds) {
  const timestamp = Number(epochSeconds) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'refreshing now';
  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  if (minutes < 60) return `refreshes in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `refreshes in ${hours} hr`;
  const days = Math.ceil(hours / 24);
  if (days < 7) return `refreshes in ${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.ceil(days / 7);
  return `refreshes in ${weeks} week${weeks === 1 ? '' : 's'}`;
}

function startLiveUpdates(callback, intervalMs = 3000) {
  if (liveUpdateTimer) clearInterval(liveUpdateTimer);
  liveUpdateTimer = setInterval(() => {
    if (document.visibilityState === 'visible') callback();
  }, intervalMs);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return '—';
  const seconds = Number(milliseconds) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatBytes(value) {
  if (value === null || value === undefined) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function selectTab(name, { updateHash = true, focus = false } = {}) {
  const selected = VALID_TABS.has(name) ? name : 'instructions';
  for (const button of ui.tabButtons) {
    const active = button.dataset.tab === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of ui.tabPanels) panel.classList.toggle('hidden', panel.dataset.panel !== selected);
  if (updateHash) history.replaceState(null, '', `#${selected}`);
  if (focus && selected === 'test') setTimeout(() => ui.prompt.focus(), 100);
}

function createAgentCard(agent) {
  // The whole card is the link into the agent. Keep it free of nested
  // interactive controls so it stays one predictable target.
  const card = document.createElement('a');
  card.className = 'agent-card';
  card.dataset.agentId = agent.id;
  card.href = `/agents/${encodeURIComponent(agent.id)}`;
  card.innerHTML = `
    <div class="agent-card-heading">
      <div><p class="kicker"></p><h2></h2></div>
      <div class="agent-card-state">
        <span class="pill neutral status-pill">checking</span>
        <span class="card-update"></span>
      </div>
    </div>
    <p class="agent-card-description"></p>
    <div class="card-quota-windows" aria-label="Subscription quota windows">
      <div class="card-quota-row card-quota-primary"><div><span class="card-quota-label">Quota window</span><strong class="card-quota-value">—</strong></div><span class="quota-bar"><span></span></span></div>
      <div class="card-quota-row card-quota-secondary"><div><span class="card-quota-label">Additional window</span><strong class="card-quota-value">—</strong></div><span class="quota-bar"><span></span></span></div>
    </div>
    <dl class="card-metrics">
      <div><dt>AUTH</dt><dd class="card-auth">—</dd></div>
      <div><dt>USAGE</dt><dd class="card-usage">—</dd></div>
      <div><dt>REQUESTS</dt><dd class="card-requests">—</dd></div>
    </dl>`;
  card.querySelector('.kicker').textContent = `${adapterLabel(agent.adapter)} · ${runtimeLabel(agent.runtime)} · ${agent.id}`;
  card.querySelector('h2').textContent = agent.name;
  card.querySelector('.agent-card-description').textContent = agent.description || 'No purpose defined yet.';
  card.querySelector('.card-update').textContent = `updated ${relativeTime(agent.updatedAt)}`;
  return card;
}

function renderAgentGrid(agents) {
  dashboardAgents = agents;
  dashboardFingerprint = JSON.stringify(agents.map((agent) => [agent.id, agent.updatedAt]));
  ui.agentGrid.replaceChildren();
  ui.agentCount.textContent = String(agents.length).padStart(2, '0');
  ui.emptyFleet.classList.toggle('hidden', agents.length !== 0);
  for (const agent of agents) ui.agentGrid.append(createAgentCard(agent));
}

function updateAgentCard(card, status) {
  const authenticated = Boolean(status.authentication?.authenticated);
  const active = Boolean(status.task?.active);
  const pill = card.querySelector('.status-pill');
  pill.textContent = active ? 'busy' : authenticated ? 'ready' : 'needs auth';
  pill.className = `pill status-pill ${active ? 'busy' : authenticated ? 'ready' : 'neutral'}`;
  card.querySelector('.card-auth').textContent = authenticated ? 'connected' : 'required';
  const windows = status.usage?.quotaWindows ?? [];
  const highest = windows.length ? Math.max(...windows.map((window) => Number(window.usedPercent) || 0)) : null;
  card.querySelector('.card-usage').textContent = highest === null ? '—' : `${highest.toFixed(0)}% used`;
  card.querySelector('.card-requests').textContent = formatTokens(status.usage?.totals?.requests ?? 0);
  const primary = windows.find((window) => window.scope === 'primary') ?? windows[0];
  const secondary = windows.find((window) => window.scope === 'secondary') ?? windows[1];
  renderCardQuota(card.querySelector('.card-quota-primary'), primary, 'Quota window');
  renderCardQuota(card.querySelector('.card-quota-secondary'), secondary, 'Additional window');
  card.querySelector('.card-update').textContent = `live · ${relativeTime(new Date().toISOString())}`;
}

function quotaFillClass(used) {
  if (used >= 90) return 'danger';
  if (used >= 70) return 'warning';
  return '';
}

function renderCardQuota(row, window, fallbackLabel) {
  const used = window ? Math.max(0, Math.min(100, Number(window.usedPercent ?? 0))) : 0;
  const refresh = quotaRefreshLabel(window?.resetsAt);
  row.querySelector('.card-quota-label').textContent = window
    ? `${quotaWindowLabel(window, fallbackLabel)}${refresh ? ` · ${refresh}` : ''}`
    : fallbackLabel;
  row.querySelector('.card-quota-value').textContent = window ? `${used.toFixed(0)}%` : 'Unavailable';
  const fill = row.querySelector('.quota-bar span');
  fill.style.width = window ? `${used}%` : '0%';
  fill.className = quotaFillClass(used);
  row.classList.toggle('unavailable', !window);
}

function markAgentCardOffline(card, message) {
  const pill = card.querySelector('.status-pill');
  pill.textContent = message.includes('not configured') ? 'definition only' : 'offline';
  pill.className = `pill status-pill ${message.includes('not configured') ? 'neutral' : 'error'}`;
  card.querySelector('.card-auth').textContent = '—';
}

async function loadDashboard() {
  ui.dashboardView.classList.remove('hidden');
  ui.agentView.classList.add('hidden');
  document.title = 'Agent Dock — Fleet';
  try {
    const { agents } = await api(`${API_ROOT}/agents`);
    setConnection('online', 'Control plane online');
    renderAgentGrid(agents);
    await refreshDashboardStatuses();
    startLiveUpdates(refreshDashboardStatuses);
  } catch (error) {
    setConnection('offline', error.message);
    ui.agentGrid.innerHTML = '<article class="panel"><p class="usage-error">Could not load the agent registry.</p></article>';
  }
}

async function refreshDashboardStatuses() {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  try {
    const { agents } = await api(`${API_ROOT}/agents`);
    const nextFingerprint = JSON.stringify(agents.map((agent) => [agent.id, agent.updatedAt]));
    if (nextFingerprint !== dashboardFingerprint) renderAgentGrid(agents);
    await Promise.allSettled(dashboardAgents.map(async (agent) => {
      const card = [...ui.agentGrid.children].find((candidate) => candidate.dataset.agentId === agent.id);
      if (!card) return;
      try {
        const status = await api(`${API_ROOT}/agents/${encodeURIComponent(agent.id)}/status`, { signal: AbortSignal.timeout(3500) });
        updateAgentCard(card, status);
      } catch (error) {
        markAgentCardOffline(card, error.message);
      }
    }));
    setConnection('online', 'Live fleet status');
  } catch (error) {
    setConnection('offline', error.message);
  } finally {
    dashboardRefreshInFlight = false;
  }
}

// The harness is chosen with radio cards rather than a select, so read the
// checked one rather than an element value.
function selectedAdapter() {
  return ui.createAdapterRadios.find((radio) => radio.checked)?.value ?? 'codex-cli';
}

function syncCreateRuntimeOptions() {
  const adapter = selectedAdapter();
  const available = retainedRuntimes.filter((runtime) => runtime.managed && runtime.binding === 'retained' && runtime.adapter === adapter && runtime.attachmentCount === 0);
  ui.attachRuntimeSelect.replaceChildren();
  for (const runtime of available) {
    const option = document.createElement('option');
    option.value = runtime.id;
    option.textContent = `${runtime.workerId || runtime.id} · ${runtime.state}`;
    ui.attachRuntimeSelect.append(option);
  }
  const canAttach = available.length > 0;
  ui.attachRuntimeRadio.disabled = !canAttach;
  ui.attachRuntimeOption.classList.toggle('disabled', !canAttach);
  if (!canAttach && ui.attachRuntimeRadio.checked) ui.createForm.querySelector('[name="runtimeMode"][value="provision"]').checked = true;
  const attaching = ui.attachRuntimeRadio.checked && canAttach;
  ui.attachRuntimeField.classList.toggle('hidden', !attaching);
  for (const option of $$('.runtime-option')) option.classList.toggle('selected', option.querySelector('input')?.checked === true);
}

async function openCreateDialog() {
  ui.createForm.reset();
  ui.createMessage.classList.add('hidden');
  ui.createMessage.textContent = '';
  retainedRuntimes = [];
  try {
    retainedRuntimes = (await api(`${API_ROOT}/runtimes`)).runtimes ?? [];
  } catch {}
  syncCreateRuntimeOptions();
  ui.createDialog.showModal();
}

async function createAgent(event) {
  event.preventDefault();
  const submit = ui.createForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(ui.createForm));
    const runtimeMode = body.runtimeMode === 'attach' ? 'attach' : 'provision';
    body.runtime = runtimeMode === 'attach'
      ? { mode: 'attach', id: body.runtimeId }
      : { mode: 'provision' };
    delete body.runtimeMode;
    delete body.runtimeId;
    submit.textContent = runtimeMode === 'attach' ? 'Attaching…' : 'Provisioning…';
    const { agent } = await api(`${API_ROOT}/agents`, { method: 'POST', body: JSON.stringify(body) });
    window.location.assign(`/agents/${encodeURIComponent(agent.id)}#instructions`);
  } catch (error) {
    ui.createMessage.textContent = error.message;
    ui.createMessage.classList.remove('hidden');
    submit.disabled = false;
    submit.textContent = 'Create isolated agent';
  }
}

function populateAgentConfig(agent) {
  ui.pageAgentName.textContent = agent.name;
  ui.pageAgentDescription.textContent = agent.description || 'Configure durable instructions, then send disposable test tasks to the runtime.';
  ui.agentIdLabel.textContent = agent.id.toUpperCase();
  ui.configName.value = agent.name;
  ui.configDescription.value = agent.description;
  ui.durablePrompt.value = agent.durablePrompt;
  const selectedModel = agent.modelPolicy?.mode === 'pinned' ? agent.modelPolicy.primary : '';
  ui.modelSelect.value = selectedModel || '';
  ui.runtimeModel.textContent = selectedModel || 'provider default';
  const plannedHarness = adapterLabel(agent.adapter);
  ui.agentName.textContent = plannedHarness;
  ui.runtimeIcon.textContent = plannedHarness.slice(0, 1).toUpperCase();
  ui.runtimeLocation.textContent = `${runtimeLabel(agent.runtime)} · ${agent.runtime?.workerId || 'no worker identity'}`;
}

function renderProviderConnections(result = {}) {
  const supported = Boolean(result.modelSelection?.supported) && currentAgent.adapter === 'opencode';
  const connections = Array.isArray(result.connections) ? result.connections : [];
  const models = connections.flatMap((connection) => connection.models ?? []);
  const ready = connections.filter((connection) => connection.status === 'ready');
  const pinned = currentAgent.modelPolicy?.mode === 'pinned' ? currentAgent.modelPolicy.primary : '';

  ui.modelSelect.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = result.modelSelection?.defaultLabel || `${adapterLabel(currentAgent.adapter)} provider default`;
  ui.modelSelect.append(defaultOption);
  for (const connection of connections) {
    if (!connection.models?.length) continue;
    const group = document.createElement('optgroup');
    group.label = `${connection.displayName} · ${connection.status}`;
    for (const model of connection.models) {
      const option = document.createElement('option');
      option.value = model.id;
      const context = model.contextLength ? ` · ${formatTokens(model.contextLength)} ctx` : '';
      const tools = model.capabilities?.includes('tools') ? ' · tools' : '';
      option.textContent = `${model.displayName || model.name}${context}${tools}`;
      group.append(option);
    }
    ui.modelSelect.append(group);
  }
  if (pinned && !models.some((model) => model.id === pinned)) {
    const unavailable = document.createElement('option');
    unavailable.value = pinned;
    unavailable.textContent = `${pinned} · currently unavailable`;
    ui.modelSelect.append(unavailable);
  }
  ui.modelSelect.value = pinned || '';
  ui.modelSelect.disabled = !supported;
  ui.providerStatus.textContent = !supported ? 'not available' : ready.length ? 'connected' : 'unavailable';
  ui.providerStatus.className = `pill ${!supported ? 'neutral' : ready.length ? 'ready' : 'error'}`;
  ui.providerModels.textContent = !supported
    ? 'Wrapper-managed model selection is not implemented for this harness yet.'
    : ready.length
      ? `${models.length} local model${models.length === 1 ? '' : 's'} discovered across ${ready.length} connection${ready.length === 1 ? '' : 's'}.`
      : connections[0]?.error || 'No local provider connection is available.';
  ui.modelPolicyCopy.textContent = supported
    ? 'Use OpenCode’s current provider default, or pin one discovered local model.'
    : `${adapterLabel(currentAgent.adapter)} currently uses its provider-managed default.`;
}

async function refreshProviders() {
  try {
    renderProviderConnections(await api(agentApi('providers')));
  } catch (error) {
    renderProviderConnections({
      modelSelection: { supported: currentAgent.adapter === 'opencode' },
      connections: [{ status: 'unavailable', displayName: 'Provider discovery', models: [], error: error.message }]
    });
  }
}

async function saveAgent(event) {
  event.preventDefault();
  ui.saveAgent.disabled = true;
  ui.saveMessage.textContent = 'Saving…';
  const body = {
    name: ui.configName.value,
    description: ui.configDescription.value,
    durablePrompt: ui.durablePrompt.value,
    modelPolicy: ui.modelSelect.value
      ? { mode: 'pinned', primary: ui.modelSelect.value, fallbacks: [], externalFallback: false }
      : { mode: 'provider-default', primary: null, fallbacks: [], externalFallback: false }
  };
  try {
    const result = await api(agentApi(), { method: 'PATCH', body: JSON.stringify(body) });
    currentAgent = result.agent;
    populateAgentConfig(currentAgent);
    ui.saveMessage.textContent = 'Saved';
    document.title = `${currentAgent.name} — Agent Dock`;
  } catch (error) {
    ui.saveMessage.textContent = error.message;
  } finally {
    ui.saveAgent.disabled = false;
  }
}

async function deleteAgentRecord(agent) {
  const runtime = agent.runtime ?? {};
  const hasManagedRuntime = runtime.managed === true;
  const baseMessage = hasManagedRuntime
    ? `Delete ${agent.name}? You will next choose whether to retain or destroy its isolated runtime.`
    : `Delete ${agent.name}? Its ${runtimeLabel(runtime)} will be left intact.`;
  if (!window.confirm(baseMessage)) return false;
  let runtimeAction = 'retain';
  let confirmation;
  if (hasManagedRuntime && window.confirm('Permanently destroy this agent’s container, CLI installation, credentials, telemetry, and workspace? Select Cancel to retain the stopped runtime for later reattachment.')) {
    confirmation = window.prompt(`This cannot be undone. Type ${agent.id} to destroy all isolated runtime volumes.`) ?? '';
    if (confirmation !== agent.id) {
      window.alert('Runtime destruction cancelled because the confirmation did not match. The agent was not deleted.');
      return false;
    }
    runtimeAction = 'destroy';
  }
  await api(`${API_ROOT}/agents/${encodeURIComponent(agent.id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ runtimeAction, confirmation })
  });
  return true;
}

async function deleteCurrentAgent() {
  try {
    if (!await deleteAgentRecord(currentAgent)) return;
    window.location.assign('/');
  } catch (error) {
    ui.agentMenu.open = false;
    setConnection('offline', error.message);
  }
}

function renderAuth(auth = {}) {
  const visible = auth.phase === 'waiting_for_user' || auth.phase === 'failed';
  ui.deviceFlow.classList.toggle('hidden', !visible);
  if (auth.challenge?.verificationUri) {
    ui.authLink.href = auth.challenge.verificationUri;
    ui.authLink.classList.remove('hidden');
  } else {
    ui.authLink.classList.add('hidden');
  }
  ui.authCode.textContent = auth.challenge?.userCode || '';
  ui.authCode.classList.toggle('hidden', !auth.challenge?.userCode);
  ui.authCompleteForm.classList.toggle('hidden', !auth.challenge?.requiresInput);
  ui.authTranscript.textContent = auth.challenge?.instructions || 'Waiting for the device login instructions…';
}

function renderAuthSession(session = {}, { authenticated = false, active = false, workerRefreshing = false } = {}) {
  ui.authSession.classList.toggle('hidden', !authenticated);
  if (!authenticated) {
    ui.authRefreshMessage.textContent = '';
    return;
  }
  const expiry = session.accessTokenExpiresAt ? new Date(session.accessTokenExpiresAt) : null;
  const lastRefresh = session.lastRefreshAt ? new Date(session.lastRefreshAt) : null;
  ui.authExpiry.textContent = expiry && !Number.isNaN(expiry.valueOf()) ? expiry.toLocaleString() : 'Unavailable';
  ui.authExpiryDetail.textContent = expiry && !Number.isNaN(expiry.valueOf())
    ? `${timeUntil(session.accessTokenExpiresAt)} · automatically renewable`
    : 'Managed by the CLI; expiry metadata unavailable.';
  ui.authLastRefresh.textContent = lastRefresh && !Number.isNaN(lastRefresh.valueOf()) ? relativeTime(session.lastRefreshAt) : 'Unavailable';
  ui.authLastRefreshDetail.textContent = lastRefresh && !Number.isNaN(lastRefresh.valueOf()) ? lastRefresh.toLocaleString() : 'No refresh metadata available.';
  ui.runtimeDetailsHint.textContent = expiry && !Number.isNaN(expiry.valueOf())
    ? `Session expires ${timeUntil(session.accessTokenExpiresAt)}`
    : 'Session connected · expand for controls';
  const refreshing = refreshingAuth || workerRefreshing;
  ui.refreshAuth.textContent = refreshing ? 'Refreshing session…' : 'Force session refresh';
  ui.refreshAuth.disabled = refreshing || active || !session.canForceRefresh;
  if (workerRefreshing) {
    ui.authRefreshMessage.textContent = `${currentHarnessName} is renewing the managed session…`;
    ui.authRefreshMessage.classList.remove('error');
  } else if (session.error && !refreshingAuth) {
    ui.authRefreshMessage.textContent = session.error;
    ui.authRefreshMessage.classList.add('error');
  }
}

function renderQuotaRow(label, window) {
  const used = Math.max(0, Math.min(100, Number(window?.usedPercent ?? 0)));
  const row = document.createElement('div');
  row.className = 'quota-row';
  const name = document.createElement('span');
  name.className = 'quota-label';
  name.textContent = label;
  const bar = document.createElement('span');
  bar.className = 'quota-bar';
  const fill = document.createElement('span');
  fill.style.width = `${used}%`;
  fill.className = quotaFillClass(used);
  bar.append(fill);
  const value = document.createElement('span');
  value.className = 'quota-value';
  value.textContent = `${used.toFixed(0)}%`;
  const reset = document.createElement('small');
  reset.className = 'quota-reset';
  const resetDate = window?.resetsAt ? new Date(Number(window.resetsAt) * 1000) : null;
  const formattedDuration = formatQuotaDuration(window?.windowDurationMinutes);
  const duration = formattedDuration ? `${formattedDuration} window` : 'quota window';
  reset.textContent = resetDate ? quotaRefreshLabel(window.resetsAt) : duration;
  row.append(name, bar, value, reset);
  return row;
}

// Why a window is missing, worst case first. An adapter that does not expose
// quota windows is a different situation from a source that failed, and both are
// different from 0% used — the UI must never let them look alike.
const POLL_ERROR_COPY = {
  unauthenticated: 'Sign in again — the provider rejected the worker credential.',
  throttled: 'The provider is rate limiting usage polling. Retrying shortly.',
  network: 'The usage source is unreachable.',
  http: 'The usage source returned an error.',
  malformed: 'The usage source returned an unrecognized response.'
};

function quotaUnavailableReason(usage = {}) {
  const kind = usage.pollErrorKind;
  if (kind && POLL_ERROR_COPY[kind]) return POLL_ERROR_COPY[kind];
  if (kind) return 'The usage source is unavailable.';
  if (!currentUsageCapability.quotaWindows) return `${currentHarnessName} does not expose subscription quota windows.`;
  if (!usage.lastPollAt) return 'Quota windows have not been polled yet.';
  return 'No quota window reported.';
}

function renderRuntimeQuota(scope, window, fallbackLabel, unavailableReason = '') {
  const used = window ? Math.max(0, Math.min(100, Number(window.usedPercent ?? 0))) : 0;
  const label = ui[`${scope}QuotaLabel`];
  const summary = ui[`${scope}QuotaSummary`];
  const bar = ui[`${scope}QuotaBar`];
  const reset = ui[`${scope}QuotaReset`];
  label.textContent = quotaWindowLabel(window, fallbackLabel);
  summary.textContent = window ? `${used.toFixed(0)}% used` : 'Unavailable';
  bar.style.width = window ? `${used}%` : '0%';
  bar.className = quotaFillClass(used);
  // An empty bar reads as "0% used". Mark the track so unavailable looks unavailable.
  bar.parentElement?.classList.toggle('unavailable', !window);
  reset.textContent = window
    ? (quotaRefreshLabel(window.resetsAt) || 'Refresh time unavailable')
    : unavailableReason;
}

function renderUsage(usage = {}) {
  const last = usage.lastRequest;
  const totals = usage.totals ?? {};
  ui.lastRequestTokens.textContent = last ? formatTokens(last.totalTokens) : '—';
  ui.lastRequestTime.textContent = last ? `${formatTokens(last.inputTokens)} in · ${formatTokens(last.outputTokens)} out · ${formatDuration(last.durationMs)}` : 'No requests yet';
  ui.agentTotalTokens.textContent = formatTokens(totals.totalTokens ?? 0);
  ui.agentTotalSummary.textContent = formatTokens(totals.totalTokens ?? 0);
  ui.agentRequestCount.textContent = `${totals.requests ?? 0} request${totals.requests === 1 ? '' : 's'}`;
  ui.lifetimeTokens.textContent = formatTokens(usage.account?.lifetimeTokens);
  ui.usagePolledAt.textContent = usage.lastPollAt ? `polled ${relativeTime(usage.lastPollAt)}` : 'Not polled';
  ui.usageError.textContent = usage.pollError || '';
  ui.usageError.classList.toggle('hidden', !usage.pollError);
  const windows = Array.isArray(usage.quotaWindows) ? usage.quotaWindows : [];
  const reason = quotaUnavailableReason(usage);
  const primary = windows.find((window) => window.scope === 'primary') ?? windows[0];
  const secondary = windows.find((window) => window.scope === 'secondary') ?? windows[1];
  renderRuntimeQuota('primary', primary, 'Quota window', reason);
  renderRuntimeQuota('secondary', secondary, 'Additional window', reason);
  ui.quotaWindows.replaceChildren();
  if (!windows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = reason;
    ui.quotaWindows.append(empty);
    return;
  }
  if (currentUsageCapability.source === 'experimental-oauth') {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = 'Experimental source: this provider publishes no supported usage API, so these windows may stop working without notice.';
    ui.quotaWindows.append(note);
  }
  for (const window of windows) ui.quotaWindows.append(renderQuotaRow(quotaWindowLabel(window), window));
}

function renderStatus(status) {
  const authenticated = status.authentication?.authenticated;
  const localCredentiallessModel = currentAgent.modelPolicy?.mode === 'pinned' && currentAgent.modelPolicy.primary?.startsWith('ollama/');
  const readyToRun = authenticated || localCredentiallessModel;
  const active = Boolean(status.task?.active) || running;
  currentHarnessName = status.agent?.adapter?.displayName || adapterLabel(currentAgent.adapter);
  setConnection('online', 'Control plane + worker online');
  ui.workerState.textContent = active ? 'busy' : readyToRun ? 'ready' : 'needs auth';
  ui.workerState.className = `pill ${active ? 'busy' : readyToRun ? 'ready' : 'neutral'}`;
  ui.agentName.textContent = currentHarnessName;
  ui.runtimeIcon.textContent = currentHarnessName.slice(0, 1).toUpperCase();
  ui.cliVersion.textContent = status.agent?.version || '—';
  ui.runtimeModel.textContent = status.task?.active?.model || (currentAgent.modelPolicy?.mode === 'pinned' ? currentAgent.modelPolicy.primary : 'provider default');
  ui.authState.textContent = authenticated ? 'connected' : localCredentiallessModel ? 'not required' : status.authentication?.phase?.replaceAll('_', ' ') || 'required';
  ui.jobState.textContent = active ? 'running' : 'idle';
  const inContainer = status.execution?.boundary === 'container';
  ui.runtimeLocation.textContent = inContainer
    ? `${runtimeLabel(currentAgent.runtime)} · ${currentAgent.runtime?.workerId || 'worker identity unavailable'}`
    : 'Worker-managed provider sandbox';
  ui.runButton.disabled = !readyToRun || active;
  currentUsageCapability = {
    quotaWindows: Boolean(status.capabilities?.usage?.quotaWindows),
    accountActivity: Boolean(status.capabilities?.usage?.accountActivity),
    source: status.capabilities?.usage?.quotaWindowSource ?? null
  };
  const canRefreshAccountUsage = Boolean(status.capabilities?.usage?.quotaWindows || status.capabilities?.usage?.accountActivity);
  ui.refreshUsage.disabled = !authenticated || !canRefreshAccountUsage;
  ui.refreshUsage.textContent = canRefreshAccountUsage ? 'Refresh' : 'Not available';
  ui.authBox.classList.toggle('authenticated', authenticated);
  ui.authTitle.textContent = authenticated ? `${currentHarnessName} session` : `Connect ${currentHarnessName}`;
  const browserOAuth = status.authentication?.method === 'browser_oauth';
  ui.authCopy.textContent = authenticated
    ? `The worker holds a CLI-managed ${currentHarnessName} login. Safe session metadata is surfaced; credentials never leave the worker.`
    : browserOAuth
      ? `The worker starts ${currentHarnessName}'s browser OAuth flow. Agent Dock forwards only the provider's one-time completion code and never stores it.`
      : `The worker starts ${currentHarnessName}'s device flow. This UI displays only the sign-in URL and one-time code.`;
  ui.authButton.textContent = authenticated ? 'Connected' : status.authentication?.method === 'browser_oauth' ? 'Start browser login' : 'Start device login';
  ui.authButton.disabled = authenticated || status.authentication?.phase === 'waiting_for_user';
  if (!authenticated) {
    ui.runtimeDetailsHint.textContent = status.authentication?.phase === 'waiting_for_user'
      ? (browserOAuth ? 'Waiting for browser authentication' : 'Waiting for device authentication')
      : 'Authentication required';
    if (ui.runtimeDetails.dataset.autoOpened !== 'true') {
      ui.runtimeDetails.open = true;
      ui.runtimeDetails.dataset.autoOpened = 'true';
    }
  }
  renderAuth(status.authentication);
  renderAuthSession(status.authentication?.session, { authenticated, active, workerRefreshing: status.authentication?.refreshing });
  renderUsage(status.usage);
}

function renderRuntimeUnavailable(message) {
  const definitionOnly = message.includes('not configured');
  const harness = adapterLabel(currentAgent.adapter);
  setConnection(definitionOnly ? 'online' : 'offline', definitionOnly ? 'Control plane online · runtime not provisioned' : message);
  ui.workerState.textContent = definitionOnly ? 'definition only' : 'offline';
  ui.workerState.className = `pill ${definitionOnly ? 'neutral' : 'error'}`;
  ui.agentName.textContent = harness;
  ui.runtimeIcon.textContent = harness.slice(0, 1).toUpperCase();
  ui.runtimeLocation.textContent = definitionOnly ? 'Runtime not yet provisioned' : 'Worker unreachable';
  ui.cliVersion.textContent = definitionOnly ? 'not provisioned' : 'unavailable';
  ui.runtimeModel.textContent = currentAgent.modelPolicy?.mode === 'pinned' ? currentAgent.modelPolicy.primary : 'provider default';
  ui.authState.textContent = '—';
  ui.jobState.textContent = 'idle';
  ui.primaryQuotaSummary.textContent = '—';
  ui.secondaryQuotaSummary.textContent = '—';
  ui.primaryQuotaLabel.textContent = 'Quota window';
  ui.secondaryQuotaLabel.textContent = 'Additional window';
  ui.primaryQuotaBar.style.width = '0%';
  ui.secondaryQuotaBar.style.width = '0%';
  ui.primaryQuotaReset.textContent = definitionOnly ? 'Runtime provisioning required' : 'Worker unavailable';
  ui.secondaryQuotaReset.textContent = definitionOnly ? 'Runtime provisioning required' : 'Worker unavailable';
  ui.agentTotalSummary.textContent = '0';
  ui.runtimeDetailsHint.textContent = definitionOnly ? 'Runtime provisioning required' : 'Worker unavailable';
  ui.runButton.disabled = true;
  ui.refreshUsage.disabled = true;
  ui.authButton.disabled = true;
  ui.authTitle.textContent = definitionOnly ? 'Runtime provisioning required' : 'Worker unavailable';
  ui.authCopy.textContent = definitionOnly
    ? 'This agent definition is ready. A dedicated worker will be attached by the future provisioning flow.'
    : 'The control plane cannot currently reach this agent worker.';
  ui.authSession.classList.add('hidden');
  ui.deviceFlow.classList.add('hidden');
}

async function refreshStatus() {
  if (!currentAgent || statusRefreshInFlight) return;
  statusRefreshInFlight = true;
  try {
    const status = await api(agentApi('status'));
    renderStatus(status);
    if (status.authentication?.authenticated && authPolling) {
      clearInterval(authPolling);
      authPolling = null;
    }
  } catch (error) {
    renderRuntimeUnavailable(error.message);
  } finally {
    statusRefreshInFlight = false;
  }
}

async function startAuth() {
  ui.authButton.disabled = true;
  ui.runtimeDetails.open = true;
  try {
    const result = await api(agentApi('auth/login'), { method: 'POST', body: '{}' });
    renderAuth(result.authentication);
    if (!authPolling) authPolling = setInterval(refreshStatus, 1800);
  } catch (error) {
    ui.authRefreshMessage.textContent = error.message;
    ui.authRefreshMessage.classList.add('error');
    ui.authButton.disabled = false;
  }
}

async function completeAuthentication(event) {
  event.preventDefault();
  const code = ui.authCompletionCode.value.trim();
  if (!code) return;
  ui.authCompleteButton.disabled = true;
  ui.authCompleteMessage.textContent = 'Sending the one-time code directly to the CLI…';
  try {
    const result = await api(agentApi('auth/complete'), { method: 'POST', body: JSON.stringify({ code }) });
    ui.authCompletionCode.value = '';
    renderAuth(result.authentication);
    ui.authCompleteMessage.textContent = 'Code accepted; waiting for Claude Code to confirm the session…';
    if (!authPolling) authPolling = setInterval(refreshStatus, 1800);
  } catch (error) {
    ui.authCompleteMessage.textContent = error.message;
  } finally {
    ui.authCompleteButton.disabled = false;
  }
}

async function refreshUsage() {
  ui.refreshUsage.disabled = true;
  try {
    const result = await api(agentApi('usage/refresh'), { method: 'POST', body: '{}' });
    renderUsage(result.usage);
  } catch (error) {
    ui.usageError.textContent = error.message;
    ui.usageError.classList.remove('hidden');
  } finally {
    ui.refreshUsage.disabled = false;
  }
}

async function refreshAuthentication() {
  if (refreshingAuth || running) return;
  refreshingAuth = true;
  ui.refreshAuth.disabled = true;
  ui.refreshAuth.textContent = 'Refreshing session…';
  ui.authRefreshMessage.textContent = `Asking ${currentHarnessName} to rotate the managed token bundle…`;
  ui.authRefreshMessage.classList.remove('error');
  let message = '';
  let failed = false;
  try {
    const result = await api(agentApi('auth/refresh'), { method: 'POST', body: '{}' });
    renderUsage(result.usage);
    message = result.authentication?.refreshed ? 'Session refreshed successfully.' : 'Session validated; token metadata is unchanged.';
  } catch (error) {
    failed = true;
    message = error.message;
  } finally {
    refreshingAuth = false;
    await refreshStatus();
    ui.authRefreshMessage.textContent = message;
    ui.authRefreshMessage.classList.toggle('error', failed);
  }
}

async function refreshWorkspace() {
  if (!currentAgent) return;
  try {
    const { workspace } = await api(agentApi('workspace'));
    const entries = workspace?.entries ?? [];
    ui.fileList.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No artifacts yet.';
      ui.fileList.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'file';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = entry.type === 'directory' ? '▸' : '·';
      const name = document.createElement('span');
      name.textContent = entry.path;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = entry.type === 'file' ? formatBytes(entry.size) : '';
      row.append(kind, name, size);
      ui.fileList.append(row);
    }
  } catch {
    ui.fileList.innerHTML = '<p class="empty">Workspace unavailable until a runtime is attached.</p>';
  }
}

function eventText(event) {
  const data = event.data ?? {};
  if (event.type === 'message.completed') return { kind: 'agent', text: data.text };
  if (event.type === 'activity.started' || event.type === 'activity.completed') {
    const detail = data.command || data.name || data.text || event.type.replace('.', ' ');
    return { kind: 'tool', text: `${data.kind || 'activity'}: ${detail}` };
  }
  if (event.type === 'log') return { kind: data.level === 'error' ? 'error' : 'tool', text: data.message };
  if (event.type === 'error') return { kind: 'error', text: data.message };
  if (event.type === 'task.started') return { kind: 'tool', text: `Task ${event.taskId.slice(0, 8)} started (${data.executionMode}) · ${data.model || 'provider default'}.` };
  if (event.type === 'task.completed') return { kind: data.status === 'succeeded' ? 'tool' : 'error', text: `Task ${data.status} with exit code ${data.exitCode}.` };
  if (event.type === 'usage.observed') {
    const request = data.request;
    const usage = request ? ` · ${request.inputTokens ?? '?'} in / ${request.outputTokens ?? '?'} out` : '';
    return { kind: 'tool', text: `Usage observed${usage}.` };
  }
  if (event.type === 'usage.updated') return { kind: 'tool', text: 'Usage and subscription limits refreshed.' };
  return null;
}

function appendLine(kind, text) {
  const row = document.createElement('div');
  row.className = `event-line ${kind}`;
  const type = document.createElement('span');
  type.className = 'event-type';
  type.textContent = kind;
  row.append(type, document.createTextNode(text));
  ui.conversation.append(row);
  ui.conversation.scrollTop = ui.conversation.scrollHeight;
}

function appendEvent(event) {
  ui.rawOutput.textContent += `${JSON.stringify(event)}\n`;
  ui.rawOutput.scrollTop = ui.rawOutput.scrollHeight;
  if (event.type === 'usage.updated') renderUsage(event.data?.usage);
  const display = eventText(event);
  if (display) appendLine(display.kind, display.text);
}

async function runTask() {
  const prompt = ui.prompt.value.trim();
  if (!prompt || running) return;
  appendLine('user', prompt);
  ui.prompt.value = '';
  running = true;
  ui.runButton.disabled = true;
  ui.cancelButton.classList.remove('hidden');
  ui.jobState.textContent = 'running';
  ui.workerState.textContent = 'busy';
  ui.workerState.className = 'pill busy';
  ui.runMessage.textContent = 'Opening event stream…';
  try {
    const response = await fetch(agentApi('tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(error.error ?? `HTTP ${response.status}`);
    }
    ui.runMessage.textContent = 'Running';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { appendEvent(JSON.parse(line)); }
        catch { appendEvent({ type: 'log', data: { level: 'info', message: line } }); }
      }
      if (done) break;
    }
    ui.runMessage.textContent = 'Run complete';
  } catch (error) {
    appendEvent({ type: 'error', data: { source: 'control-plane', message: error.message } });
    ui.runMessage.textContent = error.message;
  } finally {
    running = false;
    ui.cancelButton.classList.add('hidden');
    await Promise.all([refreshStatus(), refreshWorkspace(), refreshProviders()]);
  }
}

async function cancelRun() {
  ui.cancelButton.disabled = true;
  try {
    await api(agentApi('tasks/cancel'), { method: 'POST', body: '{}' });
    ui.runMessage.textContent = 'Cancelling…';
  } catch (error) {
    ui.runMessage.textContent = error.message;
  } finally {
    ui.cancelButton.disabled = false;
  }
}

async function loadAgent(id) {
  ui.agentView.classList.remove('hidden');
  ui.dashboardView.classList.add('hidden');
  try {
    const result = await api(`${API_ROOT}/agents/${encodeURIComponent(id)}`);
    currentAgent = result.agent;
    populateAgentConfig(currentAgent);
    document.title = `${currentAgent.name} — Agent Dock`;
    selectTab(location.hash.slice(1), { updateHash: false });
    await Promise.all([refreshStatus(), refreshWorkspace(), refreshProviders()]);
    startLiveUpdates(refreshStatus);
  } catch (error) {
    setConnection('offline', error.message);
    ui.pageAgentName.textContent = 'Agent unavailable';
    ui.pageAgentDescription.textContent = error.message;
  }
}

ui.createForm.addEventListener('submit', createAgent);
for (const radio of ui.createAdapterRadios) radio.addEventListener('change', syncCreateRuntimeOptions);
for (const radio of $$('[name="runtimeMode"]')) radio.addEventListener('change', syncCreateRuntimeOptions);
$('#new-agent').addEventListener('click', openCreateDialog);
$('#empty-new-agent').addEventListener('click', openCreateDialog);
$('#close-agent-dialog').addEventListener('click', () => ui.createDialog.close());
$('#cancel-create').addEventListener('click', () => ui.createDialog.close());
ui.configForm.addEventListener('submit', saveAgent);
ui.modelSelect.addEventListener('change', () => {
  ui.saveMessage.textContent = 'Unsaved model policy';
});
$('#delete-agent').addEventListener('click', deleteCurrentAgent);
ui.authButton.addEventListener('click', startAuth);
ui.authCompleteForm.addEventListener('submit', completeAuthentication);
ui.runButton.addEventListener('click', runTask);
ui.cancelButton.addEventListener('click', cancelRun);
ui.refreshUsage.addEventListener('click', refreshUsage);
ui.refreshAuth.addEventListener('click', refreshAuthentication);
$('#refresh-files').addEventListener('click', refreshWorkspace);
$('#clear-output').addEventListener('click', () => {
  ui.conversation.innerHTML = '<div class="welcome-line"><span>system</span> Output cleared. This transcript is not persisted.</div>';
  ui.rawOutput.textContent = '';
});
ui.prompt.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') runTask();
});
for (const button of ui.tabButtons) button.addEventListener('click', () => selectTab(button.dataset.tab));
ui.testAgentButton.addEventListener('click', () => {
  selectTab('test', { focus: true });
  ui.tabList.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
window.addEventListener('hashchange', () => selectTab(location.hash.slice(1), { updateHash: false }));

const agentRoute = window.location.pathname.match(/^\/agents\/([^/]+)\/?$/);
if (agentRoute) loadAgent(decodeURIComponent(agentRoute[1]));
else loadDashboard();
