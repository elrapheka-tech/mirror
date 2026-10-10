// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';

export interface S3Config {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
}

export interface EgressConfig {
  recordingsDir: string;
  recordingMinFreeBytes: number;
  cleanupWatermarkBytes: number;
  /** Daily local time "HH:MM" for the scheduled upload run. */
  cleanupTime: string;
  cleanupMaxMbps: number;
  ffmpegPath: string;
  /** null when S3_BUCKET is unset: recordings stay on disk. */
  s3: S3Config | null;
}

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${key} must be a number, got "${raw}"`);
  return v;
}

export function loadEgressConfig(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  const cleanupTime = env.CLEANUP_TIME || '02:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cleanupTime)) {
    throw new Error(`CLEANUP_TIME must be HH:MM (24h), got "${cleanupTime}"`);
  }
  let s3: S3Config | null = null;
  if (env.S3_BUCKET) {
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing');
    }
    let prefix = env.S3_PREFIX ?? 'recordings/';
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    s3 = {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      prefix,
      forcePathStyle: !['0', 'false', 'no'].includes((env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase()),
    };
  }
  return {
    recordingsDir: path.resolve(repoRoot, env.RECORDINGS_DIR || 'recordings'),
    recordingMinFreeBytes: num(env, 'RECORDING_MIN_FREE_GB', 10) * 1e9,
    cleanupWatermarkBytes: num(env, 'CLEANUP_WATERMARK_GB', 30) * 1e9,
    cleanupTime,
    cleanupMaxMbps: num(env, 'CLEANUP_MAX_MBPS', 200),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    s3,
  };
}
