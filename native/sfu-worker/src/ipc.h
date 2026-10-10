// SPDX-License-Identifier: Apache-2.0
// Length-prefixed JSON over stdin/stdout (a socketpair created by the Node parent).
#pragma once

#include "common.h"
#include "json.h"

typedef void (*ipc_message_fn)(json_t *msg);

int ipc_init(uv_loop_t *loop, ipc_message_fn on_message);
/* Frames and writes one complete JSON document. */
void ipc_send_raw(const char *json, size_t len);
void ipc_reply(double id, const char *error, const sbuf_t *result);
/* data_json must be a JSON object literal. */
void ipc_emit(const char *event, const char *data_json);
