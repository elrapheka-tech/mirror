// SPDX-License-Identifier: Apache-2.0
// Purpose: message types shared by signaling, egress, the web client and the C worker IPC.

export * from './ipc.ts';
export * from './signal.ts';
export * from './framing.ts';

/** Video tiles per viewer; must match MAX_VSLOTS in native/sfu-worker/src/room.h. */
export const VIDEO_SLOTS = 10;
/** Audio streams per viewer (3 steady speakers + 2 for instant new speakers); must match MAX_ASLOTS. */
export const AUDIO_SLOTS = 5;
