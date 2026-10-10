// SPDX-License-Identifier: Apache-2.0
// End-to-end check: real signaling + C worker + headless Chromium with fake camera/mic.
//   pnpm e2e                 3 peers, verifies media and the finished recording
//   E2E_PEERS=12 pnpm e2e    more peers (exercises paging: 11 others > 10 tiles)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium, type Page } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PEERS = Number(process.env.E2E_PEERS ?? 3);
const PORT = Number(process.env.E2E_PORT ?? 7901);
const HOLD_MS = Number(process.env.E2E_HOLD_MS ?? 8000);
const base = `http://127.0.0.1:${PORT}`;

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(250);
  }
  return fail(`timed out waiting for ${what}`);
}

const recordingsDir = await mkdtemp(path.join(os.tmpdir(), 'mirror-e2e-'));
const server = spawn(process.execPath, ['apps/signaling/src/main.ts'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SIGNALING_HOST: '127.0.0.1',
    SIGNALING_PORT: String(PORT),
    RECORDINGS_DIR: recordingsDir,
    ROOM_EMPTY_TIMEOUT_SEC: '2',
    WORKER_COUNT: '1',
    MEDIA_BIND_IP: '127.0.0.1',
    MEDIA_PORT_BASE: String(Number(process.env.E2E_MEDIA_PORT ?? 41000)),
    ANNOUNCED_IP: '127.0.0.1',
    API_KEY: '',
    S3_BUCKET: '',
  },
});
let serverLog = '';
const onLog = (d: Buffer) => {
  serverLog += d.toString();
  if (process.env.E2E_VERBOSE) process.stderr.write(d);
};
server.stdout.on('data', onLog);
server.stderr.on('data', onLog);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  await waitFor('signaling /healthz', async () => (await fetch(`${base}/healthz`)).ok);
  console.log(`server up; recordings in ${recordingsDir}`);

  const pages: Page[] = [];
  for (let i = 0; i < PEERS; i++) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`[peer ${i}] page error: ${e.message}`));
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(base);
    await page.fill('input[name=room]', 'e2e');
    await page.fill('input[name=name]', `peer${i}`);
    await page.click('button[type=submit]');
    await page.waitForSelector('#call:not([hidden])', { timeout: 15000 }).catch(async () => {
      fail(`peer ${i} did not join: ${await page.textContent('#join-error')}`);
    });
    pages.push(page);
  }
  console.log(`${PEERS} peers joined`);

  for (const [i, page] of pages.entries()) {
    await waitFor(`peer ${i} ICE/DTLS connected`, () =>
      page.evaluate(() => (globalThis as any).mirrorDebug.connectionState === 'connected'),
    );
  }
  console.log('all peers connected (ICE + DTLS + SRTP)');

  const expectedTiles = Math.min(PEERS - 1, 10);
  for (const [i, page] of pages.entries()) {
    await waitFor(
      `peer ${i} to decode ${expectedTiles} video tile(s)`,
      async () => {
        const inbound: any[] = await page.evaluate(() => (globalThis as any).mirrorDebug.inbound());
        return inbound.filter((s) => s.kind === 'video' && s.framesDecoded > 10).length >= expectedTiles;
      },
      30000,
    );
  }
  console.log(`every peer decodes ${expectedTiles} remote video tile(s)`);

  const pageFps: number[][] = [];
  const decoded = async (page: Page) =>
    page.evaluate(() =>
      (globalThis as any).mirrorDebug.inbound().then((rows: { kind: string; mid: string; framesDecoded: number; packets: number }[]) =>
        rows.filter((s) => s.kind === 'video').map((s) => ({ mid: s.mid, frames: s.framesDecoded, packets: s.packets })),
      ),
    );
  const before = await Promise.all(pages.map(decoded));
  const fpsWindowMs = Math.min(HOLD_MS, 4000);
  await sleep(fpsWindowMs);
  if (HOLD_MS > fpsWindowMs) await sleep(HOLD_MS - fpsWindowMs);
  for (const [i, page] of pages.entries()) {
    const inbound: any[] = await page.evaluate(() => (globalThis as any).mirrorDebug.inbound());
    const after = inbound.filter((s) => s.kind === 'video');
    const audio = inbound.filter((s) => s.kind === 'audio' && s.packets > 0);
    const slots = await page.evaluate(() => (globalThis as any).mirrorDebug.slots);
    const filled = slots.video.filter(Boolean).length;
    const fps = after
      .map((s) => {
        const prev = before[i]!.find((b: { mid: string }) => b.mid === s.mid);
        return (s.framesDecoded - (prev?.frames ?? 0)) / (fpsWindowMs / 1000);
      })
      .filter((n) => n > 0.5);
    console.log(
      `  peer ${i}: ${filled} video slot(s), decoded fps [${fps.map((n) => n.toFixed(1)).join(', ')}], ${audio.length} audio slot(s) receiving`,
    );
    if (filled !== expectedTiles) fail(`peer ${i} has ${filled} filled video slots, expected ${expectedTiles}`);
    if (fps.length < expectedTiles) fail(`peer ${i} decoded ${fps.length} moving tile(s), expected ${expectedTiles}`);
    pageFps.push(fps);
  }

  const stats = (await (await fetch(`${base}/stats`)).json()) as {
    workers?: { stats?: Record<string, number> }[];
  };
  console.log('server /stats:', JSON.stringify(stats));
  const workerStats = stats.workers?.[0]?.stats;
  if (!workerStats) fail('worker stats missing');
  const num = (key: string) => workerStats[key] ?? 0;
  const dropRate = num('txPackets') ? num('queueDrops') / num('txPackets') : 1;
  console.log(
    `pacer: ${num('queueDrops')} drops (${(dropRate * 100).toFixed(1)}% of sent), ` +
      `${num('dropExpired')} expired, ${num('dropBudget')} over budget, ` +
      `estimate ${num('estimateKbps')} kbps, remb ${num('rembKbps')} kbps, ` +
      `loss ${num('maxLossPct')}%, temporal-layer drops ${num('tlDrops')}`,
  );
  if (dropRate > 0.02) {
    fail(`send queue dropped ${(dropRate * 100).toFixed(1)}% of packets on a nearly idle link`);
  }
  const flatFps = pageFps.flat();
  if (num('tlDrops') > 0) {
    for (const fps of flatFps) {
      if (fps > 20) fail(`tile decoded at ${fps.toFixed(1)} fps; temporal layer drop should cap tiles near 15`);
    }
    console.log('temporal layer cap holds: tiles stayed at or under 20 fps');
  } else {
    console.log('this browser sent no temporal layers, so the 15 fps cap was not exercised');
  }

  for (const page of pages) await page.click('#leave');
  console.log('all peers left; waiting for the room to end and the recording to finalize');

  const manifestPath = await waitFor(
    'recording manifest.json',
    async () => {
      for (const d of await readdir(recordingsDir)) {
        const p = path.join(recordingsDir, d, 'manifest.json');
        try {
          await readFile(p);
          return p;
        } catch {
          /* not yet */
        }
      }
      return undefined;
    },
    60000,
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log(`manifest: ${manifest.files.length} file(s), errors: ${JSON.stringify(manifest.errors)}`);
  if (manifest.status !== 'ready') fail(`manifest status ${manifest.status}`);
  if (manifest.files.length !== PEERS) fail(`expected ${PEERS} recorded files, got ${manifest.files.length}`);
  if (manifest.errors.length > 0) fail('finalize reported errors');

  const ffprobe = spawnSync('ffprobe', ['-version']);
  for (const f of manifest.files) {
    const file = path.join(path.dirname(manifestPath), f.name);
    let detail = '';
    if (ffprobe.status === 0) {
      const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_name',
        '-of', 'compact=p=0:nk=1',
        file,
      ]);
      detail = probe.stdout.toString().trim().replace(/\n/g, ' ');
      if (probe.status !== 0) fail(`ffprobe could not read ${f.name}: ${probe.stderr}`);
    }
    console.log(`  ${f.name}: ${(f.bytes / 1024).toFixed(0)} KiB ${detail}`);
  }
  console.log('\n✓ e2e passed');
} catch (err) {
  if (!process.exitCode) process.exitCode = 1;
  console.error((err as Error).message);
  console.error('--- server log ---\n' + serverLog.split('\n').slice(-40).join('\n'));
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(500);
  if (!process.exitCode) await rm(recordingsDir, { recursive: true, force: true });
}
