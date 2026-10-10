// SPDX-License-Identifier: Apache-2.0
// Starts one sfu-worker per configured core and restarts any that die.
import { EventEmitter } from 'node:events';

import type { SignalingConfig } from './config.ts';
import { SfuWorker } from './worker.ts';

export class WorkerPool extends EventEmitter {
  readonly workers: SfuWorker[] = [];
  private config: SignalingConfig;
  private stopping = false;

  constructor(config: SignalingConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    const c = this.config;
    for (let i = 0; i < c.workerCount; i++) {
      const worker = new SfuWorker({
        index: i,
        binary: c.workerBinary,
        bindIp: c.mediaBindIp,
        port: c.mediaPortBase + i,
        // Core 0 is left to Node and recording finalize; workers take cores 1..N.
        cpu: c.pinWorkerCpus ? i + 1 : null,
        extraArgs: c.workerArgs,
      });
      worker.on('exit', () => this.onExit(worker));
      worker.on('event', (ev) => this.emit('workerEvent', worker, ev));
      await worker.start();
      this.workers.push(worker);
    }
  }

  private onExit(worker: SfuWorker): void {
    this.emit('workerExit', worker);
    if (this.stopping) return;
    console.error(`[signaling] worker ${worker.index} exited; restarting in 1s`);
    setTimeout(() => {
      worker.start().catch((err: Error) => {
        console.error(`[signaling] worker ${worker.index} restart failed: ${err.message}`);
      });
    }, 1000);
  }

  /** Least-loaded live worker, by participant count. */
  pick(load: (w: SfuWorker) => number): SfuWorker | null {
    let best: SfuWorker | null = null;
    for (const w of this.workers) {
      if (!w.alive) continue;
      if (!best || load(w) < load(best)) best = w;
    }
    return best;
  }

  stop(): void {
    this.stopping = true;
    for (const w of this.workers) w.stop();
  }
}
