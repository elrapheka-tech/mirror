// SPDX-License-Identifier: Apache-2.0
// One UDP socket for every client (demultiplexed by ICE username, then by address).
#pragma once

#include "common.h"

#include <sys/socket.h>

typedef void (*net_packet_fn)(const struct sockaddr *from, uint8_t *buf, size_t len);

typedef struct {
    uint64_t rx_packets, rx_bytes;
    uint64_t tx_packets, tx_bytes;
    uint64_t tx_errors;
} net_stats_t;

extern net_stats_t g_net_stats;

int net_init(uv_loop_t *loop, const char *bind_ip, int port, net_packet_fn on_packet);
/* Sends immediately (STUN, DTLS, RTCP). */
void net_send(const struct sockaddr *to, const uint8_t *buf, size_t len);
/* Queues a datagram for the next flush; flushes on its own when the batch is full. */
void net_batch_add(const struct sockaddr *to, const uint8_t *buf, size_t len);
/* Sends the batch: sendmmsg on Linux, a sendto loop elsewhere. */
void net_batch_flush(void);
