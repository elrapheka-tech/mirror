// SPDX-License-Identifier: Apache-2.0
// Admin page for runtime settings. The key lives in sessionStorage only for this tab.

const $ = (sel) => document.querySelector(sel);
const keyInput = $('#key');
const toggle = $('#recording');
keyInput.value = sessionStorage.getItem('mirrorAdminKey') ?? '';

async function call(method, body) {
  const headers = { 'content-type': 'application/json' };
  if (keyInput.value) headers.authorization = `Bearer ${keyInput.value}`;
  const res = await fetch('/admin/settings', { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

function render({ settings, status }) {
  toggle.checked = settings.recordingEnabled;
  toggle.disabled = false;
  $('#status').textContent =
    `${status.rooms} room(s) live, ${status.recordingRooms} recording, ${status.participants} participant(s).`;
  $('#error').textContent = '';
}

async function refresh() {
  try {
    render(await call('GET'));
  } catch (err) {
    toggle.disabled = true;
    $('#error').textContent = err.message;
  }
}

keyInput.addEventListener('change', () => {
  sessionStorage.setItem('mirrorAdminKey', keyInput.value);
  refresh();
});

toggle.addEventListener('change', async () => {
  toggle.disabled = true;
  try {
    render(await call('PUT', { recordingEnabled: toggle.checked }));
  } catch (err) {
    toggle.checked = !toggle.checked;
    toggle.disabled = false;
    $('#error').textContent = err.message;
  }
});

$('#admin').addEventListener('submit', (e) => e.preventDefault());
refresh();
