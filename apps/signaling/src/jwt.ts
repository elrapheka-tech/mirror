// SPDX-License-Identifier: Apache-2.0
// HS256 access tokens. Small enough to own instead of pulling in a JWT library.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessClaims {
  /** Stable user identity chosen by your backend. */
  sub: string;
  name: string;
  room: string;
  canPublish: boolean;
  canSubscribe: boolean;
  iat: number;
  exp: number;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

export function signToken(claims: Omit<AccessClaims, 'iat' | 'exp'>, secret: string, ttlSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessClaims = { ...claims, iat: now, exp: now + ttlSec };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [head, body, sig] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('unsupported token algorithm');
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('bad token signature');
  }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims;
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) throw new Error('token expired');
  if (typeof claims.room !== 'string' || typeof claims.sub !== 'string') {
    throw new Error('token missing room or sub');
  }
  return claims;
}

/** Room names double as directory names and worker IDs, so keep them boring. */
export const ROOM_NAME = /^[A-Za-z0-9_-]{1,48}$/;
