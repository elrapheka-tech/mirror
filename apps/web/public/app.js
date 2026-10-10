// SPDX-License-Identifier: Apache-2.0
// Mirror web client. One RTCPeerConnection: publish mic+camera, receive 5 audio and 10 video
// server-assigned slots. The server decides who is in each slot; this page only renders it.

const AUDIO_SLOTS = 5;
const VIDEO_SLOTS = 10;
const MEDIA_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
};

const $ = (sel) => document.querySelector(sel);

function icon(name, size = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${size}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** aria-pressed="true" means the thing the button controls is off (muted, hidden). */
function setToggle(button, pressed, label) {
  if (!button) return;
  button.setAttribute('aria-pressed', String(pressed));
  button.setAttribute('aria-label', label);
  button.title = label;
}
const form = $('#join-form');
const grid = $('#grid');
const people = $('#people');

const state = {
  ws: null,
  pc: null,
  localStream: null,
  participantId: null,
  roomId: null,
  names: new Map(),
  speakers: new Set(),
  pins: [],
  page: 0,
  videoSlots: Array(VIDEO_SLOTS).fill(null),
  audioSlots: Array(AUDIO_SLOTS).fill(null),
  tiles: [],
  videoTransceivers: [],
  audioTransceivers: [],
  videoSender: null,
  qualityKey: '',
  /** id -> { cameraOn, handRaised } */
  presence: new Map(),
  reactions: new Map(),
};

function displayName(id) {
  return state.names.get(id) ?? id;
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = (value) => Array.from(value);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return chars(parts[0]).slice(0, 2).join('').toUpperCase();
  return `${chars(parts[0])[0] ?? ''}${chars(parts[1])[0] ?? ''}`.toUpperCase();
}

function avatarColor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 48% 44%)`;
}

function presenceOf(id) {
  return state.presence.get(id) ?? { cameraOn: true, handRaised: false };
}

function hasPicture(video) {
  const stream = video?.srcObject;
  const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : null;
  return Boolean(track && track.enabled && track.readyState === 'live' && !track.muted && video.videoWidth > 0);
}

function showingVideo(id, video) {
  return presenceOf(id).cameraOn && hasPicture(video);
}

function paintAvatar(el, id, visible) {
  if (!el) return;
  el.classList.toggle('show', visible);
  el.style.setProperty('--avatar', avatarColor(id));
  const letter = el.querySelector('span');
  if (letter) letter.textContent = initials(displayName(id));
}

function personAvatar(id) {
  const el = document.createElement('span');
  el.className = 'person-avatar';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--avatar', avatarColor(id));
  el.textContent = initials(displayName(id));
  return el;
}

function watchPicture(video) {
  const refresh = () => renderTiles();
  video.addEventListener('resize', refresh);
  video.addEventListener('emptied', refresh);
  const stream = video.srcObject;
  const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : null;
  if (!track) return;
  track.addEventListener('mute', refresh);
  track.addEventListener('unmute', refresh);
  track.addEventListener('ended', refresh);
}

async function getToken(room, name, apiKey) {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) return fromUrl;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const identity = `${name}-${crypto.randomUUID().slice(0, 8)}`;
  const res = await fetch('/tokens', {
    method: 'POST',
    headers,
    body: JSON.stringify({ room, identity, name }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `token request failed (${res.status})`);
  return body.token;
}

function preferCodecs(transceiver) {
  const caps = RTCRtpReceiver.getCapabilities?.('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const rank = (c) => {
    const t = c.mimeType.toLowerCase();
    if (t === 'video/vp9') return 0;
    if (t === 'video/vp8') return 1;
    if (t === 'video/rtx') return 2;
    return 9;
  };
  const codecs = caps.codecs.filter((c) => rank(c) < 9).sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {
    console.warn('setCodecPreferences failed', err);
  }
}

function buildTiles() {
  grid.textContent = '';
  state.tiles = [];
  for (let i = 0; i < VIDEO_SLOTS; i++) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.hidden = true;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.append(document.createElement('span'));
    const hand = document.createElement('span');
    hand.className = 'hand-badge';
    hand.hidden = true;
    hand.append(icon('hand'));
    const reaction = document.createElement('span');
    reaction.className = 'reaction';
    reaction.hidden = true;
    const label = document.createElement('span');
    label.className = 'label';
    tile.append(video, avatar, hand, reaction, label);
    grid.append(tile);
    state.tiles.push({ tile, video, avatar, hand, reaction, label });
  }
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.id = 'empty';
  const badge = document.createElement('span');
  badge.className = 'empty-icon';
  badge.append(icon('users', 'lg'));
  const title = document.createElement('h2');
  title.textContent = 'You’re the only one here';
  const text = document.createElement('p');
  text.textContent = 'Share the invite link and others will show up here when they join.';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-primary';
  copy.append(icon('link', 'sm'), 'Copy Invite Link');
  copy.onclick = () => void copyInvite();
  empty.append(badge, title, text, copy);
  grid.append(empty);
}

function renderTiles() {
  let shown = 0;
  state.videoSlots.forEach((id, i) => {
    const t = state.tiles[i];
    if (!t) return;
    t.tile.hidden = !id;
    if (!id) return;
    shown++;
    const name = displayName(id);
    const presence = presenceOf(id);
    t.label.textContent = name;
    t.tile.classList.toggle('speaking', state.speakers.has(id));
    const live = showingVideo(id, t.video);
    t.tile.classList.toggle('camera-off', !live);
    paintAvatar(t.avatar, id, !live);
    t.hand.hidden = !presence.handRaised;
    const reaction = state.reactions.get(id);
    t.reaction.hidden = !reaction;
    t.reaction.textContent = reaction ?? '';
    const status = [
      live ? `Video of ${name}` : `${name}, camera off`,
      presence.handRaised ? 'hand raised' : '',
    ]
      .filter(Boolean)
      .join(', ');
    t.tile.setAttribute('aria-label', status);
    if (live) t.video.play().catch(() => {});
  });
  const empty = $('#empty');
  if (empty) empty.hidden = shown > 0;
  renderSelf();
}

function renderSelf() {
  const id = state.participantId;
  const wrap = $('#self-wrap');
  if (!id || !wrap) return;
  const video = $('#self');
  const presence = presenceOf(id);
  const live = showingVideo(id, video);
  wrap.classList.toggle('camera-off', !live);
  paintAvatar($('#self-avatar'), id, !live);
  const hand = $('#self-hand');
  hand.hidden = !presence.handRaised;
  const reaction = state.reactions.get(id);
  const bubble = $('#self-reaction');
  bubble.hidden = !reaction;
  bubble.textContent = reaction ?? '';
  video.setAttribute('aria-label', live ? 'Your camera' : 'Your camera is off');
}

function renderPeople() {
  people.textContent = '';
  const ids = [...state.names.keys()]
    .filter((id) => id !== state.participantId)
    .sort((a, b) => Number(presenceOf(b).handRaised) - Number(presenceOf(a).handRaised));
  const total = String(ids.length + 1);
  $('#count').textContent = total;
  $('#count-badge').textContent = total;
  const me = document.createElement('li');
  const myName = document.createElement('span');
  myName.className = 'name';
  myName.append(displayName(state.participantId), ' ', Object.assign(document.createElement('span'), {
    className: 'you',
    textContent: '(you)',
  }));
  const myMarks = document.createElement('span');
  myMarks.className = 'marks';
  if (presenceOf(state.participantId).handRaised) myMarks.append(mark('hand', 'Hand raised'));
  if (!presenceOf(state.participantId).cameraOn) myMarks.append(mark('video-off', 'Camera off'));
  me.append(personAvatar(state.participantId), myName, myMarks);
  people.append(me);
  for (const id of ids) {
    const li = document.createElement('li');
    li.classList.toggle('speaking', state.speakers.has(id));
    li.append(personAvatar(id));
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = displayName(id);
    const marks = document.createElement('span');
    marks.className = 'marks';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'icon-btn sm pin';
    li.append(nameEl, marks, pin);
    if (presenceOf(id).handRaised) marks.append(mark('hand', 'Hand raised'));
    if (!presenceOf(id).cameraOn) marks.append(mark('video-off', 'Camera off'));
    const pinned = state.pins.includes(id);
    const person = displayName(id);
    pin.append(icon(pinned ? 'pin-off' : 'pin', 'sm'));
    setToggle(pin, pinned, `${pinned ? 'Unpin' : 'Pin'} ${person}`);
    pin.onclick = () => {
      state.pins = pinned ? state.pins.filter((p) => p !== id) : [...state.pins, id].slice(-VIDEO_SLOTS);
      sendPrefs();
      renderPeople();
    };
    people.append(li);
  }
  const pages = Math.max(1, Math.ceil(ids.length / VIDEO_SLOTS));
  if (state.page >= pages) {
    state.page = pages - 1;
    sendPrefs();
  }
  $('#pager').hidden = pages <= 1;
  $('#page-label').textContent = `${state.page + 1} / ${pages}`;
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page >= pages - 1;
}

function mark(iconName, label) {
  const el = document.createElement('span');
  el.className = iconName;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.title = label;
  el.append(icon(iconName, 'sm'));
  return el;
}

function showReaction(id, emoji) {
  state.reactions.set(id, emoji);
  renderTiles();
  renderPeople();
  clearTimeout(showReaction.timers.get(id));
  const timer = setTimeout(() => {
    if (state.reactions.get(id) === emoji) state.reactions.delete(id);
    renderTiles();
  }, 3200);
  showReaction.timers.set(id, timer);
}
showReaction.timers = new Map();

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function sendPrefs() {
  send({ type: 'prefs', pins: state.pins, page: state.page, hidden: document.hidden });
}

/** Fewer people get a sharper picture. A full grid steps back down so ten tiles still fit. */
const VIDEO_TIERS = [
  { maxOthers: 1, width: 1280, height: 720, bitrate: 1_200_000 },
  { maxOthers: 3, width: 960, height: 540, bitrate: 700_000 },
  { maxOthers: 8, width: 640, height: 360, bitrate: 350_000 },
  { maxOthers: Infinity, width: 320, height: 180, bitrate: 180_000 },
];

async function applyVideoQuality() {
  const sender = state.videoSender;
  const track = state.localStream?.getVideoTracks()[0];
  if (!sender || !track) return;
  const others = Math.max(0, state.names.size - (state.participantId ? 1 : 0));
  const tier = VIDEO_TIERS.find((item) => others <= item.maxOthers) ?? VIDEO_TIERS[VIDEO_TIERS.length - 1];
  const key = `${tier.width}x${tier.bitrate}`;
  if (state.qualityKey === key) return;
  state.qualityKey = key;
  try {
    await track.applyConstraints({
      width: { ideal: tier.width },
      height: { ideal: tier.height },
      frameRate: { ideal: 30, max: 30 },
    });
  } catch (err) {
    console.warn('camera constraints', err);
  }
  try {
    const params = sender.getParameters();
    if (!params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = tier.bitrate;
    params.encodings[0].maxFramerate = 30;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (err) {
    console.warn('video bitrate', err);
  }
}

function showNotice(text) {
  $('#notice').textContent = text;
}

async function join(event) {
  event.preventDefault();
  const data = new FormData(form);
  const room = String(data.get('room'));
  const name = String(data.get('name'));
  const errorEl = $('#join-error');
  const joinButton = $('#join-button');
  errorEl.textContent = '';
  joinButton.disabled = true;
  $('#join-label').textContent = 'Joining…';
  try {
    const [token, config] = await Promise.all([
      getToken(room, name, String(data.get('apiKey') ?? '')),
      fetch('/config').then((r) => r.json()),
    ]);
    if (!streamIsLive(state.localStream)) {
      state.localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    }
    const camera = state.localStream.getVideoTracks()[0];
    if (camera) camera.contentHint = 'detail';
    $('#preview').srcObject = null;
    $('#self').srcObject = state.localStream;
    watchPicture($('#self'));
    await connect(token, config.iceServers ?? []);
    state.roomId = room;
    $('#room-name').textContent = room;
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    url.hash = '';
    history.replaceState(null, '', url);
    localStorage.setItem('mirrorName', name);
    syncMediaButtons();
    if (camera && !camera.enabled) {
      state.presence.set(state.participantId, { ...presenceOf(state.participantId), cameraOn: false });
      send({ type: 'camera', on: false });
      renderTiles();
      renderPeople();
    }
    setSideOpen(window.matchMedia('(min-width: 1024px)').matches);
    $('#home').hidden = true;
    $('#call').hidden = false;
    $('.skip').setAttribute('href', '#grid');
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message ?? String(err);
    errorEl.focus();
    teardown();
    void startPreview();
  } finally {
    joinButton.disabled = false;
    $('#join-label').textContent = 'Join Meeting';
  }
}

async function connect(token, iceServers) {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  state.pc = pc;
  const [audioTrack] = state.localStream.getAudioTracks();
  const [videoTrack] = state.localStream.getVideoTracks();

  pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [state.localStream] });
  let videoTx;
  try {
    // L1T3: three temporal layers so the server can drop to 15 or 7.5 fps per viewer.
    videoTx = pc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [state.localStream],
      sendEncodings: [{ maxBitrate: 1_200_000, maxFramerate: 30, scalabilityMode: 'L1T3' }],
    });
  } catch {
    videoTx = pc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [state.localStream],
      sendEncodings: [{ maxBitrate: 1_200_000, maxFramerate: 30 }],
    });
  }
  state.videoSender = videoTx.sender;
  preferCodecs(videoTx);
  for (let i = 0; i < AUDIO_SLOTS; i++) {
    state.audioTransceivers.push(pc.addTransceiver('audio', { direction: 'recvonly' }));
  }
  for (let i = 0; i < VIDEO_SLOTS; i++) {
    const t = pc.addTransceiver('video', { direction: 'recvonly' });
    preferCodecs(t);
    state.videoTransceivers.push(t);
  }

  const onIce = () => {
    const ice = pc.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') showNotice('');
    else if (ice === 'checking' || ice === 'new') showNotice('Connecting media…');
    else if (ice === 'disconnected') showNotice('Media connection is unstable. It will drop if this continues.');
    else if (ice === 'failed') showNotice('Media did not connect. Leave the room and join again.');
  };
  pc.oniceconnectionstatechange = onIce;
  pc.onconnectionstatechange = onIce;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('could not reach the signaling server'));
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', token, sdp: pc.localDescription.sdp }));
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') {
        try {
          await onJoined(msg);
          resolve();
        } catch (err) {
          reject(err);
        }
      } else if (msg.type === 'error' && !state.participantId) {
        reject(new Error(msg.message));
      } else {
        onMessage(msg);
      }
    };
    ws.onclose = () => {
      if (state.participantId) {
        teardown();
        showHome();
        $('#join-error').textContent = 'You were disconnected from the server.';
      }
    };
  });
}

async function onJoined(msg) {
  state.participantId = msg.participantId;
  state.names.set(msg.participantId, String(new FormData(form).get('name')));
  state.presence.set(msg.participantId, { cameraOn: true, handRaised: false });
  for (const p of msg.participants) {
    state.names.set(p.id, p.name);
    state.presence.set(p.id, { cameraOn: p.cameraOn !== false, handRaised: p.handRaised === true });
  }
  await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });

  const byMid = new Map(state.pc.getTransceivers().map((t) => [t.mid, t]));
  buildTiles();
  msg.slotMids.video.forEach((mid, i) => {
    const t = byMid.get(mid);
    if (t && state.tiles[i]) {
      state.tiles[i].video.srcObject = new MediaStream([t.receiver.track]);
      watchPicture(state.tiles[i].video);
    }
  });
  const sink = $('#audio-sink');
  sink.textContent = '';
  msg.slotMids.audio.forEach((mid) => {
    const t = byMid.get(mid);
    if (!t) return;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = new MediaStream([t.receiver.track]);
    sink.append(audio);
  });

  $('#recording').hidden = !msg.recording;
  if (msg.recordingUnavailableReason) showNotice(msg.recordingUnavailableReason);
  renderPeople();
  renderTiles();
  void applyVideoQuality();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'participantJoined':
      state.names.set(msg.participant.id, msg.participant.name);
      state.presence.set(msg.participant.id, {
        cameraOn: msg.participant.cameraOn !== false,
        handRaised: msg.participant.handRaised === true,
      });
      renderPeople();
      void applyVideoQuality();
      break;
    case 'participantLeft':
      state.names.delete(msg.id);
      state.presence.delete(msg.id);
      state.reactions.delete(msg.id);
      state.speakers.delete(msg.id);
      state.pins = state.pins.filter((p) => p !== msg.id);
      renderPeople();
      renderTiles();
      void applyVideoQuality();
      break;
    case 'camera':
      state.presence.set(msg.id, { ...presenceOf(msg.id), cameraOn: msg.on === true });
      renderTiles();
      renderPeople();
      break;
    case 'hand':
      state.presence.set(msg.id, { ...presenceOf(msg.id), handRaised: msg.raised === true });
      renderTiles();
      renderPeople();
      break;
    case 'react':
      showReaction(msg.id, msg.emoji);
      break;
    case 'slots':
      state.videoSlots = msg.video;
      state.audioSlots = msg.audio;
      renderTiles();
      break;
    case 'speakers':
      state.speakers = new Set(msg.ids);
      renderTiles();
      renderPeople();
      break;
    case 'error':
      showNotice(msg.message);
      break;
  }
}

function teardown() {
  state.ws?.close();
  state.pc?.close();
  state.localStream?.getTracks().forEach((t) => t.stop());
  Object.assign(state, {
    ws: null,
    pc: null,
    localStream: null,
    participantId: null,
    names: new Map(),
    speakers: new Set(),
    pins: [],
    page: 0,
    videoSlots: Array(VIDEO_SLOTS).fill(null),
    audioSlots: Array(AUDIO_SLOTS).fill(null),
    videoTransceivers: [],
    audioTransceivers: [],
    videoSender: null,
    qualityKey: '',
    presence: new Map(),
    reactions: new Map(),
  });
  for (const timer of showReaction.timers.values()) clearTimeout(timer);
  showReaction.timers.clear();
  syncMediaButtons();
  setToggle($('#raise-hand'), false, 'Raise hand');
  setReactionsOpen(false);
  setSideOpen(false);
  $('#self-wrap').classList.remove('camera-off');
  $('#self-avatar').classList.remove('show');
  $('#self-hand').hidden = true;
  $('#self-reaction').hidden = true;
  $('#notice').textContent = '';
  $('#toast').textContent = '';
}

function streamIsLive(stream) {
  return Boolean(stream && stream.getTracks().length && stream.getTracks().every((t) => t.readyState === 'live'));
}

function syncMediaButtons() {
  const mic = state.localStream?.getAudioTracks()[0];
  const cam = state.localStream?.getVideoTracks()[0];
  const micOff = !mic?.enabled;
  const camOff = !cam?.enabled;
  for (const button of [$('#toggle-mic'), $('#preview-mic')]) {
    setToggle(button, micOff, micOff ? 'Unmute microphone' : 'Mute microphone');
  }
  for (const button of [$('#toggle-cam'), $('#preview-cam')]) {
    setToggle(button, camOff, camOff ? 'Turn on camera' : 'Turn off camera');
  }
  $('#preview-mic').disabled = !mic;
  $('#preview-cam').disabled = !cam;
}

function toggleMic() {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncMediaButtons();
}

function toggleCam() {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  syncMediaButtons();
  renderPreview();
  if (state.participantId) {
    state.presence.set(state.participantId, { ...presenceOf(state.participantId), cameraOn: track.enabled });
    send({ type: 'camera', on: track.enabled });
    renderTiles();
    renderPeople();
  }
}

function mediaErrorText(err) {
  if (!navigator.mediaDevices) return 'Camera access needs HTTPS or localhost.';
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Camera and microphone are blocked. Allow them in your browser’s site settings, then try again.';
    case 'NotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'Your camera is busy in another app. Close it, then try again.';
    default:
      return err?.message ?? String(err);
  }
}

let previewRequest = 0;

async function startPreview() {
  if (state.participantId) return;
  const request = ++previewRequest;
  $('#preview-message').hidden = true;
  if (!streamIsLive(state.localStream)) {
    try {
      if (!navigator.mediaDevices) throw new Error('insecure context');
      const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
      if (request !== previewRequest || state.participantId) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      state.localStream = stream;
    } catch (err) {
      if (request !== previewRequest) return;
      $('#preview-text').textContent = mediaErrorText(err);
      $('#preview-message').hidden = false;
      syncMediaButtons();
      renderPreview();
      return;
    }
  }
  const video = $('#preview');
  video.srcObject = state.localStream;
  const track = state.localStream.getVideoTracks()[0];
  track?.addEventListener('mute', renderPreview);
  track?.addEventListener('unmute', renderPreview);
  video.play().catch(() => {});
  syncMediaButtons();
  renderPreview();
}

function renderPreview() {
  const video = $('#preview');
  const name = form.querySelector('input[name=name]').value.trim();
  const live = hasPicture(video);
  $('#preview-wrap').classList.toggle('camera-off', !live);
  const avatar = $('#preview-avatar');
  avatar.classList.toggle('show', !live);
  avatar.style.setProperty('--avatar', avatarColor(name || '?'));
  avatar.querySelector('span').textContent = initials(name);
  const label = $('#preview-name');
  label.hidden = !name;
  label.textContent = name;
}

function showHome() {
  $('#home').hidden = false;
  $('#call').hidden = true;
  $('.skip').setAttribute('href', '#join-form');
  void startPreview();
}

function setSideOpen(open) {
  $('#call').classList.toggle('side-open', open);
  setToggle($('#toggle-people'), open, open ? 'Hide people' : 'Show people');
}

function setReactionsOpen(open) {
  $('#reactions').hidden = !open;
  $('#react-toggle').setAttribute('aria-expanded', String(open));
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.textContent = '';
  }, 2600);
}

async function copyInvite() {
  const url = new URL('/', location.origin);
  url.searchParams.set('room', state.roomId ?? '');
  try {
    await navigator.clipboard.writeText(url.href);
    toast('Invite link copied');
  } catch {
    window.prompt('Copy this invite link', url.href);
  }
}

form.addEventListener('submit', (event) => {
  previewRequest++;
  void join(event);
});
$('#leave').onclick = () => {
  if (!confirm('Leave this room?')) return;
  send({ type: 'leave' });
  teardown();
  showHome();
};
$('#toggle-mic').onclick = toggleMic;
$('#preview-mic').onclick = toggleMic;
$('#toggle-cam').onclick = toggleCam;
$('#preview-cam').onclick = toggleCam;
$('#preview-retry').onclick = () => void startPreview();
$('#preview').addEventListener('resize', renderPreview);
$('#preview').addEventListener('loadeddata', renderPreview);
form.querySelector('input[name=name]').addEventListener('input', renderPreview);
$('#raise-hand').onclick = (e) => {
  if (!state.participantId) return;
  const raised = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  setToggle(e.currentTarget, raised, raised ? 'Lower hand' : 'Raise hand');
  state.presence.set(state.participantId, { ...presenceOf(state.participantId), handRaised: raised });
  send({ type: 'hand', raised });
  renderTiles();
  renderPeople();
};
$('#react-toggle').onclick = () => setReactionsOpen($('#reactions').hidden);
$('#reactions').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-emoji]');
  if (!button || !state.participantId) return;
  send({ type: 'react', emoji: button.dataset.emoji });
  setReactionsOpen(false);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.reaction-wrap')) setReactionsOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#reactions').hidden) {
    setReactionsOpen(false);
    $('#react-toggle').focus();
  }
});
$('#toggle-people').onclick = () => setSideOpen(!$('#call').classList.contains('side-open'));
$('#close-people').onclick = () => setSideOpen(false);
$('#copy-link').onclick = () => void copyInvite();
$('#prev-page').onclick = () => {
  state.page = Math.max(0, state.page - 1);
  sendPrefs();
  renderPeople();
};
$('#next-page').onclick = () => {
  state.page += 1;
  sendPrefs();
  renderPeople();
};
document.addEventListener('visibilitychange', () => {
  if (state.participantId) sendPrefs();
});

const roomInput = form.querySelector('input[name=room]');
const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl && /^[A-Za-z0-9_-]{1,48}$/.test(roomFromUrl)) roomInput.value = roomFromUrl;
const savedName = localStorage.getItem('mirrorName');
if (savedName) form.querySelector('input[name=name]').value = savedName;
const savedApiKey = localStorage.getItem('mirrorApiKey');
if (savedApiKey) form.querySelector('input[name=apiKey]').value = savedApiKey;

fetch('/config')
  .then((r) => r.json())
  .then((c) => {
    if (c.tokenRequiresApiKey && !new URLSearchParams(location.search).has('token')) {
      $('#api-key-row').hidden = false;
    }
  })
  .catch(() => {});

syncMediaButtons();
renderPreview();
void startPreview();

// Read-only hooks for scripts/e2e.ts.
window.mirrorDebug = {
  get participantId() {
    return state.participantId;
  },
  get slots() {
    return { video: [...state.videoSlots], audio: [...state.audioSlots] };
  },
  get connectionState() {
    return state.pc?.connectionState ?? 'none';
  },
  get iceState() {
    return state.pc?.iceConnectionState ?? 'none';
  },
  async transports() {
    if (!state.pc) return [];
    const report = await state.pc.getStats();
    const out = [];
    report.forEach((s) => {
      if (s.type === 'candidate-pair' || s.type === 'transport' || s.type === 'local-candidate' || s.type === 'remote-candidate') {
        out.push(s);
      }
    });
    return out;
  },
  async inbound() {
    if (!state.pc) return [];
    const report = await state.pc.getStats();
    const out = [];
    report.forEach((s) => {
      if (s.type === 'inbound-rtp') {
        out.push({
          kind: s.kind,
          mid: s.mid,
          packets: s.packetsReceived ?? 0,
          bytes: s.bytesReceived ?? 0,
          framesDecoded: s.framesDecoded ?? 0,
          fps: s.framesPerSecond ?? 0,
        });
      }
    });
    return out;
  },
  async outbound() {
    if (!state.pc) return [];
    const report = await state.pc.getStats();
    const out = [];
    report.forEach((s) => {
      if (s.type === 'outbound-rtp') {
        out.push({ kind: s.kind, packets: s.packetsSent ?? 0, codec: s.codecId, scalability: s.scalabilityMode });
      }
    });
    return out;
  },
};
