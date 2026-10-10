// SPDX-License-Identifier: Apache-2.0
// Projected outbound bandwidth, used to refuse joins before the link saturates.
import { VIDEO_SLOTS } from '@mirror/protocol';

export interface CapacityModel {
  capacityMbps: number;
  videoTileKbps: number;
  audioKbps: number;
  avgSpeakers: number;
}

/** Outbound kbps for one room: each viewer gets min(n-1, 10) tiles plus the speakers' audio. */
export function roomKbps(n: number, m: CapacityModel): number {
  if (n <= 1) return 0;
  const others = n - 1;
  return n * (Math.min(others, VIDEO_SLOTS) * m.videoTileKbps + Math.min(others, m.avgSpeakers) * m.audioKbps);
}

export function totalMbps(roomSizes: Iterable<number>, m: CapacityModel): number {
  let kbps = 0;
  for (const n of roomSizes) kbps += roomKbps(n, m);
  return kbps / 1000;
}

/** Whether one more participant fits, given current room sizes and the room being joined. */
export function canAdmit(
  roomSizes: Map<string, number>,
  roomId: string,
  m: CapacityModel,
): { ok: boolean; projectedMbps: number } {
  const next = new Map(roomSizes);
  next.set(roomId, (next.get(roomId) ?? 0) + 1);
  const projectedMbps = totalMbps(next.values(), m);
  return { ok: projectedMbps <= m.capacityMbps, projectedMbps };
}
