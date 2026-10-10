// SPDX-License-Identifier: Apache-2.0
// Track recording without transcoding: VP8/VP9 into IVF, Opus into Ogg. Both formats are
// streamable, so a file cut short by a crash is still playable up to the last write.
#pragma once

#include "codec.h"
#include "rtp.h"

typedef struct ivf_writer ivf_writer_t;
typedef struct ogg_writer ogg_writer_t;

ivf_writer_t *ivf_open(const char *path, bool vp9);
void ivf_push(ivf_writer_t *w, const rtp_pkt_t *pkt, const vpx_desc_t *d);
/* True while the writer is waiting for a keyframe (start, or after packet loss). */
bool ivf_wants_keyframe(const ivf_writer_t *w);
uint32_t ivf_frame_count(const ivf_writer_t *w);
void ivf_close(ivf_writer_t *w);

ogg_writer_t *ogg_open(const char *path);
void ogg_push(ogg_writer_t *w, uint32_t rtp_ts, const uint8_t *payload, size_t len);
void ogg_close(ogg_writer_t *w);

uint32_t ogg_crc32(const uint8_t *buf, size_t len);
