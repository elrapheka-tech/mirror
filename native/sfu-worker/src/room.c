// SPDX-License-Identifier: Apache-2.0
#include "room.h"

#include "codec.h"
#include "dtls.h"
#include "ipc.h"
#include "net.h"
#include "pacer.h"
#include "recorder.h"
#include "rtp.h"
#include "stun.h"

#include <netinet/in.h>
#include <openssl/rand.h>
#include <srtp2/srtp.h>
#include <strings.h>

#define SERVER_SSRC 0x6D697272u /* "mirr": sender SSRC for our feedback packets */
#define HISTORY_SIZE 256
#define MAX_PINS 16
#define ID_MAX 64
#define SRTP_BUF (1500 + SRTP_MAX_TRAILER_LEN + 64)
#define ADDR_BUCKETS 4096
#define EVENT_MIN_INTERVAL_MS 300
#define KEYFRAME_MIN_INTERVAL_MS 500
#define NEW_SPEAKER_WINDOW_MS 1000
#define VIDEO_TS_STEP 3000 /* ~33 ms at 90 kHz, inserted when a slot switches source */
#define AUDIO_TS_STEP 960  /* 20 ms at 48 kHz */
/* Retransmitted packets are queued with CC=1 in the first byte so the send path knows not to
 * record them in history again; the bit is cleared before encryption. */
#define RTX_MARK 0x01

static uint64_t g_tl_drops;

worker_config_t g_cfg = {
    .audio_threshold = 55,
    .max_audio_steady = 3,
    .surface_ms = 1000,
    .min_tile_ms = 4000,
    .hangover_ms = 500,
    .queue_ms = 100,
    .start_bps = 1500000,
    .min_bps = 150000,
    .max_bps = 8000000,
    .publisher_remb_bps = 1000000,
    .timeout_ms = 15000,
};

typedef struct participant participant_t;
typedef struct room room_t;

typedef struct {
    participant_t *src;
    uint32_t ssrc;
    bool need_keyframe;
    bool started;
    bool paused;
    bool frame_key;
    uint64_t assigned_ms;
    uint16_t seq_off;
    uint32_t ts_off;
    uint16_t last_seq;
    uint32_t last_ts;
    uint16_t pid_off;
    uint16_t last_pid;
    uint8_t tl0_off;
    uint8_t last_tl0;
} slot_t;

typedef struct {
    bool init;
    uint16_t max_seq;
    uint32_t cycles;
    uint32_t base_seq;
    uint32_t received;
    uint32_t expected_prior;
    uint32_t received_prior;
    uint32_t lsr;
    uint64_t lsr_ms;
    uint32_t ssrc;
} rx_stats_t;

typedef struct {
    uint32_t ssrc;
    uint16_t seq;
    uint16_t len;
    uint8_t rtx_count;
    uint64_t sent_ms;
    uint8_t *data;
} hist_t;

struct participant {
    char id[ID_MAX];
    room_t *room;
    char ufrag[ID_MAX];
    char pwd[ID_MAX];
    char remote_fp[160];
    struct sockaddr_storage addr;
    bool has_addr;
    participant_t *addr_next;
    dtls_conn_t dtls;
    srtp_t srtp_in;
    srtp_t srtp_out;
    bool srtp_ready;
    uint64_t last_rx_ms;
    uint32_t join_seq;

    uint8_t pub_audio_pt;
    uint8_t pub_video_pt;
    uint8_t audio_level_ext;
    rx_stats_t astats;
    rx_stats_t vstats;
    bool video_seen;
    uint64_t last_pli_ms;
    double level_avg;
    uint64_t last_voice_ms;
    uint64_t speech_start_ms;
    ivf_writer_t *rec_video;
    ogg_writer_t *rec_audio;

    uint8_t sub_audio_pt;
    uint8_t sub_video_pt;
    slot_t vslot[MAX_VSLOTS];
    slot_t aslot[MAX_ASLOTS];
    char pins[MAX_PINS][ID_MAX];
    int npins;
    int page;
    bool hidden;
    pacer_t pacer;
    int congestion;
    uint64_t congestion_changed_ms;
    hist_t hist[HISTORY_SIZE];
    uint32_t hist_next;
    bool slots_dirty;
    uint64_t slots_sent_ms;
};

typedef struct {
    char participant_id[ID_MAX];
    char kind[8];
    char path[512];
    uint64_t started_ms;
} rec_track_t;

struct room {
    char id[ID_MAX];
    bool vp9;
    bool record;
    char record_dir[400];
    participant_t **members; /* join order */
    int nmembers;
    int members_cap;
    participant_t **order; /* video priority, rebuilt every tick */
    participant_t *audio_sel[MAX_ASLOTS];
    int naudio_sel;
    rec_track_t *tracks;
    int ntracks;
    int tracks_cap;
    char speakers_sig[2048];
    bool speakers_dirty;
    uint64_t speakers_sent_ms;
    uint32_t next_join_seq;
};

static room_t **g_rooms;
static int g_nrooms, g_rooms_cap;
static participant_t **g_parts;
static int g_nparts, g_parts_cap;
static participant_t *g_addr_tab[ADDR_BUCKETS];

/* ---------- small helpers ---------- */

static void *grow(void *arr, int *cap, int need, size_t elem) {
    if (need <= *cap) return arr;
    int ncap = *cap ? *cap * 2 : 16;
    while (ncap < need) ncap *= 2;
    void *n = realloc(arr, (size_t)ncap * elem);
    if (!n) abort();
    *cap = ncap;
    return n;
}

static void copy_id(char *dst, const char *src) {
    snprintf(dst, ID_MAX, "%s", src ? src : "");
}

static uint32_t rand32(void) {
    uint32_t v;
    RAND_bytes((unsigned char *)&v, sizeof(v));
    return v;
}

static room_t *find_room(const char *id) {
    for (int i = 0; i < g_nrooms; i++)
        if (strcmp(g_rooms[i]->id, id) == 0) return g_rooms[i];
    return NULL;
}

static participant_t *find_participant(const char *id) {
    for (int i = 0; i < g_nparts; i++)
        if (strcmp(g_parts[i]->id, id) == 0) return g_parts[i];
    return NULL;
}

static participant_t *find_by_ufrag(const char *ufrag, size_t len) {
    for (int i = 0; i < g_nparts; i++)
        if (strlen(g_parts[i]->ufrag) == len && memcmp(g_parts[i]->ufrag, ufrag, len) == 0)
            return g_parts[i];
    return NULL;
}

/* ---------- address index ---------- */

static uint32_t addr_hash(const struct sockaddr *sa) {
    uint32_t h = 2166136261u;
    const uint8_t *bytes;
    size_t n;
    uint16_t port;
    if (sa->sa_family == AF_INET6) {
        const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)sa;
        bytes = a->sin6_addr.s6_addr;
        n = 16;
        port = a->sin6_port;
    } else {
        const struct sockaddr_in *a = (const struct sockaddr_in *)sa;
        bytes = (const uint8_t *)&a->sin_addr.s_addr;
        n = 4;
        port = a->sin_port;
    }
    for (size_t i = 0; i < n; i++) h = (h ^ bytes[i]) * 16777619u;
    h = (h ^ (port & 0xFF)) * 16777619u;
    h = (h ^ (port >> 8)) * 16777619u;
    return h % ADDR_BUCKETS;
}

static bool addr_eq(const struct sockaddr *a, const struct sockaddr *b) {
    if (a->sa_family != b->sa_family) return false;
    if (a->sa_family == AF_INET6) {
        const struct sockaddr_in6 *x = (const struct sockaddr_in6 *)a;
        const struct sockaddr_in6 *y = (const struct sockaddr_in6 *)b;
        return x->sin6_port == y->sin6_port && !memcmp(&x->sin6_addr, &y->sin6_addr, 16);
    }
    const struct sockaddr_in *x = (const struct sockaddr_in *)a;
    const struct sockaddr_in *y = (const struct sockaddr_in *)b;
    return x->sin_port == y->sin_port && x->sin_addr.s_addr == y->sin_addr.s_addr;
}

static void addr_index_remove(participant_t *p) {
    if (!p->has_addr) return;
    participant_t **pp = &g_addr_tab[addr_hash((struct sockaddr *)&p->addr)];
    while (*pp) {
        if (*pp == p) {
            *pp = p->addr_next;
            break;
        }
        pp = &(*pp)->addr_next;
    }
    p->addr_next = NULL;
}

static void addr_index_set(participant_t *p, const struct sockaddr *sa) {
    addr_index_remove(p);
    size_t len = sa->sa_family == AF_INET6 ? sizeof(struct sockaddr_in6) : sizeof(struct sockaddr_in);
    memset(&p->addr, 0, sizeof(p->addr));
    memcpy(&p->addr, sa, len);
    p->has_addr = true;
    uint32_t h = addr_hash(sa);
    p->addr_next = g_addr_tab[h];
    g_addr_tab[h] = p;
}

static participant_t *addr_lookup(const struct sockaddr *sa) {
    for (participant_t *p = g_addr_tab[addr_hash(sa)]; p; p = p->addr_next)
        if (addr_eq((struct sockaddr *)&p->addr, sa)) return p;
    return NULL;
}

/* ---------- receive statistics (RFC 3550 A.3) ---------- */

/* Returns how many packets were skipped (a forward gap), 0 otherwise. */
static uint16_t rx_stats_update(rx_stats_t *s, uint32_t ssrc, uint16_t seq) {
    uint16_t gap = 0;
    if (!s->init || s->ssrc != ssrc) {
        memset(s, 0, sizeof(*s));
        s->init = true;
        s->ssrc = ssrc;
        s->base_seq = seq;
        s->max_seq = seq;
    } else if (seq_newer(seq, s->max_seq)) {
        uint16_t delta = (uint16_t)(seq - s->max_seq);
        if (delta > 1) gap = (uint16_t)(delta - 1);
        if (seq < s->max_seq) s->cycles += 65536;
        s->max_seq = seq;
    }
    s->received++;
    return gap;
}

static bool rx_stats_report(rx_stats_t *s, uint64_t now, rtcp_report_t *out) {
    if (!s->init) return false;
    uint32_t ext_max = s->cycles + s->max_seq;
    uint32_t expected = ext_max - s->base_seq + 1;
    int64_t lost = (int64_t)expected - (int64_t)s->received;
    if (lost < 0) lost = 0;
    uint32_t expected_interval = expected - s->expected_prior;
    uint32_t received_interval = s->received - s->received_prior;
    int64_t lost_interval = (int64_t)expected_interval - (int64_t)received_interval;
    s->expected_prior = expected;
    s->received_prior = s->received;
    memset(out, 0, sizeof(*out));
    out->ssrc = s->ssrc;
    out->fraction_lost =
        (expected_interval == 0 || lost_interval <= 0)
            ? 0
            : (uint8_t)((lost_interval << 8) / expected_interval > 255
                            ? 255
                            : (lost_interval << 8) / expected_interval);
    out->cumulative_lost = (uint32_t)(lost > 0x7FFFFF ? 0x7FFFFF : lost);
    out->ext_highest_seq = ext_max;
    if (s->lsr_ms) {
        out->lsr = s->lsr;
        out->dlsr = (uint32_t)((now - s->lsr_ms) * 65536 / 1000);
    }
    return true;
}

/* ---------- sending ---------- */

void room_dtls_send(void *user, const uint8_t *data, size_t len) {
    participant_t *p = user;
    if (p->has_addr) net_send((struct sockaddr *)&p->addr, data, len);
}

static void send_rtcp(participant_t *p, const uint8_t *data, size_t len) {
    if (!p->srtp_ready || !p->has_addr || len > 1500) return;
    uint8_t buf[SRTP_BUF];
    memcpy(buf, data, len);
    int l = (int)len;
    if (srtp_protect_rtcp(p->srtp_out, buf, &l) == srtp_err_status_ok)
        net_send((struct sockaddr *)&p->addr, buf, (size_t)l);
}

static void history_store(participant_t *s, const uint8_t *data, size_t len, uint64_t now) {
    if (len > 1500) return;
    hist_t *h = &s->hist[s->hist_next++ % HISTORY_SIZE];
    if (!h->data && !(h->data = malloc(1500))) return;
    memcpy(h->data, data, len);
    h->len = (uint16_t)len;
    h->ssrc = rd32(data + 8);
    h->seq = rd16(data + 2);
    h->rtx_count = 0;
    h->sent_ms = now;
}

static void pacer_send(void *user, uint8_t *data, size_t len) {
    participant_t *s = user;
    if (!s->srtp_ready || !s->has_addr) return;
    bool rtx = data[0] & RTX_MARK;
    data[0] &= (uint8_t)~RTX_MARK;
    if (!rtx && (data[1] & 0x7F) == s->sub_video_pt) history_store(s, data, len, now_ms());
    uint8_t buf[SRTP_BUF];
    memcpy(buf, data, len);
    int l = (int)len;
    if (srtp_protect(s->srtp_out, buf, &l) == srtp_err_status_ok)
        net_batch_add((struct sockaddr *)&s->addr, buf, (size_t)l);
}

static void request_keyframe(participant_t *p) {
    if (!p || !p->srtp_ready || !p->vstats.init) return;
    uint64_t now = now_ms();
    if (now - p->last_pli_ms < KEYFRAME_MIN_INTERVAL_MS) return;
    p->last_pli_ms = now;
    uint8_t b[16];
    send_rtcp(p, b, rtcp_build_pli(b, SERVER_SSRC, p->vstats.ssrc));
}

/* ---------- speaker state ---------- */

static bool is_speaking(const participant_t *p, uint64_t now) {
    return p->last_voice_ms && now - p->last_voice_ms < (uint64_t)g_cfg.hangover_ms;
}

static bool is_surfaced(const participant_t *p, uint64_t now) {
    return is_speaking(p, now) && now - p->speech_start_ms >= (uint64_t)g_cfg.surface_ms;
}

static void update_level(participant_t *p, uint8_t level, uint64_t now) {
    double loudness = 127.0 - level;
    p->level_avg = p->level_avg * 0.9 + loudness * 0.1;
    if (level <= g_cfg.audio_threshold) {
        if (!is_speaking(p, now)) p->speech_start_ms = now;
        p->last_voice_ms = now;
    }
}

/* ---------- recording ---------- */

static void add_track(room_t *r, participant_t *p, const char *kind, const char *path) {
    r->tracks = grow(r->tracks, &r->tracks_cap, r->ntracks + 1, sizeof(rec_track_t));
    rec_track_t *t = &r->tracks[r->ntracks++];
    copy_id(t->participant_id, p->id);
    snprintf(t->kind, sizeof(t->kind), "%s", kind);
    snprintf(t->path, sizeof(t->path), "%s", path);
    t->started_ms = wall_ms();
}

static void close_recorders(participant_t *p) {
    ivf_close(p->rec_video);
    ogg_close(p->rec_audio);
    p->rec_video = NULL;
    p->rec_audio = NULL;
}

/* ---------- forwarding ---------- */

static void forward_audio(participant_t *s, slot_t *slot, const rtp_pkt_t *pkt, uint64_t now) {
    if (!slot->started) {
        slot->seq_off = (uint16_t)(slot->last_seq + 1 - pkt->seq);
        slot->ts_off = slot->last_ts + AUDIO_TS_STEP - pkt->ts;
        slot->started = true;
    }
    uint16_t seq = (uint16_t)(pkt->seq + slot->seq_off);
    uint32_t ts = pkt->ts + slot->ts_off;
    uint8_t out[1500];
    if (pkt->payload_len > sizeof(out) - 12) return;
    size_t n = rtp_write_header(out, pkt->marker, s->sub_audio_pt, seq, ts, slot->ssrc);
    memcpy(out + n, pkt->payload, pkt->payload_len);
    n += pkt->payload_len;
    if (seq_newer(seq, slot->last_seq)) {
        slot->last_seq = seq;
        slot->last_ts = ts;
    }
    pacer_enqueue(&s->pacer, PRIO_AUDIO, out, n, now);
}

static void forward_video(participant_t *s, slot_t *slot, const rtp_pkt_t *pkt,
                          const vpx_desc_t *d, uint64_t now) {
    if (slot->need_keyframe) {
        if (!(d->start_of_frame && d->keyframe)) {
            request_keyframe(slot->src);
            return;
        }
        slot->need_keyframe = false;
        slot->seq_off = (uint16_t)(slot->last_seq + 1 - pkt->seq);
        slot->ts_off = slot->last_ts + VIDEO_TS_STEP - pkt->ts;
        if (d->has_picture_id) slot->pid_off = (uint16_t)(slot->last_pid + 1 - d->picture_id);
        if (d->has_tl0picidx) slot->tl0_off = (uint8_t)(slot->last_tl0 + 1 - d->tl0picidx);
    }
    if (d->start_of_frame) slot->frame_key = d->keyframe;

    /* One tile (a two-person call) keeps every temporal layer. A grid stays at
     * layers 0-1 (15 fps). Congestion drops to layer 0 (7.5 fps). */
    int active = 0;
    for (int i = 0; i < MAX_VSLOTS; i++) {
        if (s->vslot[i].src) active++;
    }
    int max_tid = s->congestion >= 1 ? 0 : active <= 1 ? 2 : 1;
    if (d->tid > max_tid) {
        slot->seq_off--;
        if (d->start_of_frame) slot->pid_off--;
        g_tl_drops++;
        return;
    }

    uint16_t seq = (uint16_t)(pkt->seq + slot->seq_off);
    uint32_t ts = pkt->ts + slot->ts_off;
    uint8_t out[1500];
    if (pkt->payload_len > sizeof(out) - 12) return;
    size_t n = rtp_write_header(out, pkt->marker, s->sub_video_pt, seq, ts, slot->ssrc);
    uint8_t *payload = out + n;
    memcpy(payload, pkt->payload, pkt->payload_len);
    n += pkt->payload_len;
    uint16_t pid = 0;
    uint8_t tl0 = 0;
    if (d->has_picture_id) {
        pid = (uint16_t)((d->picture_id + slot->pid_off) & vpx_picture_id_mask(d));
        vpx_write_picture_id(payload, d, pid);
    }
    if (d->has_tl0picidx) {
        tl0 = (uint8_t)(d->tl0picidx + slot->tl0_off);
        vpx_write_tl0picidx(payload, d, tl0);
    }
    if (seq_newer(seq, slot->last_seq)) {
        slot->last_seq = seq;
        slot->last_ts = ts;
        if (d->has_picture_id) slot->last_pid = pid;
        if (d->has_tl0picidx) slot->last_tl0 = tl0;
    }
    int prio = slot->frame_key ? PRIO_RTX_KEY : d->tid == 0 ? PRIO_BASE : PRIO_ENH;
    pacer_enqueue(&s->pacer, prio, out, n, now);
}

static void on_audio(participant_t *p, const rtp_pkt_t *pkt, uint64_t now) {
    room_t *r = p->room;
    rx_stats_update(&p->astats, pkt->ssrc, pkt->seq);
    const uint8_t *level;
    if (p->audio_level_ext && rtp_find_ext(pkt, p->audio_level_ext, &level) >= 1)
        update_level(p, level[0] & 0x7F, now);

    if (r->record && pkt->payload_len > 0) {
        if (!p->rec_audio) {
            char path[512];
            snprintf(path, sizeof(path), "%s/%s-audio.ogg", r->record_dir, p->id);
            if ((p->rec_audio = ogg_open(path))) add_track(r, p, "audio", path);
        }
        ogg_push(p->rec_audio, pkt->ts, pkt->payload, pkt->payload_len);
    }

    for (int i = 0; i < r->nmembers; i++) {
        participant_t *s = r->members[i];
        if (s == p || !s->srtp_ready) continue;
        for (int k = 0; k < MAX_ASLOTS; k++) {
            if (s->aslot[k].src == p) {
                forward_audio(s, &s->aslot[k], pkt, now);
                break;
            }
        }
    }
}

static void on_video(participant_t *p, const rtp_pkt_t *pkt, uint64_t now) {
    room_t *r = p->room;
    uint16_t gap = rx_stats_update(&p->vstats, pkt->ssrc, pkt->seq);
    if (gap > 0 && gap <= 16) {
        uint16_t missing[16];
        for (uint16_t i = 0; i < gap; i++) missing[i] = (uint16_t)(pkt->seq - gap + i);
        uint8_t b[96];
        send_rtcp(p, b, rtcp_build_nack(b, SERVER_SSRC, pkt->ssrc, missing, gap));
    }
    vpx_desc_t d;
    bool ok = r->vp9 ? vp9_parse(pkt->payload, pkt->payload_len, &d)
                     : vp8_parse(pkt->payload, pkt->payload_len, &d);
    if (!ok) return;
    if (!p->video_seen) {
        p->video_seen = true;
        request_keyframe(p);
    }

    if (r->record) {
        if (!p->rec_video) {
            char path[512];
            snprintf(path, sizeof(path), "%s/%s-video.ivf", r->record_dir, p->id);
            if ((p->rec_video = ivf_open(path, r->vp9))) add_track(r, p, "video", path);
        }
        ivf_push(p->rec_video, pkt, &d);
        if (ivf_wants_keyframe(p->rec_video)) request_keyframe(p);
    }

    for (int i = 0; i < r->nmembers; i++) {
        participant_t *s = r->members[i];
        if (s == p || !s->srtp_ready || s->hidden) continue;
        for (int k = 0; k < MAX_VSLOTS; k++) {
            slot_t *slot = &s->vslot[k];
            if (slot->src == p && !slot->paused) {
                forward_video(s, slot, pkt, &d, now);
                break;
            }
        }
    }
}

/* ---------- RTCP from clients ---------- */

static slot_t *slot_by_ssrc(participant_t *s, uint32_t ssrc) {
    for (int k = 0; k < MAX_VSLOTS; k++)
        if (s->vslot[k].ssrc == ssrc) return &s->vslot[k];
    for (int k = 0; k < MAX_ASLOTS; k++)
        if (s->aslot[k].ssrc == ssrc) return &s->aslot[k];
    return NULL;
}

static void handle_report_blocks(participant_t *s, const uint8_t *blocks, int count, size_t avail,
                                 uint64_t now) {
    double worst = -1;
    for (int i = 0; i < count && (size_t)(i + 1) * 24 <= avail; i++) {
        const uint8_t *b = blocks + i * 24;
        if (slot_by_ssrc(s, rd32(b))) {
            double f = b[4] / 256.0;
            if (f > worst) worst = f;
        }
    }
    if (worst >= 0) pacer_on_loss(&s->pacer, worst, now);
}

static void handle_nack(participant_t *s, uint32_t media, uint16_t seq, uint64_t now) {
    for (int i = 0; i < HISTORY_SIZE; i++) {
        hist_t *h = &s->hist[i];
        if (!h->data || h->ssrc != media || h->seq != seq) continue;
        if (h->rtx_count >= 2 || now - h->sent_ms > 1000) return;
        h->rtx_count++;
        uint8_t copy[1500];
        memcpy(copy, h->data, h->len);
        copy[0] |= RTX_MARK;
        pacer_enqueue(&s->pacer, PRIO_RTX_KEY, copy, h->len, now);
        return;
    }
}

static void handle_rtcp(participant_t *p, uint8_t *buf, size_t len, uint64_t now) {
    int l = (int)len;
    if (srtp_unprotect_rtcp(p->srtp_in, buf, &l) != srtp_err_status_ok) return;
    size_t off = 0, total = (size_t)l;
    while (off + 8 <= total) {
        const uint8_t *pk = buf + off;
        size_t plen = ((size_t)rd16(pk + 2) + 1) * 4;
        if (off + plen > total) break;
        uint8_t fmt = pk[0] & 0x1F, pt = pk[1];
        switch (pt) {
        case RTCP_SR:
            if (plen >= 28) {
                uint32_t ssrc = rd32(pk + 4);
                uint32_t lsr = (rd32(pk + 8) << 16) | (rd32(pk + 12) >> 16);
                rx_stats_t *st = ssrc == p->vstats.ssrc   ? &p->vstats
                                 : ssrc == p->astats.ssrc ? &p->astats
                                                          : NULL;
                if (st) {
                    st->lsr = lsr;
                    st->lsr_ms = now;
                }
                handle_report_blocks(p, pk + 28, fmt, plen - 28, now);
            }
            break;
        case RTCP_RR: handle_report_blocks(p, pk + 8, fmt, plen - 8, now); break;
        case RTCP_RTPFB:
            if (fmt == 1 && plen >= 16) {
                uint32_t media = rd32(pk + 8);
                for (size_t f = 12; f + 4 <= plen; f += 4) {
                    uint16_t pid = rd16(pk + f), blp = rd16(pk + f + 2);
                    handle_nack(p, media, pid, now);
                    for (int bit = 0; bit < 16; bit++)
                        if (blp & (1u << bit)) handle_nack(p, media, (uint16_t)(pid + bit + 1), now);
                }
            }
            break;
        case RTCP_PSFB:
            if ((fmt == 1 && plen >= 12) || (fmt == 4 && plen >= 20)) {
                uint32_t media = fmt == 1 ? rd32(pk + 8) : rd32(pk + 12);
                slot_t *slot = slot_by_ssrc(p, media);
                if (slot && slot->src) request_keyframe(slot->src);
            } else if (fmt == 15 && plen >= 20 && memcmp(pk + 12, "REMB", 4) == 0) {
                uint8_t exp = pk[17] >> 2;
                uint32_t mantissa = ((uint32_t)(pk[17] & 0x03) << 16) | rd16(pk + 18);
                pacer_on_remb(&p->pacer, (double)((uint64_t)mantissa << exp), now);
            }
            break;
        default: break;
        }
        off += plen;
    }
}

/* ---------- participant lifecycle ---------- */

static void clear_slot_refs(room_t *r, participant_t *gone) {
    for (int i = 0; i < r->nmembers; i++) {
        participant_t *s = r->members[i];
        for (int k = 0; k < MAX_VSLOTS; k++)
            if (s->vslot[k].src == gone) {
                s->vslot[k].src = NULL;
                s->slots_dirty = true;
            }
        for (int k = 0; k < MAX_ASLOTS; k++)
            if (s->aslot[k].src == gone) {
                s->aslot[k].src = NULL;
                s->slots_dirty = true;
            }
    }
    for (int k = 0; k < r->naudio_sel; k++)
        if (r->audio_sel[k] == gone) {
            memmove(&r->audio_sel[k], &r->audio_sel[k + 1],
                    sizeof(r->audio_sel[0]) * (size_t)(r->naudio_sel - k - 1));
            r->naudio_sel--;
            k--;
        }
}

static void remove_participant(participant_t *p) {
    room_t *r = p->room;
    for (int i = 0; i < r->nmembers; i++)
        if (r->members[i] == p) {
            memmove(&r->members[i], &r->members[i + 1],
                    sizeof(r->members[0]) * (size_t)(r->nmembers - i - 1));
            r->nmembers--;
            break;
        }
    clear_slot_refs(r, p);
    for (int i = 0; i < g_nparts; i++)
        if (g_parts[i] == p) {
            g_parts[i] = g_parts[--g_nparts];
            break;
        }
    close_recorders(p);
    addr_index_remove(p);
    dtls_conn_free(&p->dtls);
    if (p->srtp_ready) {
        srtp_dealloc(p->srtp_in);
        srtp_dealloc(p->srtp_out);
    }
    pacer_free(&p->pacer);
    for (int i = 0; i < HISTORY_SIZE; i++) free(p->hist[i].data);
    free(p);
}

static void disconnect(participant_t *p, const char *reason) {
    sbuf_t sb;
    sb_init(&sb);
    sb_puts(&sb, "{\"participantId\":");
    sb_json_str(&sb, p->id);
    sb_puts(&sb, ",\"reason\":");
    sb_json_str(&sb, reason);
    sb_putc(&sb, '}');
    ipc_emit("participantDisconnected", sb.buf);
    sb_free(&sb);
    remove_participant(p);
}

static bool setup_srtp(participant_t *p) {
    uint8_t km[60];
    if (!dtls_conn_export_srtp(&p->dtls, km)) return false;
    uint8_t in_key[30], out_key[30];
    memcpy(in_key, km, 16);       /* client key */
    memcpy(in_key + 16, km + 32, 14); /* client salt */
    memcpy(out_key, km + 16, 16);     /* server key */
    memcpy(out_key + 16, km + 46, 14);

    srtp_policy_t pol;
    memset(&pol, 0, sizeof(pol));
    srtp_crypto_policy_set_rtp_default(&pol.rtp);
    srtp_crypto_policy_set_rtcp_default(&pol.rtcp);
    pol.window_size = 1024;
    pol.allow_repeat_tx = 1;
    pol.ssrc.type = ssrc_any_inbound;
    pol.key = in_key;
    if (srtp_create(&p->srtp_in, &pol) != srtp_err_status_ok) return false;
    pol.ssrc.type = ssrc_any_outbound;
    pol.key = out_key;
    if (srtp_create(&p->srtp_out, &pol) != srtp_err_status_ok) {
        srtp_dealloc(p->srtp_in);
        return false;
    }
    return true;
}

static void on_dtls_connected(participant_t *p) {
    if (p->remote_fp[0]) {
        char fp[160];
        if (!dtls_conn_peer_fingerprint(&p->dtls, fp, sizeof(fp)) ||
            strcasecmp(fp, p->remote_fp) != 0) {
            disconnect(p, "fingerprint_mismatch");
            return;
        }
    }
    if (!setup_srtp(p)) {
        disconnect(p, "srtp_setup_failed");
        return;
    }
    p->srtp_ready = true;
    for (int k = 0; k < MAX_VSLOTS; k++) p->vslot[k].need_keyframe = true;
    sbuf_t sb;
    sb_init(&sb);
    sb_puts(&sb, "{\"participantId\":");
    sb_json_str(&sb, p->id);
    sb_putc(&sb, '}');
    ipc_emit("participantConnected", sb.buf);
    sb_free(&sb);
}

/* ---------- packet entry point ---------- */

static void handle_stun(const struct sockaddr *from, const uint8_t *buf, size_t len) {
    stun_msg_t m;
    if (!stun_parse(buf, len, &m) || m.type != STUN_BINDING_REQUEST || !m.has_username) return;
    const char *colon = strchr(m.username, ':');
    size_t ulen = colon ? (size_t)(colon - m.username) : strlen(m.username);
    participant_t *p = find_by_ufrag(m.username, ulen);
    if (!p || !stun_check_integrity(buf, len, &m, p->pwd)) return;
    if (!p->has_addr || (m.use_candidate && !addr_eq((struct sockaddr *)&p->addr, from)))
        addr_index_set(p, from);
    p->last_rx_ms = now_ms();
    uint8_t out[128];
    size_t n = stun_build_binding_success(out, m.txid, from, p->pwd);
    net_send(from, out, n);
}

void room_on_packet(const struct sockaddr *from, uint8_t *buf, size_t len) {
    if (len < 1) return;
    uint8_t b0 = buf[0];
    if (b0 < 2) {
        if (stun_is_packet(buf, len)) handle_stun(from, buf, len);
        return;
    }
    participant_t *p = addr_lookup(from);
    if (!p) return;
    uint64_t now = now_ms();
    p->last_rx_ms = now;
    if (b0 >= 20 && b0 <= 63) {
        int r = dtls_conn_feed(&p->dtls, buf, len);
        if (r == 1) on_dtls_connected(p);
        else if (r < 0) disconnect(p, "dtls_closed");
        return;
    }
    if (b0 < 128 || b0 > 191 || !p->srtp_ready) return;
    if (rtp_is_rtcp(buf, len)) {
        handle_rtcp(p, buf, len, now);
        room_tick_pacer();
        return;
    }
    int l = (int)len;
    if (srtp_unprotect(p->srtp_in, buf, &l) != srtp_err_status_ok) return;
    rtp_pkt_t pkt;
    if (!rtp_parse(buf, (size_t)l, &pkt)) return;
    if (p->pub_audio_pt && pkt.pt == p->pub_audio_pt) on_audio(p, &pkt, now);
    else if (p->pub_video_pt && pkt.pt == p->pub_video_pt) on_video(p, &pkt, now);
    /* Send now. Waiting for the 5 ms timer makes the tail of a frame burst miss the queue bound. */
    room_tick_pacer();
}

/* ---------- speaker selection and slot assignment ---------- */

static bool has_pin(const participant_t *s, const participant_t *q) {
    for (int i = 0; i < s->npins; i++)
        if (strcmp(s->pins[i], q->id) == 0) return true;
    return false;
}

static int vslot_of(const participant_t *s, const participant_t *q) {
    for (int k = 0; k < MAX_VSLOTS; k++)
        if (s->vslot[k].src == q) return k;
    return -1;
}

static int empty_vslot(const participant_t *s) { return vslot_of(s, NULL); }

static void set_vslot(participant_t *s, int k, participant_t *q, uint64_t now) {
    slot_t *slot = &s->vslot[k];
    if (slot->src == q) return;
    slot->src = q;
    slot->need_keyframe = true;
    slot->paused = false;
    slot->assigned_ms = now;
    s->slots_dirty = true;
    if (q) request_keyframe(q);
}

/* Higher-priority first: surfaced speakers, then most recently heard, then join order. */
static bool video_before(const participant_t *a, const participant_t *b, uint64_t now) {
    bool sa = is_surfaced(a, now), sb = is_surfaced(b, now);
    if (sa != sb) return sa;
    if (a->last_voice_ms != b->last_voice_ms) return a->last_voice_ms > b->last_voice_ms;
    return a->join_seq < b->join_seq;
}

static bool audio_before(const participant_t *a, const participant_t *b) {
    return a->level_avg > b->level_avg;
}

static void update_room_speakers(room_t *r, uint64_t now) {
    r->order = realloc(r->order, sizeof(participant_t *) * (size_t)(r->nmembers ? r->nmembers : 1));
    int n = 0;
    participant_t *speaking[256];
    int ns = 0;
    for (int i = 0; i < r->nmembers; i++) {
        participant_t *p = r->members[i];
        /* insertion sort: rooms are at most a few hundred people per worker */
        int j = n++;
        while (j > 0 && video_before(p, r->order[j - 1], now)) {
            r->order[j] = r->order[j - 1];
            j--;
        }
        r->order[j] = p;
        if (is_speaking(p, now) && ns < 256) {
            int k = ns++;
            while (k > 0 && audio_before(p, speaking[k - 1])) {
                speaking[k] = speaking[k - 1];
                k--;
            }
            speaking[k] = p;
        }
    }

    /* Steady speakers first, then anyone who just started talking (so first words are not
     * clipped), up to MAX_ASLOTS in total. */
    r->naudio_sel = 0;
    for (int i = 0; i < ns && r->naudio_sel < g_cfg.max_audio_steady; i++)
        r->audio_sel[r->naudio_sel++] = speaking[i];
    for (int i = g_cfg.max_audio_steady; i < ns && r->naudio_sel < MAX_ASLOTS; i++)
        if (now - speaking[i]->speech_start_ms < NEW_SPEAKER_WINDOW_MS)
            r->audio_sel[r->naudio_sel++] = speaking[i];

    sbuf_t sig;
    sb_init(&sig);
    sb_putc(&sig, '[');
    for (int i = 0; i < ns; i++) {
        if (i) sb_putc(&sig, ',');
        sb_json_str(&sig, speaking[i]->id);
    }
    sb_putc(&sig, ']');
    if (strncmp(sig.buf, r->speakers_sig, sizeof(r->speakers_sig) - 1) != 0) {
        snprintf(r->speakers_sig, sizeof(r->speakers_sig), "%s", sig.buf);
        r->speakers_dirty = true;
    }
    sb_free(&sig);
    if (r->speakers_dirty && now - r->speakers_sent_ms >= EVENT_MIN_INTERVAL_MS) {
        sbuf_t sb;
        sb_init(&sb);
        sb_puts(&sb, "{\"roomId\":");
        sb_json_str(&sb, r->id);
        sb_puts(&sb, ",\"speakers\":");
        sb_puts(&sb, r->speakers_sig);
        sb_putc(&sb, '}');
        ipc_emit("speakers", sb.buf);
        sb_free(&sb);
        r->speakers_dirty = false;
        r->speakers_sent_ms = now;
    }
}

static void assign_audio(room_t *r, participant_t *s) {
    for (int k = 0; k < MAX_ASLOTS; k++) {
        participant_t *src = s->aslot[k].src;
        if (!src) continue;
        bool keep = false;
        for (int i = 0; i < r->naudio_sel; i++) keep |= r->audio_sel[i] == src;
        if (!keep) {
            s->aslot[k].src = NULL;
            s->slots_dirty = true;
        }
    }
    for (int i = 0; i < r->naudio_sel; i++) {
        participant_t *q = r->audio_sel[i];
        if (q == s) continue;
        int free_k = -1;
        bool present = false;
        for (int k = 0; k < MAX_ASLOTS; k++) {
            if (s->aslot[k].src == q) present = true;
            else if (!s->aslot[k].src && free_k < 0) free_k = k;
        }
        if (!present && free_k >= 0) {
            s->aslot[free_k].src = q;
            s->aslot[free_k].started = false;
            s->slots_dirty = true;
        }
    }
}

static int choose_victim(participant_t *s, uint64_t now, bool for_pin) {
    int best = -1;
    for (int k = 0; k < MAX_VSLOTS; k++) {
        participant_t *o = s->vslot[k].src;
        if (!o) return k;
        if (has_pin(s, o) || is_surfaced(o, now)) continue;
        if (!for_pin && now - s->vslot[k].assigned_ms < (uint64_t)g_cfg.min_tile_ms) continue;
        if (best < 0) {
            best = k;
            continue;
        }
        participant_t *b = s->vslot[best].src;
        if (o->last_voice_ms < b->last_voice_ms ||
            (o->last_voice_ms == b->last_voice_ms &&
             s->vslot[k].assigned_ms < s->vslot[best].assigned_ms))
            best = k;
    }
    return best;
}

static void assign_video(room_t *r, participant_t *s, uint64_t now) {
    int others = 0;
    for (int i = 0; i < r->nmembers; i++)
        if (r->members[i] != s && r->members[i]->video_seen) others++;

    if (s->page > 0) {
        participant_t *want[MAX_VSLOTS];
        int nw = 0, idx = 0;
        int first = s->page * MAX_VSLOTS;
        for (int i = 0; i < r->nmembers && nw < MAX_VSLOTS; i++) {
            participant_t *q = r->members[i];
            if (q == s || !q->video_seen) continue;
            if (idx++ >= first) want[nw++] = q;
        }
        for (int k = 0; k < MAX_VSLOTS; k++) {
            participant_t *src = s->vslot[k].src;
            bool keep = false;
            for (int i = 0; i < nw; i++) keep |= want[i] == src;
            if (src && !keep) set_vslot(s, k, NULL, now);
        }
        for (int i = 0; i < nw; i++)
            if (vslot_of(s, want[i]) < 0) set_vslot(s, empty_vslot(s), want[i], now);
        return;
    }

    if (others <= MAX_VSLOTS) {
        for (int i = 0; i < r->nmembers; i++) {
            participant_t *q = r->members[i];
            if (q == s || !q->video_seen || vslot_of(s, q) >= 0) continue;
            int k = empty_vslot(s);
            if (k >= 0) set_vslot(s, k, q, now);
        }
        return;
    }

    for (int i = 0; i < s->npins; i++) {
        participant_t *q = find_participant(s->pins[i]);
        if (!q || q == s || q->room != r || !q->video_seen || vslot_of(s, q) >= 0) continue;
        int k = choose_victim(s, now, true);
        if (k >= 0) set_vslot(s, k, q, now);
    }
    for (int i = 0; i < r->nmembers; i++) {
        participant_t *q = r->order[i];
        if (q == s || !q->video_seen || vslot_of(s, q) >= 0) continue;
        int k = empty_vslot(s);
        if (k < 0) break;
        set_vslot(s, k, q, now);
    }
    for (int i = 0; i < r->nmembers; i++) {
        participant_t *q = r->order[i];
        if (!is_surfaced(q, now)) break;
        if (q == s || !q->video_seen || vslot_of(s, q) >= 0) continue;
        int k = choose_victim(s, now, false);
        if (k >= 0) set_vslot(s, k, q, now);
    }
}

static void emit_slots(participant_t *s, uint64_t now) {
    if (!s->slots_dirty || now - s->slots_sent_ms < EVENT_MIN_INTERVAL_MS) return;
    sbuf_t sb;
    sb_init(&sb);
    sb_puts(&sb, "{\"participantId\":");
    sb_json_str(&sb, s->id);
    sb_puts(&sb, ",\"video\":[");
    for (int k = 0; k < MAX_VSLOTS; k++) {
        if (k) sb_putc(&sb, ',');
        sb_json_str(&sb, s->vslot[k].src ? s->vslot[k].src->id : NULL);
    }
    sb_puts(&sb, "],\"audio\":[");
    for (int k = 0; k < MAX_ASLOTS; k++) {
        if (k) sb_putc(&sb, ',');
        sb_json_str(&sb, s->aslot[k].src ? s->aslot[k].src->id : NULL);
    }
    sb_puts(&sb, "]}");
    ipc_emit("slots", sb.buf);
    sb_free(&sb);
    s->slots_dirty = false;
    s->slots_sent_ms = now;
}

/* ---------- congestion ---------- */

static void apply_congestion(participant_t *s, uint64_t now) {
    if (s->pacer.drops_window > 5 && s->congestion < 2) {
        s->congestion++;
        s->congestion_changed_ms = now;
    } else if (s->pacer.drops_window == 0 && s->congestion > 0 &&
               now - s->pacer.last_drop_ms > 5000 && now - s->congestion_changed_ms > 5000) {
        s->congestion--;
        s->congestion_changed_ms = now;
    }
    s->pacer.drops_window = 0;

    /* Level 2: keep pinned tiles, speakers and the 4 most recently active; pause the rest. */
    int order[MAX_VSLOTS], n = 0;
    for (int k = 0; k < MAX_VSLOTS; k++)
        if (s->vslot[k].src) order[n++] = k;
    for (int i = 1; i < n; i++)
        for (int j = i; j > 0 && s->vslot[order[j]].src->last_voice_ms >
                                     s->vslot[order[j - 1]].src->last_voice_ms;
             j--) {
            int t = order[j];
            order[j] = order[j - 1];
            order[j - 1] = t;
        }
    for (int i = 0; i < n; i++) {
        slot_t *slot = &s->vslot[order[i]];
        bool keep = s->congestion < 2 || i < 4 || has_pin(s, slot->src) ||
                    is_speaking(slot->src, now);
        if (!keep && !slot->paused) {
            slot->paused = true;
        } else if (keep && slot->paused) {
            slot->paused = false;
            slot->need_keyframe = true;
            request_keyframe(slot->src);
        }
    }
}

/* ---------- timers ---------- */

void room_tick_pacer(void) {
    uint64_t now = now_ms();
    for (int i = 0; i < g_nparts; i++)
        if (g_parts[i]->srtp_ready) pacer_drain(&g_parts[i]->pacer, now, pacer_send, g_parts[i]);
    net_batch_flush();
}

void room_tick_100ms(void) {
    uint64_t now = now_ms();
    for (int i = 0; i < g_nparts; i++)
        if (!g_parts[i]->dtls.done) dtls_conn_handle_timeout(&g_parts[i]->dtls);
    for (int i = 0; i < g_nrooms; i++) {
        room_t *r = g_rooms[i];
        update_room_speakers(r, now);
        for (int k = 0; k < r->nmembers; k++) {
            participant_t *s = r->members[k];
            assign_audio(r, s);
            assign_video(r, s, now);
            emit_slots(s, now);
        }
    }
}

void room_tick_1s(void) {
    uint64_t now = now_ms();
    participant_t *expired[256];
    int nexp = 0;
    for (int i = 0; i < g_nparts; i++) {
        participant_t *p = g_parts[i];
        if (now - p->last_rx_ms > (uint64_t)g_cfg.timeout_ms) {
            if (nexp < 256) expired[nexp++] = p;
            continue;
        }
        if (!p->srtp_ready) continue;

        uint8_t b[256];
        rtcp_report_t blocks[2];
        int nb = 0;
        if (rx_stats_report(&p->astats, now, &blocks[nb])) nb++;
        if (rx_stats_report(&p->vstats, now, &blocks[nb])) nb++;
        if (nb) {
            size_t n = rtcp_build_rr(b, SERVER_SSRC, blocks, nb);
            if (p->vstats.init) {
                uint32_t ssrc = p->vstats.ssrc;
                n += rtcp_build_remb(b + n, SERVER_SSRC, (uint64_t)g_cfg.publisher_remb_bps, &ssrc,
                                     1);
            }
            send_rtcp(p, b, n);
        }
        apply_congestion(p, now);
    }
    for (int i = 0; i < nexp; i++) disconnect(expired[i], "timeout");
}

/* ---------- IPC API ---------- */

const char *room_api_create_room(const json_t *params, sbuf_t *out) {
    const char *id = json_get_str(params, "roomId", NULL);
    if (!id || strlen(id) >= ID_MAX) return "invalid roomId";
    if (find_room(id)) return "room exists";
    room_t *r = calloc(1, sizeof(*r));
    if (!r) return "out of memory";
    copy_id(r->id, id);
    r->vp9 = strcmp(json_get_str(params, "videoCodec", "vp9"), "vp9") == 0;
    r->record = json_get_bool(params, "record", false);
    snprintf(r->record_dir, sizeof(r->record_dir), "%s", json_get_str(params, "recordDir", "."));
    g_rooms = grow(g_rooms, &g_rooms_cap, g_nrooms + 1, sizeof(room_t *));
    g_rooms[g_nrooms++] = r;
    return NULL;
}

const char *room_api_close_room(const json_t *params, sbuf_t *out) {
    room_t *r = find_room(json_get_str(params, "roomId", ""));
    if (!r) return "unknown room";
    while (r->nmembers) remove_participant(r->members[0]);
    sb_puts(out, "{\"tracks\":[");
    for (int i = 0; i < r->ntracks; i++) {
        rec_track_t *t = &r->tracks[i];
        if (i) sb_putc(out, ',');
        sb_puts(out, "{\"participantId\":");
        sb_json_str(out, t->participant_id);
        sb_puts(out, ",\"kind\":");
        sb_json_str(out, t->kind);
        sb_puts(out, ",\"path\":");
        sb_json_str(out, t->path);
        sb_printf(out, ",\"codec\":\"%s\",\"startedAtMs\":%llu}",
                  strcmp(t->kind, "audio") == 0 ? "opus" : (r->vp9 ? "vp9" : "vp8"),
                  (unsigned long long)t->started_ms);
    }
    sb_puts(out, "]}");
    for (int i = 0; i < g_nrooms; i++)
        if (g_rooms[i] == r) {
            g_rooms[i] = g_rooms[--g_nrooms];
            break;
        }
    free(r->members);
    free(r->order);
    free(r->tracks);
    free(r);
    return NULL;
}

const char *room_api_create_participant(const json_t *params, sbuf_t *out) {
    room_t *r = find_room(json_get_str(params, "roomId", ""));
    if (!r) return "unknown room";
    const char *id = json_get_str(params, "participantId", NULL);
    const char *ufrag = json_get_str(params, "iceUfrag", NULL);
    const char *pwd = json_get_str(params, "icePwd", NULL);
    if (!id || !ufrag || !pwd || strlen(id) >= ID_MAX || strlen(ufrag) >= ID_MAX ||
        strlen(pwd) >= ID_MAX)
        return "invalid participant credentials";
    if (find_participant(id)) return "participant exists";
    if (find_by_ufrag(ufrag, strlen(ufrag))) return "ufrag in use";
    json_t *pub = json_get(params, "pub"), *sub = json_get(params, "sub");
    json_t *assrcs = json_get(sub, "audioSsrcs"), *vssrcs = json_get(sub, "videoSsrcs");
    if (!pub || !sub || !assrcs || !vssrcs || assrcs->len != MAX_ASLOTS ||
        vssrcs->len != MAX_VSLOTS)
        return "invalid pub/sub parameters";

    participant_t *p = calloc(1, sizeof(*p));
    if (!p) return "out of memory";
    copy_id(p->id, id);
    copy_id(p->ufrag, ufrag);
    copy_id(p->pwd, pwd);
    snprintf(p->remote_fp, sizeof(p->remote_fp), "%s",
             json_get_str(params, "remoteFingerprint", ""));
    p->room = r;
    p->last_rx_ms = now_ms();
    p->join_seq = r->next_join_seq++;
    p->pub_audio_pt = (uint8_t)json_get_num(pub, "audioPt", 0);
    p->pub_video_pt = (uint8_t)json_get_num(pub, "videoPt", 0);
    p->audio_level_ext = (uint8_t)json_get_num(pub, "audioLevelExtId", 0);
    p->sub_audio_pt = (uint8_t)json_get_num(sub, "audioPt", 0);
    p->sub_video_pt = (uint8_t)json_get_num(sub, "videoPt", 0);
    for (int k = 0; k < MAX_VSLOTS; k++) {
        slot_t *s = &p->vslot[k];
        s->ssrc = (uint32_t)json_at(vssrcs, (size_t)k)->num;
        s->last_seq = (uint16_t)rand32();
        s->last_ts = rand32();
        s->last_pid = (uint16_t)(rand32() & 0x7FFF);
        s->last_tl0 = (uint8_t)rand32();
        s->need_keyframe = true;
    }
    for (int k = 0; k < MAX_ASLOTS; k++) {
        slot_t *s = &p->aslot[k];
        s->ssrc = (uint32_t)json_at(assrcs, (size_t)k)->num;
        s->last_seq = (uint16_t)rand32();
        s->last_ts = rand32();
    }
    pacer_init(&p->pacer, g_cfg.start_bps);
    if (dtls_conn_init(&p->dtls, p) != 0) {
        dtls_conn_free(&p->dtls);
        free(p);
        return "DTLS init failed";
    }
    r->members = grow(r->members, &r->members_cap, r->nmembers + 1, sizeof(participant_t *));
    r->members[r->nmembers++] = p;
    g_parts = grow(g_parts, &g_parts_cap, g_nparts + 1, sizeof(participant_t *));
    g_parts[g_nparts++] = p;
    return NULL;
}

const char *room_api_close_participant(const json_t *params, sbuf_t *out) {
    participant_t *p = find_participant(json_get_str(params, "participantId", ""));
    if (!p) return "unknown participant";
    remove_participant(p);
    return NULL;
}

const char *room_api_set_viewer_prefs(const json_t *params, sbuf_t *out) {
    participant_t *s = find_participant(json_get_str(params, "participantId", ""));
    if (!s) return "unknown participant";
    s->npins = 0;
    json_t *pins = json_get(params, "pins");
    for (json_t *c = pins ? pins->child : NULL; c && s->npins < MAX_PINS; c = c->next)
        if (c->type == JSON_STR) copy_id(s->pins[s->npins++], c->str);
    int page = (int)json_get_num(params, "page", 0);
    s->page = page < 0 ? 0 : page;
    bool hidden = json_get_bool(params, "hidden", false);
    if (s->hidden && !hidden) {
        for (int k = 0; k < MAX_VSLOTS; k++) {
            if (!s->vslot[k].src) continue;
            s->vslot[k].need_keyframe = true;
            request_keyframe(s->vslot[k].src);
        }
    }
    s->hidden = hidden;
    return NULL;
}

const char *room_api_get_stats(const json_t *params, sbuf_t *out) {
    uint64_t drops = 0, expired = 0, budget = 0;
    double min_est = 0, min_remb = 0, max_loss = 0;
    int loss_limited = 0;
    for (int i = 0; i < g_nparts; i++) {
        pacer_t *pc = &g_parts[i]->pacer;
        drops += pc->drops_total;
        expired += pc->drops_expired;
        budget += pc->drops_budget;
        if (min_est == 0 || pc->estimate_bps < min_est) min_est = pc->estimate_bps;
        if (pc->remb_bps > 0 && (min_remb == 0 || pc->remb_bps < min_remb)) min_remb = pc->remb_bps;
        if (pc->last_fraction > max_loss) max_loss = pc->last_fraction;
        if (pc->loss_limited) loss_limited++;
    }
    size_t rss = 0;
    uv_resident_set_memory(&rss);
    sb_printf(out,
              "{\"rooms\":%d,\"participants\":%d,\"rxPackets\":%llu,\"rxBytes\":%llu,"
              "\"txPackets\":%llu,\"txBytes\":%llu,\"queueDrops\":%llu,\"dropExpired\":%llu,"
              "\"dropBudget\":%llu,\"tlDrops\":%llu,\"estimateKbps\":%.0f,\"rembKbps\":%.0f,"
              "\"maxLossPct\":%.1f,\"lossLimited\":%d,\"rssBytes\":%zu}",
              g_nrooms, g_nparts, (unsigned long long)g_net_stats.rx_packets,
              (unsigned long long)g_net_stats.rx_bytes, (unsigned long long)g_net_stats.tx_packets,
              (unsigned long long)g_net_stats.tx_bytes, (unsigned long long)drops,
              (unsigned long long)expired, (unsigned long long)budget,
              (unsigned long long)g_tl_drops, min_est / 1000.0, min_remb / 1000.0, max_loss * 100.0,
              loss_limited, rss);
    return NULL;
}
