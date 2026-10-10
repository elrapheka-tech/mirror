// SPDX-License-Identifier: Apache-2.0
#include "stun.h"

#include <netinet/in.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#define ATTR_USERNAME 0x0006
#define ATTR_MESSAGE_INTEGRITY 0x0008
#define ATTR_XOR_MAPPED_ADDRESS 0x0020
#define ATTR_USE_CANDIDATE 0x0025
#define ATTR_FINGERPRINT 0x8028
#define FINGERPRINT_XOR 0x5354554Eu

uint32_t stun_crc32(const uint8_t *buf, size_t len) {
    static uint32_t table[256];
    static bool ready = false;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        ready = true;
    }
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

bool stun_is_packet(const uint8_t *buf, size_t len) {
    return len >= 20 && buf[0] < 2 && rd32(buf + 4) == STUN_MAGIC;
}

bool stun_parse(const uint8_t *buf, size_t len, stun_msg_t *msg) {
    memset(msg, 0, sizeof(*msg));
    if (!stun_is_packet(buf, len)) return false;
    size_t body = rd16(buf + 2);
    if (20 + body > len || (body & 3)) return false;
    msg->type = rd16(buf);
    memcpy(msg->txid, buf + 8, 12);
    size_t off = 20, end = 20 + body;
    while (off + 4 <= end) {
        uint16_t type = rd16(buf + off);
        uint16_t alen = rd16(buf + off + 2);
        if (off + 4 + alen > end) return false;
        const uint8_t *val = buf + off + 4;
        switch (type) {
        case ATTR_USERNAME: {
            size_t n = alen < sizeof(msg->username) - 1 ? alen : sizeof(msg->username) - 1;
            memcpy(msg->username, val, n);
            msg->username[n] = '\0';
            msg->has_username = true;
            break;
        }
        case ATTR_USE_CANDIDATE: msg->use_candidate = true; break;
        case ATTR_MESSAGE_INTEGRITY:
            if (alen != 20) return false;
            msg->has_integrity = true;
            msg->integrity_offset = off;
            break;
        default: break;
        }
        off += 4 + (((size_t)alen + 3) & ~(size_t)3);
    }
    return true;
}

bool stun_check_integrity(const uint8_t *buf, size_t len, const stun_msg_t *msg, const char *pwd) {
    if (!msg->has_integrity || msg->integrity_offset + 24 > len) return false;
    uint8_t tmp[1500];
    size_t n = msg->integrity_offset;
    if (n > sizeof(tmp)) return false;
    memcpy(tmp, buf, n);
    /* The length field covers attributes up to and including MESSAGE-INTEGRITY. */
    wr16(tmp + 2, (uint16_t)(n - 20 + 24));
    uint8_t mac[EVP_MAX_MD_SIZE];
    unsigned mac_len = 0;
    if (!HMAC(EVP_sha1(), pwd, (int)strlen(pwd), tmp, n, mac, &mac_len) || mac_len != 20)
        return false;
    return CRYPTO_memcmp(mac, buf + msg->integrity_offset + 4, 20) == 0;
}

size_t stun_build_binding_success(uint8_t *out, const uint8_t txid[12], const struct sockaddr *addr,
                                  const char *pwd) {
    wr16(out, STUN_BINDING_SUCCESS);
    wr32(out + 4, STUN_MAGIC);
    memcpy(out + 8, txid, 12);
    size_t off = 20;

    if (addr->sa_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
        wr16(out + off, ATTR_XOR_MAPPED_ADDRESS);
        wr16(out + off + 2, 8);
        out[off + 4] = 0;
        out[off + 5] = 0x01;
        wr16(out + off + 6, (uint16_t)(ntohs(in->sin_port) ^ (STUN_MAGIC >> 16)));
        wr32(out + off + 8, ntohl(in->sin_addr.s_addr) ^ STUN_MAGIC);
        off += 12;
    } else {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
        uint8_t mask[16];
        wr32(mask, STUN_MAGIC);
        memcpy(mask + 4, txid, 12);
        wr16(out + off, ATTR_XOR_MAPPED_ADDRESS);
        wr16(out + off + 2, 20);
        out[off + 4] = 0;
        out[off + 5] = 0x02;
        wr16(out + off + 6, (uint16_t)(ntohs(in6->sin6_port) ^ (STUN_MAGIC >> 16)));
        for (int i = 0; i < 16; i++) out[off + 8 + i] = in6->sin6_addr.s6_addr[i] ^ mask[i];
        off += 24;
    }

    wr16(out + 2, (uint16_t)(off - 20 + 24));
    unsigned mac_len = 0;
    HMAC(EVP_sha1(), pwd, (int)strlen(pwd), out, off, out + off + 4, &mac_len);
    wr16(out + off, ATTR_MESSAGE_INTEGRITY);
    wr16(out + off + 2, 20);
    off += 24;

    wr16(out + 2, (uint16_t)(off - 20 + 8));
    uint32_t crc = stun_crc32(out, off) ^ FINGERPRINT_XOR;
    wr16(out + off, ATTR_FINGERPRINT);
    wr16(out + off + 2, 4);
    wr32(out + off + 4, crc);
    off += 8;
    return off;
}
