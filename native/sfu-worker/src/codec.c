// SPDX-License-Identifier: Apache-2.0
#include "codec.h"

static bool read_picture_id(const uint8_t *p, size_t n, size_t *off, vpx_desc_t *d) {
    if (*off >= n) return false;
    d->has_picture_id = true;
    d->picture_id_offset = *off;
    if (p[*off] & 0x80) {
        if (*off + 1 >= n) return false;
        d->picture_id_15bit = true;
        d->picture_id = (uint16_t)(((p[*off] & 0x7F) << 8) | p[*off + 1]);
        *off += 2;
    } else {
        d->picture_id = p[*off] & 0x7F;
        *off += 1;
    }
    return true;
}

bool vp8_parse(const uint8_t *p, size_t n, vpx_desc_t *d) {
    memset(d, 0, sizeof(*d));
    if (n < 1) return false;
    uint8_t b0 = p[0];
    size_t off = 1;
    bool start = b0 & 0x10;
    uint8_t pid = b0 & 0x07;
    if (b0 & 0x80) {
        if (off >= n) return false;
        uint8_t b1 = p[off++];
        if ((b1 & 0x80) && !read_picture_id(p, n, &off, d)) return false;
        if (b1 & 0x40) {
            if (off >= n) return false;
            d->has_tl0picidx = true;
            d->tl0picidx_offset = off;
            d->tl0picidx = p[off++];
        }
        if (b1 & 0x30) {
            if (off >= n) return false;
            if (b1 & 0x20) d->tid = p[off] >> 6;
            off++;
        }
    }
    d->start_of_frame = start && pid == 0;
    if (d->start_of_frame) {
        if (off >= n) return false;
        d->keyframe = (p[off] & 0x01) == 0;
    }
    d->header_len = off;
    return true;
}

bool vp9_parse(const uint8_t *p, size_t n, vpx_desc_t *d) {
    memset(d, 0, sizeof(*d));
    if (n < 1) return false;
    uint8_t b0 = p[0];
    bool has_i = b0 & 0x80, inter = b0 & 0x40, has_l = b0 & 0x20, flexible = b0 & 0x10;
    bool begin = b0 & 0x08, end = b0 & 0x04, has_ss = b0 & 0x02;
    size_t off = 1;
    if (has_i && !read_picture_id(p, n, &off, d)) return false;
    if (has_l) {
        if (off >= n) return false;
        d->tid = p[off] >> 5;
        d->sid = (p[off] >> 1) & 0x07;
        off++;
        if (!flexible) {
            if (off >= n) return false;
            d->has_tl0picidx = true;
            d->tl0picidx_offset = off;
            d->tl0picidx = p[off++];
        }
    }
    if (flexible && inter) {
        for (int i = 0; i < 3; i++) {
            if (off >= n) return false;
            bool more = p[off++] & 0x01;
            if (!more) break;
        }
    }
    if (has_ss) {
        if (off >= n) return false;
        uint8_t ss = p[off++];
        size_t spatial_layers = (size_t)(ss >> 5) + 1;
        if (ss & 0x10) off += 4 * spatial_layers;
        if (ss & 0x08) {
            if (off >= n) return false;
            uint8_t groups = p[off++];
            for (uint8_t g = 0; g < groups; g++) {
                if (off >= n) return false;
                off += 1 + ((p[off] >> 2) & 0x03);
            }
        }
        if (off > n) return false;
    }
    d->start_of_frame = begin;
    d->end_of_frame = end;
    d->keyframe = begin && !inter && d->sid == 0;
    d->header_len = off;
    return true;
}

void vpx_write_picture_id(uint8_t *p, const vpx_desc_t *d, uint16_t picture_id) {
    if (!d->has_picture_id) return;
    uint8_t *q = p + d->picture_id_offset;
    if (d->picture_id_15bit) {
        q[0] = (uint8_t)(0x80 | ((picture_id >> 8) & 0x7F));
        q[1] = (uint8_t)picture_id;
    } else {
        q[0] = (uint8_t)(picture_id & 0x7F);
    }
}

void vpx_write_tl0picidx(uint8_t *p, const vpx_desc_t *d, uint8_t value) {
    if (d->has_tl0picidx) p[d->tl0picidx_offset] = value;
}
