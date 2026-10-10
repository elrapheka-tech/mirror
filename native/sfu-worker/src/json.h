// SPDX-License-Identifier: Apache-2.0
// Minimal JSON reader/writer for the IPC channel (messages are small and trusted).
#pragma once

#include <stdbool.h>
#include <stddef.h>

typedef enum { JSON_NULL, JSON_BOOL, JSON_NUM, JSON_STR, JSON_ARR, JSON_OBJ } json_type_t;

typedef struct json json_t;
struct json {
    json_type_t type;
    char *key;
    char *str;
    double num;
    bool b;
    json_t *child;
    json_t *next;
    size_t len;
};

json_t *json_parse(const char *s, size_t n);
void json_free(json_t *j);
json_t *json_get(const json_t *obj, const char *key);
json_t *json_at(const json_t *arr, size_t i);
const char *json_get_str(const json_t *obj, const char *key, const char *def);
double json_get_num(const json_t *obj, const char *key, double def);
bool json_get_bool(const json_t *obj, const char *key, bool def);

typedef struct {
    char *buf;
    size_t len;
    size_t cap;
} sbuf_t;

void sb_init(sbuf_t *sb);
void sb_free(sbuf_t *sb);
void sb_putc(sbuf_t *sb, char c);
void sb_puts(sbuf_t *sb, const char *s);
void sb_printf(sbuf_t *sb, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
/* Appends s as a quoted, escaped JSON string; NULL becomes null. */
void sb_json_str(sbuf_t *sb, const char *s);
