// SPDX-License-Identifier: Apache-2.0
#include "dtls.h"

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/srtp.h>
#include <openssl/x509.h>

#define DTLS_MTU 1200

static SSL_CTX *g_ctx;
static char g_fingerprint[128];
static BIO_METHOD *g_writer_method;
static dtls_send_fn g_send;

static int verify_any(int ok, X509_STORE_CTX *ctx) {
    /* Browsers use self-signed certificates; we check the SDP fingerprint after the handshake. */
    return 1;
}

static int writer_write(BIO *b, const char *data, int len) {
    dtls_conn_t *c = BIO_get_data(b);
    if (c && g_send) g_send(c->user, (const uint8_t *)data, (size_t)len);
    return len;
}

static long writer_ctrl(BIO *b, int cmd, long num, void *ptr) {
    switch (cmd) {
    case BIO_CTRL_FLUSH: return 1;
    case BIO_CTRL_DGRAM_QUERY_MTU: return DTLS_MTU;
    default: return 0;
    }
}

static int writer_create(BIO *b) {
    BIO_set_init(b, 1);
    return 1;
}

static void format_fingerprint(const unsigned char *md, unsigned n, char *out, size_t cap) {
    size_t o = 0;
    for (unsigned i = 0; i < n && o + 3 < cap; i++)
        o += (size_t)snprintf(out + o, cap - o, i ? ":%02X" : "%02X", md[i]);
}

static X509 *make_certificate(EVP_PKEY *key) {
    X509 *x = X509_new();
    if (!x) return NULL;
    X509_set_version(x, 2);
    uint32_t serial;
    RAND_bytes((unsigned char *)&serial, sizeof(serial));
    ASN1_INTEGER_set(X509_get_serialNumber(x), (long)(serial & 0x7FFFFFFF));
    X509_gmtime_adj(X509_getm_notBefore(x), -86400);
    X509_gmtime_adj(X509_getm_notAfter(x), 30L * 86400);
    X509_set_pubkey(x, key);
    X509_NAME *name = X509_get_subject_name(x);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char *)"mirror-sfu", -1,
                               -1, 0);
    X509_set_issuer_name(x, name);
    if (!X509_sign(x, key, EVP_sha256())) {
        X509_free(x);
        return NULL;
    }
    return x;
}

int dtls_global_init(dtls_send_fn send) {
    g_send = send;
    EVP_PKEY *key = EVP_EC_gen("P-256");
    X509 *cert = key ? make_certificate(key) : NULL;
    if (!cert) {
        LOG("failed to create DTLS certificate");
        return -1;
    }
    unsigned char md[EVP_MAX_MD_SIZE];
    unsigned md_len = 0;
    X509_digest(cert, EVP_sha256(), md, &md_len);
    format_fingerprint(md, md_len, g_fingerprint, sizeof(g_fingerprint));

    g_ctx = SSL_CTX_new(DTLS_server_method());
    if (!g_ctx || SSL_CTX_use_certificate(g_ctx, cert) != 1 ||
        SSL_CTX_use_PrivateKey(g_ctx, key) != 1) {
        LOG("failed to configure DTLS context");
        return -1;
    }
    SSL_CTX_set_min_proto_version(g_ctx, DTLS1_2_VERSION);
    SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT, verify_any);
    /* Returns 0 on success, unlike most OpenSSL calls. */
    if (SSL_CTX_set_tlsext_use_srtp(g_ctx, "SRTP_AES128_CM_SHA1_80") != 0) {
        LOG("failed to enable DTLS-SRTP");
        return -1;
    }
    X509_free(cert);
    EVP_PKEY_free(key);

    g_writer_method = BIO_meth_new(BIO_TYPE_SOURCE_SINK | BIO_get_new_index(), "mirror-dtls-writer");
    BIO_meth_set_write(g_writer_method, writer_write);
    BIO_meth_set_ctrl(g_writer_method, writer_ctrl);
    BIO_meth_set_create(g_writer_method, writer_create);
    return 0;
}

const char *dtls_local_fingerprint(void) { return g_fingerprint; }

int dtls_conn_init(dtls_conn_t *c, void *user) {
    memset(c, 0, sizeof(*c));
    c->user = user;
    c->ssl = SSL_new(g_ctx);
    if (!c->ssl) return -1;
    c->rbio = BIO_new(BIO_s_mem());
    c->wbio = BIO_new(g_writer_method);
    if (!c->rbio || !c->wbio) return -1;
    BIO_set_mem_eof_return(c->rbio, -1);
    BIO_set_data(c->wbio, c);
    SSL_set_bio(c->ssl, c->rbio, c->wbio);
    SSL_set_accept_state(c->ssl);
    SSL_set_options(c->ssl, SSL_OP_NO_QUERY_MTU);
    SSL_set_mtu(c->ssl, DTLS_MTU);
    DTLS_set_link_mtu(c->ssl, DTLS_MTU);
    return 0;
}

int dtls_conn_feed(dtls_conn_t *c, const uint8_t *data, size_t len) {
    if (!c->ssl) return -1;
    BIO_write(c->rbio, data, (int)len);
    if (!c->done) {
        int r = SSL_do_handshake(c->ssl);
        if (r == 1) {
            c->done = true;
            return 1;
        }
        int err = SSL_get_error(c->ssl, r);
        if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) return 0;
        unsigned long e = ERR_get_error();
        LOG("DTLS handshake failed: %s", e ? ERR_error_string(e, NULL) : "unknown");
        ERR_clear_error();
        return -1;
    }
    char buf[2048];
    int r = SSL_read(c->ssl, buf, sizeof(buf));
    if (r <= 0) {
        int err = SSL_get_error(c->ssl, r);
        ERR_clear_error();
        if (err == SSL_ERROR_ZERO_RETURN) return -1;
    }
    return 0;
}

void dtls_conn_handle_timeout(dtls_conn_t *c) {
    if (c->ssl && !c->done) DTLSv1_handle_timeout(c->ssl);
}

bool dtls_conn_peer_fingerprint(dtls_conn_t *c, char *out, size_t cap) {
    X509 *peer = SSL_get1_peer_certificate(c->ssl);
    if (!peer) return false;
    unsigned char md[EVP_MAX_MD_SIZE];
    unsigned md_len = 0;
    bool ok = X509_digest(peer, EVP_sha256(), md, &md_len) == 1;
    X509_free(peer);
    if (ok) format_fingerprint(md, md_len, out, cap);
    return ok;
}

bool dtls_conn_export_srtp(dtls_conn_t *c, uint8_t out[60]) {
    SRTP_PROTECTION_PROFILE *profile = SSL_get_selected_srtp_profile(c->ssl);
    if (!profile || profile->id != SRTP_AES128_CM_SHA1_80) return false;
    static const char label[] = "EXTRACTOR-dtls_srtp";
    return SSL_export_keying_material(c->ssl, out, 60, label, sizeof(label) - 1, NULL, 0, 0) == 1;
}

void dtls_conn_free(dtls_conn_t *c) {
    if (c->ssl) SSL_free(c->ssl); /* also frees both BIOs */
    memset(c, 0, sizeof(*c));
}
