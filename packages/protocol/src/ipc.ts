// SPDX-License-Identifier: Apache-2.0
// Node <-> C worker messages, sent as length-prefixed JSON over the worker's stdin/stdout socketpair.

export type VideoCodec = 'vp9' | 'vp8';

export interface CreateRoomParams {
  roomId: string;
  videoCodec: VideoCodec;
  record: boolean;
  /** Absolute directory the worker writes raw track files into. */
  recordDir: string;
}

export interface CreateParticipantParams {
  roomId: string;
  participantId: string;
  iceUfrag: string;
  icePwd: string;
  /** sha-256 fingerprint from the client's offer, "AA:BB:..." */
  remoteFingerprint: string;
  pub: {
    audioPt: number;
    videoPt: number;
    audioLevelExtId: number;
  };
  sub: {
    audioPt: number;
    videoPt: number;
    audioSsrcs: number[];
    videoSsrcs: number[];
  };
}

export interface ViewerPrefsParams {
  participantId: string;
  pins: string[];
  page: number;
  hidden: boolean;
}

export interface RecordedTrack {
  participantId: string;
  kind: 'audio' | 'video';
  path: string;
  codec: 'opus' | VideoCodec;
  /** Wall-clock time of the first packet written, ms since epoch. */
  startedAtMs: number;
}

export interface WorkerStats {
  rooms: number;
  participants: number;
  rxPackets: number;
  rxBytes: number;
  txPackets: number;
  txBytes: number;
  queueDrops: number;
  dropExpired: number;
  dropBudget: number;
  /** Video packets not forwarded because their temporal layer was above the tile cap. */
  tlDrops: number;
  estimateKbps: number;
  rembKbps: number;
  maxLossPct: number;
  lossLimited: number;
  rssBytes: number;
}

export interface WorkerMethods {
  createRoom: { params: CreateRoomParams; result: Record<string, never> };
  closeRoom: { params: { roomId: string }; result: { tracks: RecordedTrack[] } };
  createParticipant: { params: CreateParticipantParams; result: Record<string, never> };
  closeParticipant: { params: { participantId: string }; result: Record<string, never> };
  setViewerPrefs: { params: ViewerPrefsParams; result: Record<string, never> };
  getStats: { params: Record<string, never>; result: WorkerStats };
}

export type WorkerMethod = keyof WorkerMethods;

export interface WorkerRequest {
  id: number;
  method: WorkerMethod;
  params: unknown;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WorkerEvent =
  | { event: 'hello'; data: { fingerprint: string; port: number; pid: number } }
  | { event: 'participantConnected'; data: { participantId: string } }
  | { event: 'participantDisconnected'; data: { participantId: string; reason: string } }
  | {
      event: 'slots';
      data: { participantId: string; video: (string | null)[]; audio: (string | null)[] };
    }
  | { event: 'speakers'; data: { roomId: string; speakers: string[] } };
