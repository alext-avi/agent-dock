const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
import {
  buildMcpWorkshopPrompt,
  createWorkshopRunState,
  extractMcpWorkshopProposal,
  observeWorkshopRunEvent,
  requireSuccessfulWorkshopRun
} from './mcp-workshop.js';

const API_ROOT = '/api/v1';
const VALID_TABS = new Set(['instructions', 'tools', 'data', 'test']);
let currentUsageCapability = { quotaWindows: false, accountActivity: false, source: null };
// Image drift only changes when someone rebuilds, so it is read per page load
// rather than in the three-second status poll, which would mean a Docker
// inspection per agent per tick.
let runtimeDrift = new Map();
let runtimeDriftReadAt = 0;
// The status poll and the refresh handler both write the refresh control. While
// a refresh is in flight the handler owns it, or the poll re-enables a button
// mid-request and a second click fires a POST the server correctly rejects.
let runtimeRefreshInFlight = false;
// Neither a provider Retry-After nor our own poll floor is something a click can
// skip, so the refresh control must not pretend otherwise.
let usageBackingOff = false;
let usageThrottled = false;

const ui = {
  dashboardView: $('#dashboard-view'),
  jobsView: $('#jobs-view'),
  mcpView: $('#mcp-view'),
  registryList: $('#registry-list'),
  registryCount: $('#registry-count'),
  registryMessage: $('#registry-message'),
  newRegistryMcp: $('#new-registry-mcp'),
  credentialListMessage: $('#credential-list-message'),
  workshop: $('#workshop'),
  workshopAgent: $('#workshop-agent'),
  workshopObjective: $('#workshop-objective'),
  workshopRun: $('#run-workshop'),
  workshopStatus: $('#workshop-status'),
  workshopLog: $('#workshop-log'),
  credentialList: $('#credential-list'),
  credentialStorage: $('#credential-storage'),
  credentialStorageNote: $('#credential-storage-note'),
  credentialStorageDetail: $('#credential-storage-detail'),
  credentialsRefreshed: $('#credentials-refreshed'),
  newCredential: $('#new-credential'),
  credentialDialog: $('#credential-dialog'),
  credentialForm: $('#credential-form'),
  credentialDialogTitle: $('#credential-dialog-title'),
  credentialId: $('#credential-id'),
  credentialName: $('#credential-name'),
  credentialHosts: $('#credential-hosts'),
  credentialValue: $('#credential-value'),
  credentialValueHint: $('#credential-value-hint'),
  credentialMessage: $('#credential-message'),
  cancelCredential: $('#cancel-credential'),
  closeCredentialDialog: $('#close-credential-dialog'),
  agentView: $('#agent-view'),
  connectionDot: $('#connection-dot'),
  connectionLabel: $('#connection-label'),
  operatorName: $('#operator-name'),
  operatorRole: $('#operator-role'),
  accessPolicyButton: $('#access-policy-button'),
  accessPolicyDialog: $('#access-policy-dialog'),
  accessIdentityName: $('#access-identity-name'),
  accessIdentityProvider: $('#access-identity-provider'),
  accessIdentityRole: $('#access-identity-role'),
  signOut: $('#sign-out'),
  agentGrid: $('#agent-grid'),
  emptyFleet: $('#empty-fleet'),
  agentCount: $('#agent-count'),
  schedulerState: $('#scheduler-state'),
  activeJobCount: $('#active-job-count'),
  nextJobTime: $('#next-job-time'),
  nextJobName: $('#next-job-name'),
  jobSuccessRate: $('#job-success-rate'),
  jobOutcomeCount: $('#job-outcome-count'),
  jobsRefreshed: $('#jobs-refreshed'),
  jobGrid: $('#job-grid'),
  emptyJobs: $('#empty-jobs'),
  jobDialog: $('#job-dialog'),
  jobForm: $('#job-form'),
  jobId: $('#job-id'),
  jobDialogTitle: $('#job-dialog-title'),
  jobName: $('#job-name'),
  jobAgent: $('#job-agent'),
  jobPrompt: $('#job-prompt'),
  jobOnceFields: $('#job-once-fields'),
  jobCronFields: $('#job-cron-fields'),
  jobRunAt: $('#job-run-at'),
  jobOnceSummary: $('#job-once-summary'),
  jobCron: $('#job-cron'),
  jobFrequency: $('#job-frequency'),
  jobRepeatTimeField: $('#job-repeat-time-field'),
  jobRepeatTime: $('#job-repeat-time'),
  jobWeekdayField: $('#job-weekday-field'),
  jobWeekday: $('#job-weekday'),
  jobMonthDayField: $('#job-month-day-field'),
  jobMonthDay: $('#job-month-day'),
  jobHourMinuteField: $('#job-hour-minute-field'),
  jobHourMinute: $('#job-hour-minute'),
  jobTimezone: $('#job-timezone'),
  jobCustomSchedule: $('#job-custom-schedule'),
  jobScheduleSummary: $('#job-schedule-summary'),
  jobTimeout: $('#job-timeout'),
  jobFormMessage: $('#job-form-message'),
  deleteJob: $('#delete-job'),
  saveJob: $('#save-job'),
  createDialog: $('#create-agent-dialog'),
  createForm: $('#create-agent-form'),
  createMessage: $('#create-message'),
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
  mcpCount: $('#mcp-count'),
  mcpLibrary: $('#mcp-library'),
  mcpList: $('#mcp-list'),
  mcpMessage: $('#mcp-message'),
  mcpDialog: $('#mcp-dialog'),
  mcpForm: $('#mcp-form'),
  mcpDefinitionId: $('#mcp-definition-id'),
  mcpDialogTitle: $('#mcp-dialog-title'),
  mcpName: $('#mcp-name'),
  mcpTransport: $('#mcp-transport'),
  mcpHttpFields: $('#mcp-http-fields'),
  mcpStdioFields: $('#mcp-stdio-fields'),
  mcpUrl: $('#mcp-url'),
  mcpCommand: $('#mcp-command'),
  mcpArgs: $('#mcp-args'),
  mcpAdvanced: $('#mcp-advanced'),
  mcpHttpAdvanced: $('#mcp-http-advanced'),
  mcpStdioAdvanced: $('#mcp-stdio-advanced'),
  mcpHeaders: $('#mcp-headers'),
  mcpCwd: $('#mcp-cwd'),
  mcpEnvironment: $('#mcp-environment'),
  mcpPlaceholders: $('#mcp-placeholders'),
  mcpPlaceholderRows: $('#mcp-placeholder-rows'),
  mcpTimeout: $('#mcp-timeout'),
  mcpFormMessage: $('#mcp-form-message'),
  saveMcp: $('#save-mcp'),
  deleteMcpDefinition: $('#delete-mcp-definition'),
  saveAgent: $('#save-agent'),
  saveMessage: $('#save-message'),
  pageAgentName: $('#page-agent-name'),
  pageAgentDescription: $('#page-agent-description'),
  agentIdLabel: $('#agent-id-label'),
  workerState: $('#worker-state'),
  runtimeDrift: $('#runtime-drift'),
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
  refreshRuntime: $('#refresh-runtime'),
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
let activeWorkerTaskId = null;
let authPolling = null;
let refreshingAuth = false;
let currentAgent = null;
let currentHarnessName = 'Agent';
let dashboardAgents = [];
let dashboardFingerprint = '';
let dashboardRefreshInFlight = false;
let schedules = [];
let scheduleAgents = [];
let scheduleRuns = new Map();
let jobsRefreshInFlight = false;
let statusRefreshInFlight = false;
let liveUpdateTimer = null;
let retainedRuntimes = [];
let mcpDefinitions = [];
let mcpBindings = [];
let mcpRefreshInFlight = false;

function setConnection(state, label) {
  ui.connectionDot.className = `dot ${state}`;
  ui.connectionLabel.textContent = label;
}

async function api(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'x-agent-dock-csrf': '1' } : {}),
      ...options.headers
    }
  });
  // A proxied agent can return 401 when its private worker credential is stale.
  // Only the control plane's own protected-resource challenge means the
  // operator session has expired; treating every upstream 401 as that signal
  // traps the dashboard in a /login -> / refresh loop.
  const authenticationChallenge = response.headers.get('www-authenticate') ?? '';
  if (response.status === 401 && /\bresource_metadata\s*=/.test(authenticationChallenge)) {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    throw new Error('Authentication required');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function loadPlatformSession() {
  try {
    const { authentication } = await api(`${API_ROOT}/session`);
    const principal = authentication.principal;
    if (!principal) return;
    ui.operatorName.textContent = principal.displayName;
    ui.operatorRole.textContent = principal.roles.join(' · ') || principal.provider;
    ui.accessIdentityName.textContent = principal.displayName;
    ui.accessIdentityProvider.textContent = [principal.email, principal.provider].filter(Boolean).join(' · ');
    ui.accessIdentityRole.textContent = principal.roles.join(' · ') || 'scope only';
    ui.signOut.classList.toggle('hidden', authentication.mode !== 'oidc');
  } catch {
    // The API helper handles an expired session by returning to the login page.
  }
}

async function signOut() {
  ui.signOut.disabled = true;
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-agent-dock-csrf': '1' } });
  } finally {
    window.location.assign('/login');
  }
}

// maxAgeMs lets the live poll resync cheaply: drift only changes when someone
// rebuilds, so re-reading it every minute keeps an open tab honest without
// putting a Docker inspection behind every three-second tick.
async function loadRuntimeDrift({ maxAgeMs = 0 } = {}) {
  if (maxAgeMs && Date.now() - runtimeDriftReadAt < maxAgeMs) return;
  try {
    const { runtimes } = await api(`${API_ROOT}/runtimes`);
    runtimeDrift = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
    runtimeDriftReadAt = Date.now();
  } catch {
    // Drift is advisory. Failing to read it must not block the fleet.
  }
}

const DRIFT_RESYNC_MS = 60_000;

function renderRuntimeDrift() {
  // The refresh handler owns both controls until its request settles.
  if (runtimeRefreshInFlight) return;
  const outdated = runtimeIsOutdated(currentAgent?.runtime);
  ui.runtimeDrift.classList.toggle('hidden', !outdated);
  ui.runtimeDrift.disabled = false;
  ui.runtimeDrift.textContent = 'image update available · refresh';
  ui.refreshRuntime.textContent = outdated ? 'Refresh runtime image · update available' : 'Refresh runtime image';
}

function runtimeIsOutdated(runtime) {
  return runtimeDrift.get(runtime?.id)?.outdated === true;
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
  if (selected === 'tools' && currentAgent) refreshMcp();
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
        <span class="card-outdated hidden">image update available</span>
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
  card.querySelector('.card-outdated').classList.toggle('hidden', !runtimeIsOutdated(agent.runtime));
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
  const stale = Boolean(status.usage?.pollErrorKind);
  // Name the window the headline number came from. The card only draws two bars,
  // so a bare maximum taken across every window can report a percentage that
  // nothing visible on the card accounts for.
  const worst = windows.reduce(
    (highest, window) => (highest && Number(highest.usedPercent) >= Number(window.usedPercent) ? highest : window),
    null
  );
  card.querySelector('.card-usage').textContent = worst
    ? `${Number(worst.usedPercent).toFixed(0)}% ${worst.label}${stale ? ' · stale' : ''}`
    : '—';
  card.querySelector('.card-requests').textContent = formatTokens(status.usage?.totals?.requests ?? 0);
  const primary = windows.find((window) => window.scope === 'primary') ?? windows[0];
  const secondary = windows.find((window) => window.scope === 'secondary') ?? windows[1];
  renderCardQuota(card.querySelector('.card-quota-primary'), primary, 'Quota window', stale);
  renderCardQuota(card.querySelector('.card-quota-secondary'), secondary, 'Additional window', stale);
  card.querySelector('.card-update').textContent = `live · ${relativeTime(new Date().toISOString())}`;
}

function quotaFillClass(used) {
  if (used >= 90) return 'danger';
  if (used >= 70) return 'warning';
  return '';
}

function renderCardQuota(row, window, fallbackLabel, stale = false) {
  const used = window ? Math.max(0, Math.min(100, Number(window.usedPercent ?? 0))) : 0;
  // A retained reading from before a failed poll has an untrustworthy countdown.
  const refresh = stale ? 'last known' : quotaRefreshLabel(window?.resetsAt);
  row.querySelector('.card-quota-label').textContent = window
    ? `${quotaWindowLabel(window, fallbackLabel)}${refresh ? ` · ${refresh}` : ''}`
    : fallbackLabel;
  row.querySelector('.card-quota-value').textContent = window ? `${used.toFixed(0)}%` : 'Unavailable';
  const fill = row.querySelector('.quota-bar span');
  fill.style.width = window ? `${used}%` : '0%';
  fill.className = quotaFillClass(used);
  row.classList.toggle('unavailable', !window);
  row.classList.toggle('stale', Boolean(window) && stale);
}

function markAgentCardOffline(card, message) {
  const pill = card.querySelector('.status-pill');
  pill.textContent = message.includes('not configured') ? 'definition only' : 'offline';
  pill.className = `pill status-pill ${message.includes('not configured') ? 'neutral' : 'error'}`;
  card.querySelector('.card-auth').textContent = '—';
}

function scheduleDateTime(iso) {
  if (!iso) return 'Not scheduled';
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return 'Invalid time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
  }).format(date);
}

function scheduleCountdown(iso) {
  if (!iso) return 'No future occurrence';
  const milliseconds = Date.parse(iso) - Date.now();
  if (!Number.isFinite(milliseconds)) return 'Time unavailable';
  if (milliseconds <= 0) return 'due now';
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours} hr`;
  const days = Math.ceil(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

const JOB_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function friendlyTime(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return 'a selected time';
  const date = new Date(2000, 0, 1, hour, minute);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function timezoneLabel(timezone) {
  if (timezone === 'UTC') return 'UTC';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      timeZoneName: 'longGeneric'
    }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ?? timezone.replaceAll('_', ' ');
  } catch {
    return String(timezone || 'local time').replaceAll('_', ' ');
  }
}

function parseRecurringExpression(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) return { frequency: 'custom' };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d+$/.test(minute) || month !== '*') return { frequency: 'custom' };
  const minuteNumber = Number(minute);
  if (hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return { frequency: 'hourly', minute: minuteNumber };
  }
  if (!/^\d+$/.test(hour)) return { frequency: 'custom' };
  const time = `${String(Number(hour)).padStart(2, '0')}:${String(minuteNumber).padStart(2, '0')}`;
  if (dayOfMonth === '*' && dayOfWeek === '1-5') return { frequency: 'weekdays', time };
  if (dayOfMonth === '*' && dayOfWeek === '*') return { frequency: 'daily', time };
  if (dayOfMonth === '*' && /^[0-6]$/.test(dayOfWeek)) return { frequency: 'weekly', time, weekday: dayOfWeek };
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') return { frequency: 'monthly', time, monthDay: Number(dayOfMonth) };
  return { frequency: 'custom' };
}

function recurringDescription(timing) {
  const parsed = parseRecurringExpression(timing.expression);
  const zone = timezoneLabel(timing.timezone);
  if (parsed.frequency === 'hourly') {
    const minute = parsed.minute === 0 ? 'at the start of every hour' : `${parsed.minute} minutes past every hour`;
    return `${minute} · ${zone}`;
  }
  const at = friendlyTime(parsed.time);
  if (parsed.frequency === 'weekdays') return `Every weekday at ${at} · ${zone}`;
  if (parsed.frequency === 'daily') return `Every day at ${at} · ${zone}`;
  if (parsed.frequency === 'weekly') return `Every ${JOB_WEEKDAYS[Number(parsed.weekday)]} at ${at} · ${zone}`;
  if (parsed.frequency === 'monthly') return `Day ${parsed.monthDay} of every month at ${at} · ${zone}`;
  return `Recurring on a custom cadence · ${zone}`;
}

function scheduleTimingLabel(schedule) {
  return schedule.timing.kind === 'once'
    ? `Run once · ${scheduleDateTime(schedule.timing.at)}`
    : recurringDescription(schedule.timing);
}

function runPresentation(status) {
  if (status === 'succeeded') return { label: 'succeeded', className: 'ready' };
  if (status === 'running' || status === 'claimed') return { label: status, className: 'busy' };
  if (status?.startsWith('skipped')) return { label: status.replace('skipped_', 'skipped · '), className: 'neutral' };
  if (status === 'failed' || status === 'timed_out' || status === 'interrupted') {
    return { label: status.replace('_', ' '), className: 'error' };
  }
  return { label: status || 'unknown', className: 'neutral' };
}

function usageTotal(usage) {
  const value = usage?.totalTokens ?? usage?.tokens?.total ?? usage?.totals?.totalTokens;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function makeButton(label, action, scheduleId, className = 'button secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.dataset.jobAction = action;
  button.dataset.scheduleId = scheduleId;
  return button;
}

function makeJobHistory(runs) {
  const details = document.createElement('details');
  details.className = 'job-history';
  const summary = document.createElement('summary');
  summary.textContent = runs.length ? `History · ${runs.length}` : 'No run history';
  details.append(summary);
  if (!runs.length) return details;
  const list = document.createElement('div');
  list.className = 'job-history-list';
  for (const run of runs) {
    const row = document.createElement('div');
    row.className = 'job-history-row';
    const status = document.createElement('strong');
    status.textContent = runPresentation(run.status).label;
    const occurrence = document.createElement('span');
    occurrence.textContent = scheduleDateTime(run.occurrenceAt);
    const duration = document.createElement('span');
    duration.textContent = formatDuration(run.durationMs);
    const tokens = document.createElement('span');
    const total = usageTotal(run.usage);
    tokens.textContent = total === null ? '— tokens' : `${formatTokens(total)} tokens`;
    const error = document.createElement('span');
    error.className = run.error ? 'history-error' : '';
    error.textContent = run.error || run.taskId || run.trigger;
    row.append(status, occurrence, duration, tokens, error);
    list.append(row);
  }
  details.append(list);
  return details;
}

function createJobCard(schedule) {
  const agent = scheduleAgents.find((candidate) => candidate.id === schedule.agentId);
  const runs = scheduleRuns.get(schedule.id) ?? [];
  const lastRun = runs[0] ?? null;
  const article = document.createElement('article');
  article.className = 'panel job-card';
  article.dataset.scheduleId = schedule.id;

  const main = document.createElement('div');
  main.className = 'job-card-main';
  const title = document.createElement('div');
  title.className = 'job-card-title';
  const kicker = document.createElement('p');
  kicker.className = 'kicker';
  kicker.textContent = `${agent?.name ?? schedule.agentId} · ${schedule.timing.kind === 'cron' ? 'recurring' : 'one-off'}`;
  const heading = document.createElement('h2');
  heading.textContent = schedule.name;
  const timing = document.createElement('p');
  timing.textContent = scheduleTimingLabel(schedule);
  title.append(kicker, heading, timing);

  const next = document.createElement('div');
  next.className = 'job-next';
  const nextLabel = document.createElement('span');
  nextLabel.textContent = schedule.state === 'paused' ? 'PAUSED' : schedule.state === 'completed' ? 'COMPLETED' : 'NEXT RUN';
  const nextTime = document.createElement('strong');
  nextTime.textContent = schedule.nextRunAt ? scheduleDateTime(schedule.nextRunAt) : 'No future run';
  const nextRelative = document.createElement('small');
  nextRelative.textContent = schedule.state === 'paused'
    ? 'held until resumed'
    : schedule.nextRunAt ? scheduleCountdown(schedule.nextRunAt) : schedule.state;
  next.append(nextLabel, nextTime, nextRelative);

  const actions = document.createElement('div');
  actions.className = 'job-card-actions';
  actions.append(makeButton('Run now', 'run-now', schedule.id));
  if (schedule.state === 'active') actions.append(makeButton('Pause', 'pause', schedule.id));
  if (schedule.state === 'paused') actions.append(makeButton('Resume', 'resume', schedule.id));
  const edit = makeButton(schedule.state === 'completed' ? 'Manage' : 'Edit', 'edit', schedule.id, 'text-button');
  actions.append(edit);
  main.append(title, next, actions);

  const footer = document.createElement('div');
  footer.className = 'job-card-footer';
  const last = document.createElement('div');
  last.className = 'job-last-run';
  const runPill = document.createElement('span');
  const presentation = runPresentation(lastRun?.status);
  runPill.className = `pill ${lastRun ? presentation.className : 'neutral'}`;
  runPill.textContent = lastRun ? presentation.label : 'never run';
  const runTime = document.createElement('span');
  runTime.textContent = lastRun ? `${relativeTime(lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt)} · ${formatDuration(lastRun.durationMs)}` : 'No occurrences recorded';
  last.append(runPill, runTime);
  const metadata = document.createElement('span');
  metadata.className = 'job-run-meta';
  const total = usageTotal(lastRun?.usage);
  metadata.textContent = lastRun
    ? `${lastRun.trigger} · ${total === null ? 'usage unavailable' : `${formatTokens(total)} tokens`}${lastRun.taskId ? ` · ${lastRun.taskId}` : ''}`
    : `id · ${schedule.id}`;
  footer.append(last, metadata, makeJobHistory(runs));
  article.append(main, footer);
  return article;
}

function renderJobs(scheduler) {
  const expandedHistory = new Set([...ui.jobGrid.querySelectorAll('.job-history[open]')]
    .map((details) => details.closest('.job-card')?.dataset.scheduleId).filter(Boolean));
  ui.jobGrid.replaceChildren();
  ui.emptyJobs.classList.toggle('hidden', schedules.length !== 0);
  ui.jobGrid.classList.toggle('hidden', schedules.length === 0);
  for (const schedule of schedules) {
    const card = createJobCard(schedule);
    if (expandedHistory.has(schedule.id)) card.querySelector('.job-history').open = true;
    ui.jobGrid.append(card);
  }

  const active = schedules.filter((schedule) => schedule.state === 'active');
  ui.activeJobCount.textContent = String(active.length).padStart(2, '0');
  const next = active.filter((schedule) => schedule.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
  ui.nextJobTime.textContent = next ? scheduleDateTime(next.nextRunAt) : '—';
  ui.nextJobName.textContent = next ? `${next.name} · ${scheduleCountdown(next.nextRunAt)}` : 'No active schedule';
  const recent = [...scheduleRuns.values()].flat().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
  const outcomes = recent.filter((run) => ['succeeded', 'failed', 'timed_out', 'interrupted'].includes(run.status));
  const successes = outcomes.filter((run) => run.status === 'succeeded').length;
  ui.jobSuccessRate.textContent = outcomes.length ? `${Math.round(successes / outcomes.length * 100)}%` : '—';
  ui.jobOutcomeCount.textContent = recent.length ? `${successes} succeeded · ${recent.length - successes} other` : 'No runs recorded';
  const schedulerError = scheduler.lastTickError || scheduler.lastExecutionError;
  ui.schedulerState.textContent = scheduler.enabled ? (schedulerError ? 'scheduler error' : 'scheduler online') : 'scheduler paused';
  ui.schedulerState.className = `pill ${schedulerError ? 'error' : scheduler.enabled ? 'ready' : 'neutral'}`;
  ui.schedulerState.title = schedulerError || `${scheduler.database} · last tick ${scheduler.lastTickAt ? relativeTime(scheduler.lastTickAt) : 'pending'}`;
  ui.jobsRefreshed.textContent = `Live · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

async function refreshJobs() {
  if (jobsRefreshInFlight) return;
  jobsRefreshInFlight = true;
  try {
    const [{ scheduler }, scheduleResult, agentResult] = await Promise.all([
      api(`${API_ROOT}/scheduler`),
      api(`${API_ROOT}/schedules?includeRuns=5`),
      api(`${API_ROOT}/agents`)
    ]);
    schedules = scheduleResult.schedules ?? [];
    scheduleAgents = agentResult.agents ?? [];
    scheduleRuns = new Map(schedules.map((schedule) => [schedule.id, scheduleResult.runs?.[schedule.id] ?? []]));
    renderJobs(scheduler);
    setConnection('online', 'Scheduler live');
  } catch (error) {
    setConnection('offline', error.message);
    ui.jobsRefreshed.textContent = error.message;
    if (!schedules.length) {
      ui.jobGrid.replaceChildren();
      const panel = document.createElement('article');
      panel.className = 'panel';
      const message = document.createElement('p');
      message.className = 'usage-error';
      message.textContent = `Could not load scheduled jobs: ${error.message}`;
      panel.append(message);
      ui.jobGrid.append(panel);
    }
  } finally {
    jobsRefreshInFlight = false;
  }
}

async function loadJobs() {
  ui.jobsView.classList.remove('hidden');
  ui.dashboardView.classList.add('hidden');
  ui.agentView.classList.add('hidden');
  document.title = 'Scheduled Jobs — Agent Dock';
  await refreshJobs();
  startLiveUpdates(refreshJobs);
}

async function loadDashboard() {
  ui.dashboardView.classList.remove('hidden');
  ui.jobsView.classList.add('hidden');
  ui.agentView.classList.add('hidden');
  document.title = 'Agent Dock — Fleet';
  try {
    const [{ agents }] = await Promise.all([api(`${API_ROOT}/agents`), loadRuntimeDrift()]);
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
    await loadRuntimeDrift({ maxAgeMs: DRIFT_RESYNC_MS });
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

function localDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ensureTimezoneOption(timezone) {
  if (!timezone || [...ui.jobTimezone.options].some((option) => option.value === timezone)) return;
  const option = document.createElement('option');
  option.value = timezone;
  option.textContent = timezoneLabel(timezone);
  ui.jobTimezone.prepend(option);
}

function populateJobTimezones(selected) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const common = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  const zones = [...new Set([local, selected, ...common].filter(Boolean))];
  ui.jobTimezone.replaceChildren();
  for (const timezone of zones) {
    const option = document.createElement('option');
    option.value = timezone;
    option.textContent = timezone === local ? `${timezoneLabel(timezone)} (current)` : timezoneLabel(timezone);
    ui.jobTimezone.append(option);
  }
  ui.jobTimezone.value = selected || local;
}

function buildRecurringExpression() {
  const [hour, minute] = ui.jobRepeatTime.value.split(':').map(Number);
  switch (ui.jobFrequency.value) {
    case 'hourly': return `${Number(ui.jobHourMinute.value)} * * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${ui.jobWeekday.value}`;
    case 'monthly': return `${minute} ${hour} ${Number(ui.jobMonthDay.value)} * *`;
    case 'custom': return ui.jobCron.value;
    default: return '';
  }
}

function updateJobScheduleSummary() {
  const once = new Date(ui.jobRunAt.value);
  ui.jobOnceSummary.textContent = Number.isFinite(once.valueOf())
    ? `This job will run once on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(once)}.`
    : 'Choose when this job should run.';

  const expression = buildRecurringExpression();
  ui.jobScheduleSummary.textContent = expression
    ? recurringDescription({ expression, timezone: ui.jobTimezone.value })
    : 'Choose how often this job should repeat.';
}

function syncJobRecurrenceFields() {
  const frequency = ui.jobFrequency.value;
  const custom = frequency === 'custom';
  ui.jobRepeatTimeField.classList.toggle('hidden', frequency === 'hourly' || custom);
  ui.jobWeekdayField.classList.toggle('hidden', frequency !== 'weekly');
  ui.jobMonthDayField.classList.toggle('hidden', frequency !== 'monthly');
  ui.jobHourMinuteField.classList.toggle('hidden', frequency !== 'hourly');
  ui.jobCustomSchedule.classList.toggle('hidden', !custom);
  ui.jobRepeatTime.required = !custom && frequency !== 'hourly';
  ui.jobMonthDay.required = frequency === 'monthly';
  updateJobScheduleSummary();
}

function applyRecurringExpression(expression) {
  const parsed = parseRecurringExpression(expression);
  let customOption = ui.jobFrequency.querySelector('option[value="custom"]');
  if (parsed.frequency === 'custom' && !customOption) {
    customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Advanced schedule (unchanged)';
    ui.jobFrequency.append(customOption);
  }
  ui.jobFrequency.value = parsed.frequency;
  if (parsed.time) ui.jobRepeatTime.value = parsed.time;
  if (parsed.weekday !== undefined) ui.jobWeekday.value = String(parsed.weekday);
  if (parsed.monthDay !== undefined) ui.jobMonthDay.value = String(parsed.monthDay);
  if (parsed.minute !== undefined) {
    const minute = String(parsed.minute);
    if (![...ui.jobHourMinute.options].some((option) => option.value === minute)) {
      const option = document.createElement('option');
      option.value = minute;
      option.textContent = `${minute} minutes past`;
      ui.jobHourMinute.append(option);
    }
    ui.jobHourMinute.value = minute;
  }
  syncJobRecurrenceFields();
}

function syncJobTimingFields() {
  const timing = ui.jobForm.querySelector('[name="jobTiming"]:checked')?.value ?? 'once';
  const recurring = timing === 'cron';
  ui.jobOnceFields.classList.toggle('hidden', recurring);
  ui.jobCronFields.classList.toggle('hidden', !recurring);
  ui.jobRunAt.required = !recurring;
  ui.jobFrequency.required = recurring;
  ui.jobTimezone.required = recurring;
  for (const option of ui.jobForm.querySelectorAll('.timing-option')) {
    option.classList.toggle('selected', option.querySelector('input')?.checked === true);
  }
  syncJobRecurrenceFields();
}

function populateJobAgents(selectedId = '') {
  ui.jobAgent.replaceChildren();
  for (const agent of scheduleAgents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = `${agent.name} · ${adapterLabel(agent.adapter)}`;
    option.selected = agent.id === selectedId;
    ui.jobAgent.append(option);
  }
}

function openJobDialog(schedule = null) {
  ui.jobForm.reset();
  ui.jobFormMessage.classList.add('hidden');
  ui.jobFormMessage.textContent = '';
  ui.jobId.value = schedule?.id ?? '';
  ui.jobDialogTitle.textContent = schedule ? 'Edit scheduled job' : 'New scheduled job';
  ui.saveJob.textContent = schedule ? 'Save changes' : 'Create job';
  ui.deleteJob.classList.toggle('hidden', !schedule);
  populateJobAgents(schedule?.agentId);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const defaultRunAt = new Date(Date.now() + 60 * 60 * 1000);
  defaultRunAt.setSeconds(0, 0);
  defaultRunAt.setMinutes(Math.ceil(defaultRunAt.getMinutes() / 5) * 5);
  ui.jobFrequency.querySelector('option[value="custom"]')?.remove();
  ui.jobRunAt.value = localDateTimeValue(defaultRunAt);
  ui.jobCron.value = '0 9 * * 1-5';
  ui.jobFrequency.value = 'weekdays';
  ui.jobRepeatTime.value = '09:00';
  ui.jobWeekday.value = '1';
  ui.jobMonthDay.value = '1';
  ui.jobHourMinute.value = '0';
  populateJobTimezones(schedule?.timing.timezone || timezone);
  ui.jobTimeout.value = '60';
  if (schedule) {
    ui.jobName.value = schedule.name;
    ui.jobPrompt.value = schedule.prompt;
    ui.jobAgent.value = schedule.agentId;
    const timingRadio = ui.jobForm.querySelector(`[name="jobTiming"][value="${schedule.timing.kind}"]`);
    if (timingRadio) timingRadio.checked = true;
    if (schedule.timing.kind === 'once') ui.jobRunAt.value = localDateTimeValue(new Date(schedule.timing.at));
    else {
      ui.jobCron.value = schedule.timing.expression;
      ensureTimezoneOption(schedule.timing.timezone);
      ui.jobTimezone.value = schedule.timing.timezone;
      applyRecurringExpression(schedule.timing.expression);
    }
    ui.jobTimeout.value = String(Math.round((schedule.policies?.timeoutMs ?? 3_600_000) / 60_000));
  }
  syncJobTimingFields();
  if (schedule?.state === 'completed') {
    ui.jobFormMessage.textContent = 'This one-off job is complete. You can run it manually again or delete it, but its original schedule is immutable.';
    ui.jobFormMessage.classList.remove('hidden');
    ui.saveJob.disabled = true;
  } else if (!scheduleAgents.length) {
    ui.jobFormMessage.textContent = 'Create an agent before scheduling work.';
    ui.jobFormMessage.classList.remove('hidden');
    ui.saveJob.disabled = true;
  } else ui.saveJob.disabled = false;
  ui.jobDialog.showModal();
  ui.jobName.focus();
}

async function saveJob(event) {
  event.preventDefault();
  ui.jobFormMessage.classList.add('hidden');
  const timingKind = ui.jobForm.querySelector('[name="jobTiming"]:checked')?.value ?? 'once';
  let timing;
  if (timingKind === 'once') {
    const at = new Date(ui.jobRunAt.value);
    if (!Number.isFinite(at.valueOf()) || at.getTime() <= Date.now()) {
      ui.jobFormMessage.textContent = 'Choose a future date and time.';
      ui.jobFormMessage.classList.remove('hidden');
      return;
    }
    timing = { kind: 'once', at: at.toISOString() };
  } else {
    const expression = buildRecurringExpression();
    if (!expression || expression.includes('NaN')) {
      ui.jobFormMessage.textContent = 'Choose a complete repeating schedule.';
      ui.jobFormMessage.classList.remove('hidden');
      return;
    }
    ui.jobCron.value = expression;
    timing = { kind: 'cron', expression, timezone: ui.jobTimezone.value };
  }
  const existing = schedules.find((schedule) => schedule.id === ui.jobId.value);
  const body = {
    name: ui.jobName.value.trim(),
    agentId: ui.jobAgent.value,
    prompt: ui.jobPrompt.value.trim(),
    timing,
    policies: {
      overlap: 'skip-if-busy',
      misfire: 'skip',
      misfireGraceMs: existing?.policies?.misfireGraceMs ?? 60_000,
      timeoutMs: Number(ui.jobTimeout.value) * 60_000,
      maxAttempts: 1
    }
  };
  ui.saveJob.disabled = true;
  ui.saveJob.textContent = existing ? 'Saving…' : 'Creating…';
  try {
    await api(existing ? `${API_ROOT}/schedules/${encodeURIComponent(existing.id)}` : `${API_ROOT}/schedules`, {
      method: existing ? 'PATCH' : 'POST',
      body: JSON.stringify(body)
    });
    ui.jobDialog.close();
    await refreshJobs();
  } catch (error) {
    ui.jobFormMessage.textContent = error.message;
    ui.jobFormMessage.classList.remove('hidden');
  } finally {
    ui.saveJob.disabled = false;
    ui.saveJob.textContent = existing ? 'Save changes' : 'Create job';
  }
}

async function deleteJob(id = ui.jobId.value) {
  const schedule = schedules.find((candidate) => candidate.id === id);
  if (!schedule || !window.confirm(`Delete “${schedule.name}”? Its audit rows stay in the scheduler database.`)) return;
  try {
    await api(`${API_ROOT}/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (ui.jobDialog.open) ui.jobDialog.close();
    await refreshJobs();
  } catch (error) {
    ui.jobFormMessage.textContent = error.message;
    ui.jobFormMessage.classList.remove('hidden');
  }
}

async function handleJobAction(event) {
  const button = event.target.closest('[data-job-action]');
  if (!button) return;
  const schedule = schedules.find((candidate) => candidate.id === button.dataset.scheduleId);
  if (!schedule) return;
  if (button.dataset.jobAction === 'edit') return openJobDialog(schedule);
  button.disabled = true;
  const original = button.textContent;
  button.textContent = button.dataset.jobAction === 'run-now' ? 'Queueing…' : 'Updating…';
  try {
    await api(`${API_ROOT}/schedules/${encodeURIComponent(schedule.id)}/${button.dataset.jobAction}`, { method: 'POST' });
    await refreshJobs();
  } catch (error) {
    ui.jobsRefreshed.textContent = error.message;
    button.disabled = false;
    button.textContent = original;
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

function mcpEndpoint(server) {
  if (server.transport === 'http') return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
}

function renderMcpLibrary() {
  const bound = new Set(mcpBindings.map((binding) => binding.serverId));
  const available = mcpDefinitions.filter((server) => !bound.has(server.id));
  ui.mcpLibrary.replaceChildren();
  if (!available.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No unattached definitions';
    ui.mcpLibrary.append(option);
  } else {
    for (const server of available) {
      const option = document.createElement('option');
      option.value = server.id;
      option.textContent = `${server.name} · ${server.transport}`;
      ui.mcpLibrary.append(option);
    }
  }
  $('#attach-mcp').disabled = !available.length;
}

function bindingHealth(binding, runtime = {}) {
  const health = runtime.mcp?.health?.servers?.find((item) => item.name === binding.server.name);
  if (health?.status) return health.status;
  return binding.state || 'pending';
}

function renderMcp(result, definitions) {
  mcpDefinitions = definitions;
  mcpBindings = result.bindings ?? [];
  const runtime = result.runtime ?? {};
  ui.mcpCount.textContent = `${mcpBindings.length} attached`;
  ui.mcpCount.className = `pill ${mcpBindings.some((binding) => binding.state === 'error') ? 'error' : mcpBindings.length ? 'ready' : 'neutral'}`;
  ui.mcpList.replaceChildren();
  if (!mcpBindings.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-capability compact';
    empty.innerHTML = '<span class="empty-icon">⌁</span><h3>No MCP servers attached</h3><p>Create a remote or allowlisted local server, or attach a reusable definition from the control-plane library.</p>';
    ui.mcpList.append(empty);
  }
  for (const binding of mcpBindings) {
    const server = binding.server;
    const row = document.createElement('article');
    row.className = 'mcp-row';
    const heading = document.createElement('div');
    heading.className = 'mcp-row-heading';
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = server.name;
    const transport = document.createElement('small');
    transport.textContent = `${server.transport === 'http' ? 'remote HTTP' : 'local stdio'} · ${bindingHealth(binding, runtime).replaceAll('_', ' ')}`;
    identity.append(name, transport);
    const status = document.createElement('span');
    status.className = `pill ${binding.state === 'error' ? 'error' : binding.enabled ? 'ready' : 'neutral'}`;
    status.textContent = binding.enabled ? binding.state : 'disabled';
    heading.append(identity, status);
    const endpoint = document.createElement('code');
    endpoint.className = 'mcp-endpoint';
    endpoint.textContent = mcpEndpoint(server);
    const meta = document.createElement('p');
    meta.className = 'mcp-meta';
    // A stored credential is not a connector-secret reference, and saying "no
    // credential references" on a connector that plainly has one reads as a bug
    // in the thing the operator just configured.
    // One description of a connector's credential, shared with the MCP page.
    // Two copies is how this line came to say "no longer stored" here while the
    // other said "checking".
    meta.textContent = registryMeta(server);
    const actions = document.createElement('div');
    actions.className = 'mcp-row-actions';
    const validate = document.createElement('button');
    validate.className = 'text-button';
    validate.type = 'button';
    validate.textContent = 'Validate';
    validate.addEventListener('click', () => validateMcp(server.id));
    const edit = document.createElement('button');
    edit.className = 'text-button';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openMcpDialog(server));
    const detach = document.createElement('button');
    detach.className = 'text-button danger-text';
    detach.type = 'button';
    detach.textContent = 'Detach';
    detach.addEventListener('click', () => detachMcp(server));
    actions.append(validate, edit, detach);
    row.append(heading, endpoint, meta, actions);
    if (binding.error) {
      const error = document.createElement('p');
      error.className = 'usage-error';
      error.textContent = binding.error;
      row.append(error);
    }
    ui.mcpList.append(row);
  }
  renderMcpLibrary();
  if (runtime.unavailable) ui.mcpMessage.textContent = `Desired state is available; worker inspection failed: ${runtime.error}`;
}

async function refreshMcp() {
  if (!currentAgent || mcpRefreshInFlight) return;
  mcpRefreshInFlight = true;
  try {
    const [agentMcp, library, credentials] = await Promise.all([
      api(agentApi('mcp')),
      api(`${API_ROOT}/mcp/servers`),
      // A row names the credential it uses, so the panel needs them before it
      // renders rather than only when the dialog opens.
      api(`${API_ROOT}/credentials`).catch(() => null)
    ]);
    if (credentials) {
      storedCredentials = credentials.credentials;
      credentialsLoaded = true;
    }
    renderMcp(agentMcp, library.servers ?? []);
  } catch (error) {
    ui.mcpMessage.textContent = error.message;
    ui.mcpCount.textContent = 'unavailable';
    ui.mcpCount.className = 'pill error';
  } finally {
    mcpRefreshInFlight = false;
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CONNECTOR_SECRET_PREFIX = 'MCP_SECRET_';

// What the operator has typed, read the same way the control plane and the worker
// read a stored definition. A placeholder is only ever found in a field they can
// actually edit here, so scanning those is scanning all of them.
function placeholdersInForm() {
  const sources = ui.mcpTransport.value === 'stdio'
    ? [
        [ui.mcpArgs.value, 'the arguments'],
        [ui.mcpCwd.value, 'the working directory'],
        [ui.mcpEnvironment.value, 'the environment']
      ]
    : [
        [ui.mcpUrl.value, 'the URL'],
        [ui.mcpHeaders.value, 'the headers']
      ];
  const found = new Map();
  for (const [value, where] of sources) {
    for (const match of String(value ?? '').matchAll(PLACEHOLDER)) {
      if (!found.has(match[1])) found.set(match[1], where);
    }
  }
  return found;
}

// Bindings survive retyping: the row for a name keeps its choice while the
// operator edits around it, and a name that disappears from the definition takes
// its binding with it.
let placeholderBindings = new Map();

function bindingLabel(binding) {
  if (!binding) return null;
  if (binding.source === 'credential') {
    const credential = storedCredentials.find((item) => item.id === binding.credentialId);
    if (!credential) return ['That stored key is no longer available.'];
    if (!credential.complete) {
      return [
        'The key ',
        { code: credential.name },
        ' exists but has no value yet. Add its value under Stored keys below, or this connector cannot start.'
      ];
    }
    // A host list is checked against this connector's url when the definition is
    // saved. It is not egress control: nothing stops the agent sending the value
    // somewhere else once it holds it, and a local process has no url to check
    // at all. Saying "limited to" implied an enforcement that does not exist.
    if (ui.mcpTransport.value === 'stdio') {
      return [
        'Uses the stored key ',
        { code: credential.name },
        '. A local process has no URL, so its host list is not consulted here.'
      ];
    }
    return credential.restricted
      ? [
        'Uses the stored key ',
        { code: credential.name },
        '. This connector\'s URL is checked against ',
        { code: credential.hosts.join(', ') },
        ' when this configuration is applied — that stops the URL being changed to redirect the key, not the agent from using it elsewhere.'
      ]
      : [
        'Uses the stored key ',
        { code: credential.name },
        '. It names no hosts, so nothing checks where this connector points.'
      ];
  }
  return [
    'Read from ',
    { code: `${CONNECTOR_SECRET_PREFIX}${binding.name}` },
    ' inside the agent\'s own container. The control plane never sees it.'
  ];
}

function renderPlaceholderRows() {
  const found = placeholdersInForm();
  // Drop bindings for names no longer written anywhere.
  for (const name of [...placeholderBindings.keys()]) {
    if (!found.has(name)) placeholderBindings.delete(name);
  }
  ui.mcpPlaceholders.classList.toggle('hidden', found.size === 0);
  ui.mcpPlaceholderRows.replaceChildren();
  if (!found.size) return;

  const knownSecrets = new Set();
  for (const server of [...registryServers, ...mcpDefinitions]) {
    for (const binding of Object.values(server.placeholders ?? {})) {
      if (binding.source === 'connector-secret') knownSecrets.add(binding.name);
    }
  }

  for (const [name, where] of found) {
    const row = document.createElement('div');
    row.className = 'placeholder-row';

    const head = document.createElement('div');
    head.className = 'placeholder-row-head';
    const code = document.createElement('code');
    code.textContent = name;
    const from = document.createElement('span');
    from.textContent = 'is filled from';
    const choice = document.createElement('select');
    choice.setAttribute('aria-label', `What fills ${name}`);
    const where_ = document.createElement('span');
    where_.className = 'placeholder-where';
    where_.textContent = `used in ${where}`;

    const options = [['', 'choose…']];
    for (const credential of storedCredentials) {
      options.push([`credential:${credential.id}`, `stored key · ${credential.name}`]);
    }
    for (const secret of [...knownSecrets].sort()) {
      options.push([`secret:${secret}`, `container secret · ${secret}`]);
    }
    options.push(['__new', 'a new container secret…']);
    const matching = storedCredentials.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!matching) options.push(['__create', `create a key called ${name}…`]);
    for (const [value, label] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      choice.append(option);
    }

    const custom = document.createElement('input');
    custom.className = 'hidden';
    custom.pattern = '[A-Za-z_][A-Za-z0-9_]*';
    custom.placeholder = 'COMPANY_API_TOKEN';
    custom.setAttribute('aria-label', `New container secret name for ${name}`);

    const effect = document.createElement('p');
    effect.className = 'field-effect unset';
    effect.textContent = 'Nothing fills this yet, so the connector cannot be saved.';

    const existing = placeholderBindings.get(name);
    // A key whose name matches the placeholder is the obvious answer, so it is
    // preselected. Still visible and still changeable — it is a prefill, not a
    // decision made on the operator's behalf.
    if (!existing && matching) {
      placeholderBindings.set(name, { source: 'credential', credentialId: matching.id });
    }
    const binding = placeholderBindings.get(name);
    if (binding?.source === 'credential') choice.value = `credential:${binding.credentialId}`;
    else if (binding?.source === 'connector-secret') {
      if (knownSecrets.has(binding.name)) choice.value = `secret:${binding.name}`;
      else { choice.value = '__new'; custom.value = binding.name; custom.classList.remove('hidden'); }
    }

    const settle = async () => {
      const value = choice.value;
      if (value === '__create') {
        try {
          const created = await api(`${API_ROOT}/credentials`, {
            method: 'POST',
            body: JSON.stringify({ name })
          });
          storedCredentials = [...storedCredentials, created.credential];
          placeholderBindings.set(name, { source: 'credential', credentialId: created.credential.id });
          renderPlaceholderRows();
          void loadCredentials();
          return;
        } catch (error) {
          effect.classList.remove('unset');
          effect.textContent = error.message;
          return;
        }
      }
      let binding = null;
      if (value.startsWith('credential:')) binding = { source: 'credential', credentialId: value.slice('credential:'.length) };
      else if (value.startsWith('secret:')) binding = { source: 'connector-secret', name: value.slice('secret:'.length) };
      else if (value === '__new' && custom.value.trim()) binding = { source: 'connector-secret', name: custom.value.trim() };
      custom.classList.toggle('hidden', value !== '__new');
      if (binding) placeholderBindings.set(name, binding);
      else placeholderBindings.delete(name);
      const described = bindingLabel(binding);
      effect.classList.toggle('unset', !described);
      if (!described) {
        effect.textContent = 'Nothing fills this yet, so the connector cannot be saved.';
        return;
      }
      effect.replaceChildren();
      for (const part of described) {
        if (typeof part === 'string') effect.append(document.createTextNode(part));
        else {
          const fragment = document.createElement('code');
          fragment.textContent = part.code;
          effect.append(fragment);
        }
      }
    };
    choice.addEventListener('change', settle);
    custom.addEventListener('input', settle);
    settle();

    head.append(code, from, choice, custom, where_);
    row.append(head, effect);
    ui.mcpPlaceholderRows.append(row);
  }
}

function syncMcpTransportFields() {
  const http = ui.mcpTransport.value === 'http';
  ui.mcpHttpFields.classList.toggle('hidden', !http);
  ui.mcpStdioFields.classList.toggle('hidden', http);
  ui.mcpHttpAdvanced.classList.toggle('hidden', !http);
  ui.mcpStdioAdvanced.classList.toggle('hidden', http);
  ui.mcpUrl.required = http;
  ui.mcpCommand.required = !http;
  renderPlaceholderRows();
}

function openMcpDialog(server = null) {
  ui.mcpForm.reset();
  ui.mcpDefinitionId.value = server?.id ?? '';
  ui.mcpDialogTitle.textContent = server ? `Edit ${server.name}` : 'New MCP server';
  ui.mcpName.value = server?.name ?? '';
  ui.mcpTransport.value = server?.transport ?? 'http';
  ui.mcpUrl.value = server?.url ?? '';
  ui.mcpCommand.value = server?.command ?? '';
  ui.mcpArgs.value = (server?.args ?? []).join('\n');
  ui.mcpHeaders.value = formatSettings(server?.headers, ': ');
  ui.mcpCwd.value = server?.cwd ?? '';
  ui.mcpEnvironment.value = formatSettings(server?.environment, '=');
  ui.mcpAdvanced.open = Boolean(
    Object.keys(server?.headers ?? {}).length
    || Object.keys(server?.environment ?? {}).length
    || server?.cwd
  );
  ui.mcpTimeout.value = String(Math.round((server?.timeoutMs ?? 30_000) / 1000));
  // Bindings come from the definition, and the rows are drawn from whatever
  // placeholders the definition actually contains.
  placeholderBindings = new Map(Object.entries(server?.placeholders ?? {}));
  renderPlaceholderRows();
  ui.mcpFormMessage.textContent = '';
  ui.mcpFormMessage.classList.add('hidden');
  ui.deleteMcpDefinition.classList.toggle('hidden', !server || !currentAgent);
  ui.saveMcp.textContent = currentAgent ? (server ? 'Save and apply' : 'Save and attach') : 'Save connector';
  syncMcpTransportFields();
  void prepareWorkshop(server);
  ui.mcpDialog.showModal();
}

function formatSettings(value, separator) {
  return Object.entries(value ?? {}).map(([name, setting]) => `${name}${separator}${setting}`).join('\n');
}

function parseSettings(value, separator, label) {
  const result = {};
  for (const [index, raw] of String(value ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0) throw new Error(`${label} line ${index + 1} must use ${separator === ':' ? 'Name: value' : 'NAME=value'}.`);
    const name = line.slice(0, at).trim();
    const setting = line.slice(at + separator.length).trim();
    if (!name || !setting) throw new Error(`${label} line ${index + 1} must have both a name and a value.`);
    if (Object.hasOwn(result, name)) throw new Error(`${label} contains ${name} more than once.`);
    result[name] = setting;
  }
  return result;
}

function mcpFormPayload() {
  const transport = ui.mcpTransport.value;
  renderPlaceholderRows();
  const found = placeholdersInForm();
  const unbound = [...found.keys()].filter((name) => !placeholderBindings.has(name));
  // The control plane refuses this too; saying it here names which one.
  if (unbound.length) {
    throw new Error(`Choose what fills ${unbound.join(', ')} before saving.`);
  }
  const placeholders = {};
  for (const [name, binding] of placeholderBindings) placeholders[name] = binding;
  return {
    name: ui.mcpName.value.trim(),
    transport,
    command: transport === 'stdio' ? ui.mcpCommand.value.trim() : null,
    args: transport === 'stdio' ? ui.mcpArgs.value.split('\n').map((value) => value.trim()).filter(Boolean) : [],
    cwd: transport === 'stdio' ? ui.mcpCwd.value.trim() || null : null,
    url: transport === 'http' ? ui.mcpUrl.value.trim() : null,
    environment: transport === 'stdio' ? parseSettings(ui.mcpEnvironment.value, '=', 'Environment') : {},
    headers: transport === 'http' ? parseSettings(ui.mcpHeaders.value, ':', 'Headers') : {},
    placeholders,
    timeoutMs: Number(ui.mcpTimeout.value) * 1000
  };
}

async function applyMcp() {
  ui.mcpMessage.textContent = 'Applying desired MCP state inside the worker…';
  try {
    await api(agentApi('mcp/apply'), { method: 'POST', body: '{}' });
    ui.mcpMessage.textContent = 'Applied. New tasks will use this configuration.';
  } catch (error) {
    ui.mcpMessage.textContent = error.message;
  } finally {
    await refreshMcp();
  }
}

// The workshop lives inside the connector dialog. A successful run fills in the
// form you were already looking at; a failed one leaves the exchange visible so
// you can correct it and ask again. Every ask after the first continues the same
// conversation, so "no, it uses a different endpoint" is a correction rather
// than a fresh start.
let workshopConversationId = null;
let workshopConversationAgentId = null;
let workshopRunning = false;
// Bumped every time the dialog is prepared. A stream carrying an older token is
// a run the operator has walked away from: it stops reading and writes nothing.
let workshopRunToken = 0;
let workshopAbort = null;
let workshopTurns = 0;
let workshopContinuity = true;

const WORKSHOP_LOG_LIMIT = 60;

// Every line says who produced it. The operator's own words were being styled
// with the class named for the model and rendered brighter than the model's
// output, which makes a transcript impossible to read honestly.
function workshopNote(speaker, text, kind, token) {
  // The token is required, not defaulted. Defaulting it to the current token
  // made this comparison always false, which is the whole point of the check.
  if (!text || token !== workshopRunToken) return;
  const line = document.createElement('p');
  line.className = [kind, speaker === 'you' ? 'from-operator' : 'from-harness'].filter(Boolean).join(' ');
  const who = document.createElement('span');
  who.className = 'speaker';
  who.textContent = speaker === 'you' ? 'you' : 'harness';
  line.append(who, document.createTextNode(text));
  ui.workshopLog.classList.remove('hidden');
  ui.workshopLog.append(line);
  // A runaway harness should not be able to grow the operator's tab until it dies.
  while (ui.workshopLog.childElementCount > WORKSHOP_LOG_LIMIT) ui.workshopLog.firstElementChild.remove();
  ui.workshopLog.scrollTop = ui.workshopLog.scrollHeight;
}

async function prepareWorkshop(server) {
  // Bump first, then capture, so the token this call owns is a fact rather than
  // a prediction about a later line.
  workshopRunToken += 1;
  const token = workshopRunToken;
  workshopAbort?.abort();
  workshopAbort = null;
  workshopConversationId = null;
  workshopConversationAgentId = null;
  workshopTurns = 0;
  workshopContinuity = true;
  workshopRunning = false;
  ui.workshopLog.replaceChildren();
  ui.workshopLog.classList.add('hidden');
  ui.workshopStatus.textContent = '';
  ui.workshopObjective.value = '';
  // A run that threw outside the try used to leave this disabled for the life of
  // the page, so the button silently did nothing ever again.
  ui.workshopRun.disabled = false;
  // Only offered when defining something new — editing a known shape is a
  // deliberate act, not a question — and hidden until the harness list is known,
  // because it used to appear at once with "No agents available" as its only
  // option and then either fill in or vanish.
  ui.workshop.classList.add('hidden');
  if (server) return;
  try {
    const { agents } = await api(`${API_ROOT}/agents`);
    // The dialog may have been closed and reopened for something else while
    // this was in flight.
    if (token !== workshopRunToken) return;
    const usable = (agents ?? []).filter((agent) => agent.runtime);
    ui.workshopAgent.replaceChildren();
    if (!usable.length) {
      ui.workshop.classList.add('hidden');
      return;
    }
    for (const agent of usable) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name ?? agent.id;
      ui.workshopAgent.append(option);
    }
    // Only when that agent is in the list; otherwise this blanks the picker.
    if (currentAgent && usable.some((agent) => agent.id === currentAgent.id)) {
      ui.workshopAgent.value = currentAgent.id;
    }
    ui.workshop.classList.remove('hidden');
  } catch {
    // The dialog still works as a plain form.
    ui.workshop.classList.add('hidden');
  }
}

function applyProposalToForm(proposal) {
  ui.mcpName.value = proposal.name ?? '';
  ui.mcpTransport.value = proposal.transport;
  syncMcpTransportFields();
  ui.mcpUrl.value = proposal.url ?? '';
  ui.mcpCommand.value = proposal.command ?? '';
  ui.mcpArgs.value = (proposal.args ?? []).join('\n');
  ui.mcpHeaders.value = formatSettings(proposal.headers, ': ');
  ui.mcpCwd.value = proposal.cwd ?? '';
  ui.mcpEnvironment.value = formatSettings(proposal.environment, '=');
  ui.mcpAdvanced.open = Boolean(
    Object.keys(proposal.headers ?? {}).length
    || Object.keys(proposal.environment ?? {}).length
    || proposal.cwd
  );
  ui.mcpTimeout.value = String(Math.round((proposal.timeoutMs ?? 30_000) / 1000));
  // A proposal describes the shape; what fills a placeholder is the operator's
  // to choose, so the rows appear unbound and the connector cannot be saved
  // until they are answered.
  placeholderBindings = new Map();
  renderPlaceholderRows();
}

async function runWorkshop() {
  if (workshopRunning) return;
  const agentId = ui.workshopAgent.value;
  const objective = ui.workshopObjective.value.trim();
  if (!agentId || !objective) {
    ui.workshopStatus.textContent = 'Choose a harness and describe the connector.';
    return;
  }
  workshopRunning = true;
  ui.workshopRun.disabled = true;
  ui.workshopStatus.textContent = 'Asking…';

  const token = workshopRunToken;
  const mine = () => token === workshopRunToken;
  workshopNote('you', objective, '', token);
  workshopAbort?.abort();
  const abort = new AbortController();
  workshopAbort = abort;

  try {
    // Continuity has to start at the first ask, or a correction reaches a harness
    // that never saw the objective. The conversation is keyed to the agent that
    // answered, because switching harnesses mid-exchange would send a bare
    // correction to one with no context.
    const sameAgent = workshopConversationAgentId === agentId;
    if (!sameAgent) {
      workshopConversationId = `workshop-${workshopId()}`;
      workshopConversationAgentId = agentId;
      workshopContinuity = true;
      // Without this the new harness inherits the old one's turn count and the
      // next ask is sent as a correction into a conversation it never saw.
      workshopTurns = 0;
    }
    const continuing = sameAgent && workshopTurns > 0 && workshopContinuity;
    const prompt = continuing ? objective : buildMcpWorkshopPrompt(objective);

    let response = await workshopDispatch(agentId, prompt, workshopContinuity ? workshopConversationId : null, abort);
    // An un-refreshed runtime cannot continue a conversation and says so with a
    // 409. Losing follow-up corrections is worth far more than losing the
    // feature, so ask again without one and tell the operator what they lost.
    if ((response.status === 409 || response.status === 502) && workshopContinuity) {
      const failure = await response.clone().json().catch(() => ({}));
      if (!mine()) return;
      if (/continue a conversation/i.test(failure.error ?? '')) {
        workshopContinuity = false;
        workshopNote('harness', 'This runtime cannot carry a conversation, so each ask starts fresh. Refresh it onto the current image to correct by conversation.', 'warn', token);
        response = await workshopDispatch(agentId, buildMcpWorkshopPrompt(objective), null, abort);
      }
    }
    if (!response.ok || !response.body) {
      const failure = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(failure.error ?? `HTTP ${response.status}`);
    }

    const runState = createWorkshopRunState();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    while (true) {
      const { done, value } = await reader.read();
      if (!mine()) return;
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        observeWorkshopRunEvent(runState, event);
        if (event.type === 'message.completed' && event.data?.text) {
          output += `${event.data.text}\n`;
          workshopNote('harness', event.data.text, '', token);
        }
        if (event.type === 'activity.started' && event.data?.name) {
          ui.workshopStatus.textContent = `Working — ${event.data.name}`;
        }
        // Advisory while the run continues: a harness probing an endpoint reports
        // a 401 or a 404 as an error and then carries on. Only the outcome decides
        // whether this run failed.
        if (event.type === 'error' && event.data?.message) workshopNote('harness', event.data.message, 'warn', token);
      }
      if (done) {
        if (!buffer.trim()) break;
        try {
          const event = JSON.parse(buffer);
          observeWorkshopRunEvent(runState, event);
          if (event.type === 'message.completed' && event.data?.text) {
            output += `${event.data.text}\n`;
            workshopNote('harness', event.data.text, '', token);
          }
          if (event.type === 'error' && event.data?.message) {
            workshopNote('harness', event.data.message, 'warn', token);
          }
        } catch { /* a partial final line is not an event */ }
        break;
      }
    }

    // Only a run that started, ended on its own task, and reported success may
    // put anything in the form. Without this a harness could emit a proposal and
    // then fail, and the operator would be shown a filled form and told to review
    // it as though the run had worked.
    if (!mine()) return;
    requireSuccessfulWorkshopRun(runState);
    const { proposal, warnings } = extractMcpWorkshopProposal(output);
    applyProposalToForm(proposal);
    for (const warning of warnings) workshopNote('harness', warning, 'warn', token);

    workshopTurns += 1;

    // A proposal is model-generated, so ask the harness's own adapter whether the
    // shape is valid for it rather than implying the operator is reviewing
    // something checked. This proves payload and adapter policy compatibility —
    // not that the connector works, and not that its credentials are right.
    //
    // But a proposal that needs a secret arrives with its placeholders unbound,
    // on purpose, and the control plane refuses to normalize a definition with an
    // unbound placeholder. Validating now would therefore fail every time and
    // report it as though the shape were wrong, which is what a live harness
    // proposing ${GITHUB_TOKEN} actually produced.
    const pending = [...placeholdersInForm().keys()].filter((name) => !placeholderBindings.has(name));
    if (pending.length) {
      if (mine()) {
        ui.workshopStatus.textContent = `Filled in below. Choose what fills ${pending.join(', ')}; the shape is checked when you save.`;
      }
      return;
    }
    ui.workshopStatus.textContent = 'Checking the proposal against this harness…';
    const checked = await checkProposal(agentId, proposal, token, abort.signal);
    if (mine()) ui.workshopStatus.textContent = checked;
  } catch (error) {
    if (!mine() || error.name === 'AbortError') return;
    // Not fatal: the exchange stays open so the next ask is a correction.
    workshopNote('harness', error.message, 'failed', token);
    ui.workshopStatus.textContent = 'Nothing was filled in. Tell it what was wrong and ask again.';
  } finally {
    if (mine()) {
      workshopRunning = false;
      ui.workshopRun.disabled = false;
      ui.workshopObjective.value = '';
      workshopAbort = null;
    }
  }
}

// crypto.randomUUID is secure-context only, and this page is reachable over plain
// http on a LAN address. Falling back keeps the feature working there instead of
// throwing inside the click handler.
function workshopId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues ?? ((array) => array.forEach((_, index) => { array[index] = Math.floor(Math.random() * 256); })))(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function workshopDispatch(agentId, prompt, conversationId, abort) {
  const body = conversationId ? { prompt, conversationId } : { prompt };
  return fetch(`${API_ROOT}/agents/${encodeURIComponent(agentId)}/tasks`, {
    method: 'POST',
    // Same headers api() would send. This reads the stream itself rather than
    // going through api(), which must not mean losing the CSRF header: without
    // it an OIDC session refuses the request outright.
    headers: { 'content-type': 'application/json', 'x-agent-dock-csrf': '1' },
    body: JSON.stringify(body),
    signal: abort.signal
  });
}

async function checkProposal(agentId, proposal, token, signal) {
  try {
    const result = await api(`${API_ROOT}/agents/${encodeURIComponent(agentId)}/mcp/validate`, {
      method: 'POST',
      body: JSON.stringify({ server: proposal }),
      signal
    });
    const warnings = result.mcp?.validation?.warnings ?? [];
    for (const warning of warnings) workshopNote('harness', warning.message ?? String(warning), 'warn', token);
    return `Filled in below. Valid for this harness${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''} — that checks the shape, not that the connector works. Review before saving.`;
  } catch (error) {
    workshopNote('harness', error.message, 'warn', token);
    // Only a 400 is the adapter judging the shape. A duplicate name, an unknown
    // agent, or an unreachable worker are the control plane's own answers and
    // never reach the harness at all, so they must not be reported as its verdict.
    return error.status === 400
      ? 'Filled in below, but this harness rejected the shape. Review and correct before saving.'
      : 'Filled in below. The compatibility check could not be completed, so nothing about the shape was confirmed.';
  }
}

async function saveMcpDefinition(event) {
  event.preventDefault();
  ui.saveMcp.disabled = true;
  ui.mcpFormMessage.classList.add('hidden');
  try {
    const payload = mcpFormPayload();
    const id = ui.mcpDefinitionId.value;
    const result = await api(id ? `${API_ROOT}/mcp/servers/${encodeURIComponent(id)}` : `${API_ROOT}/mcp/servers`, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    const server = result.server;
    // The same dialog serves two places. On an agent it also attaches and
    // applies, because that is what the operator came to do; on the MCP page
    // there is no agent to attach to, so it only defines the connector.
    if (!currentAgent) {
      ui.mcpDialog.close();
      await loadRegistry();
      return;
    }
    if (!id) {
      await api(agentApi('mcp/bindings'), {
        method: 'POST',
        body: JSON.stringify({ serverId: server.id, apply: false })
      });
    }
    ui.mcpDialog.close();
    await refreshMcp();
    await applyMcp();
  } catch (error) {
    ui.mcpFormMessage.textContent = error.message;
    ui.mcpFormMessage.classList.remove('hidden');
  } finally {
    ui.saveMcp.disabled = false;
  }
}

async function attachExistingMcp() {
  const serverId = ui.mcpLibrary.value;
  if (!serverId) return;
  ui.mcpMessage.textContent = 'Attaching definition…';
  try {
    await api(agentApi('mcp/bindings'), { method: 'POST', body: JSON.stringify({ serverId, apply: false }) });
    await applyMcp();
  } catch (error) {
    ui.mcpMessage.textContent = error.message;
    await refreshMcp();
  }
}

async function validateMcp(serverId) {
  ui.mcpMessage.textContent = 'Validating against this worker harness and command policy…';
  try {
    const result = await api(agentApi('mcp/validate'), { method: 'POST', body: JSON.stringify({ serverId }) });
    const warnings = result.mcp?.validation?.warnings ?? [];
    const detail = warnings.map((warning) => warning.message ?? String(warning)).join(' · ');
    ui.mcpMessage.textContent = `Valid for ${adapterLabel(currentAgent.adapter)}${detail ? `. Warning: ${detail}` : '.'}`;
  } catch (error) {
    ui.mcpMessage.textContent = error.message;
  }
}

async function detachMcp(server) {
  if (!window.confirm(`Detach ${server.name} from ${currentAgent.name}?`)) return;
  ui.mcpMessage.textContent = `Detaching ${server.name}…`;
  try {
    await api(agentApi(`mcp/bindings/${encodeURIComponent(server.id)}`), { method: 'DELETE' });
    ui.mcpMessage.textContent = `${server.name} detached and desired state reapplied.`;
  } catch (error) {
    ui.mcpMessage.textContent = error.message;
  } finally {
    await refreshMcp();
  }
}

async function deleteMcpDefinition() {
  const serverId = ui.mcpDefinitionId.value;
  const server = mcpDefinitions.find((item) => item.id === serverId);
  if (!server || !window.confirm(`Delete the reusable MCP definition ${server.name}? It must not be attached to another agent.`)) return;
  try {
    const attachedHere = mcpBindings.some((binding) => binding.serverId === serverId);
    if (attachedHere && currentAgent) await api(agentApi(`mcp/bindings/${encodeURIComponent(serverId)}`), { method: 'DELETE' });
    await api(`${API_ROOT}/mcp/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
    ui.mcpDialog.close();
    ui.mcpMessage.textContent = `${server.name} deleted.`;
    await refreshMcp();
  } catch (error) {
    ui.mcpFormMessage.textContent = error.message;
    ui.mcpFormMessage.classList.remove('hidden');
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

// Replaces the runtime's container with one built from the current image. The
// four private volumes are retained, so the agent does not have to authenticate
// again — that is the whole reason this exists rather than delete-and-recreate.
async function refreshRuntimeImage() {
  if (!currentAgent?.runtime?.managed) return;
  const confirmed = window.confirm(
    "Replace this runtime's container with one built from the current image?\n\n"
    + 'Its CLI, credentials, telemetry, and workspace volumes are kept, so the agent stays signed in. '
    + 'The runtime restarts and is briefly unavailable.'
  );
  if (!confirmed || runtimeRefreshInFlight) return;
  runtimeRefreshInFlight = true;
  ui.refreshRuntime.disabled = true;
  ui.refreshRuntime.textContent = 'Refreshing…';
  ui.runtimeDrift.disabled = true;
  ui.runtimeDrift.textContent = 'refreshing…';
  try {
    const result = await api(agentApi('runtime/refresh'), { method: 'POST' });
    currentAgent.runtime = result.runtime;
    setConnection('online', `Runtime refreshed onto ${result.runtime.image || 'the current image'}`);
    await loadRuntimeDrift();
    await refreshStatus();
  } catch (error) {
    setConnection('offline', error.message);
  } finally {
    runtimeRefreshInFlight = false;
    ui.refreshRuntime.disabled = false;
    renderRuntimeDrift();
  }
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

function renderQuotaRow(label, window, stale = false) {
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
  if (stale) row.classList.add('stale');
  const reset = document.createElement('small');
  reset.className = 'quota-reset';
  const resetDate = window?.resetsAt ? new Date(Number(window.resetsAt) * 1000) : null;
  const formattedDuration = formatQuotaDuration(window?.windowDurationMinutes);
  const duration = formattedDuration ? `${formattedDuration} window` : 'quota window';
  reset.textContent = stale ? 'last known reading' : resetDate ? quotaRefreshLabel(window.resetsAt) : duration;
  row.append(name, bar, value, reset);
  return row;
}

// Why a window is missing, worst case first. An adapter that does not expose
// quota windows is a different situation from a source that failed, and both are
// different from 0% used — the UI must never let them look alike.
const POLL_ERROR_COPY = {
  unauthenticated: 'Sign in again — the provider rejected the worker credential.',
  throttled: 'The provider is rate limiting usage polling.',
  network: 'The usage source is unreachable.',
  http: 'The usage source returned an error.',
  malformed: 'The usage source returned an unrecognized response.',
  provider: 'The harness reported a usage error.'
};

function quotaUnavailableReason(usage = {}) {
  const kind = usage.pollErrorKind;
  if (kind && POLL_ERROR_COPY[kind]) return POLL_ERROR_COPY[kind];
  if (kind) return 'The usage source is unavailable.';
  if (!currentUsageCapability.quotaWindows) return `${currentHarnessName} does not expose subscription quota windows.`;
  if (!usage.lastPollAt) return 'Quota windows have not been polled yet.';
  return 'No quota window reported.';
}

function renderRuntimeQuota(scope, window, fallbackLabel, unavailableReason = '', stale = false) {
  const used = window ? Math.max(0, Math.min(100, Number(window.usedPercent ?? 0))) : 0;
  const label = ui[`${scope}QuotaLabel`];
  const summary = ui[`${scope}QuotaSummary`];
  const bar = ui[`${scope}QuotaBar`];
  const reset = ui[`${scope}QuotaReset`];
  label.textContent = quotaWindowLabel(window, fallbackLabel);
  summary.textContent = window ? `${used.toFixed(0)}% used${stale ? ' · stale' : ''}` : 'Unavailable';
  bar.style.width = window ? `${used}%` : '0%';
  bar.className = quotaFillClass(used);
  // An empty bar reads as "0% used". Mark the track so unavailable looks unavailable.
  bar.parentElement?.classList.toggle('unavailable', !window);
  // A retained window from before a failed poll is not a current reading, and its
  // reset countdown is no longer trustworthy either.
  bar.parentElement?.classList.toggle('stale', Boolean(window) && stale);
  reset.textContent = !window
    ? unavailableReason
    : stale
      ? `Last known reading · ${unavailableReason}`
      : (quotaRefreshLabel(window.resetsAt) || 'Refresh time unavailable');
}

// Waiting on the floor after a clean read means the numbers are current; waiting
// after a failure does not, and must not read as if it did.
function waitingLabel(pollErrorKind, throttled) {
  if (throttled || pollErrorKind === 'throttled') return 'Rate limited';
  if (pollErrorKind) return 'Retrying';
  return 'Up to date';
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
  const waitingUntil = usage.nextAttemptAt ? Date.parse(usage.nextAttemptAt) : 0;
  const waiting = waitingUntil > Date.now();
  const throttled = usage.nextAttemptReason === 'provider-backoff';
  ui.usagePolledAt.textContent = waiting
    ? `${throttled ? 'rate limited by provider' : 'next read'} ${timeUntil(usage.nextAttemptAt)}`
    : usage.pollErrorKind && usage.lastSuccessAt
      ? `last good reading ${relativeTime(usage.lastSuccessAt)}`
      : usage.lastPollAt ? `polled ${relativeTime(usage.lastPollAt)}` : 'Not polled';
  usageBackingOff = waiting;
  usageThrottled = throttled;
  if (waiting) {
    ui.refreshUsage.disabled = true;
    ui.refreshUsage.textContent = waitingLabel(usage.pollErrorKind, throttled);
  }
  ui.usageError.textContent = usage.pollError || '';
  ui.usageError.classList.toggle('hidden', !usage.pollError);
  const windows = Array.isArray(usage.quotaWindows) ? usage.quotaWindows : [];
  const reason = quotaUnavailableReason(usage);
  const stale = Boolean(usage.pollErrorKind);
  const primary = windows.find((window) => window.scope === 'primary') ?? windows[0];
  const secondary = windows.find((window) => window.scope === 'secondary') ?? windows[1];
  renderRuntimeQuota('primary', primary, 'Quota window', reason, stale);
  renderRuntimeQuota('secondary', secondary, 'Additional window', reason, stale);
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
  for (const window of windows) ui.quotaWindows.append(renderQuotaRow(window.label ?? quotaWindowLabel(window), window, stale));
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
  const runtimeImage = currentAgent.runtime?.image;
  ui.runtimeLocation.textContent = inContainer
    ? `${runtimeLabel(currentAgent.runtime)} · ${currentAgent.runtime?.workerId || 'worker identity unavailable'}${runtimeImage ? ` · ${runtimeImage}` : ''}`
    : 'Worker-managed provider sandbox';
  // Only a managed runtime has a container of ours to replace, and never while
  // a task is running.
  if (!runtimeRefreshInFlight) ui.refreshRuntime.disabled = !currentAgent.runtime?.managed || active;
  renderRuntimeDrift();
  ui.runButton.disabled = !readyToRun || active;
  currentUsageCapability = {
    quotaWindows: Boolean(status.capabilities?.usage?.quotaWindows),
    accountActivity: Boolean(status.capabilities?.usage?.accountActivity),
    source: status.capabilities?.usage?.quotaWindowSource ?? null
  };
  const canRefreshAccountUsage = Boolean(status.capabilities?.usage?.quotaWindows || status.capabilities?.usage?.accountActivity);
  const nextAttempt = status.usage?.nextAttemptAt ? Date.parse(status.usage.nextAttemptAt) : 0;
  usageBackingOff = nextAttempt > Date.now();
  usageThrottled = status.usage?.nextAttemptReason === 'provider-backoff';
  ui.refreshUsage.disabled = !authenticated || !canRefreshAccountUsage || usageBackingOff;
  ui.refreshUsage.textContent = !canRefreshAccountUsage
    ? 'Not available'
    : !usageBackingOff ? 'Refresh'
      : waitingLabel(status.usage?.pollErrorKind, usageThrottled);
  // The harness's own auth check and the provider can disagree: a token the CLI
  // still considers present can be rejected upstream. When that happens the UI
  // asks the operator to sign in again, so the control has to allow it.
  const credentialRejected = status.usage?.pollErrorKind === 'unauthenticated';
  ui.authBox.classList.toggle('authenticated', authenticated && !credentialRejected);
  ui.authTitle.textContent = authenticated ? `${currentHarnessName} session` : `Connect ${currentHarnessName}`;
  const browserOAuth = status.authentication?.method === 'browser_oauth';
  ui.authCopy.textContent = credentialRejected
    ? `${currentHarnessName} still reports a stored login, but the provider rejected it. Usage telemetry is stale until you sign in again; the agent may also fail to run tasks.`
    : authenticated
    ? `The worker holds a CLI-managed ${currentHarnessName} login. Safe session metadata is surfaced; credentials never leave the worker.`
    : browserOAuth
      ? `The worker starts ${currentHarnessName}'s browser OAuth flow. Agent Dock forwards only the provider's one-time completion code and never stores it.`
      : `The worker starts ${currentHarnessName}'s device flow. This UI displays only the sign-in URL and one-time code.`;
  const waiting = status.authentication?.phase === 'waiting_for_user';
  ui.authButton.textContent = waiting
    ? 'Waiting for sign-in'
    : credentialRejected
      ? 'Sign in again'
      : authenticated
        ? 'Connected'
        : status.authentication?.method === 'browser_oauth' ? 'Start browser login' : 'Start device login';
  ui.authButton.disabled = waiting || (authenticated && !credentialRejected);
  ui.authBox.classList.toggle('rejected', credentialRejected);
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

async function refreshAgentLive() {
  await loadRuntimeDrift({ maxAgeMs: DRIFT_RESYNC_MS });
  await refreshStatus();
  if (location.hash === '#tools') await refreshMcp();
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
    ui.refreshUsage.disabled = usageBackingOff;
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
  if (event.type === 'task.started' && event.taskId) activeWorkerTaskId = event.taskId;
  if (event.type === 'task.completed' && event.taskId === activeWorkerTaskId) activeWorkerTaskId = null;
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
    activeWorkerTaskId = null;
    ui.cancelButton.classList.add('hidden');
    await Promise.all([refreshStatus(), refreshWorkspace(), refreshProviders(), refreshMcp()]);
  }
}

async function cancelRun() {
  ui.cancelButton.disabled = true;
  try {
    if (!activeWorkerTaskId) throw new Error('The worker has not reported a cancellable task yet');
    await api(agentApi('tasks/cancel'), { method: 'POST', body: JSON.stringify({ taskId: activeWorkerTaskId }) });
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
  ui.jobsView.classList.add('hidden');
  try {
    const [result] = await Promise.all([api(`${API_ROOT}/agents/${encodeURIComponent(id)}`), loadRuntimeDrift()]);
    currentAgent = result.agent;
    populateAgentConfig(currentAgent);
    document.title = `${currentAgent.name} — Agent Dock`;
    selectTab(location.hash.slice(1), { updateHash: false });
    await Promise.all([refreshStatus(), refreshWorkspace(), refreshProviders(), refreshMcp()]);
    startLiveUpdates(refreshAgentLive);
  } catch (error) {
    setConnection('offline', error.message);
    ui.pageAgentName.textContent = 'Agent unavailable';
    ui.pageAgentDescription.textContent = error.message;
  }
}

ui.createForm.addEventListener('submit', createAgent);
ui.jobForm.addEventListener('submit', saveJob);
for (const radio of ui.jobForm.querySelectorAll('[name="jobTiming"]')) radio.addEventListener('change', syncJobTimingFields);
ui.jobFrequency.addEventListener('change', syncJobRecurrenceFields);
ui.jobRunAt.addEventListener('input', updateJobScheduleSummary);
for (const control of [ui.jobRepeatTime, ui.jobWeekday, ui.jobMonthDay, ui.jobHourMinute, ui.jobTimezone]) {
  control.addEventListener('input', updateJobScheduleSummary);
  control.addEventListener('change', updateJobScheduleSummary);
}
$('#new-job').addEventListener('click', () => openJobDialog());
$('#empty-new-job').addEventListener('click', () => openJobDialog());
$('#close-job-dialog').addEventListener('click', () => ui.jobDialog.close());
$('#cancel-job').addEventListener('click', () => ui.jobDialog.close());
ui.deleteJob.addEventListener('click', () => deleteJob());
ui.jobGrid.addEventListener('click', handleJobAction);
for (const radio of ui.createAdapterRadios) radio.addEventListener('change', syncCreateRuntimeOptions);
for (const radio of $$('[name="runtimeMode"]')) radio.addEventListener('change', syncCreateRuntimeOptions);
$('#new-agent').addEventListener('click', openCreateDialog);
$('#empty-new-agent').addEventListener('click', openCreateDialog);
$('#close-agent-dialog').addEventListener('click', () => ui.createDialog.close());
$('#cancel-create').addEventListener('click', () => ui.createDialog.close());
ui.configForm.addEventListener('submit', saveAgent);
ui.mcpForm.addEventListener('submit', saveMcpDefinition);
ui.mcpTransport.addEventListener('change', syncMcpTransportFields);
$('#new-mcp').addEventListener('click', () => openMcpDialog());
$('#attach-mcp').addEventListener('click', attachExistingMcp);
$('#apply-mcp').addEventListener('click', applyMcp);
$('#close-mcp-dialog').addEventListener('click', () => ui.mcpDialog.close());
$('#cancel-mcp').addEventListener('click', () => ui.mcpDialog.close());
// Closing the dialog abandons any run it started, however it was closed —
// button, Escape, or form submit. Otherwise the stream keeps going and writes
// into whatever the dialog is showing next.
ui.mcpDialog.addEventListener('close', () => {
  workshopRunToken += 1;
  workshopAbort?.abort();
  workshopAbort = null;
  workshopRunning = false;
  ui.workshopRun.disabled = false;
});
ui.deleteMcpDefinition.addEventListener('click', deleteMcpDefinition);
ui.modelSelect.addEventListener('change', () => {
  ui.saveMessage.textContent = 'Unsaved model policy';
});
$('#delete-agent').addEventListener('click', deleteCurrentAgent);
ui.refreshRuntime.addEventListener('click', refreshRuntimeImage);
ui.runtimeDrift.addEventListener('click', refreshRuntimeImage);
ui.authButton.addEventListener('click', startAuth);
ui.authCompleteForm.addEventListener('submit', completeAuthentication);
ui.runButton.addEventListener('click', runTask);
ui.cancelButton.addEventListener('click', cancelRun);
ui.refreshUsage.addEventListener('click', refreshUsage);
ui.refreshAuth.addEventListener('click', refreshAuthentication);
ui.signOut.addEventListener('click', signOut);
ui.accessPolicyButton.addEventListener('click', () => ui.accessPolicyDialog.showModal());
$('#close-access-policy').addEventListener('click', () => ui.accessPolicyDialog.close());
$('#dismiss-access-policy').addEventListener('click', () => ui.accessPolicyDialog.close());
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

let storedCredentials = [];
let registryServers = [];
let credentialsLoaded = false;

function credentialRow(credential) {
  const row = document.createElement('article');
  row.className = 'credential-row';
  row.dataset.credentialId = credential.id;
  row.innerHTML = `
    <div><strong></strong><small></small></div>
    <div class="credential-hint"></div>
    <div class="credential-hosts"></div>
    <div class="credential-actions">
      <button class="text-button credential-edit" type="button">Edit</button>
      <button class="text-button danger-text credential-delete" type="button">Delete</button>
    </div>`;
  row.querySelector('strong').textContent = credential.name;
  row.querySelector('small').textContent = credential.type;
  // A key created by writing a placeholder has no value yet. Saying so on the
  // row is the whole point of letting it exist in that state.
  const hint = row.querySelector('.credential-hint');
  if (credential.complete) {
    hint.textContent = credential.hint ?? '…';
  } else {
    row.classList.add('incomplete');
    hint.className = 'credential-needs-value';
    hint.textContent = 'needs a value';
  }
  const hosts = credential.hosts ?? [];
  const hostList = row.querySelector('.credential-hosts');
  // An empty list is not a blank cell: it means this key is not limited.
  hostList.textContent = hosts.length ? hosts.join(', ') : 'any host';
  hostList.title = hosts.length ? hosts.join('\n') : 'This key is not limited to any host.';
  row.querySelector('.credential-edit').addEventListener('click', () => openCredentialDialog(credential));
  row.querySelector('.credential-delete').addEventListener('click', () => deleteCredential(credential));
  return row;
}

function renderCredentials() {
  ui.credentialList.replaceChildren();
  if (!storedCredentials.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No credentials yet. Add one, then choose it on a connector instead of naming an environment variable.';
    ui.credentialList.append(empty);
    return;
  }
  for (const credential of storedCredentials) ui.credentialList.append(credentialRow(credential));
}

function renderCredentialStorage(storage = {}) {
  const available = storage.available !== false;
  ui.credentialStorage.textContent = available ? `storage: ${storage.name ?? 'unknown'}` : 'storage unavailable';
  ui.credentialStorage.className = `pill ${available ? 'neutral' : 'error'}`;
  ui.newCredential.disabled = !available;
  // Whichever mode is in force, say what it actually protects rather than
  // letting "encrypted at rest" imply more than it does.
  ui.credentialStorageDetail.textContent = available
    ? `Values are encrypted at rest, and with the ${storage.name} key provider that protects ${storage.protects}. Anyone able to read this host can read them.`
    : 'Set CREDENTIAL_ENCRYPTION_KEY to 32 base64 bytes where the control plane runs. A key is not generated automatically, because one written beside the data it protects would imply protection that does not exist.';
  ui.credentialStorageNote.classList.remove('hidden');
}

// Connectors and the keys they authenticate with are one page, because a stored
// key exists only to be used by a connector.
async function loadMcpPage() {
  ui.mcpView.classList.remove('hidden');
  ui.dashboardView.classList.add('hidden');
  ui.agentView.classList.add('hidden');
  ui.jobsView.classList.add('hidden');
  document.title = 'MCP — Agent Dock';
  await Promise.all([loadRegistry(), loadCredentials()]);
}

async function loadRegistry() {
  try {
    const { servers } = await api(`${API_ROOT}/mcp/servers`);
    registryServers = servers ?? [];
    ui.registryMessage.textContent = '';
    renderRegistry();
    ui.registryCount.textContent = `${registryServers.length} defined`;
    setConnection('online', 'Control plane online');
  } catch (error) {
    ui.registryMessage.textContent = error.message;
    ui.registryList.innerHTML = '<p class="usage-error">Could not load connectors.</p>';
    setConnection('offline', error.message);
  }
}

function renderRegistry() {
  ui.registryList.replaceChildren();
  if (!registryServers.length) {
    ui.registryList.innerHTML = '<p class="empty">No connectors yet. Add one, then attach it from an agent.</p>';
    return;
  }
  for (const server of registryServers) {
    const row = document.createElement('article');
    row.className = 'mcp-row';
    row.dataset.serverId = server.id;

    const heading = document.createElement('div');
    heading.className = 'mcp-row-heading';
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = server.name;
    const kind = document.createElement('small');
    kind.textContent = server.transport === 'http' ? 'remote HTTP' : 'local stdio process';
    identity.append(name, kind);
    heading.append(identity);

    const endpoint = document.createElement('code');
    endpoint.className = 'mcp-endpoint';
    endpoint.textContent = mcpEndpoint(server);

    const meta = document.createElement('p');
    meta.className = 'mcp-meta';
    meta.textContent = registryMeta(server);

    const actions = document.createElement('div');
    actions.className = 'mcp-row-actions';
    const edit = document.createElement('button');
    edit.className = 'text-button';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openMcpDialog(server));
    const remove = document.createElement('button');
    remove.className = 'text-button danger';
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteRegistryServer(server));
    actions.append(edit, remove);

    row.append(heading, endpoint, meta, actions);
    ui.registryList.append(row);
  }
}

function registryMeta(server) {
  const bound = Object.entries(server.placeholders ?? {});
  if (bound.length) {
    return bound.map(([name, binding]) => {
      if (binding.source === 'credential') {
        const credential = storedCredentials.find((item) => item.id === binding.credentialId);
        if (credential) return `${name} ← stored key ${credential.name}`;
        return credentialsLoaded ? `${name} ← a key that is no longer stored` : `${name} ← checking`;
      }
      return `${name} ← ${CONNECTOR_SECRET_PREFIX}${binding.name} in the container`;
    }).join(' · ');
  }
  return `Timeout ${Math.round(server.timeoutMs / 1000)}s · no credential references`;
}

async function deleteRegistryServer(server) {
  if (!window.confirm(`Delete ${server.name}? It must be detached from every agent first.`)) return;
  try {
    await api(`${API_ROOT}/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
    ui.registryMessage.textContent = '';
    await loadRegistry();
  } catch (error) {
    // Beside the list being acted on, not in the topbar status.
    ui.registryMessage.textContent = error.message;
  }
}

async function loadCredentials() {
  try {
    const result = await api(`${API_ROOT}/credentials`);
    storedCredentials = result.credentials ?? [];
    credentialsLoaded = true;
    ui.credentialListMessage.textContent = '';
    renderCredentialStorage(result.storage ?? {});
    renderCredentials();
    ui.credentialsRefreshed.textContent = `${storedCredentials.length} stored`;
    // A connector row names the key it uses, so it has to re-render once the
    // keys are known.
    if (registryServers.length) renderRegistry();
  } catch (error) {
    ui.credentialListMessage.textContent = error.message;
    ui.credentialList.innerHTML = '<p class="usage-error">Could not load credentials.</p>';
  }
}

function openCredentialDialog(credential = null) {
  ui.credentialForm.reset();
  ui.credentialMessage.classList.add('hidden');
  ui.credentialId.value = credential?.id ?? '';
  ui.credentialDialogTitle.textContent = credential ? `Edit ${credential.name}` : 'New credential';
  ui.credentialName.value = credential?.name ?? '';
  ui.credentialHosts.value = (credential?.hosts ?? []).join('\n');
  // Editing cannot show the value, so the field means "replace it" rather than
  // "here is what it is".
  const incomplete = credential && !credential.complete;
  ui.credentialValue.required = !credential || incomplete;
  ui.credentialValueHint.textContent = !credential
    ? 'pasted once, never shown again'
    : incomplete
      ? 'this key has no value yet — paste it to finish setting it up'
      : `currently ${credential.hint} — leave blank to keep it, required if you change the hosts`;
  ui.credentialDialog.showModal();
}

async function saveCredential(event) {
  event.preventDefault();
  const id = ui.credentialId.value;
  const hosts = ui.credentialHosts.value.split('\n').map((line) => line.trim()).filter(Boolean);
  const body = {
    name: ui.credentialName.value.trim(),
    type: 'api-key',
    hosts
  };
  if (ui.credentialValue.value) body.value = ui.credentialValue.value;
  try {
    if (id) await api(`${API_ROOT}/credentials/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await api(`${API_ROOT}/credentials`, { method: 'POST', body: JSON.stringify(body) });
    ui.credentialDialog.close();
    ui.credentialValue.value = '';
    await loadCredentials();
    if (registryServers.length) renderRegistry();
  } catch (error) {
    ui.credentialMessage.textContent = error.message;
    ui.credentialMessage.classList.remove('hidden');
  }
}

async function deleteCredential(credential) {
  if (!window.confirm(`Delete ${credential.name}? Any connector still using it must be changed first.`)) return;
  try {
    await api(`${API_ROOT}/credentials/${encodeURIComponent(credential.id)}?confirmation=${encodeURIComponent(credential.name)}`, { method: 'DELETE' });
    ui.credentialListMessage.textContent = '';
    await loadCredentials();
  } catch (error) {
    // Next to the credential being deleted. This used to overwrite the topbar
    // connection status, which reads as the control plane having gone offline.
    ui.credentialListMessage.textContent = error.message;
  }
}

ui.mcpArgs.addEventListener('input', renderPlaceholderRows);
ui.mcpUrl.addEventListener('input', renderPlaceholderRows);
ui.mcpHeaders.addEventListener('input', renderPlaceholderRows);
ui.mcpCwd.addEventListener('input', renderPlaceholderRows);
ui.mcpEnvironment.addEventListener('input', renderPlaceholderRows);
ui.workshopRun?.addEventListener('click', runWorkshop);
ui.newRegistryMcp?.addEventListener('click', () => openMcpDialog());
ui.newCredential.addEventListener('click', () => openCredentialDialog());
ui.credentialForm.addEventListener('submit', saveCredential);
ui.cancelCredential.addEventListener('click', () => ui.credentialDialog.close());
ui.closeCredentialDialog.addEventListener('click', () => ui.credentialDialog.close());

const agentRoute = window.location.pathname.match(/^\/agents\/([^/]+)\/?$/);
const jobsRoute = /^\/(?:jobs|schedules)\/?$/.test(window.location.pathname);
// Served at /connectors, not /mcp: the control plane's own MCP protocol endpoint
// owns /mcp and answers a browser GET with 503. /credentials stays an alias so
// existing links and bookmarks resolve, since credentials are now a section here
// rather than a page of their own.
const mcpRoute = /^\/(?:connectors|credentials)\/?$/.test(window.location.pathname);
void loadPlatformSession();
if (agentRoute) loadAgent(decodeURIComponent(agentRoute[1]));
else if (jobsRoute) loadJobs();
else if (mcpRoute) loadMcpPage();
else loadDashboard();
