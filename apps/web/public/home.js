// SPDX-License-Identifier: Apache-2.0
// Home: server status, the server drawer (overview, setup, settings), and room name helpers.

const $ = (sel) => document.querySelector(sel);
const tabs = [...document.querySelectorAll('#home-nav [role=tab]')];
const drawer = $('#server-drawer');
const NAME_KEY = 'mirrorName';
const API_KEY = 'mirrorApiKey';
const ADMIN_KEY = 'mirrorAdminKey';

/** Tab id -> hash segment under #server/. */
const ROUTES = { 'tab-dashboard': 'overview', 'tab-setup': 'setup', 'tab-settings': 'settings' };
const LEGACY_HASHES = { dashboard: 'overview', setup: 'setup', settings: 'settings' };

function icon(name, size = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${size}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function showPanel(id) {
  for (const tab of tabs) {
    const on = tab.id === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !on;
  }
  $('.drawer-content').scrollTop = 0;
  const hash = `#server/${ROUTES[id]}`;
  if (location.hash !== hash)
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  if (id === 'tab-dashboard') void refreshDashboard();
  if (id === 'tab-setup') void refreshSetup();
  if (id === 'tab-settings') void refreshSettings();
}

function tabFromHash() {
  const raw = location.hash.slice(1);
  const route = raw.startsWith('server/') ? raw.slice('server/'.length) : LEGACY_HASHES[raw];
  if (!route && raw !== 'server') return null;
  return Object.keys(ROUTES).find((id) => ROUTES[id] === route) ?? 'tab-dashboard';
}

function openDrawer(tabId = 'tab-dashboard') {
  if (!drawer.open) drawer.showModal();
  showPanel(tabId);
}

drawer.addEventListener('close', () => {
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  $('#open-server').focus();
});

drawer.addEventListener('click', (event) => {
  if (event.target === drawer) drawer.close();
});

$('#open-server').onclick = () => openDrawer();
$('#close-server').onclick = () => drawer.close();

$('#home-nav').addEventListener('click', (event) => {
  const tab = event.target.closest('[role=tab]');
  if (tab) showPanel(tab.id);
});

$('#home-nav').addEventListener('keydown', (event) => {
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  showPanel(next.id);
});

function authHeaders(storage, keyName) {
  const key = storage.getItem(keyName);
  return key ? { authorization: `Bearer ${key}` } : {};
}

function setStatus(health) {
  const pill = $('#home-status');
  const text = pill.querySelector('.status-text');
  if (!health) {
    pill.dataset.state = 'down';
    text.textContent = 'Server unreachable';
    pill.title = 'The signaling server did not answer.';
    return;
  }
  pill.dataset.state = health.ok ? 'up' : 'down';
  text.textContent = health.ok ? 'Ready' : 'Media offline';
  pill.title = health.ok
    ? `${health.workers} media worker${health.workers === 1 ? '' : 's'} running`
    : 'Signaling is up, but no media workers are running';
}

async function refreshStatus() {
  try {
    const res = await fetch('/healthz');
    const health = await res.json();
    setStatus(health);
    return health;
  } catch {
    setStatus(null);
    return null;
  }
}

function stat(iconName, value, label) {
  const el = document.createElement('div');
  el.className = 'stat';
  const badge = document.createElement('span');
  badge.className = 'stat-icon';
  badge.append(icon(iconName));
  const number = document.createElement('b');
  number.textContent = value;
  const caption = document.createElement('span');
  caption.textContent = label;
  el.append(badge, number, caption);
  return el;
}

async function refreshDashboard() {
  const box = $('#stats');
  const error = $('#stats-error');
  error.textContent = '';
  try {
    const [health, statsRes] = await Promise.all([
      refreshStatus(),
      fetch('/stats', { headers: authHeaders(localStorage, API_KEY) }),
    ]);
    if (statsRes.status === 401) {
      box.textContent = '';
      error.textContent = 'This server needs an API key. Add it under Settings, then come back.';
      return;
    }
    if (!statsRes.ok) throw new Error(`Could not load stats (${statsRes.status})`);
    const stats = await statsRes.json();
    box.textContent = '';
    box.append(
      stat('users', String(stats.participants ?? 0), 'People in calls'),
      stat('layout-grid', String(stats.rooms ?? 0), 'Live rooms'),
      stat('circle-dot', String(stats.recordingRooms ?? 0), 'Rooms recording'),
      stat('server', String(health?.workers ?? 0), 'Media workers'),
      stat('activity', `${stats.measuredTxMbps ?? 0} Mbps`, 'Upload speed'),
      stat(
        'hard-drive',
        stats.recordingsFreeGb == null ? '—' : `${stats.recordingsFreeGb} GB`,
        'Free disk',
      ),
    );
  } catch (err) {
    error.textContent = err.message ?? String(err);
  }
}

function checkRow(label, detail, ok) {
  const li = document.createElement('li');
  li.classList.toggle('bad', !ok);
  const badge = document.createElement('span');
  badge.className = 'check-icon';
  badge.append(icon(ok ? 'check' : 'alert', 'sm'));
  const text = document.createElement('span');
  text.className = 'check-text';
  const name = document.createElement('strong');
  name.textContent = label;
  const value = document.createElement('span');
  value.textContent = detail;
  text.append(name, value);
  li.append(badge, text);
  return li;
}

async function refreshSetup() {
  const list = $('#setup-checks');
  list.textContent = '';
  try {
    const [health, configRes, adminRes] = await Promise.all([
      refreshStatus(),
      fetch('/config'),
      fetch('/admin/settings', { headers: authHeaders(sessionStorage, ADMIN_KEY) }),
    ]);
    const config = await configRes.json();
    list.append(
      checkRow('Signaling', health ? 'Reachable' : 'Not reachable', Boolean(health)),
      checkRow(
        'Media workers',
        health?.ok ? `${health.workers} running` : 'None running',
        Boolean(health?.ok),
      ),
      checkRow(
        'Joining',
        config.tokenRequiresApiKey
          ? 'Requires an API key'
          : 'Open to anyone who can reach this server',
        true,
      ),
      checkRow(
        'Admin settings',
        adminRes.ok ? 'Reachable from here' : 'Needs an admin key or localhost',
        adminRes.ok,
      ),
    );
  } catch (err) {
    list.append(checkRow('Server', err.message ?? String(err), false));
  }
}

function recordingSummary(status) {
  return `${status.rooms} room${status.rooms === 1 ? '' : 's'} live, ${status.recordingRooms} recording.`;
}

async function refreshSettings() {
  $('#setting-name').value = localStorage.getItem(NAME_KEY) ?? '';
  $('#setting-api-key').value = localStorage.getItem(API_KEY) ?? '';
  $('#setting-admin-key').value = sessionStorage.getItem(ADMIN_KEY) ?? '';
  const error = $('#settings-error');
  const status = $('#settings-status');
  error.textContent = '';
  try {
    const res = await fetch('/admin/settings', { headers: authHeaders(sessionStorage, ADMIN_KEY) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    $('#record-new').checked = data.settings.recordingEnabled;
    $('#record-new').disabled = false;
    status.textContent = recordingSummary(data.status);
  } catch (err) {
    $('#record-new').disabled = true;
    status.textContent = '';
    error.textContent = err.message ?? String(err);
  }
}

$('#setting-name').addEventListener('change', () => {
  localStorage.setItem(NAME_KEY, $('#setting-name').value.trim());
  const name = document.querySelector('#join-form input[name=name]');
  if (name) {
    name.value = $('#setting-name').value.trim();
    name.dispatchEvent(new Event('input'));
  }
});

$('#setting-api-key').addEventListener('change', () => {
  localStorage.setItem(API_KEY, $('#setting-api-key').value);
  const field = document.querySelector('#join-form input[name=apiKey]');
  if (field) field.value = $('#setting-api-key').value;
});

$('#setting-admin-key').addEventListener('change', () => {
  sessionStorage.setItem(ADMIN_KEY, $('#setting-admin-key').value);
  void refreshSettings();
});

$('#record-new').addEventListener('change', async () => {
  const toggle = $('#record-new');
  toggle.disabled = true;
  try {
    const res = await fetch('/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(sessionStorage, ADMIN_KEY) },
      body: JSON.stringify({ recordingEnabled: toggle.checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    $('#settings-error').textContent = '';
    $('#settings-status').textContent = recordingSummary(data.status);
    toggle.disabled = false;
  } catch (err) {
    toggle.checked = !toggle.checked;
    toggle.disabled = false;
    $('#settings-error').textContent = err.message ?? String(err);
  }
});

$('#settings-form').addEventListener('submit', (event) => event.preventDefault());

$('#create-room').onclick = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  const room = document.querySelector('#join-form input[name=room]');
  room.value = `room-${suffix}`;
  const name = document.querySelector('#join-form input[name=name]');
  if (name.value.trim()) $('#join-button').focus();
  else name.focus();
};

$('#refresh-stats').onclick = () => void refreshDashboard();

void refreshStatus();
setInterval(() => {
  if (!document.hidden && !$('#home').hidden) void refreshStatus();
}, 20_000);

const initialTab = tabFromHash();
if (initialTab) openDrawer(initialTab);
