// SPDX-License-Identifier: Apache-2.0
// Admin-editable runtime settings, persisted to a JSON file so they survive restarts.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Settings {
  /** Whether newly created rooms are recorded. Rooms already running keep their state. */
  recordingEnabled: boolean;
}

export class SettingsStore {
  private file: string;
  private current: Settings;

  constructor(file: string, defaults: Settings) {
    this.file = file;
    this.current = { ...defaults };
  }

  /** Loads the saved file; missing file means "use the env defaults". */
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>;
      if (typeof saved.recordingEnabled === 'boolean') this.current.recordingEnabled = saved.recordingEnabled;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[signaling] ignoring unreadable settings file ${this.file}: ${(err as Error).message}`);
      }
    }
  }

  get(): Settings {
    return { ...this.current };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...this.current };
    if (patch.recordingEnabled !== undefined) {
      if (typeof patch.recordingEnabled !== 'boolean') throw new Error('recordingEnabled must be a boolean');
      next.recordingEnabled = patch.recordingEnabled;
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, this.file);
    this.current = next;
    return this.get();
  }
}
