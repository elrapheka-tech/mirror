// SPDX-License-Identifier: Apache-2.0
// Offer parsing and answer generation. The client always offers the same layout:
//   1 audio sendonly (mic), 1 video sendonly (camera),
//   AUDIO_SLOTS audio recvonly, VIDEO_SLOTS video recvonly.
// The server answers as ICE-lite + DTLS passive, accepting one codec per kind.
import { AUDIO_SLOTS, VIDEO_SLOTS, type VideoCodec } from '@mirror/protocol';

export const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';

export interface Payload {
  pt: number;
  codec: string;
  clock: number;
  channels?: number;
  fmtp?: string;
}

export interface MediaSection {
  kind: 'audio' | 'video';
  mid: string;
  direction: 'sendonly' | 'recvonly' | 'sendrecv' | 'inactive';
  payloads: Payload[];
  extmaps: { id: number; uri: string }[];
  fingerprint?: string;
}

export interface ParsedOffer {
  fingerprint: string | null;
  media: MediaSection[];
}

export interface SessionPlan {
  pubAudio: MediaSection;
  pubVideo: MediaSection;
  recvAudio: MediaSection[];
  recvVideo: MediaSection[];
  audioPt: number;
  videoCodec: VideoCodec;
  pubVideoPt: number;
  subVideoPt: number;
  audioLevelExtId: number;
  remoteFingerprint: string;
}

export class SdpError extends Error {
  code: 'bad_request' | 'codec_unsupported';
  constructor(code: 'bad_request' | 'codec_unsupported', message: string) {
    super(message);
    this.code = code;
  }
}

export function parseOffer(sdp: string): ParsedOffer {
  const lines = sdp.split(/\r?\n/).filter((l) => l.length > 0);
  let fingerprint: string | null = null;
  const media: MediaSection[] = [];
  let current: MediaSection | null = null;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      const [kindRaw, , , ...pts] = line.slice(2).split(' ');
      const kind = kindRaw === 'audio' || kindRaw === 'video' ? kindRaw : null;
      if (!kind) {
        current = null;
        continue;
      }
      current = {
        kind,
        mid: '',
        direction: 'sendrecv',
        payloads: pts.map((pt) => ({ pt: Number(pt), codec: '', clock: 0 })),
        extmaps: [],
      };
      media.push(current);
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const attr = line.slice(2);
    if (attr.startsWith('fingerprint:sha-256 ')) {
      const fp = attr.slice('fingerprint:sha-256 '.length).trim().toUpperCase();
      if (current) current.fingerprint = fp;
      else fingerprint = fp;
      continue;
    }
    if (!current) continue;
    if (attr.startsWith('mid:')) current.mid = attr.slice(4).trim();
    else if (['sendonly', 'recvonly', 'sendrecv', 'inactive'].includes(attr)) {
      current.direction = attr as MediaSection['direction'];
    } else if (attr.startsWith('rtpmap:')) {
      const m = /^rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?/.exec(attr);
      const p = m && current.payloads.find((x) => x.pt === Number(m[1]));
      if (m && p) {
        p.codec = m[2]!.toLowerCase();
        p.clock = Number(m[3]);
        if (m[4]) p.channels = Number(m[4]);
      }
    } else if (attr.startsWith('fmtp:')) {
      const m = /^fmtp:(\d+) (.*)$/.exec(attr);
      const p = m && current.payloads.find((x) => x.pt === Number(m[1]));
      if (m && p) p.fmtp = m[2]!.trim();
    } else if (attr.startsWith('extmap:')) {
      const m = /^extmap:(\d+)(?:\/\w+)? (\S+)/.exec(attr);
      if (m) current.extmaps.push({ id: Number(m[1]), uri: m[2]! });
    }
  }
  return { fingerprint, media };
}

function findPayload(section: MediaSection, codec: string): Payload | undefined {
  const candidates = section.payloads.filter((p) => p.codec === codec);
  if (codec === 'vp9') {
    // Profile 0 is the 8-bit 4:2:0 profile every VP9 decoder supports.
    return (
      candidates.find((p) => !p.fmtp || /profile-id=0\b/.test(p.fmtp) || !/profile-id/.test(p.fmtp)) ??
      undefined
    );
  }
  return candidates[0];
}

/** Codecs (in preference order) every video section of this offer can carry. */
export function supportedVideoCodecs(offer: ParsedOffer, preference: VideoCodec[]): VideoCodec[] {
  const video = offer.media.filter((m) => m.kind === 'video');
  return preference.filter((c) => video.length > 0 && video.every((m) => findPayload(m, c)));
}

export function planSession(offer: ParsedOffer, videoCodec: VideoCodec): SessionPlan {
  const pubAudio = offer.media.find((m) => m.kind === 'audio' && m.direction === 'sendonly');
  const pubVideo = offer.media.find((m) => m.kind === 'video' && m.direction === 'sendonly');
  const recvAudio = offer.media.filter((m) => m.kind === 'audio' && m.direction === 'recvonly');
  const recvVideo = offer.media.filter((m) => m.kind === 'video' && m.direction === 'recvonly');
  if (!pubAudio || !pubVideo) {
    throw new SdpError('bad_request', 'offer needs one sendonly audio and one sendonly video section');
  }
  if (recvAudio.length !== AUDIO_SLOTS || recvVideo.length !== VIDEO_SLOTS) {
    throw new SdpError(
      'bad_request',
      `offer needs ${AUDIO_SLOTS} recvonly audio and ${VIDEO_SLOTS} recvonly video sections`,
    );
  }
  if (offer.media.some((m) => !m.mid)) throw new SdpError('bad_request', 'every section needs a mid');

  const opus = findPayload(pubAudio, 'opus');
  if (!opus || recvAudio.some((m) => findPayload(m, 'opus')?.pt !== opus.pt)) {
    throw new SdpError('codec_unsupported', 'opus must be offered with one payload type');
  }
  const pubVideoPayload = findPayload(pubVideo, videoCodec);
  const subVideoPayload = findPayload(recvVideo[0]!, videoCodec);
  if (!pubVideoPayload || !subVideoPayload) {
    throw new SdpError('codec_unsupported', `this room uses ${videoCodec.toUpperCase()}`);
  }
  if (recvVideo.some((m) => findPayload(m, videoCodec)?.pt !== subVideoPayload.pt)) {
    throw new SdpError('bad_request', 'receive video sections must share one payload type');
  }
  const fingerprint = pubAudio.fingerprint ?? offer.fingerprint;
  if (!fingerprint) throw new SdpError('bad_request', 'offer has no sha-256 fingerprint');

  return {
    pubAudio,
    pubVideo,
    recvAudio,
    recvVideo,
    audioPt: opus.pt,
    videoCodec,
    pubVideoPt: pubVideoPayload.pt,
    subVideoPt: subVideoPayload.pt,
    audioLevelExtId: pubAudio.extmaps.find((e) => e.uri === AUDIO_LEVEL_URI)?.id ?? 0,
    remoteFingerprint: fingerprint,
  };
}

export interface AnswerParams {
  plan: SessionPlan;
  offer: ParsedOffer;
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  ip: string;
  port: number;
  audioSsrcs: number[];
  videoSsrcs: number[];
}

export function buildAnswer(a: AnswerParams): string {
  const { plan } = a;
  const out: string[] = [
    'v=0',
    `o=- ${Date.now()} 2 IN ${a.ip.includes(':') ? 'IP6' : 'IP4'} ${a.ip}`,
    's=mirror',
    't=0 0',
    'a=ice-lite',
    `a=group:BUNDLE ${a.offer.media.map((m) => m.mid).join(' ')}`,
    'a=msid-semantic: WMS *',
  ];
  const ipVersion = a.ip.includes(':') ? 'IP6' : 'IP4';

  for (const section of a.offer.media) {
    const isAudio = section.kind === 'audio';
    const pt = isAudio
      ? plan.audioPt
      : section === plan.pubVideo
        ? plan.pubVideoPt
        : plan.subVideoPt;
    const payload = section.payloads.find((p) => p.pt === pt)!;
    out.push(
      `m=${section.kind} 9 UDP/TLS/RTP/SAVPF ${pt}`,
      `c=IN ${ipVersion} ${a.ip}`,
      `a=rtcp:9 IN ${ipVersion} ${a.ip}`,
      `a=ice-ufrag:${a.iceUfrag}`,
      `a=ice-pwd:${a.icePwd}`,
      `a=fingerprint:sha-256 ${a.fingerprint}`,
      'a=setup:passive',
      `a=mid:${section.mid}`,
    );

    const publishing = section === plan.pubAudio || section === plan.pubVideo;
    out.push(publishing ? 'a=recvonly' : 'a=sendonly');
    out.push('a=rtcp-mux', 'a=rtcp-rsize');

    if (isAudio) {
      out.push(`a=rtpmap:${pt} opus/48000/2`);
      // usedtx=1 asks the sender to stop sending during silence (Opus DTX).
      out.push(`a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`);
      if (section === plan.pubAudio && plan.audioLevelExtId) {
        out.push(`a=extmap:${plan.audioLevelExtId} ${AUDIO_LEVEL_URI}`);
      }
    } else {
      out.push(`a=rtpmap:${pt} ${plan.videoCodec.toUpperCase()}/90000`);
      if (payload.fmtp) out.push(`a=fmtp:${pt} ${payload.fmtp}`);
      for (const fb of ['nack', 'nack pli', 'ccm fir', 'goog-remb']) out.push(`a=rtcp-fb:${pt} ${fb}`);
    }

    if (!publishing) {
      const index = isAudio ? plan.recvAudio.indexOf(section) : plan.recvVideo.indexOf(section);
      const ssrc = isAudio ? a.audioSsrcs[index]! : a.videoSsrcs[index]!;
      const stream = `mirror-${isAudio ? 'a' : 'v'}${index}`;
      out.push(`a=msid:${stream} ${stream}-track`);
      out.push(`a=ssrc:${ssrc} cname:mirror`);
      out.push(`a=ssrc:${ssrc} msid:${stream} ${stream}-track`);
    }
    out.push(`a=candidate:1 1 udp 2130706431 ${a.ip} ${a.port} typ host`, 'a=end-of-candidates');
  }
  return out.join('\r\n') + '\r\n';
}
