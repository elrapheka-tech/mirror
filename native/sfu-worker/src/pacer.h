// SPDX-License-Identifier: Apache-2.0
// Per-subscriber send pacing: a bounded (~100 ms) priority queue drained at the bandwidth estimate.
#pragma once

#include "common.h"

enum {
    PRIO_AUDIO = 0,
    PRIO_RTX_KEY = 1, /* retransmissions and keyframe packets */
    PRIO_BASE = 2,    /* video temporal layer 0 */
    PRIO_ENH = 3,     /* higher video temporal layers */
    PRIO_COUNT = 4
};

typedef struct qpkt {
    uint64_t enqueued_ms;
    uint16_t len;
    uint8_t data[];
} qpkt_t;

typedef struct {
    qpkt_t **items;
    uint32_t head;
    uint32_t count;
    uint32_t cap;
} qring_t;

typedef struct {
    qring_t q[PRIO_COUNT];
    size_t queued_bytes;
    double estimate_bps;
    double remb_bps;
    double last_fraction;
    double credit_bytes;
    uint64_t last_drain_ms;
    uint64_t last_loss_update_ms;
    uint64_t remb_ms;
    uint32_t drops_total;
    uint32_t drops_expired;
    uint32_t drops_budget;
    uint32_t drops_window;
    uint64_t last_drop_ms;
    bool loss_limited; /* recent receiver report showed loss; REMB may cap the rate */
} pacer_t;

typedef void (*pacer_send_fn)(void *user, uint8_t *data, size_t len);

void pacer_init(pacer_t *p, double start_bps);
void pacer_free(pacer_t *p);
/* Copies the packet in. Under pressure drops lower-priority packets first; audio is never
 * dropped to make room for video. Returns false if this packet was dropped. */
bool pacer_enqueue(pacer_t *p, int prio, const uint8_t *data, size_t len, uint64_t now);
/* Sends what the budget allows; packets older than the queue limit are dropped, never sent late. */
void pacer_drain(pacer_t *p, uint64_t now, pacer_send_fn send, void *user);
/* Loss-based estimate update from a receiver report's fraction lost (0..1). */
void pacer_on_loss(pacer_t *p, double fraction, uint64_t now);
void pacer_on_remb(pacer_t *p, double bps, uint64_t now);
double pacer_limit_bps(const pacer_t *p, uint64_t now);
