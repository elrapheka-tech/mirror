// SPDX-License-Identifier: Apache-2.0
// Browser <-> signaling WebSocket messages (JSON text frames).

export interface ParticipantInfo {
  id: string;
  name: string;
  cameraOn: boolean;
  handRaised: boolean;
}

/** Reactions the server will relay. Anything else is ignored. */
export const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '👀'] as const;

export type ClientMessage =
  | { type: 'join'; token: string; sdp: string }
  | { type: 'prefs'; pins: string[]; page: number; hidden: boolean }
  | { type: 'camera'; on: boolean }
  | { type: 'hand'; raised: boolean }
  | { type: 'react'; emoji: string }
  | { type: 'leave' };

export type ErrorCode =
  | 'bad_request'
  | 'bad_token'
  | 'server_full'
  | 'codec_unsupported'
  | 'worker_unavailable'
  | 'internal';

export type ServerMessage =
  | {
      type: 'joined';
      participantId: string;
      roomId: string;
      sdp: string;
      /** Offer mids of the receive-only transceivers, in slot order. */
      slotMids: { video: string[]; audio: string[] };
      participants: ParticipantInfo[];
      recording: boolean;
      recordingUnavailableReason?: string;
    }
  | { type: 'participantJoined'; participant: ParticipantInfo }
  | { type: 'participantLeft'; id: string }
  | { type: 'slots'; video: (string | null)[]; audio: (string | null)[] }
  | { type: 'speakers'; ids: string[] }
  | { type: 'camera'; id: string; on: boolean }
  | { type: 'hand'; id: string; raised: boolean }
  | { type: 'react'; id: string; emoji: string }
  | { type: 'error'; code: ErrorCode; message: string };
