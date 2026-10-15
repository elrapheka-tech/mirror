// SPDX-License-Identifier: Apache-2.0
// Turns a room's raw IVF/Ogg copy-out into one playable file plus manifest.json.
// The worker stays a forwarder. Mixing audio and building the camera grid cannot be a
// stream copy, so ffmpeg decodes the copy-out, composites, and encodes here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RecordedTrack, VideoCodec } from '@mirror/protocol';

export interface ManifestFile {
  name: string;
  /** Empty for the room file. Older manifests used a participant id here. */
  participantId: string;
  /** "av" / "audio" / "video" describe the one room file. "raw" is an older unmuxed source. */
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

/** Room-page tiles are 16:9. Two or more cameras use this cell; one camera fills a 720p frame. */
const CELL_W = 640;
const CELL_H = 360;
const SOLO_W = 1280;
const SOLO_H = 720;
const MAX_W = 1920;
const MAX_H = 1080;

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
  // nice keeps the encode from competing with the media workers for CPU.
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

function probeDurationMs(ffmpegPath: string, file: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const finish = () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (!m) {
        resolve(0);
        return;
      }
      const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
      resolve(Number.isFinite(ms) ? Math.round(ms) : 0);
    };
    proc.on('error', () => resolve(0));
    proc.on('exit', finish);
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

function even(n: number): number {
  const v = Math.floor(n) & ~1;
  return v >= 2 ? v : 2;
}

/** Row-major 16:9 grid, the same tile shape the room page uses. */
function gridShape(count: number): { cols: number; rows: number; cellW: number; cellH: number } {
  if (count <= 1) return { cols: 1, rows: 1, cellW: SOLO_W, cellH: SOLO_H };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  let cellW = CELL_W;
  let cellH = CELL_H;
  if (cols * cellW > MAX_W) {
    cellW = even(MAX_W / cols);
    cellH = even((cellW * 9) / 16);
  }
  if (rows * cellH > MAX_H) {
    cellH = even(MAX_H / rows);
    cellW = even((cellH * 16) / 9);
  }
  return { cols, rows, cellW, cellH };
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

interface Piece {
  participantId: string;
  audio?: RecordedTrack;
  video?: RecordedTrack;
}

function groupTracks(tracks: RecordedTrack[]): Piece[] {
  const map = new Map<string, Piece>();
  for (const t of tracks) {
    let piece = map.get(t.participantId);
    if (!piece) {
      piece = { participantId: t.participantId };
      map.set(t.participantId, piece);
    }
    piece[t.kind] = t;
  }
  return [...map.values()].sort((a, b) => {
    const ta = Math.min(a.audio?.startedAtMs ?? Infinity, a.video?.startedAtMs ?? Infinity);
    const tb = Math.min(b.audio?.startedAtMs ?? Infinity, b.video?.startedAtMs ?? Infinity);
    if (ta !== tb) return ta - tb;
    return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
  });
}

function videoBitrateK(width: number, height: number): number {
  return Math.max(400, Math.min(4000, Math.round((width * height) / 1000)));
}

interface TimedInput {
  index: number;
  offsetMs: number;
  durationMs: number;
}

function buildFilter(
  videos: TimedInput[],
  audios: TimedInput[],
  shape: { cols: number; cellW: number; cellH: number },
  roomMs: number,
): string {
  const chains: string[] = [];
  const vlabels: string[] = [];
  videos.forEach((v, i) => {
    const label = videos.length === 1 ? 'vout' : `v${i}`;
    vlabels.push(label);
    const tail = Math.max(0, roomMs - v.offsetMs - v.durationMs);
    // Cover-crop matches the room page (object-fit: cover) inside a 16:9 cell.
    chains.push(
      `[${v.index}:v]scale=${shape.cellW}:${shape.cellH}:force_original_aspect_ratio=increase,` +
        `crop=${shape.cellW}:${shape.cellH},setsar=1,fps=30,setpts=PTS-STARTPTS,format=yuv420p,` +
        `tpad=start_duration=${sec(v.offsetMs)}:stop_duration=${sec(tail)}:start_mode=add:stop_mode=add:color=black[${label}]`,
    );
  });
  if (videos.length > 1) {
    const layout = videos
      .map((_, i) => {
        const col = i % shape.cols;
        const row = Math.floor(i / shape.cols);
        return `${col * shape.cellW}_${row * shape.cellH}`;
      })
      .join('|');
    chains.push(`[${vlabels.join('][')}]xstack=inputs=${videos.length}:layout=${layout}:fill=black:shortest=0[vout]`);
  }

  const alabels: string[] = [];
  audios.forEach((a, i) => {
    const label = audios.length === 1 ? 'aout' : `a${i}`;
    alabels.push(label);
    chains.push(
      `[${a.index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `adelay=${a.offsetMs}:all=1,apad=whole_dur=${sec(roomMs)}[${label}]`,
    );
  });
  if (audios.length > 1) {
    chains.push(
      `[${alabels.join('][')}]amix=inputs=${audios.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `volume=${(1 / Math.sqrt(audios.length)).toFixed(4)}[aout]`,
    );
  }
  return chains.join(';');
}

function encodeArgs(container: 'mp4' | 'webm', hasVideo: boolean, hasAudio: boolean, bitrateK: number): string[] {
  const args: string[] = [];
  if (hasVideo && container === 'mp4') {
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      `${bitrateK}k`,
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
    );
  } else if (hasVideo) {
    args.push(
      '-c:v',
      'libvpx',
      '-b:v',
      `${bitrateK}k`,
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-auto-alt-ref',
      '0',
    );
  }
  if (hasAudio && container === 'mp4') args.push('-c:a', 'aac', '-b:a', '128k');
  else if (hasAudio) args.push('-c:a', 'libopus', '-b:a', '96k');
  if (container === 'mp4') args.push('-movflags', '+faststart');
  return args;
}

export async function finalizeRoom(input: FinalizeInput): Promise<Manifest> {
  const usable: RecordedTrack[] = [];
  for (const t of input.tracks) {
    if (await nonEmpty(t.path)) usable.push(t);
  }

  const container = input.codec === 'vp9' ? 'mp4' : 'webm';
  const base: Omit<Manifest, 'files' | 'errors'> = {
    version: 1,
    roomId: input.roomId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    codec: input.codec,
    status: 'ready',
    participants: input.roster,
  };

  if (usable.length === 0) {
    await Promise.all(input.tracks.map((t) => rm(t.path, { force: true })));
    const manifest: Manifest = { ...base, files: [], errors: [] };
    await writeManifest(input.dir, manifest);
    return manifest;
  }

  const pieces = groupTracks(usable);
  const t0 = Math.min(...usable.map((t) => t.startedAtMs));
  const durations = new Map<string, number>();
  await Promise.all(
    usable.map(async (t) => {
      durations.set(t.path, await probeDurationMs(input.ffmpegPath, t.path));
    }),
  );

  const inputs: string[] = [];
  const videos: TimedInput[] = [];
  const audios: TimedInput[] = [];
  for (const piece of pieces) {
    if (piece.video) {
      const offsetMs = Math.max(0, Math.round(piece.video.startedAtMs - t0));
      videos.push({
        index: inputs.length,
        offsetMs,
        durationMs: durations.get(piece.video.path) ?? 0,
      });
      inputs.push(piece.video.path);
    }
    if (piece.audio) {
      const offsetMs = Math.max(0, Math.round(piece.audio.startedAtMs - t0));
      audios.push({
        index: inputs.length,
        offsetMs,
        durationMs: durations.get(piece.audio.path) ?? 0,
      });
      inputs.push(piece.audio.path);
    }
  }

  let roomMs = 0;
  for (const item of [...videos, ...audios]) roomMs = Math.max(roomMs, item.offsetMs + item.durationMs);
  if (roomMs <= 0) roomMs = Math.max(1000, input.endedAt - input.startedAt);

  const shape = gridShape(videos.length);
  const width = shape.cols * shape.cellW;
  const height = Math.ceil(videos.length / shape.cols) * shape.cellH;
  const filter = buildFilter(videos, audios, shape, roomMs);
  const outName = `room.${container}`;
  const out = path.join(input.dir, outName);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const file of inputs) args.push('-i', file);
  args.push('-filter_complex', filter);
  if (videos.length > 0) args.push('-map', '[vout]');
  if (audios.length > 0) args.push('-map', '[aout]');
  args.push(...encodeArgs(container, videos.length > 0, audios.length > 0, videoBitrateK(width, height)), out);

  try {
    await runFfmpeg(input.ffmpegPath, args);
    if (!(await nonEmpty(out))) throw new Error('ffmpeg wrote an empty room file');
  } catch (err) {
    await rm(out, { force: true });
    // Leave the copy-out files in place and do not write a manifest, so the next
    // start can retry. They are not the room result.
    throw new Error(`room compose failed: ${(err as Error).message}`);
  }

  const kind: ManifestFile['kind'] = videos.length && audios.length ? 'av' : videos.length ? 'video' : 'audio';
  const file = await describe(input.dir, outName, '', kind);
  await Promise.all(input.tracks.map((t) => rm(t.path, { force: true })));
  const manifest: Manifest = { ...base, files: [file], errors: [] };
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

const ROOM_FILE = /^room\.(mp4|webm)$/;

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
      const roomName = names.find((name) => ROOM_FILE.test(name));
      if (!roomName) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      // Compose finished and the copy-out was removed, but the manifest write did not.
      const info = await stat(path.join(dir, roomName));
      const file = await describe(dir, roomName, '', 'av');
      await writeManifest(dir, {
        version: 1,
        roomId,
        startedAt: info.birthtimeMs || info.mtimeMs,
        endedAt: info.mtimeMs,
        codec: roomName.endsWith('.webm') ? 'vp8' : 'vp9',
        status: 'ready',
        participants: {},
        files: [file],
        errors: [],
      });
      recovered++;
      continue;
    }
    try {
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
    } catch (err) {
      // Copy-out stays on disk with no manifest, so a later start can try again.
      // It is not listed as the room result.
      console.error(`[egress] could not finalize ${entry.name}: ${(err as Error).message}`);
    }
  }
  return recovered;
}
