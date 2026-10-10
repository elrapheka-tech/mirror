// SPDX-License-Identifier: Apache-2.0
// One-shot cleanup: `pnpm cleanup`. Uploads every finalized recording now, ignoring the schedule.
import { loadEgressConfig } from './config.ts';
import { runCleanup } from './cleanup.ts';
import { createS3Uploader } from './s3.ts';

const config = loadEgressConfig();
if (!config.s3) {
  console.error('S3_BUCKET is not set; configure S3_* in .env first (see .env.example).');
  process.exit(1);
}
const result = await runCleanup({
  dir: config.recordingsDir,
  uploader: createS3Uploader(config.s3),
  prefix: config.s3.prefix,
  rateBps: () => config.cleanupMaxMbps * 1e6,
});
console.log(`uploaded ${result.uploaded.length}, failed ${result.failed.length}`);
process.exit(result.failed.length > 0 ? 1 : 0);
