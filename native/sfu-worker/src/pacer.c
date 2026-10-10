// SPDX-License-Identifier: Apache-2.0
#include "pacer.h"

#include "room.h"

#define RING_CAP 1024
/* Drain runs on a timer, so a packet can be a little older than the budget that admitted it. */
#define QUEUE_SLACK_MS 25
#define REMB_STALE_MS 2000

static double limit_bps(const pacer_t *p, uint64_t now) {
    double limit = p->estimate_bps;
    /* REMB from a receiver that is not losing packets tracks the media rate, and capping at the
     * media rate leaves no room for two tiles' frames arriving together. Apply it only once loss
     * shows the path is actually short, and ignore values that have gone stale. */
    bool fresh = p->remb_bps >= g_cfg.min_bps && p->remb_ms && now - p->remb_ms < REMB_STALE_MS;
    if (fresh && p->loss_limited && p->remb_bps < limit) limit = p->remb_bps;
    return limit;
}

static void ring_push(qring_t *r, qpkt_t *pkt) {
    if (!r->items) {
        r->items = calloc(RING_CAP, sizeof(*r->items));
        r->cap = RING_CAP;
    }
    r->items[(r->head + r->count) % r->cap] = pkt;
    r->count++;
}

static qpkt_t *ring_pop_front(qring_t *r) {
    qpkt_t *pkt = r->items[r->head];
    r->head = (r->head + 1) % r->cap;
    r->count--;
    return pkt;
}

static qpkt_t *ring_pop_back(qring_t *r) {
    r->count--;
    return r->items[(r->head + r->count) % r->cap];
}

void pacer_init(pacer_t *p, double start_bps) {
    memset(p, 0, sizeof(*p));
    p->estimate_bps = start_bps;
}

void pacer_free(pacer_t *p) {
    for (int i = 0; i < PRIO_COUNT; i++) {
        while (p->q[i].count) free(ring_pop_front(&p->q[i]));
        free(p->q[i].items);
    }
    memset(p, 0, sizeof(*p));
}

double pacer_limit_bps(const pacer_t *p, uint64_t now) { return limit_bps(p, now); }

static void count_drop(pacer_t *p, uint64_t now) {
    p->drops_total++;
    p->drops_window++;
    p->last_drop_ms = now;
}

bool pacer_enqueue(pacer_t *p, int prio, const uint8_t *data, size_t len, uint64_t now) {
    size_t budget = (size_t)(limit_bps(p, now) * g_cfg.queue_ms / 8000.0);
    if (budget < 4 * 1500) budget = 4 * 1500;
    while (p->queued_bytes + len > budget) {
        int victim = -1;
        for (int i = PRIO_COUNT - 1; i > prio; i--) {
            if (p->q[i].count) {
                victim = i;
                break;
            }
        }
        if (victim < 0) {
            if (prio == PRIO_AUDIO && p->q[PRIO_AUDIO].count) victim = PRIO_AUDIO;
            else {
                p->drops_budget++;
                count_drop(p, now);
                return false;
            }
        }
        qpkt_t *old = victim == PRIO_AUDIO ? ring_pop_front(&p->q[victim])
                                           : ring_pop_back(&p->q[victim]);
        p->queued_bytes -= old->len;
        free(old);
        p->drops_budget++;
        count_drop(p, now);
    }
    if (p->q[prio].count >= RING_CAP) {
        p->drops_budget++;
        count_drop(p, now);
        return false;
    }
    qpkt_t *pkt = malloc(sizeof(qpkt_t) + len);
    if (!pkt) return false;
    pkt->enqueued_ms = now;
    pkt->len = (uint16_t)len;
    memcpy(pkt->data, data, len);
    ring_push(&p->q[prio], pkt);
    p->queued_bytes += len;
    return true;
}

void pacer_drain(pacer_t *p, uint64_t now, pacer_send_fn send, void *user) {
    int first = -1;
    for (int i = 0; i < PRIO_COUNT; i++) {
        if (p->q[i].count) {
            first = i;
            break;
        }
    }
    if (first < 0) {
        /* Idle queues must not bank credit. Leave last_drain_ms alone so the next burst
         * may send up to one burst immediately instead of waiting out a timer tick. */
        if (p->credit_bytes > 0) p->credit_bytes = 0;
        return;
    }

    double rate = limit_bps(p, now) / 8000.0; /* bytes per ms */
    uint64_t dt = p->last_drain_ms ? now - p->last_drain_ms : 20;
    p->last_drain_ms = now;
    p->credit_bytes += rate * (double)dt;
    double burst = rate * 20.0;
    if (burst < 3000) burst = 3000;
    if (p->credit_bytes > burst) p->credit_bytes = burst;

    for (;;) {
        int prio = -1;
        for (int i = 0; i < PRIO_COUNT; i++) {
            if (p->q[i].count) {
                prio = i;
                break;
            }
        }
        if (prio < 0) {
            if (p->credit_bytes > 0) p->credit_bytes = 0;
            return;
        }
        qpkt_t *head = p->q[prio].items[p->q[prio].head];
        if (now - head->enqueued_ms > (uint64_t)g_cfg.queue_ms + QUEUE_SLACK_MS) {
            ring_pop_front(&p->q[prio]);
            p->queued_bytes -= head->len;
            free(head);
            p->drops_expired++;
            count_drop(p, now);
            continue;
        }
        if (p->credit_bytes <= 0) return;
        ring_pop_front(&p->q[prio]);
        p->queued_bytes -= head->len;
        p->credit_bytes -= head->len;
        send(user, head->data, head->len);
        free(head);
    }
}

void pacer_on_loss(pacer_t *p, double fraction, uint64_t now) {
    if (now - p->last_loss_update_ms < 500) return;
    p->last_loss_update_ms = now;
    p->last_fraction = fraction;
    p->loss_limited = fraction >= 0.02;
    if (fraction > 0.10) p->estimate_bps *= 1.0 - 0.5 * fraction;
    else if (fraction < 0.02) p->estimate_bps *= 1.08;
    if (p->estimate_bps < g_cfg.min_bps) p->estimate_bps = g_cfg.min_bps;
    if (p->estimate_bps > g_cfg.max_bps) p->estimate_bps = g_cfg.max_bps;
}

void pacer_on_remb(pacer_t *p, double bps, uint64_t now) {
    if (bps < g_cfg.min_bps) return;
    p->remb_bps = bps;
    p->remb_ms = now;
}
