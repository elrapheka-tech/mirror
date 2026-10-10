// SPDX-License-Identifier: Apache-2.0
// sfu-worker: one media process per CPU core, controlled by the Node signaling server.
#include "common.h"
#include "dtls.h"
#include "ipc.h"
#include "json.h"
#include "net.h"
#include "room.h"

#include <srtp2/srtp.h>
#include <unistd.h>
#ifdef __linux__
#include <sched.h>
#endif

static uv_timer_t g_pacer_timer, g_tick_timer, g_second_timer;
static int g_port = 40000;

static void on_message(json_t *msg) {
    double id = json_get_num(msg, "id", -1);
    const char *method = json_get_str(msg, "method", "");
    const json_t *params = json_get(msg, "params");
    sbuf_t result;
    sb_init(&result);
    const char *err;
    if (strcmp(method, "createRoom") == 0) err = room_api_create_room(params, &result);
    else if (strcmp(method, "closeRoom") == 0) err = room_api_close_room(params, &result);
    else if (strcmp(method, "createParticipant") == 0)
        err = room_api_create_participant(params, &result);
    else if (strcmp(method, "closeParticipant") == 0)
        err = room_api_close_participant(params, &result);
    else if (strcmp(method, "setViewerPrefs") == 0)
        err = room_api_set_viewer_prefs(params, &result);
    else if (strcmp(method, "getStats") == 0) err = room_api_get_stats(params, &result);
    else err = "unknown method";
    if (id >= 0) ipc_reply(id, err, &result);
    sb_free(&result);
}

static void pacer_cb(uv_timer_t *t) { room_tick_pacer(); }
static void tick_cb(uv_timer_t *t) { room_tick_100ms(); }
static void second_cb(uv_timer_t *t) { room_tick_1s(); }

static void usage(void) {
    fprintf(stderr,
            "usage: sfu-worker --port N [--bind IP] [--cpu N] [--audio-threshold N]\n"
            "                  [--surface-ms N] [--min-tile-ms N] [--hangover-ms N]\n"
            "                  [--queue-ms N] [--start-kbps N] [--max-kbps N]\n"
            "                  [--publisher-kbps N] [--timeout-ms N]\n"
            "Controlled over stdin/stdout by apps/signaling; not meant to be run by hand.\n");
}

int main(int argc, char **argv) {
    const char *bind_ip = "0.0.0.0";
    int cpu = -1;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!strcmp(a, "--help")) {
            usage();
            return 0;
        }
        if (!v) {
            usage();
            return 2;
        }
        i++;
        if (!strcmp(a, "--port")) g_port = atoi(v);
        else if (!strcmp(a, "--bind")) bind_ip = v;
        else if (!strcmp(a, "--cpu")) cpu = atoi(v);
        else if (!strcmp(a, "--audio-threshold")) g_cfg.audio_threshold = atoi(v);
        else if (!strcmp(a, "--surface-ms")) g_cfg.surface_ms = atoi(v);
        else if (!strcmp(a, "--min-tile-ms")) g_cfg.min_tile_ms = atoi(v);
        else if (!strcmp(a, "--hangover-ms")) g_cfg.hangover_ms = atoi(v);
        else if (!strcmp(a, "--queue-ms")) g_cfg.queue_ms = atoi(v);
        else if (!strcmp(a, "--start-kbps")) g_cfg.start_bps = atof(v) * 1000;
        else if (!strcmp(a, "--max-kbps")) g_cfg.max_bps = atof(v) * 1000;
        else if (!strcmp(a, "--publisher-kbps")) g_cfg.publisher_remb_bps = atoi(v) * 1000;
        else if (!strcmp(a, "--timeout-ms")) g_cfg.timeout_ms = atoi(v);
        else {
            usage();
            return 2;
        }
    }

#ifdef __linux__
    if (cpu >= 0) {
        cpu_set_t set;
        CPU_ZERO(&set);
        CPU_SET(cpu, &set);
        if (sched_setaffinity(0, sizeof(set), &set) != 0) LOG("could not pin to CPU %d", cpu);
    }
#else
    (void)cpu;
#endif

    if (srtp_init() != srtp_err_status_ok) {
        LOG("srtp_init failed");
        return 1;
    }
    if (dtls_global_init(room_dtls_send) != 0) return 1;

    uv_loop_t *loop = uv_default_loop();
    if (net_init(loop, bind_ip, g_port, room_on_packet) != 0) return 1;
    if (ipc_init(loop, on_message) != 0) {
        LOG("stdin/stdout must be the control socket");
        return 1;
    }

    uv_timer_init(loop, &g_pacer_timer);
    uv_timer_start(&g_pacer_timer, pacer_cb, 5, 5);
    uv_timer_init(loop, &g_tick_timer);
    uv_timer_start(&g_tick_timer, tick_cb, 100, 100);
    uv_timer_init(loop, &g_second_timer);
    uv_timer_start(&g_second_timer, second_cb, 1000, 1000);

    sbuf_t hello;
    sb_init(&hello);
    sb_puts(&hello, "{\"fingerprint\":");
    sb_json_str(&hello, dtls_local_fingerprint());
    sb_printf(&hello, ",\"port\":%d,\"pid\":%d}", g_port, (int)getpid());
    ipc_emit("hello", hello.buf);
    sb_free(&hello);

    return uv_run(loop, UV_RUN_DEFAULT);
}
