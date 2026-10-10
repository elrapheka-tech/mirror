// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>

#define LOG(fmt, ...) fprintf(stderr, "[sfu-worker] " fmt "\n", ##__VA_ARGS__)

static inline uint64_t now_ms(void) { return uv_hrtime() / 1000000ULL; }

static inline uint64_t wall_ms(void) {
    uv_timeval64_t tv;
    uv_gettimeofday(&tv);
    return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
}

static inline uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static inline uint32_t rd32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static inline void wr16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}
static inline void wr32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

/* True when a is newer than b in 16-bit sequence space. */
static inline bool seq_newer(uint16_t a, uint16_t b) { return a != b && (uint16_t)(a - b) < 0x8000; }
