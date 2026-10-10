// SPDX-License-Identifier: Apache-2.0
// S3-compatible uploader (AWS S3, MinIO, R2, ...) with a bandwidth cap so uploads never starve calls.
import { createReadStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transform, type TransformCallback } from 'node:stream';

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import type { Uploader } from './cleanup.ts';
import type { S3Config } from './config.ts';

/** Paces bytes to rateBps(), re-read per chunk so the cap follows live call traffic. */
class Throttle extends Transform {
  private rateBps: () => number;
  private start = Date.now();
  private budgetMs = 0;

  constructor(rateBps: () => number) {
    super();
    this.rateBps = rateBps;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.budgetMs += ((chunk.length * 8) / Math.max(this.rateBps(), 8000)) * 1000;
    const ahead = this.start + this.budgetMs - Date.now();
    if (ahead > 5) {
      sleep(ahead).then(() => cb(null, chunk), cb);
    } else {
      cb(null, chunk);
    }
  }
}

export function createS3Uploader(cfg: S3Config): Uploader {
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async upload(key, file, opts) {
      const body = createReadStream(file, { highWaterMark: 256 * 1024 }).pipe(new Throttle(opts.rateBps));
      await new Upload({
        client,
        params: {
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          Metadata: { sha256: opts.sha256 },
        },
        queueSize: 2,
        partSize: 16 * 1024 * 1024,
      }).done();
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { bytes: Number(res.ContentLength ?? -1), sha256: res.Metadata?.sha256 };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw err;
      }
    },
  };
}
