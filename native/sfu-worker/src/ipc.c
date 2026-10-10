// SPDX-License-Identifier: Apache-2.0
#include "ipc.h"

static uv_pipe_t g_in;
static uv_pipe_t g_out;
static ipc_message_fn g_on_message;
static uint8_t *g_rx;
static size_t g_rx_len, g_rx_cap;

typedef struct {
    uv_write_t req;
    uv_buf_t buf;
} write_req_t;

static void alloc_cb(uv_handle_t *h, size_t suggested, uv_buf_t *buf) {
    if (g_rx_cap - g_rx_len < 65536) {
        size_t cap = g_rx_cap ? g_rx_cap * 2 : 131072;
        while (cap - g_rx_len < 65536) cap *= 2;
        g_rx = realloc(g_rx, cap);
        if (!g_rx) abort();
        g_rx_cap = cap;
    }
    buf->base = (char *)g_rx + g_rx_len;
    buf->len = g_rx_cap - g_rx_len;
}

static void read_cb(uv_stream_t *s, ssize_t nread, const uv_buf_t *buf) {
    if (nread < 0) {
        LOG("control channel closed, exiting");
        exit(0);
    }
    g_rx_len += (size_t)nread;
    size_t off = 0;
    while (g_rx_len - off >= 4) {
        uint32_t len = rd32(g_rx + off);
        if (g_rx_len - off - 4 < len) break;
        json_t *msg = json_parse((const char *)g_rx + off + 4, len);
        if (msg) {
            g_on_message(msg);
            json_free(msg);
        } else {
            LOG("invalid IPC JSON (%u bytes)", len);
        }
        off += 4 + len;
    }
    if (off) {
        memmove(g_rx, g_rx + off, g_rx_len - off);
        g_rx_len -= off;
    }
}

static void write_cb(uv_write_t *req, int status) {
    write_req_t *w = (write_req_t *)req;
    free(w->buf.base);
    free(w);
}

int ipc_init(uv_loop_t *loop, ipc_message_fn on_message) {
    g_on_message = on_message;
    if (uv_pipe_init(loop, &g_in, 0) || uv_pipe_open(&g_in, 0)) return -1;
    if (uv_pipe_init(loop, &g_out, 0) || uv_pipe_open(&g_out, 1)) return -1;
    return uv_read_start((uv_stream_t *)&g_in, alloc_cb, read_cb);
}

void ipc_send_raw(const char *json, size_t len) {
    write_req_t *w = malloc(sizeof(*w));
    char *frame = malloc(len + 4);
    if (!w || !frame) abort();
    wr32((uint8_t *)frame, (uint32_t)len);
    memcpy(frame + 4, json, len);
    w->buf = uv_buf_init(frame, (unsigned)(len + 4));
    uv_write(&w->req, (uv_stream_t *)&g_out, &w->buf, 1, write_cb);
}

void ipc_reply(double id, const char *error, const sbuf_t *result) {
    sbuf_t sb;
    sb_init(&sb);
    sb_printf(&sb, "{\"id\":%.0f,\"ok\":%s", id, error ? "false" : "true");
    if (error) {
        sb_puts(&sb, ",\"error\":");
        sb_json_str(&sb, error);
    } else {
        sb_puts(&sb, ",\"result\":");
        sb_puts(&sb, result && result->len ? result->buf : "{}");
    }
    sb_putc(&sb, '}');
    ipc_send_raw(sb.buf, sb.len);
    sb_free(&sb);
}

void ipc_emit(const char *event, const char *data_json) {
    sbuf_t sb;
    sb_init(&sb);
    sb_puts(&sb, "{\"event\":");
    sb_json_str(&sb, event);
    sb_puts(&sb, ",\"data\":");
    sb_puts(&sb, data_json);
    sb_putc(&sb, '}');
    ipc_send_raw(sb.buf, sb.len);
    sb_free(&sb);
}
