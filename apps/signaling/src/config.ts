// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';

import type { VideoCodec } from '@mirror/protocol';
import { loadEgressConfig, type EgressConfig } from '@mirror/egress';

export interface SignalingConfig {
  host: string;
  port: number;
  publicDir: string;
  apiKey: string | null;
  /** Guards /admin/*. When null, admin endpoints only answer requests from localhost. */
  adminApiKey: string | null;
  settingsFile: string;
  jwtSecret: string;
  jwtSecretIsDefault: boolean;
  iceServers: unknown[];

  workerBinary: string;
  workerCount: number;
  pinWorkerCpus: boolean;
  mediaBindIp: string;
  mediaPortBase: number;
  announcedIp: string;
  workerArgs: string[];

  videoCodecs: VideoCodec[];
  roomEmptyTimeoutMs: number;

  capacityMbps: number;
  videoTileKbps: number;
  audioKbps: number;
  avgSpeakers: number;

  recordingEnabled: boolean;
  egress: EgressConfig;
}

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const DEV_SECRET = 'dev-only-insecure-secret-change-me';

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? def : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SignalingConfig {
  const codecs = str(env, 'VIDEO_CODECS', 'vp9,vp8')
    .split(',')
    .map((c) => c.trim().toLowerCase());
  for (const c of codecs) {
    if (c !== 'vp9' && c !== 'vp8') throw new Error(`VIDEO_CODECS: unsupported codec "${c}"`);
  }
  const iceRaw = str(env, 'ICE_SERVERS', '[]');
  let iceServers: unknown[];
  try {
    iceServers = JSON.parse(iceRaw) as unknown[];
    if (!Array.isArray(iceServers)) throw new Error('not an array');
  } catch {
    throw new Error('ICE_SERVERS must be a JSON array of RTCIceServer objects');
  }

  const workerArgs: string[] = [];
  const tuning: [string, string][] = [
    ['AUDIO_LEVEL_THRESHOLD', '--audio-threshold'],
    ['SURFACE_MS', '--surface-ms'],
    ['MIN_TILE_MS', '--min-tile-ms'],
    ['HANGOVER_MS', '--hangover-ms'],
    ['QUEUE_MS', '--queue-ms'],
    ['PUBLISHER_KBPS', '--publisher-kbps'],
    ['SUBSCRIBER_START_KBPS', '--start-kbps'],
    ['SUBSCRIBER_MAX_KBPS', '--max-kbps'],
    ['PARTICIPANT_TIMEOUT_MS', '--timeout-ms'],
  ];
  for (const [key, flag] of tuning) {
    if (env[key]) workerArgs.push(flag, String(num(env, key, 0)));
  }

  const jwtSecret = str(env, 'JWT_SECRET', DEV_SECRET);
  const announcedIp = str(env, 'ANNOUNCED_IP', '127.0.0.1');
  // A wildcard bind answers 127.0.0.1 from the wrong source address on macOS, so Chrome
  // never sees the ICE replies and the worker then drops the participant.
  const loopback = announcedIp === '127.0.0.1' || announcedIp === '::1';
  return {
    host: str(env, 'SIGNALING_HOST', '0.0.0.0'),
    port: num(env, 'SIGNALING_PORT', 7880),
    publicDir: path.resolve(repoRoot, str(env, 'WEB_PUBLIC_DIR', 'apps/web/public')),
    apiKey: env.API_KEY ? env.API_KEY : null,
    adminApiKey: env.ADMIN_API_KEY ? env.ADMIN_API_KEY : null,
    settingsFile: path.resolve(repoRoot, str(env, 'SETTINGS_FILE', 'data/settings.json')),
    jwtSecret,
    jwtSecretIsDefault: jwtSecret === DEV_SECRET,
    iceServers,

    workerBinary: path.resolve(repoRoot, str(env, 'WORKER_BINARY', 'build/native/sfu-worker')),
    workerCount: Math.max(1, num(env, 'WORKER_COUNT', Math.max(1, os.availableParallelism() - 1))),
    pinWorkerCpus: bool(env, 'WORKER_PIN_CPUS', true),
    mediaBindIp: str(env, 'MEDIA_BIND_IP', loopback ? announcedIp : '0.0.0.0'),
    mediaPortBase: num(env, 'MEDIA_PORT_BASE', 40000),
    announcedIp,
    workerArgs,

    videoCodecs: codecs as VideoCodec[],
    roomEmptyTimeoutMs: num(env, 'ROOM_EMPTY_TIMEOUT_SEC', 10) * 1000,

    capacityMbps: num(env, 'CAPACITY_MBPS', 900),
    videoTileKbps: num(env, 'VIDEO_TILE_KBPS', 80),
    audioKbps: num(env, 'AUDIO_KBPS', 40),
    avgSpeakers: num(env, 'AVG_SPEAKERS', 1.5),

    recordingEnabled: bool(env, 'RECORDING_ENABLED', true),
    egress: loadEgressConfig(env),
  };
}
