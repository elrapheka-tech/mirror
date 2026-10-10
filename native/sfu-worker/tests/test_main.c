// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure parsing/building code in the worker.
#include "codec.h"
#include "json.h"
#include "pacer.h"
#include "room.h"
#include "recorder.h"
#include "rtp.h"
#include "stun.h"

#include <arpa/inet.h>
#include <netinet/in.h>

static int g_failures;

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        if (!(cond)) {                                                                             \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                        \
            g_failures++;                                                                          \
        }                                                                                          \
    } while (0)

static void test_json(void) {
    const char *s = "{\"id\":7,\"method\":\"createRoom\",\"params\":{\"roomId\":\"a\\u00e9\","
                    "\"record\":true,\"ssrcs\":[1,2,3]}}";
    json_t *j = json_parse(s, strlen(s));
    CHECK(j != NULL);
    CHECK(json_get_num(j, "id", 0) == 7);
    CHECK(strcmp(json_get_str(j, "method", ""), "createRoom") == 0);
    json_t *params = json_get(j, "params");
    CHECK(strcmp(json_get_str(params, "roomId", ""), "a\xc3\xa9") == 0);
    CHECK(json_get_bool(params, "record", false));
    json_t *arr = json_get(params, "ssrcs");
    CHECK(arr && arr->len == 3 && json_at(arr, 2)->num == 3);
    json_free(j);
    CHECK(json_parse("{\"a\":", 5) == NULL);
    CHECK(json_parse("[1,2] x", 7) == NULL);

    sbuf_t sb;
    sb_init(&sb);
    sb_json_str(&sb, "q\"\n");
    CHECK(strcmp(sb.buf, "\"q\\\"\\n\"") == 0);
    sb_free(&sb);
}

static void test_stun_roundtrip(void) {
    /* Build a request the way a browser would: USERNAME, USE-CANDIDATE, MESSAGE-INTEGRITY. */
    uint8_t req[256] = {0};
    wr16(req, STUN_BINDING_REQUEST);
    wr32(req + 4, STUN_MAGIC);
    for (int i = 0; i < 12; i++) req[8 + i] = (uint8_t)i;
    size_t off = 20;
    const char *user = "srv1:cli1";
    wr16(req + off, 0x0006);
    wr16(req + off + 2, (uint16_t)strlen(user));
    memcpy(req + off + 4, user, strlen(user));
    off += 4 + ((strlen(user) + 3) & ~3u);
    wr16(req + off, 0x0025);
    wr16(req + off + 2, 0);
    off += 4;
    /* MESSAGE-INTEGRITY over everything before it, length covering the attribute. */
    struct sockaddr_in from;
    memset(&from, 0, sizeof(from));
    from.sin_family = AF_INET;
    from.sin_port = htons(54321);
    inet_pton(AF_INET, "192.0.2.10", &from.sin_addr);
    uint8_t resp[128];
    size_t rlen = stun_build_binding_success(resp, req + 8, (struct sockaddr *)&from, "secretpw");
    CHECK(rlen == 20 + 12 + 24 + 8);
    CHECK(rd16(resp) == STUN_BINDING_SUCCESS);
    CHECK(rd16(resp + 2) == rlen - 20);
    /* XOR-MAPPED-ADDRESS decodes back to the sender. */
    CHECK((rd16(resp + 26) ^ (STUN_MAGIC >> 16)) == 54321);
    CHECK((rd32(resp + 28) ^ STUN_MAGIC) == ntohl(from.sin_addr.s_addr));
    /* FINGERPRINT matches CRC32 of the message before it. */
    uint32_t fp = rd32(resp + rlen - 4);
    CHECK(fp == (stun_crc32(resp, rlen - 8) ^ 0x5354554Eu));
    /* Our own response verifies with our integrity check. */
    stun_msg_t m;
    CHECK(stun_parse(resp, rlen, &m));
    CHECK(m.has_integrity);
    CHECK(stun_check_integrity(resp, rlen, &m, "secretpw"));
    CHECK(!stun_check_integrity(resp, rlen, &m, "wrong"));

    stun_msg_t q;
    wr16(req + 2, (uint16_t)(off - 20));
    CHECK(stun_parse(req, off, &q));
    CHECK(q.has_username && strcmp(q.username, user) == 0);
    CHECK(q.use_candidate);
}

static void test_crc32(void) {
    /* Standard check value for "123456789". */
    CHECK(stun_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u);
    /* Ogg CRC (poly 0x04C11DB7, no reflection, init 0) check value. */
    CHECK(ogg_crc32((const uint8_t *)"123456789", 9) == 0x89A1897Fu);
}

static void test_vp8(void) {
    /* X=1 S=1 PID=0; I=1 L=1 T=1; 15-bit picture id 0x1234; TL0PICIDX 9; TID=2 Y=1; then a
     * keyframe payload byte (P bit clear). */
    uint8_t p[] = {0x90, 0xE0, 0x80 | 0x12, 0x34, 0x09, (2 << 6) | 0x20, 0x10, 0xAA};
    vpx_desc_t d;
    CHECK(vp8_parse(p, sizeof(p), &d));
    CHECK(d.start_of_frame && d.keyframe);
    CHECK(d.has_picture_id && d.picture_id_15bit && d.picture_id == 0x1234);
    CHECK(d.has_tl0picidx && d.tl0picidx == 9);
    CHECK(d.tid == 2);
    CHECK(d.header_len == 6);
    vpx_write_picture_id(p, &d, 0x0042);
    vpx_write_tl0picidx(p, &d, 77);
    vpx_desc_t e;
    CHECK(vp8_parse(p, sizeof(p), &e));
    CHECK(e.picture_id == 0x0042 && e.tl0picidx == 77);
    p[6] = 0x11; /* inter frame */
    CHECK(vp8_parse(p, sizeof(p), &e) && !e.keyframe);
}

static void test_vp9(void) {
    /* I=1 P=0 L=1 F=0 B=1 E=1; picture id 15-bit 0x0101; TID=1 SID=0; TL0PICIDX 4. */
    uint8_t p[] = {0x80 | 0x20 | 0x08 | 0x04, 0x81, 0x01, (1 << 5), 0x04, 0x55};
    vpx_desc_t d;
    CHECK(vp9_parse(p, sizeof(p), &d));
    CHECK(d.keyframe && d.start_of_frame && d.end_of_frame);
    CHECK(d.picture_id == 0x0101 && d.tid == 1 && d.tl0picidx == 4);
    CHECK(d.header_len == 5);
    /* Flexible mode inter frame with two P_DIFF bytes. */
    uint8_t f[] = {0x80 | 0x40 | 0x20 | 0x10 | 0x08, 0x05, (2 << 5), 0x03, 0x02, 0x99};
    CHECK(vp9_parse(f, sizeof(f), &d));
    CHECK(!d.keyframe && d.tid == 2 && !d.has_tl0picidx && d.header_len == 5);
}

static void test_rtp(void) {
    /* Header with one-byte extension: id 1 (audio level) = 0x85. */
    uint8_t p[] = {0x90, 0x6F, 0x00, 0x05, 0, 0, 0, 100, 0, 0, 0, 7,
                   0xBE, 0xDE, 0x00, 0x01, 0x10, 0x85, 0x00, 0x00, 0xF8, 0xFF};
    rtp_pkt_t pkt;
    CHECK(rtp_parse(p, sizeof(p), &pkt));
    CHECK(pkt.pt == 111 && pkt.seq == 5 && pkt.ts == 100 && pkt.ssrc == 7);
    CHECK(pkt.payload_len == 2 && pkt.payload[0] == 0xF8);
    const uint8_t *v;
    CHECK(rtp_find_ext(&pkt, 1, &v) == 1 && v[0] == 0x85);
    CHECK(rtp_find_ext(&pkt, 2, &v) < 0);
    CHECK(!rtp_is_rtcp(p, sizeof(p)));

    uint8_t b[128];
    uint16_t seqs[] = {100, 101, 103, 200};
    size_t n = rtcp_build_nack(b, 1, 2, seqs, 4);
    CHECK(n == 20);
    CHECK(rd16(b + 12) == 100 && rd16(b + 14) == 0x0005);
    CHECK(rd16(b + 16) == 200 && rd16(b + 18) == 0);
    CHECK(rtp_is_rtcp(b, n));
    uint32_t ssrc = 9;
    n = rtcp_build_remb(b, 1, 1000000, &ssrc, 1);
    uint8_t exp = b[17] >> 2;
    uint32_t mantissa = ((uint32_t)(b[17] & 3) << 16) | rd16(b + 18);
    CHECK(n == 24 && ((uint64_t)mantissa << exp) <= 1000000 &&
          ((uint64_t)mantissa << exp) > 990000);
}

static int g_sent;

static void count_send(void *user, uint8_t *data, size_t len) {
    (void)user;
    (void)data;
    (void)len;
    g_sent++;
}

/* A burst that fits in the 100 ms budget must leave the queue, and a REMB near the media rate
 * must not cap an uncongested subscriber. */
static void test_pacer(void) {
    pacer_t p;
    pacer_init(&p, g_cfg.start_bps);
    uint8_t pkt[200];
    memset(pkt, 0, sizeof(pkt));
    for (int i = 0; i < 8; i++) CHECK(pacer_enqueue(&p, PRIO_BASE, pkt, sizeof(pkt), 1000));
    g_sent = 0;
    pacer_drain(&p, 1000, count_send, NULL);
    CHECK(g_sent == 8);
    CHECK(p.drops_total == 0);

    CHECK(pacer_enqueue(&p, PRIO_BASE, pkt, sizeof(pkt), 1000));
    pacer_drain(&p, 1000 + g_cfg.queue_ms + 40, count_send, NULL);
    CHECK(p.drops_expired == 1);
    CHECK(g_sent == 8);

    pacer_on_remb(&p, 300000, 5000);
    CHECK(pacer_limit_bps(&p, 5000) == g_cfg.start_bps);
    pacer_on_loss(&p, 0.05, 5000);
    CHECK(pacer_limit_bps(&p, 5000) == 300000);
    CHECK(pacer_limit_bps(&p, 5000 + 3000) == p.estimate_bps); /* REMB went stale */
    pacer_free(&p);
}

int main(void) {
    test_json();
    test_stun_roundtrip();
    test_crc32();
    test_vp8();
    test_vp9();
    test_rtp();
    test_pacer();
    if (g_failures) {
        fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    printf("all sfu-worker tests passed\n");
    return 0;
}
