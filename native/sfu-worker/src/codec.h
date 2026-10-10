// SPDX-License-Identifier: Apache-2.0
// VP8 (RFC 7741) and VP9 (RFC 9628) payload descriptors: temporal layers, keyframes, rewriting.
#pragma once

#include "common.h"

typedef struct {
    size_t header_len; /* descriptor length; codec bitstream starts after it */
    bool start_of_frame;
    bool end_of_frame; /* VP9 E bit; VP8 relies on the RTP marker */
    bool keyframe;     /* only meaningful when start_of_frame */
    bool has_picture_id;
    bool picture_id_15bit;
    uint16_t picture_id;
    size_t picture_id_offset;
    bool has_tl0picidx;
    uint8_t tl0picidx;
    size_t tl0picidx_offset;
    uint8_t tid;
    uint8_t sid;
} vpx_desc_t;

bool vp8_parse(const uint8_t *p, size_t n, vpx_desc_t *d);
bool vp9_parse(const uint8_t *p, size_t n, vpx_desc_t *d);
/* Rewrites the picture ID in place, keeping its 7- or 15-bit width. */
void vpx_write_picture_id(uint8_t *p, const vpx_desc_t *d, uint16_t picture_id);
void vpx_write_tl0picidx(uint8_t *p, const vpx_desc_t *d, uint8_t value);
static inline uint16_t vpx_picture_id_mask(const vpx_desc_t *d) {
    return d->picture_id_15bit ? 0x7FFF : 0x7F;
}
