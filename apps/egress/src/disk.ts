// SPDX-License-Identifier: Apache-2.0
import { statfs } from 'node:fs/promises';

/** Bytes available to unprivileged writers on the filesystem holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
