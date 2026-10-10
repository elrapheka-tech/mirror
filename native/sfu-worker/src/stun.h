// SPDX-License-Identifier: Apache-2.0
// ICE-lite STUN: answer binding requests from browsers (RFC 5389 / 8445).
#pragma once

#include "common.h"

#include <sys/socket.h>

#define STUN_MAGIC 0x2112A442u
#define STUN_BINDING_REQUEST 0x0001
#define STUN_BINDING_SUCCESS 0x0101

typedef struct {
    uint16_t type;
    uint8_t txid[12];
    char username[256];
    bool has_username;
    bool use_candidate;
    bool has_integrity;
    size_t integrity_offset;
} stun_msg_t;

bool stun_is_packet(const uint8_t *buf, size_t len);
bool stun_parse(const uint8_t *buf, size_t len, stun_msg_t *msg);
/* Verifies MESSAGE-INTEGRITY with the short-term credential (our ICE password). */
bool stun_check_integrity(const uint8_t *buf, size_t len, const stun_msg_t *msg, const char *pwd);
/* Builds a binding success response with XOR-MAPPED-ADDRESS, MESSAGE-INTEGRITY and FINGERPRINT.
 * out must hold at least 128 bytes. Returns the response length. */
size_t stun_build_binding_success(uint8_t *out, const uint8_t txid[12], const struct sockaddr *addr,
                                  const char *pwd);
uint32_t stun_crc32(const uint8_t *buf, size_t len);
