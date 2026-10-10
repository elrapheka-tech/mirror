// SPDX-License-Identifier: Apache-2.0
// RTP parsing/building and the RTCP messages the SFU sends.
#pragma once

#include "common.h"

#define RTCP_SR 200
#define RTCP_RR 201
#define RTCP_RTPFB 205
#define RTCP_PSFB 206

typedef struct {
    bool marker;
    uint8_t pt;
    uint16_t seq;
    uint32_t ts;
    uint32_t ssrc;
    size_t header_len;
    uint16_t ext_profile;
    const uint8_t *ext;
    size_t ext_len;
    const uint8_t *payload;
    size_t payload_len;
} rtp_pkt_t;

typedef struct {
    uint32_t ssrc;
    uint8_t fraction_lost;
    uint32_t cumulative_lost;
    uint32_t ext_highest_seq;
    uint32_t jitter;
    uint32_t lsr;
    uint32_t dlsr;
} rtcp_report_t;

bool rtp_parse(const uint8_t *buf, size_t len, rtp_pkt_t *pkt);
bool rtp_is_rtcp(const uint8_t *buf, size_t len);
/* Finds a one-byte (0xBEDE) or two-byte header extension element; returns its length or -1. */
int rtp_find_ext(const rtp_pkt_t *pkt, uint8_t id, const uint8_t **value);
/* Writes a 12-byte header with no CSRCs and no extensions (forwarded packets drop all
 * extensions because subscriber answers negotiate none). */
size_t rtp_write_header(uint8_t *out, bool marker, uint8_t pt, uint16_t seq, uint32_t ts,
                        uint32_t ssrc);

size_t rtcp_build_pli(uint8_t *out, uint32_t sender, uint32_t media);
size_t rtcp_build_nack(uint8_t *out, uint32_t sender, uint32_t media, const uint16_t *seqs, int n);
size_t rtcp_build_remb(uint8_t *out, uint32_t sender, uint64_t bps, const uint32_t *ssrcs, int n);
size_t rtcp_build_rr(uint8_t *out, uint32_t sender, const rtcp_report_t *blocks, int n);
