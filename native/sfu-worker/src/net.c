// SPDX-License-Identifier: Apache-2.0
#include "net.h"

#include <errno.h>
#include <netinet/in.h>
#include <sys/types.h>

#define BATCH_MAX 64
#define DATAGRAM_MAX 1600
#define SOCKET_BUFFER (4 * 1024 * 1024)

net_stats_t g_net_stats;

static uv_udp_t g_udp;
static uv_os_fd_t g_fd = -1;
static net_packet_fn g_on_packet;
static uint8_t g_rx_buf[65536];

typedef struct {
    struct sockaddr_storage to;
    socklen_t to_len;
    size_t len;
    uint8_t data[DATAGRAM_MAX];
} batch_entry_t;

static batch_entry_t g_batch[BATCH_MAX];
static int g_batch_len;

static socklen_t addr_len(const struct sockaddr *sa) {
    return sa->sa_family == AF_INET6 ? sizeof(struct sockaddr_in6) : sizeof(struct sockaddr_in);
}

static void alloc_cb(uv_handle_t *h, size_t suggested, uv_buf_t *buf) {
    buf->base = (char *)g_rx_buf;
    buf->len = sizeof(g_rx_buf);
}

static void recv_cb(uv_udp_t *h, ssize_t nread, const uv_buf_t *buf, const struct sockaddr *addr,
                    unsigned flags) {
    if (nread <= 0 || !addr) return;
    g_net_stats.rx_packets++;
    g_net_stats.rx_bytes += (uint64_t)nread;
    g_on_packet(addr, (uint8_t *)buf->base, (size_t)nread);
}

int net_init(uv_loop_t *loop, const char *bind_ip, int port, net_packet_fn on_packet) {
    g_on_packet = on_packet;
    struct sockaddr_storage addr;
    if (strchr(bind_ip, ':')) {
        if (uv_ip6_addr(bind_ip, port, (struct sockaddr_in6 *)&addr) != 0) return -1;
    } else if (uv_ip4_addr(bind_ip, port, (struct sockaddr_in *)&addr) != 0) {
        return -1;
    }
    uv_udp_init(loop, &g_udp);
    int r = uv_udp_bind(&g_udp, (const struct sockaddr *)&addr, 0);
    if (r != 0) {
        LOG("cannot bind UDP %s:%d: %s", bind_ip, port, uv_strerror(r));
        return -1;
    }
    int size = SOCKET_BUFFER;
    uv_send_buffer_size((uv_handle_t *)&g_udp, &size);
    size = SOCKET_BUFFER;
    uv_recv_buffer_size((uv_handle_t *)&g_udp, &size);
    uv_fileno((uv_handle_t *)&g_udp, &g_fd);
    return uv_udp_recv_start(&g_udp, alloc_cb, recv_cb);
}

void net_send(const struct sockaddr *to, const uint8_t *buf, size_t len) {
    ssize_t r = sendto(g_fd, buf, len, 0, to, addr_len(to));
    if (r < 0) {
        g_net_stats.tx_errors++;
        return;
    }
    g_net_stats.tx_packets++;
    g_net_stats.tx_bytes += len;
}

void net_batch_add(const struct sockaddr *to, const uint8_t *buf, size_t len) {
    if (len > DATAGRAM_MAX) return;
    if (g_batch_len == BATCH_MAX) net_batch_flush();
    batch_entry_t *e = &g_batch[g_batch_len++];
    e->to_len = addr_len(to);
    memcpy(&e->to, to, e->to_len);
    memcpy(e->data, buf, len);
    e->len = len;
}

#ifdef __linux__
void net_batch_flush(void) {
    if (g_batch_len == 0) return;
    struct mmsghdr msgs[BATCH_MAX];
    struct iovec iov[BATCH_MAX];
    memset(msgs, 0, sizeof(msgs[0]) * (size_t)g_batch_len);
    for (int i = 0; i < g_batch_len; i++) {
        iov[i].iov_base = g_batch[i].data;
        iov[i].iov_len = g_batch[i].len;
        msgs[i].msg_hdr.msg_name = &g_batch[i].to;
        msgs[i].msg_hdr.msg_namelen = g_batch[i].to_len;
        msgs[i].msg_hdr.msg_iov = &iov[i];
        msgs[i].msg_hdr.msg_iovlen = 1;
    }
    int sent = 0;
    while (sent < g_batch_len) {
        int r = sendmmsg(g_fd, msgs + sent, (unsigned)(g_batch_len - sent), 0);
        if (r <= 0) {
            /* Socket buffer full: the rest of this batch is dropped rather than sent late. */
            g_net_stats.tx_errors += (uint64_t)(g_batch_len - sent);
            break;
        }
        for (int i = sent; i < sent + r; i++) {
            g_net_stats.tx_packets++;
            g_net_stats.tx_bytes += g_batch[i].len;
        }
        sent += r;
    }
    g_batch_len = 0;
}
#else
void net_batch_flush(void) {
    for (int i = 0; i < g_batch_len; i++)
        net_send((const struct sockaddr *)&g_batch[i].to, g_batch[i].data, g_batch[i].len);
    g_batch_len = 0;
}
#endif
