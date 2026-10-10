// SPDX-License-Identifier: Apache-2.0
#include "json.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *s;
    size_t n;
    size_t i;
    int depth;
} parser_t;

static void skip_ws(parser_t *p) {
    while (p->i < p->n &&
           (p->s[p->i] == ' ' || p->s[p->i] == '\t' || p->s[p->i] == '\n' || p->s[p->i] == '\r'))
        p->i++;
}

static json_t *new_node(json_type_t t) {
    json_t *j = calloc(1, sizeof(*j));
    if (j) j->type = t;
    return j;
}

static void put_utf8(char *out, size_t *o, unsigned cp) {
    if (cp < 0x80) {
        out[(*o)++] = (char)cp;
    } else if (cp < 0x800) {
        out[(*o)++] = (char)(0xC0 | (cp >> 6));
        out[(*o)++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out[(*o)++] = (char)(0xE0 | (cp >> 12));
        out[(*o)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[(*o)++] = (char)(0x80 | (cp & 0x3F));
    } else {
        out[(*o)++] = (char)(0xF0 | (cp >> 18));
        out[(*o)++] = (char)(0x80 | ((cp >> 12) & 0x3F));
        out[(*o)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[(*o)++] = (char)(0x80 | (cp & 0x3F));
    }
}

static int hex4(const char *s, unsigned *out) {
    unsigned v = 0;
    for (int k = 0; k < 4; k++) {
        char c = s[k];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

static char *parse_string_raw(parser_t *p) {
    if (p->i >= p->n || p->s[p->i] != '"') return NULL;
    p->i++;
    size_t start = p->i;
    /* Escapes never expand output beyond input length (\uXXXX -> at most 4 bytes). */
    char *out = malloc(p->n - start + 1);
    if (!out) return NULL;
    size_t o = 0;
    while (p->i < p->n) {
        char c = p->s[p->i++];
        if (c == '"') {
            out[o] = '\0';
            return out;
        }
        if (c != '\\') {
            out[o++] = c;
            continue;
        }
        if (p->i >= p->n) break;
        char e = p->s[p->i++];
        switch (e) {
        case '"': out[o++] = '"'; break;
        case '\\': out[o++] = '\\'; break;
        case '/': out[o++] = '/'; break;
        case 'b': out[o++] = '\b'; break;
        case 'f': out[o++] = '\f'; break;
        case 'n': out[o++] = '\n'; break;
        case 'r': out[o++] = '\r'; break;
        case 't': out[o++] = '\t'; break;
        case 'u': {
            unsigned cp;
            if (p->i + 4 > p->n || hex4(p->s + p->i, &cp) < 0) goto fail;
            p->i += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && p->i + 6 <= p->n && p->s[p->i] == '\\' &&
                p->s[p->i + 1] == 'u') {
                unsigned lo;
                if (hex4(p->s + p->i + 2, &lo) == 0 && lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    p->i += 6;
                }
            }
            put_utf8(out, &o, cp);
            break;
        }
        default: goto fail;
        }
    }
fail:
    free(out);
    return NULL;
}

static json_t *parse_value(parser_t *p);

static json_t *parse_container(parser_t *p, bool is_obj) {
    json_t *node = new_node(is_obj ? JSON_OBJ : JSON_ARR);
    if (!node) return NULL;
    char close = is_obj ? '}' : ']';
    p->i++;
    json_t **tail = &node->child;
    skip_ws(p);
    if (p->i < p->n && p->s[p->i] == close) {
        p->i++;
        return node;
    }
    for (;;) {
        char *key = NULL;
        skip_ws(p);
        if (is_obj) {
            key = parse_string_raw(p);
            if (!key) goto fail;
            skip_ws(p);
            if (p->i >= p->n || p->s[p->i] != ':') {
                free(key);
                goto fail;
            }
            p->i++;
        }
        json_t *v = parse_value(p);
        if (!v) {
            free(key);
            goto fail;
        }
        v->key = key;
        *tail = v;
        tail = &v->next;
        node->len++;
        skip_ws(p);
        if (p->i < p->n && p->s[p->i] == ',') {
            p->i++;
            continue;
        }
        if (p->i < p->n && p->s[p->i] == close) {
            p->i++;
            return node;
        }
        goto fail;
    }
fail:
    json_free(node);
    return NULL;
}

static json_t *parse_value(parser_t *p) {
    skip_ws(p);
    if (p->i >= p->n || ++p->depth > 64) return NULL;
    json_t *r = NULL;
    char c = p->s[p->i];
    if (c == '{' || c == '[') {
        r = parse_container(p, c == '{');
    } else if (c == '"') {
        char *s = parse_string_raw(p);
        if (s && (r = new_node(JSON_STR))) r->str = s;
        else free(s);
    } else if (c == 't' && p->n - p->i >= 4 && !memcmp(p->s + p->i, "true", 4)) {
        p->i += 4;
        if ((r = new_node(JSON_BOOL))) r->b = true;
    } else if (c == 'f' && p->n - p->i >= 5 && !memcmp(p->s + p->i, "false", 5)) {
        p->i += 5;
        r = new_node(JSON_BOOL);
    } else if (c == 'n' && p->n - p->i >= 4 && !memcmp(p->s + p->i, "null", 4)) {
        p->i += 4;
        r = new_node(JSON_NULL);
    } else if (c == '-' || (c >= '0' && c <= '9')) {
        char tmp[64];
        size_t k = 0;
        while (p->i < p->n && k < sizeof(tmp) - 1 && strchr("+-0123456789.eE", p->s[p->i]))
            tmp[k++] = p->s[p->i++];
        tmp[k] = '\0';
        char *end;
        double v = strtod(tmp, &end);
        if (end != tmp && (r = new_node(JSON_NUM))) r->num = v;
    }
    p->depth--;
    return r;
}

json_t *json_parse(const char *s, size_t n) {
    parser_t p = {s, n, 0, 0};
    json_t *r = parse_value(&p);
    if (!r) return NULL;
    skip_ws(&p);
    if (p.i != p.n) {
        json_free(r);
        return NULL;
    }
    return r;
}

void json_free(json_t *j) {
    while (j) {
        json_t *next = j->next;
        json_free(j->child);
        free(j->key);
        free(j->str);
        free(j);
        j = next;
    }
}

json_t *json_get(const json_t *obj, const char *key) {
    if (!obj || obj->type != JSON_OBJ) return NULL;
    for (json_t *c = obj->child; c; c = c->next)
        if (c->key && strcmp(c->key, key) == 0) return c;
    return NULL;
}

json_t *json_at(const json_t *arr, size_t i) {
    if (!arr || arr->type != JSON_ARR) return NULL;
    json_t *c = arr->child;
    while (c && i--) c = c->next;
    return c;
}

const char *json_get_str(const json_t *obj, const char *key, const char *def) {
    json_t *v = json_get(obj, key);
    return v && v->type == JSON_STR ? v->str : def;
}

double json_get_num(const json_t *obj, const char *key, double def) {
    json_t *v = json_get(obj, key);
    return v && v->type == JSON_NUM ? v->num : def;
}

bool json_get_bool(const json_t *obj, const char *key, bool def) {
    json_t *v = json_get(obj, key);
    return v && v->type == JSON_BOOL ? v->b : def;
}

void sb_init(sbuf_t *sb) { memset(sb, 0, sizeof(*sb)); }

void sb_free(sbuf_t *sb) {
    free(sb->buf);
    memset(sb, 0, sizeof(*sb));
}

static void sb_reserve(sbuf_t *sb, size_t extra) {
    if (sb->len + extra + 1 <= sb->cap) return;
    size_t cap = sb->cap ? sb->cap : 256;
    while (cap < sb->len + extra + 1) cap *= 2;
    char *nb = realloc(sb->buf, cap);
    if (!nb) abort();
    sb->buf = nb;
    sb->cap = cap;
}

void sb_putc(sbuf_t *sb, char c) {
    sb_reserve(sb, 1);
    sb->buf[sb->len++] = c;
    sb->buf[sb->len] = '\0';
}

void sb_puts(sbuf_t *sb, const char *s) {
    size_t n = strlen(s);
    sb_reserve(sb, n);
    memcpy(sb->buf + sb->len, s, n + 1);
    sb->len += n;
}

void sb_printf(sbuf_t *sb, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n > 0) {
        sb_reserve(sb, (size_t)n);
        vsnprintf(sb->buf + sb->len, (size_t)n + 1, fmt, ap2);
        sb->len += (size_t)n;
    }
    va_end(ap2);
}

void sb_json_str(sbuf_t *sb, const char *s) {
    if (!s) {
        sb_puts(sb, "null");
        return;
    }
    sb_putc(sb, '"');
    for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
        switch (*c) {
        case '"': sb_puts(sb, "\\\""); break;
        case '\\': sb_puts(sb, "\\\\"); break;
        case '\n': sb_puts(sb, "\\n"); break;
        case '\r': sb_puts(sb, "\\r"); break;
        case '\t': sb_puts(sb, "\\t"); break;
        default:
            if (*c < 0x20) sb_printf(sb, "\\u%04x", *c);
            else sb_putc(sb, (char)*c);
        }
    }
    sb_putc(sb, '"');
}
