// SPDX-License-Identifier: Apache-2.0
// Room and participant state. Rooms are pinned to one worker; media never touches Node.
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  AUDIO_SLOTS,
  REACTIONS,
  VIDEO_SLOTS,
  type ErrorCode,
  type ParticipantInfo,
  type RecordedTrack,
  type ServerMessage,
  type VideoCodec,
  type WorkerEvent,
} from '@mirror/protocol';
import { finalizeRoom, freeBytes } from '@mirror/egress';

import { canAdmit, totalMbps } from './admission.ts';
import type { SignalingConfig } from './config.ts';
import type { AccessClaims } from './jwt.ts';
import { buildAnswer, parseOffer, planSession, SdpError, supportedVideoCodecs } from './sdp.ts';
import type { SettingsStore } from './settings.ts';
import type { SfuWorker } from './worker.ts';
import type { WorkerPool } from './workers.ts';

export interface Connection {
  send(msg: ServerMessage): void;
  close(): void;
}

interface Participant {
  id: string;
  identity: string;
  name: string;
  roomId: string;
  conn: Connection;
  cameraOn: boolean;
  handRaised: boolean;
  lastReactMs: number;
}

interface Room {
  id: string;
  worker: SfuWorker;
  codec: VideoCodec;
  record: boolean;
  recordDir: string | null;
  recordingUnavailableReason?: string;
  participants: Map<string, Participant>;
  /** Everyone who joined during the room's life, for the recording manifest. */
  roster: Record<string, { name: string; identity: string }>;
  startedAt: number;
  emptyTimer: NodeJS.Timeout | null;
}

export class JoinError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x');
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private creating = new Map<string, Promise<Room>>();
  private participants = new Map<string, Participant>();
  private config: SignalingConfig;
  private pool: WorkerPool;
  private settings: SettingsStore;

  constructor(config: SignalingConfig, pool: WorkerPool, settings: SettingsStore) {
    this.config = config;
    this.pool = pool;
    this.settings = settings;
    pool.on('workerEvent', (worker: SfuWorker, ev: WorkerEvent) => this.onWorkerEvent(worker, ev));
    pool.on('workerExit', (worker: SfuWorker) => this.onWorkerExit(worker));
  }

  roomSizes(): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const r of this.rooms.values()) sizes.set(r.id, r.participants.size);
    return sizes;
  }

  projectedMbps(): number {
    return totalMbps(this.roomSizes().values(), this.config);
  }

  summary() {
    let recordingRooms = 0;
    for (const r of this.rooms.values()) if (r.record) recordingRooms++;
    return {
      rooms: this.rooms.size,
      recordingRooms,
      participants: this.participants.size,
      projectedMbps: Math.round(this.projectedMbps() * 10) / 10,
      capacityMbps: this.config.capacityMbps,
    };
  }

  private workerLoad(worker: SfuWorker): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.worker === worker) n += r.participants.size + 1;
    return n;
  }

  private async getOrCreateRoom(roomId: string, offerCodecs: VideoCodec[]): Promise<Room> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const pending = this.creating.get(roomId);
    if (pending) return pending;

    const create = (async (): Promise<Room> => {
      const worker = this.pool.pick((w) => this.workerLoad(w));
      if (!worker) throw new JoinError('worker_unavailable', 'no media worker is running');
      const codec = offerCodecs[0];
      if (!codec) throw new JoinError('codec_unsupported', 'no common video codec');

      let record = this.settings.get().recordingEnabled;
      let recordDir: string | null = null;
      let reason: string | undefined;
      if (record) {
        const egress = this.config.egress;
        await mkdir(egress.recordingsDir, { recursive: true });
        const free = await freeBytes(egress.recordingsDir);
        if (free < egress.recordingMinFreeBytes) {
          record = false;
          reason = `recording unavailable: only ${(free / 1e9).toFixed(1)} GB free on the recordings disk`;
          console.warn(`[signaling] ${reason} (room ${roomId})`);
        } else {
          recordDir = path.join(egress.recordingsDir, `${roomId}-${Date.now()}`);
          await mkdir(recordDir, { recursive: true });
        }
      }
      await worker.request('createRoom', {
        roomId,
        videoCodec: codec,
        record,
        recordDir: recordDir ?? '',
      });
      const room: Room = {
        id: roomId,
        worker,
        codec,
        record,
        recordDir,
        recordingUnavailableReason: reason,
        participants: new Map(),
        roster: {},
        startedAt: Date.now(),
        emptyTimer: null,
      };
      this.rooms.set(roomId, room);
      return room;
    })();
    this.creating.set(roomId, create);
    try {
      return await create;
    } finally {
      this.creating.delete(roomId);
    }
  }

  async join(conn: Connection, claims: AccessClaims, sdp: string): Promise<string> {
    let offer;
    try {
      offer = parseOffer(sdp);
    } catch {
      throw new JoinError('bad_request', 'could not parse SDP offer');
    }
    const admit = canAdmit(this.roomSizes(), claims.room, this.config);
    if (!admit.ok) {
      throw new JoinError(
        'server_full',
        `server is at capacity (${admit.projectedMbps.toFixed(0)} of ${this.config.capacityMbps} Mbps projected)`,
      );
    }

    const offerCodecs = supportedVideoCodecs(offer, this.config.videoCodecs);
    const room = await this.getOrCreateRoom(claims.room, offerCodecs);
    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }

    let plan;
    try {
      plan = planSession(offer, room.codec);
    } catch (err) {
      if (err instanceof SdpError) throw new JoinError(err.code, err.message);
      throw err;
    }

    const id = `P_${randomToken(9)}`;
    const iceUfrag = randomToken(6);
    const icePwd = randomToken(18);
    const used = new Set<number>();
    const ssrc = () => {
      let v;
      do v = randomInt(1, 0xffffffff);
      while (used.has(v));
      used.add(v);
      return v;
    };
    const audioSsrcs = Array.from({ length: AUDIO_SLOTS }, ssrc);
    const videoSsrcs = Array.from({ length: VIDEO_SLOTS }, ssrc);

    await room.worker.request('createParticipant', {
      roomId: room.id,
      participantId: id,
      iceUfrag,
      icePwd,
      remoteFingerprint: plan.remoteFingerprint,
      pub: {
        audioPt: claims.canPublish ? plan.audioPt : 0,
        videoPt: claims.canPublish ? plan.pubVideoPt : 0,
        audioLevelExtId: plan.audioLevelExtId,
      },
      sub: { audioPt: plan.audioPt, videoPt: plan.subVideoPt, audioSsrcs, videoSsrcs },
    });

    const answer = buildAnswer({
      plan,
      offer,
      iceUfrag,
      icePwd,
      fingerprint: room.worker.fingerprint,
      ip: this.config.announcedIp,
      port: room.worker.port,
      audioSsrcs,
      videoSsrcs,
    });

    const participant: Participant = {
      id,
      identity: claims.sub,
      name: claims.name || claims.sub,
      roomId: room.id,
      conn,
      cameraOn: true,
      handRaised: false,
      lastReactMs: 0,
    };
    const others = [...room.participants.values()].map((p) => this.info(p));
    room.participants.set(id, participant);
    room.roster[id] = { name: participant.name, identity: participant.identity };
    this.participants.set(id, participant);

    conn.send({
      type: 'joined',
      participantId: id,
      roomId: room.id,
      sdp: answer,
      slotMids: { video: plan.recvVideo.map((m) => m.mid), audio: plan.recvAudio.map((m) => m.mid) },
      participants: others,
      recording: room.record,
      recordingUnavailableReason: room.recordingUnavailableReason,
    });
    this.broadcast(room, { type: 'participantJoined', participant: this.info(participant) }, id);
    return id;
  }

  private info(p: Participant): ParticipantInfo {
    return { id: p.id, name: p.name, cameraOn: p.cameraOn, handRaised: p.handRaised };
  }

  private inRoom(participantId: string): { participant: Participant; room: Room } | null {
    const participant = this.participants.get(participantId);
    const room = participant && this.rooms.get(participant.roomId);
    return participant && room ? { participant, room } : null;
  }

  setCamera(participantId: string, on: boolean): void {
    const found = this.inRoom(participantId);
    if (!found || found.participant.cameraOn === on) return;
    found.participant.cameraOn = on;
    this.broadcast(found.room, { type: 'camera', id: participantId, on });
  }

  setHand(participantId: string, raised: boolean): void {
    const found = this.inRoom(participantId);
    if (!found || found.participant.handRaised === raised) return;
    found.participant.handRaised = raised;
    this.broadcast(found.room, { type: 'hand', id: participantId, raised });
  }

  react(participantId: string, emoji: string): void {
    const found = this.inRoom(participantId);
    if (!found || !(REACTIONS as readonly string[]).includes(emoji)) return;
    const now = Date.now();
    if (now - found.participant.lastReactMs < 400) return;
    found.participant.lastReactMs = now;
    this.broadcast(found.room, { type: 'react', id: participantId, emoji });
  }

  async setPrefs(participantId: string, pins: string[], page: number, hidden: boolean) {
    const p = this.participants.get(participantId);
    const room = p && this.rooms.get(p.roomId);
    if (!room) return;
    await room.worker
      .request('setViewerPrefs', {
        participantId,
        pins: pins.slice(0, 16).map(String),
        page: Math.max(0, Math.floor(page) || 0),
        hidden: Boolean(hidden),
      })
      .catch(() => undefined);
  }

  /** Removes a participant. workerAlreadyRemoved skips the IPC call (worker-initiated). */
  async leave(participantId: string, workerAlreadyRemoved = false): Promise<void> {
    const p = this.participants.get(participantId);
    if (!p) return;
    this.participants.delete(participantId);
    const room = this.rooms.get(p.roomId);
    if (!room) return;
    room.participants.delete(participantId);
    if (!workerAlreadyRemoved) {
      await room.worker.request('closeParticipant', { participantId }).catch(() => undefined);
    }
    this.broadcast(room, { type: 'participantLeft', id: participantId });
    if (room.participants.size === 0 && !room.emptyTimer) {
      room.emptyTimer = setTimeout(() => void this.endRoom(room), this.config.roomEmptyTimeoutMs);
    }
  }

  private async endRoom(room: Room, workerDied = false): Promise<void> {
    if (this.rooms.get(room.id) !== room) return;
    this.rooms.delete(room.id);
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    for (const p of room.participants.values()) {
      this.participants.delete(p.id);
      p.conn.close();
    }
    let tracks: RecordedTrack[] = [];
    if (!workerDied) {
      try {
        tracks = (await room.worker.request('closeRoom', { roomId: room.id })).tracks;
      } catch (err) {
        console.error(`[signaling] closeRoom ${room.id} failed: ${(err as Error).message}`);
      }
    }
    console.log(`[signaling] room ${room.id} ended (${tracks.length} recorded tracks)`);
    if (!room.recordDir) return;
    // Recovery on next start handles rooms whose worker died (no track list).
    if (workerDied) return;
    try {
      const manifest = await finalizeRoom({
        roomId: room.id,
        dir: room.recordDir,
        tracks,
        roster: room.roster,
        startedAt: room.startedAt,
        endedAt: Date.now(),
        codec: room.codec,
        ffmpegPath: this.config.egress.ffmpegPath,
      });
      console.log(
        `[signaling] recording ${room.id} ready: ${manifest.files.length} file(s) in ${room.recordDir}`,
      );
    } catch (err) {
      console.error(`[signaling] finalize ${room.id} failed: ${(err as Error).message}`);
    }
  }

  private broadcast(room: Room, msg: ServerMessage, exceptId?: string): void {
    for (const p of room.participants.values()) if (p.id !== exceptId) p.conn.send(msg);
  }

  private onWorkerEvent(worker: SfuWorker, ev: WorkerEvent): void {
    switch (ev.event) {
      case 'slots': {
        const p = this.participants.get(ev.data.participantId);
        p?.conn.send({ type: 'slots', video: ev.data.video, audio: ev.data.audio });
        break;
      }
      case 'speakers': {
        const room = this.rooms.get(ev.data.roomId);
        if (room && room.worker === worker) this.broadcast(room, { type: 'speakers', ids: ev.data.speakers });
        break;
      }
      case 'participantDisconnected': {
        const p = this.participants.get(ev.data.participantId);
        if (!p) break;
        console.log(`[signaling] ${p.id} disconnected by worker: ${ev.data.reason}`);
        p.conn.send({ type: 'error', code: 'internal', message: `media connection lost (${ev.data.reason})` });
        p.conn.close();
        void this.leave(p.id, true);
        break;
      }
      default:
        break;
    }
  }

  private onWorkerExit(worker: SfuWorker): void {
    for (const room of [...this.rooms.values()]) {
      if (room.worker !== worker) continue;
      this.broadcast(room, { type: 'error', code: 'worker_unavailable', message: 'media worker restarted' });
      void this.endRoom(room, true);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((r) => this.endRoom(r)));
  }
}
