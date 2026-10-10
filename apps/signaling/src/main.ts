// SPDX-License-Identifier: Apache-2.0
// Signaling server: HTTP API, WebSocket signaling, static web client, worker supervision.
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage, WorkerStats } from '@mirror/protocol';
import {
  createS3Uploader,
  freeBytes,
  recoverIncompleteRooms,
  runCleanup,
  startCleanupScheduler,
} from '@mirror/egress';

import { loadConfig } from './config.ts';
import { ROOM_NAME, signToken, verifyToken } from './jwt.ts';
import { JoinError, RoomManager } from './rooms.ts';
import { SettingsStore } from './settings.ts';
import { WorkerPool } from './workers.ts';

const config = loadConfig();
const settings = new SettingsStore(config.settingsFile, { recordingEnabled: config.recordingEnabled });
const pool = new WorkerPool(config);
const rooms = new RoomManager(config, pool, settings);

interface WorkerSample {
  stats: WorkerStats;
  at: number;
  txMbps: number;
  rxMbps: number;
  txPps: number;
}
const samples = new Map<number, WorkerSample>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req: http.IncomingMessage): boolean {
  if (!config.apiKey) return true;
  return req.headers.authorization === `Bearer ${config.apiKey}`;
}

function adminAuthorized(req: http.IncomingMessage): boolean {
  if (config.adminApiKey) {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.adminApiKey}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object') throw new Error('expected a JSON object');
  return parsed as Record<string, unknown>;
}

function currentTxMbps(): number {
  let total = 0;
  for (const s of samples.values()) total += s.txMbps;
  return total;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const aliases: Record<string, string> = { '/': '/index.html', '/admin': '/admin.html' };
  const rel = aliases[url.pathname] ?? decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const live = pool.workers.filter((w) => w.alive).length;
      sendJson(res, live > 0 ? 200 : 503, { ok: live > 0, workers: live });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      sendJson(res, 200, { iceServers: config.iceServers, tokenRequiresApiKey: Boolean(config.apiKey) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tokens') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'missing or wrong API key' });
      const body = await readJson(req);
      const room = String(body.room ?? '');
      const identity = String(body.identity ?? '').slice(0, 128);
      if (!ROOM_NAME.test(room)) {
        return sendJson(res, 400, { error: 'room must match [A-Za-z0-9_-]{1,48}' });
      }
      if (!identity) return sendJson(res, 400, { error: 'identity is required' });
      const ttl = Math.min(Math.max(Number(body.ttlSec) || 3600, 60), 24 * 3600);
      const token = signToken(
        {
          sub: identity,
          name: String(body.name ?? identity).slice(0, 64),
          room,
          canPublish: body.canPublish !== false,
          canSubscribe: body.canSubscribe !== false,
        },
        config.jwtSecret,
        ttl,
      );
      return sendJson(res, 200, { token });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'missing or wrong API key' });
      const free = await freeBytes(config.egress.recordingsDir).catch(() => null);
      return sendJson(res, 200, {
        ...rooms.summary(),
        measuredTxMbps: Math.round(currentTxMbps() * 10) / 10,
        recordingsFreeGb: free === null ? null : Math.round(free / 1e8) / 10,
        workers: pool.workers.map((w) => ({
          index: w.index,
          port: w.port,
          alive: w.alive,
          ...samples.get(w.index),
        })),
      });
    }
    if (url.pathname === '/admin/settings') {
      if (!adminAuthorized(req)) {
        return sendJson(res, 401, {
          error: config.adminApiKey
            ? 'missing or wrong admin key'
            : 'ADMIN_API_KEY is not set; admin settings are only reachable from localhost',
        });
      }
      if (req.method === 'GET') {
        return sendJson(res, 200, { settings: settings.get(), status: rooms.summary() });
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readJson(req);
        const updated = await settings.update({
          recordingEnabled: body.recordingEnabled as boolean | undefined,
        });
        console.log(`[signaling] admin updated settings: ${JSON.stringify(updated)}`);
        return sendJson(res, 200, { settings: updated, status: rooms.summary() });
      }
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405).end();
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
}

function handleSocket(ws: WebSocket): void {
  let participantId: string | null = null;
  let joining = false;
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const joinTimer = setTimeout(() => {
    if (!participantId) ws.close(4000, 'join timeout');
  }, 15000);

  ws.on('message', async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return send({ type: 'error', code: 'bad_request', message: 'invalid JSON' });
    }
    if (msg.type === 'join') {
      if (participantId || joining) return;
      joining = true;
      try {
        let claims;
        try {
          claims = verifyToken(String(msg.token), config.jwtSecret);
        } catch (err) {
          throw new JoinError('bad_token', (err as Error).message);
        }
        if (!claims.canSubscribe && !claims.canPublish) {
          throw new JoinError('bad_token', 'token grants neither publish nor subscribe');
        }
        participantId = await rooms.join({ send, close: () => ws.close(1000) }, claims, String(msg.sdp));
        clearTimeout(joinTimer);
        if (ws.readyState !== ws.OPEN) await rooms.leave(participantId);
      } catch (err) {
        const code = err instanceof JoinError ? err.code : 'internal';
        send({ type: 'error', code, message: (err as Error).message });
        ws.close(4001, code);
      } finally {
        joining = false;
      }
      return;
    }
    if (!participantId) return;
    if (msg.type === 'prefs') {
      await rooms.setPrefs(participantId, Array.isArray(msg.pins) ? msg.pins : [], Number(msg.page), Boolean(msg.hidden));
    } else if (msg.type === 'camera') {
      rooms.setCamera(participantId, msg.on === true);
    } else if (msg.type === 'hand') {
      rooms.setHand(participantId, msg.raised === true);
    } else if (msg.type === 'react') {
      rooms.react(participantId, String(msg.emoji ?? ''));
    } else if (msg.type === 'leave') {
      const id = participantId;
      participantId = null;
      await rooms.leave(id);
      ws.close(1000);
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (participantId) void rooms.leave(participantId);
    participantId = null;
  });
}

async function pollStats(): Promise<void> {
  for (const w of pool.workers) {
    if (!w.alive) continue;
    try {
      const stats = await w.request('getStats', {});
      const now = Date.now();
      const prev = samples.get(w.index);
      const dt = prev ? (now - prev.at) / 1000 : 0;
      samples.set(w.index, {
        stats,
        at: now,
        txMbps: prev && dt > 0 ? ((stats.txBytes - prev.stats.txBytes) * 8) / 1e6 / dt : 0,
        rxMbps: prev && dt > 0 ? ((stats.rxBytes - prev.stats.rxBytes) * 8) / 1e6 / dt : 0,
        txPps: prev && dt > 0 ? (stats.txPackets - prev.stats.txPackets) / dt : 0,
      });
    } catch {
      /* worker restarting */
    }
  }
}

async function main(): Promise<void> {
  if (config.jwtSecretIsDefault) {
    console.warn('[signaling] JWT_SECRET is not set; using an insecure development secret');
  }
  if (!config.apiKey) {
    console.warn('[signaling] API_KEY is not set; anyone can mint tokens (fine for local development)');
  }

  if (!config.adminApiKey) {
    console.warn('[signaling] ADMIN_API_KEY is not set; /admin is only reachable from localhost');
  }
  await settings.load();
  console.log(`[signaling] recording for new rooms: ${settings.get().recordingEnabled ? 'on' : 'off'}`);

  await mkdir(config.egress.recordingsDir, { recursive: true });
  const recovered = await recoverIncompleteRooms(config.egress.recordingsDir, config.egress.ffmpegPath);
  if (recovered > 0) console.log(`[signaling] recovered ${recovered} interrupted recording(s)`);

  await pool.start();
  console.log(
    `[signaling] ${pool.workers.length} media worker(s) on UDP ${config.mediaPortBase}-${config.mediaPortBase + pool.workers.length - 1}, announced as ${config.announcedIp}`,
  );

  const server = http.createServer((req, res) => void handleHttp(req, res));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('connection', handleSocket);
  server.listen(config.port, config.host, () => {
    console.log(`[signaling] listening on http://${config.host}:${config.port}`);
  });

  const statsTimer = setInterval(() => void pollStats(), 5000);

  let scheduler: { stop(): void } | null = null;
  const s3 = config.egress.s3;
  if (s3) {
    const uploader = createS3Uploader(s3);
    scheduler = startCleanupScheduler({
      dir: config.egress.recordingsDir,
      cleanupTime: config.egress.cleanupTime,
      watermarkBytes: config.egress.cleanupWatermarkBytes,
      run: () =>
        runCleanup({
          dir: config.egress.recordingsDir,
          uploader,
          prefix: s3.prefix,
          // Uploads only use what live calls leave free, capped by CLEANUP_MAX_MBPS.
          rateBps: () => {
            const spare = config.capacityMbps - currentTxMbps();
            return Math.max(1, Math.min(config.egress.cleanupMaxMbps, spare)) * 1e6;
          },
        }),
    });
    console.log(`[signaling] cleanup scheduled daily at ${config.egress.cleanupTime} and below the disk watermark`);
  } else {
    console.warn('[signaling] S3 is not configured; recordings stay in RECORDINGS_DIR until uploaded manually');
  }

  const shutdown = async () => {
    console.log('[signaling] shutting down');
    clearInterval(statsTimer);
    scheduler?.stop();
    wss.close();
    server.close();
    await rooms.shutdown();
    pool.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err: Error) => {
  console.error(`[signaling] fatal: ${err.message}`);
  process.exit(1);
});
