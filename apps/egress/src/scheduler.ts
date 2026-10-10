// SPDX-License-Identifier: Apache-2.0
// Runs cleanup once a day at CLEANUP_TIME, and early whenever free disk drops below the watermark.
import { freeBytes } from './disk.ts';
import type { CleanupResult } from './cleanup.ts';

export interface SchedulerOptions {
  dir: string;
  cleanupTime: string;
  watermarkBytes: number;
  run: () => Promise<CleanupResult>;
  checkIntervalMs?: number;
  now?: () => Date;
}

export function msUntil(time: string, now: Date): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startCleanupScheduler(opts: SchedulerOptions): { stop(): void; runNow(): Promise<void> } {
  const now = opts.now ?? (() => new Date());
  let running: Promise<void> | null = null;
  let daily: NodeJS.Timeout | null = null;

  const runNow = (reason = 'manual'): Promise<void> => {
    if (running) return running;
    console.log(`[cleanup] starting (${reason})`);
    running = opts
      .run()
      .then((r) => console.log(`[cleanup] done: ${r.uploaded.length} uploaded, ${r.failed.length} failed`))
      .catch((err: Error) => console.error(`[cleanup] run failed: ${err.message}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const scheduleDaily = () => {
    daily = setTimeout(() => {
      void runNow('scheduled');
      scheduleDaily();
    }, msUntil(opts.cleanupTime, now()));
    daily.unref();
  };
  scheduleDaily();

  const watermark = setInterval(async () => {
    try {
      if ((await freeBytes(opts.dir)) < opts.watermarkBytes) void runNow('disk below watermark');
    } catch {
      /* recordings dir not created yet */
    }
  }, opts.checkIntervalMs ?? 60_000);
  watermark.unref();

  return {
    stop() {
      if (daily) clearTimeout(daily);
      clearInterval(watermark);
    },
    runNow: () => runNow(),
  };
}
