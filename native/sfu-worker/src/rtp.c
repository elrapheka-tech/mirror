// SPDX-License-Identifier: Apache-2.0
#include "rtp.h"

bool rtp_parse(const uint8_t *buf, size_t len, rtp_pkt_t *pkt) {
    if (len < 12 || (buf[0] >> 6) != 2) return false;
    memset(pkt, 0, sizeof(*pkt));
    bool padding = buf[0] & 0x20;
    bool has_ext = buf[0] & 0x10;
    size_t cc = buf[0] & 0x0F;
    pkt->marker = buf[1] & 0x80;
    pkt->pt = buf[1] & 0x7F;
    pkt->seq = rd16(buf + 2);
    pkt->ts = rd32(buf + 4);
    pkt->ssrc = rd32(buf + 8);
    size_t off = 12 + cc * 4;
    if (off > len) return false;
    if (has_ext) {
        if (off + 4 > len) return false;
        pkt->ext_profile = rd16(buf + off);
        size_t ext_len = (size_t)rd16(buf + off + 2) * 4;
        if (off + 4 + ext_len > len) return false;
        pkt->ext = buf + off + 4;
        pkt->ext_len = ext_len;
        off += 4 + ext_len;
    }
    size_t end = len;
    if (padding) {
        uint8_t pad = buf[len - 1];
        if (pad == 0 || off + pad > len) return false;
        end -= pad;
    }
    pkt->header_len = off;
    pkt->payload = buf + off;
    pkt->payload_len = end - off;
    return true;
}

bool rtp_is_rtcp(const uint8_t *buf, size_t len) {
    return len >= 8 && buf[1] >= 192 && buf[1] <= 223;
}

int rtp_find_ext(const rtp_pkt_t *pkt, uint8_t id, const uint8_t **value) {
    if (!pkt->ext || id == 0) return -1;
    const uint8_t *p = pkt->ext, *end = pkt->ext + pkt->ext_len;
    if (pkt->ext_profile == 0xBEDE) {
        while (p < end) {
            uint8_t b = *p;
            if (b == 0) {
                p++;
                continue;
            }
            uint8_t eid = b >> 4;
            size_t elen = (size_t)(b & 0x0F) + 1;
            if (eid == 15 || p + 1 + elen > end) return -1;
            if (eid == id) {
                *value = p + 1;
                return (int)elen;
            }
            p += 1 + elen;
        }
    } else if ((pkt->ext_profile & 0xFFF0) == 0x1000) {
        while (p + 2 <= end) {
            uint8_t eid = p[0];
            if (eid == 0) {
                p++;
                continue;
            }
            size_t elen = p[1];
            if (p + 2 + elen > end) return -1;
            if (eid == id) {
                *value = p + 2;
                return (int)elen;
            }
            p += 2 + elen;
        }
    }
    return -1;
}

size_t rtp_write_header(uint8_t *out, bool marker, uint8_t pt, uint16_t seq, uint32_t ts,
                        uint32_t ssrc) {
    out[0] = 0x80;
    out[1] = (uint8_t)((marker ? 0x80 : 0) | (pt & 0x7F));
    wr16(out + 2, seq);
    wr32(out + 4, ts);
    wr32(out + 8, ssrc);
    return 12;
}

static void rtcp_header(uint8_t *out, uint8_t count_or_fmt, uint8_t pt, size_t total_len) {
    out[0] = (uint8_t)(0x80 | (count_or_fmt & 0x1F));
    out[1] = pt;
    wr16(out + 2, (uint16_t)(total_len / 4 - 1));
}

size_t rtcp_build_pli(uint8_t *out, uint32_t sender, uint32_t media) {
    rtcp_header(out, 1, RTCP_PSFB, 12);
    wr32(out + 4, sender);
    wr32(out + 8, media);
    return 12;
}

size_t rtcp_build_nack(uint8_t *out, uint32_t sender, uint32_t media, const uint16_t *seqs, int n) {
    size_t off = 12;
    int i = 0;
    while (i < n && off < 12 + 4 * 16) {
        uint16_t pid = seqs[i++];
        uint16_t blp = 0;
        while (i < n) {
            uint16_t d = (uint16_t)(seqs[i] - pid);
            if (d == 0 || d > 16) break;
            blp |= (uint16_t)(1u << (d - 1));
            i++;
        }
        wr16(out + off, pid);
        wr16(out + off + 2, blp);
        off += 4;
    }
    rtcp_header(out, 1, RTCP_RTPFB, off);
    wr32(out + 4, sender);
    wr32(out + 8, media);
    return off;
}

size_t rtcp_build_remb(uint8_t *out, uint32_t sender, uint64_t bps, const uint32_t *ssrcs, int n) {
    uint8_t exp = 0;
    uint64_t mantissa = bps;
    while (mantissa > 0x3FFFF) {
        mantissa >>= 1;
        exp++;
    }
    size_t len = 20 + (size_t)n * 4;
    rtcp_header(out, 15, RTCP_PSFB, len);
    wr32(out + 4, sender);
    wr32(out + 8, 0);
    memcpy(out + 12, "REMB", 4);
    out[16] = (uint8_t)n;
    out[17] = (uint8_t)((exp << 2) | ((mantissa >> 16) & 0x03));
    wr16(out + 18, (uint16_t)(mantissa & 0xFFFF));
    for (int i = 0; i < n; i++) wr32(out + 20 + i * 4, ssrcs[i]);
    return len;
}

size_t rtcp_build_rr(uint8_t *out, uint32_t sender, const rtcp_report_t *blocks, int n) {
    size_t len = 8 + (size_t)n * 24;
    rtcp_header(out, (uint8_t)n, RTCP_RR, len);
    wr32(out + 4, sender);
    for (int i = 0; i < n; i++) {
        uint8_t *b = out + 8 + i * 24;
        const rtcp_report_t *r = &blocks[i];
        wr32(b, r->ssrc);
        wr32(b + 4, ((uint32_t)r->fraction_lost << 24) | (r->cumulative_lost & 0xFFFFFF));
        wr32(b + 8, r->ext_highest_seq);
        wr32(b + 12, r->jitter);
        wr32(b + 16, r->lsr);
        wr32(b + 20, r->dlsr);
    }
    return len;
}
