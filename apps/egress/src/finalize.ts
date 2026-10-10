// SPDX-License-Identifier: Apache-2.0
// Turns a room's raw IVF/Ogg tracks into one playable file per participant plus manifest.json.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RecordedTrack, VideoCodec } from '@mirror/protocol';

export interface ManifestFile {
  name: string;
  participantId: string;
  /** "av" = muxed audio+video; "raw" = an unmuxed source kept because ffmpeg failed. */
  kind: 'av' | 'audio' | 'video' | 'raw';
  bytes: number;
  sha256: string;
}

export interface Manifest {
  version: 1;
  roomId: string;
  startedAt: number;
  endedAt: number;
  codec: VideoCodec;
  status: 'ready' | 'uploading' | 'uploaded';
  participants: Record<string, { name: string; identity: string }>;
  files: ManifestFile[];
  errors: string[];
  uploadedAt?: number;
}

export interface FinalizeInput {
  roomId: string;
  dir: string;
  tracks: RecordedTrack[];
  roster: Record<string, { name: string; identity: string }>;
  startedAt: number;
  endedAt: number;
  codec: VideoCodec;
  ffmpegPath: string;
}

export const MANIFEST = 'manifest.json';

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Atomic write: a reader never sees a half-written manifest. */
export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const tmp = path.join(dir, `${MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, path.join(dir, MANIFEST));
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  // nice keeps the remux from competing with the media workers for CPU.
  const useNice = process.platform !== 'win32';
  const cmd = useNice ? 'nice' : ffmpegPath;
  const full = useNice ? ['-n', '10', ffmpegPath, ...args] : args;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, full, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on('error', (err) => reject(new Error(`could not run ${ffmpegPath}: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function nonEmpty(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function describe(dir: string, name: string, participantId: string, kind: ManifestFile['kind']) {
  const file = path.join(dir, name);
  const [info, sha256] = await Promise.all([stat(file), sha256File(file)]);
  return { name, participantId, kind, bytes: info.size, sha256 } satisfies ManifestFile;
}

export async function finalizeRoom(input: FinalizeInput): Promise<Manifest> {
  const byParticipant = new Map<string, { audio?: RecordedTrack; video?: RecordedTrack }>();
  for (const t of input.tracks) {
    if (!(await nonEmpty(t.path))) continue;
    const entry = byParticipant.get(t.participantId) ?? {};
    entry[t.kind] = t;
    byParticipant.set(t.participantId, entry);
  }

  const files: ManifestFile[] = [];
  const errors: string[] = [];
  const container = input.codec === 'vp9' ? 'mp4' : 'webm';

  for (const [participantId, { audio, video }] of byParticipant) {
    const kind = audio && video ? 'av' : video ? 'video' : 'audio';
    const outName = `${participantId}.${video ? container : 'ogg'}`;
    const out = path.join(input.dir, outName);
    const t0 = Math.min(audio?.startedAtMs ?? Infinity, video?.startedAtMs ?? Infinity);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const t of [video, audio]) {
      if (!t) continue;
      const offset = ((t.startedAtMs - t0) / 1000).toFixed(3);
      args.push('-itsoffset', offset, '-i', t.path);
    }
    args.push('-c', 'copy');
    if (video && container === 'mp4') args.push('-movflags', '+faststart');
    args.push(out);
    try {
      await runFfmpeg(input.ffmpegPath, args);
      files.push(await describe(input.dir, outName, participantId, kind));
      for (const t of [video, audio]) if (t) await rm(t.path, { force: true });
    } catch (err) {
      errors.push(`${participantId}: ${(err as Error).message}`);
      await rm(out, { force: true });
      for (const t of [video, audio]) {
        if (t) files.push(await describe(input.dir, path.basename(t.path), participantId, 'raw'));
      }
    }
  }

  const manifest: Manifest = {
    version: 1,
    roomId: input.roomId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    codec: input.codec,
    status: 'ready',
    participants: input.roster,
    files,
    errors,
  };
  await writeManifest(input.dir, manifest);
  return manifest;
}

async function ivfCodec(file: string): Promise<VideoCodec> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);
    return buf.toString('latin1', 8, 12) === 'VP80' ? 'vp8' : 'vp9';
  } finally {
    await fh.close();
  }
}

/**
 * Finalizes recording directories left without a manifest (server crash or worker exit).
 * Raw IVF/Ogg are streamable, so everything written before the crash is recoverable.
 * Must run before workers start so no live room is touched.
 */
export async function recoverIncompleteRooms(recordingsDir: string, ffmpegPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(recordingsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(recordingsDir, entry.name);
    if (await readManifest(dir)) continue;
    const names = await readdir(dir);
    const tracks: RecordedTrack[] = [];
    let codec: VideoCodec = 'vp9';
    let startedAt = Infinity;
    let endedAt = 0;
    for (const name of names) {
      const m = /^(.+)-(audio|video)\.(ogg|ivf)$/.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      const info = await stat(file);
      const kind = m[2] as 'audio' | 'video';
      if (kind === 'video') codec = await ivfCodec(file);
      startedAt = Math.min(startedAt, info.birthtimeMs || info.mtimeMs);
      endedAt = Math.max(endedAt, info.mtimeMs);
      tracks.push({
        participantId: m[1]!,
        kind,
        path: file,
        codec: kind === 'audio' ? 'opus' : codec,
        // Exact start times died with the worker; birth time is the closest record.
        startedAtMs: info.birthtimeMs || info.mtimeMs,
      });
    }
    const roomId = entry.name.replace(/-\d+$/, '');
    if (tracks.length === 0) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    await finalizeRoom({
      roomId,
      dir,
      tracks,
      roster: {},
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      endedAt: endedAt || Date.now(),
      codec,
      ffmpegPath,
    });
    recovered++;
  }
  return recovered;
}
