// SPDX-License-Identifier: Apache-2.0
// One C sfu-worker child process, driven over its stdin/stdout socketpair.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';

import {
  encodeFrame,
  FrameDecoder,
  type WorkerEvent,
  type WorkerMethod,
  type WorkerMethods,
  type WorkerResponse,
} from '@mirror/protocol';

const REQUEST_TIMEOUT_MS = 5000;

export interface WorkerOptions {
  index: number;
  binary: string;
  bindIp: string;
  port: number;
  cpu: number | null;
  extraArgs: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SfuWorker extends EventEmitter {
  readonly index: number;
  readonly port: number;
  fingerprint = '';
  alive = false;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private options: WorkerOptions;

  constructor(options: WorkerOptions) {
    super();
    this.options = options;
    this.index = options.index;
    this.port = options.port;
  }

  async start(): Promise<void> {
    const o = this.options;
    try {
      await access(o.binary);
    } catch {
      throw new Error(`sfu-worker binary not found at ${o.binary}; run "pnpm build:native"`);
    }
    const args = ['--port', String(o.port), '--bind', o.bindIp, ...o.extraArgs];
    if (o.cpu !== null) args.push('--cpu', String(o.cpu));
    const proc = spawn(o.binary, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    const decoder = new FrameDecoder();

    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker ${o.index} did not start`)), 5000);
      this.once('hello', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`worker ${o.index} exited during startup (code ${code})`));
      });
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) this.onMessage(msg as WorkerResponse | WorkerEvent);
    });
    proc.once('exit', (code, signal) => {
      this.alive = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('worker exited'));
      }
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    await hello;
    this.alive = true;
  }

  private onMessage(msg: WorkerResponse | WorkerEvent): void {
    if ('event' in msg) {
      if (msg.event === 'hello') this.fingerprint = msg.data.fingerprint;
      this.emit(msg.event, msg.data);
      this.emit('event', msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'worker error'));
  }

  request<M extends WorkerMethod>(
    method: M,
    params: WorkerMethods[M]['params'],
  ): Promise<WorkerMethods[M]['result']> {
    if (!this.proc || !this.alive) return Promise.reject(new Error('worker not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker ${this.index} ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin!.write(encodeFrame({ id, method, params }));
    });
  }

  stop(): void {
    this.proc?.kill('SIGTERM');
  }
}
