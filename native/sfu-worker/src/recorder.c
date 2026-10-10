// SPDX-License-Identifier: Apache-2.0
#include "recorder.h"

#define WRITE_BUFFER (128 * 1024)
#define MAX_FRAME (4 * 1024 * 1024)

typedef struct {
    bool init;
    uint32_t last;
    uint64_t high;
    uint64_t first;
} ts_unwrap_t;

static uint64_t unwrap(ts_unwrap_t *u, uint32_t ts) {
    if (!u->init) {
        u->init = true;
        u->last = ts;
        u->first = ts;
        return 0;
    }
    if (ts < u->last && u->last - ts > 0x80000000u) u->high += 1ULL << 32;
    else if (ts > u->last && ts - u->last > 0x80000000u && u->high) u->high -= 1ULL << 32;
    u->last = ts;
    return (u->high | ts) - u->first;
}

static void put_le16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}
static void put_le32(uint8_t *p, uint32_t v) {
    for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
}
static void put_le64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}

static FILE *open_buffered(const char *path) {
    FILE *f = fopen(path, "wb");
    if (f) setvbuf(f, NULL, _IOFBF, WRITE_BUFFER);
    else LOG("cannot open %s for recording", path);
    return f;
}

/* ---- IVF ---- */

struct ivf_writer {
    FILE *f;
    uint8_t *frame;
    size_t frame_len;
    bool in_frame;
    uint32_t frame_ts;
    uint16_t expect_seq;
    bool waiting_keyframe;
    uint32_t frames;
    ts_unwrap_t clock;
};

ivf_writer_t *ivf_open(const char *path, bool vp9) {
    ivf_writer_t *w = calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->f = open_buffered(path);
    w->frame = malloc(MAX_FRAME);
    if (!w->f || !w->frame) {
        if (w->f) fclose(w->f);
        free(w->frame);
        free(w);
        return NULL;
    }
    uint8_t h[32] = {0};
    memcpy(h, "DKIF", 4);
    put_le16(h + 4, 0);
    put_le16(h + 6, 32);
    memcpy(h + 8, vp9 ? "VP90" : "VP80", 4);
    put_le16(h + 12, 320); /* nominal; decoders read real dimensions from the bitstream */
    put_le16(h + 14, 180);
    put_le32(h + 16, 90000); /* timebase = RTP clock */
    put_le32(h + 20, 1);
    fwrite(h, 1, sizeof(h), w->f);
    w->waiting_keyframe = true;
    return w;
}

static void ivf_write_frame(ivf_writer_t *w) {
    uint8_t h[12];
    put_le32(h, (uint32_t)w->frame_len);
    put_le64(h + 4, unwrap(&w->clock, w->frame_ts));
    fwrite(h, 1, sizeof(h), w->f);
    fwrite(w->frame, 1, w->frame_len, w->f);
    w->frames++;
}

void ivf_push(ivf_writer_t *w, const rtp_pkt_t *pkt, const vpx_desc_t *d) {
    if (!w) return;
    if (w->waiting_keyframe) {
        if (!(d->start_of_frame && d->keyframe)) return;
        w->waiting_keyframe = false;
        w->in_frame = false;
    }
    if (w->in_frame && pkt->ts != w->frame_ts) w->in_frame = false; /* lost the marker packet */
    if (!w->in_frame) {
        if (!d->start_of_frame) return;
        w->in_frame = true;
        w->frame_ts = pkt->ts;
        w->frame_len = 0;
        w->expect_seq = pkt->seq;
    }
    if (pkt->seq != w->expect_seq) {
        /* A hole in the frame corrupts every frame that references it; resync on a keyframe. */
        w->in_frame = false;
        w->waiting_keyframe = true;
        return;
    }
    w->expect_seq++;
    size_t n = pkt->payload_len - d->header_len;
    if (w->frame_len + n > MAX_FRAME) {
        w->in_frame = false;
        w->waiting_keyframe = true;
        return;
    }
    memcpy(w->frame + w->frame_len, pkt->payload + d->header_len, n);
    w->frame_len += n;
    if (pkt->marker) {
        ivf_write_frame(w);
        w->in_frame = false;
    }
}

bool ivf_wants_keyframe(const ivf_writer_t *w) { return w && w->waiting_keyframe; }
uint32_t ivf_frame_count(const ivf_writer_t *w) { return w ? w->frames : 0; }

void ivf_close(ivf_writer_t *w) {
    if (!w) return;
    uint8_t count[4];
    put_le32(count, w->frames);
    fseek(w->f, 24, SEEK_SET);
    fwrite(count, 1, 4, w->f);
    fclose(w->f);
    free(w->frame);
    free(w);
}

/* ---- Ogg Opus (RFC 7845) ---- */

uint32_t ogg_crc32(const uint8_t *buf, size_t len) {
    static uint32_t table[256];
    static bool ready = false;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t r = i << 24;
            for (int k = 0; k < 8; k++) r = (r & 0x80000000u) ? (r << 1) ^ 0x04C11DB7u : r << 1;
            table[i] = r;
        }
        ready = true;
    }
    uint32_t crc = 0;
    for (size_t i = 0; i < len; i++) crc = (crc << 8) ^ table[((crc >> 24) ^ buf[i]) & 0xFF];
    return crc;
}

struct ogg_writer {
    FILE *f;
    uint32_t serial;
    uint32_t page_seq;
    ts_unwrap_t clock;
    uint8_t *pending;
    size_t pending_len;
    uint64_t pending_granule;
    bool has_pending;
};

static void ogg_write_page(ogg_writer_t *w, uint8_t flags, uint64_t granule, const uint8_t *data,
                           size_t len) {
    uint8_t page[27 + 255 + 65025];
    size_t segments = len / 255 + 1;
    if (segments > 255) return; /* Opus packets are far smaller than one page */
    memcpy(page, "OggS", 4);
    page[4] = 0;
    page[5] = flags;
    put_le64(page + 6, granule);
    put_le32(page + 14, w->serial);
    put_le32(page + 18, w->page_seq++);
    put_le32(page + 22, 0);
    page[26] = (uint8_t)segments;
    for (size_t i = 0; i < segments; i++)
        page[27 + i] = (uint8_t)(i + 1 < segments ? 255 : len % 255);
    size_t hdr = 27 + segments;
    memcpy(page + hdr, data, len);
    put_le32(page + 22, ogg_crc32(page, hdr + len));
    fwrite(page, 1, hdr + len, w->f);
}

ogg_writer_t *ogg_open(const char *path) {
    ogg_writer_t *w = calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->f = open_buffered(path);
    w->pending = malloc(65536);
    if (!w->f || !w->pending) {
        if (w->f) fclose(w->f);
        free(w->pending);
        free(w);
        return NULL;
    }
    w->serial = (uint32_t)(uv_hrtime() & 0xFFFFFFFF);
    uint8_t head[19] = {0};
    memcpy(head, "OpusHead", 8);
    head[8] = 1;
    head[9] = 2;
    put_le16(head + 10, 0);
    put_le32(head + 12, 48000);
    ogg_write_page(w, 0x02, 0, head, sizeof(head));
    static const char vendor[] = "mirror";
    uint8_t tags[8 + 4 + sizeof(vendor) - 1 + 4];
    memcpy(tags, "OpusTags", 8);
    put_le32(tags + 8, sizeof(vendor) - 1);
    memcpy(tags + 12, vendor, sizeof(vendor) - 1);
    put_le32(tags + 12 + sizeof(vendor) - 1, 0);
    ogg_write_page(w, 0, 0, tags, sizeof(tags));
    return w;
}

void ogg_push(ogg_writer_t *w, uint32_t rtp_ts, const uint8_t *payload, size_t len) {
    if (!w || len == 0 || len > 65535) return;
    /* Hold one packet back so the final page can carry the end-of-stream flag. */
    if (w->has_pending) ogg_write_page(w, 0, w->pending_granule, w->pending, w->pending_len);
    memcpy(w->pending, payload, len);
    w->pending_len = len;
    w->pending_granule = unwrap(&w->clock, rtp_ts) + 960;
    w->has_pending = true;
}

void ogg_close(ogg_writer_t *w) {
    if (!w) return;
    if (w->has_pending) ogg_write_page(w, 0x04, w->pending_granule, w->pending, w->pending_len);
    fclose(w->f);
    free(w->pending);
    free(w);
}
