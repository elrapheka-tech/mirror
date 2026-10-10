// SPDX-License-Identifier: Apache-2.0
// Uploads finalized recordings oldest-first, verifies each object, then deletes the local copy.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST, readManifest, sha256File, writeManifest, type Manifest } from './finalize.ts';

export interface Uploader {
  upload(
    key: string,
    file: string,
    opts: { bytes: number; sha256: string; contentType: string; rateBps: () => number },
  ): Promise<void>;
  /** Size and sha256 metadata of a stored object, or null if it does not exist. */
  head(key: string): Promise<{ bytes: number; sha256: string | undefined } | null>;
}

export interface CleanupOptions {
  dir: string;
  uploader: Uploader;
  prefix: string;
  rateBps: () => number;
  log?: (msg: string) => void;
}

export interface CleanupResult {
  uploaded: string[];
  failed: { room: string; error: string }[];
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.ivf': 'video/x-ivf',
  '.json': 'application/json',
};

async function uploadVerified(
  opts: CleanupOptions,
  key: string,
  file: string,
  bytes: number,
  sha256: string,
): Promise<void> {
  const contentType = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
  await opts.uploader.upload(key, file, { bytes, sha256, contentType, rateBps: opts.rateBps });
  const head = await opts.uploader.head(key);
  if (!head) throw new Error(`${key}: object missing after upload`);
  if (head.bytes !== bytes) throw new Error(`${key}: size mismatch (${head.bytes} != ${bytes})`);
  if (head.sha256 && head.sha256 !== sha256) throw new Error(`${key}: sha256 mismatch`);
}

export async function runCleanup(opts: CleanupOptions): Promise<CleanupResult> {
  const log = opts.log ?? ((m: string) => console.log(`[cleanup] ${m}`));
  const result: CleanupResult = { uploaded: [], failed: [] };
  let entries;
  try {
    entries = await readdir(opts.dir, { withFileTypes: true });
  } catch {
    return result;
  }

  const ready: { name: string; dir: string; manifest: Manifest }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(opts.dir, e.name);
    const manifest = await readManifest(dir);
    // "uploading" means a previous run died mid-way; uploads are idempotent, so retry.
    if (manifest && (manifest.status === 'ready' || manifest.status === 'uploading')) {
      ready.push({ name: e.name, dir, manifest });
    }
  }
  ready.sort((a, b) => a.manifest.endedAt - b.manifest.endedAt);

  for (const { name, dir, manifest } of ready) {
    try {
      await writeManifest(dir, { ...manifest, status: 'uploading' });
      for (const f of manifest.files) {
        await uploadVerified(opts, `${opts.prefix}${name}/${f.name}`, path.join(dir, f.name), f.bytes, f.sha256);
      }
      const final: Manifest = { ...manifest, status: 'uploaded', uploadedAt: Date.now() };
      await writeManifest(dir, final);
      const manifestPath = path.join(dir, MANIFEST);
      const { size } = await stat(manifestPath);
      await uploadVerified(opts, `${opts.prefix}${name}/${MANIFEST}`, manifestPath, size, await sha256File(manifestPath));
      await rm(dir, { recursive: true, force: true });
      result.uploaded.push(name);
      log(`uploaded and removed ${name} (${manifest.files.length} file(s))`);
    } catch (err) {
      const error = (err as Error).message;
      result.failed.push({ room: name, error });
      log(`upload of ${name} failed, will retry next run: ${error}`);
      await writeManifest(dir, { ...manifest, status: 'ready' }).catch(() => undefined);
    }
  }
  return result;
}
