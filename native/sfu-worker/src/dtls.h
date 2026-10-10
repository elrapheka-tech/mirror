// SPDX-License-Identifier: Apache-2.0
// DTLS-SRTP server side (we always answer with a=setup:passive).
#pragma once

#include "common.h"

#include <openssl/ssl.h>

typedef void (*dtls_send_fn)(void *user, const uint8_t *data, size_t len);

typedef struct {
    SSL *ssl;
    BIO *rbio;
    BIO *wbio;
    bool done;
    void *user;
} dtls_conn_t;

/* Generates the worker's ECDSA P-256 certificate; send is used for every outgoing DTLS record. */
int dtls_global_init(dtls_send_fn send);
/* "AA:BB:..." sha-256 fingerprint of our certificate, for the SDP answer. */
const char *dtls_local_fingerprint(void);

int dtls_conn_init(dtls_conn_t *c, void *user);
/* Feeds one datagram. Returns 1 when the handshake just completed, 0 to continue, -1 on
 * failure or close_notify. */
int dtls_conn_feed(dtls_conn_t *c, const uint8_t *data, size_t len);
void dtls_conn_handle_timeout(dtls_conn_t *c);
bool dtls_conn_peer_fingerprint(dtls_conn_t *c, char *out, size_t cap);
/* Exports 60 bytes of SRTP keying material: client key, server key, client salt, server salt. */
bool dtls_conn_export_srtp(dtls_conn_t *c, uint8_t out[60]);
void dtls_conn_free(dtls_conn_t *c);
