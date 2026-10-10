// SPDX-License-Identifier: Apache-2.0
// Rooms, participants, forwarding, speaker detection and the 10-slot speaker-driven layout.
#pragma once

#include "common.h"
#include "json.h"

#include <sys/socket.h>

#define MAX_VSLOTS 10
#define MAX_ASLOTS 5

typedef struct {
    int audio_threshold;  /* RFC 6464 level (0 loudest .. 127 silent); <= threshold is voice */
    int max_audio_steady; /* speakers forwarded per subscriber */
    int surface_ms;       /* continuous speech before a speaker is surfaced into a tile */
    int min_tile_ms;      /* minimum time a tile stays before auto-replacement */
    int hangover_ms;      /* speaker stays "speaking" this long after going quiet */
    int queue_ms;         /* send queue bound */
    double start_bps;
    double min_bps;
    double max_bps;
    int publisher_remb_bps;
    int timeout_ms;
} worker_config_t;

extern worker_config_t g_cfg;

void room_on_packet(const struct sockaddr *from, uint8_t *buf, size_t len);
void room_dtls_send(void *user, const uint8_t *data, size_t len);
void room_tick_pacer(void);
void room_tick_100ms(void);
void room_tick_1s(void);

/* IPC methods. Return NULL on success (result object written to out) or an error message. */
const char *room_api_create_room(const json_t *params, sbuf_t *out);
const char *room_api_close_room(const json_t *params, sbuf_t *out);
const char *room_api_create_participant(const json_t *params, sbuf_t *out);
const char *room_api_close_participant(const json_t *params, sbuf_t *out);
const char *room_api_set_viewer_prefs(const json_t *params, sbuf_t *out);
const char *room_api_get_stats(const json_t *params, sbuf_t *out);
