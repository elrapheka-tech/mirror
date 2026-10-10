# Setup

Production target is Linux. Development and the checks below were done on macOS.

You need Node.js 22.18 or newer, pnpm 10 (`packageManager` in `package.json` pins 10.10.0), a C toolchain, CMake, OpenSSL 3, libsrtp2, libuv, and ffmpeg. Enable pnpm with `corepack enable && corepack prepare pnpm@10.10.0 --activate`, or install it with your package manager. `npm install` is refused.

## macOS

These are the commands used to build and run Mirror on macOS:

```sh
brew install cmake pkg-config openssl@3 srtp libuv ffmpeg
node --version   # 22.18 or newer
pnpm install
pnpm build:native
pnpm test
pnpm test:native
cp .env.example .env
pnpm dev
```

The native build finds Homebrew's OpenSSL by itself. Open `http://127.0.0.1:7880`.

`pnpm e2e` installs Playwright's Chromium on first use (`pnpm exec playwright install chromium`) and runs three headless browsers against the server and the C worker.

## Linux (Debian or Ubuntu)

Package names the build expects:

```sh
sudo apt-get update
sudo apt-get install -y build-essential cmake pkg-config libssl-dev libsrtp2-dev libuv1-dev ffmpeg
pnpm install
pnpm build:native
pnpm dev
```

This package list has not been re-run inside a Linux container yet. The CMake file asks pkg-config for `libsrtp2` and `libuv`, and CMake's OpenSSL finder for OpenSSL 3.

## Firewall

Signaling listens on TCP `SIGNALING_PORT` (7880). Each media worker listens on one UDP port, starting at `MEDIA_PORT_BASE` (40000). Open that TCP port and `WORKER_COUNT` UDP ports.

Set `ANNOUNCED_IP` to the address browsers should send media to. Leave it as `127.0.0.1` only when the browser is on the same machine. For callers on other machines, set it to this host's reachable IP and set `ICE_SERVERS` if those callers are behind NAT. Mirror answers ICE as an ice-lite server; it does not dial out through a TURN server itself. A TURN server in `ICE_SERVERS` is used by the browser.

## Environment

Copy `.env.example` to `.env`. `pnpm dev` loads it. An empty value means the default.

### Process

| Variable | Default | Meaning |
| --- | --- | --- |
| `SIGNALING_HOST` | `0.0.0.0` | HTTP bind address |
| `SIGNALING_PORT` | `7880` | HTTP and WebSocket port |
| `WEB_PUBLIC_DIR` | `apps/web/public` | Static files, relative to the repo |
| `API_KEY` | empty | If set, `POST /tokens` and `GET /stats` require `Authorization: Bearer` |
| `JWT_SECRET` | a published dev secret | HMAC secret for room tokens. Set this anywhere but a laptop |
| `ADMIN_API_KEY` | empty | If set, `/admin` and `/admin/settings` require it. If empty, those routes answer only from localhost |
| `SETTINGS_FILE` | `data/settings.json` | Saved admin settings, including whether new rooms are recorded |
| `ICE_SERVERS` | `[]` | JSON array of RTCIceServer objects handed to the browser |

### Media workers

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_BINARY` | `build/native/sfu-worker` | C worker path |
| `WORKER_COUNT` | one less than the CPU count | Worker processes. Core 0 is left for Node |
| `WORKER_PIN_CPUS` | `true` | Pin worker `i` to CPU `i+1` on Linux. Pinning is skipped on macOS |
| `MEDIA_BIND_IP` | `127.0.0.1` when `ANNOUNCED_IP` is loopback, otherwise `0.0.0.0` | UDP bind address. Do not use `0.0.0.0` together with `ANNOUNCED_IP=127.0.0.1`; the replies come from the wrong address and browsers drop the call |
| `MEDIA_PORT_BASE` | `40000` | First worker's UDP port. The next workers take the following ports |
| `ANNOUNCED_IP` | `127.0.0.1` | Address placed in the SDP answer |
| `VIDEO_CODECS` | `vp9,vp8` | Preference order. The room uses the first codec the first participant can send |
| `ROOM_EMPTY_TIMEOUT_SEC` | `10` | How long an empty room stays open before the recording is finalized |

Worker tuning, applied only when the variable is set:

| Variable | Worker flag | Role |
| --- | --- | --- |
| `AUDIO_LEVEL_THRESHOLD` | `--audio-threshold` | RFC 6464 level at or below which a person counts as speaking. Default in the worker is 55 |
| `SURFACE_MS` | `--surface-ms` | Speech time before someone is pulled into a tile. Default 1000 |
| `MIN_TILE_MS` | `--min-tile-ms` | Minimum time a tile stays. Default 4000 |
| `HANGOVER_MS` | `--hangover-ms` | How long someone stays "speaking" after going quiet. Default 500 |
| `QUEUE_MS` | `--queue-ms` | Per-subscriber send queue bound. Default 100 |
| `PUBLISHER_KBPS` | `--publisher-kbps` | REMB the worker sends to publishers. Default 1000 |
| `SUBSCRIBER_START_KBPS` | `--start-kbps` | Initial send estimate. Default 1500 |
| `SUBSCRIBER_MAX_KBPS` | `--max-kbps` | Estimate ceiling. Default 8000 |
| `PARTICIPANT_TIMEOUT_MS` | `--timeout-ms` | Drop a participant after this long with no packets. Default 15000 |

### Capacity

Joins are refused when the projected outbound rate would pass `CAPACITY_MBPS`. The projection is `n * (min(n-1, 10) * VIDEO_TILE_KBPS + min(n-1, AVG_SPEAKERS) * AUDIO_KBPS)` per room.

| Variable | Default |
| --- | --- |
| `CAPACITY_MBPS` | `900` |
| `VIDEO_TILE_KBPS` | `80` |
| `AUDIO_KBPS` | `40` |
| `AVG_SPEAKERS` | `1.5` |

### Recording and upload

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECORDING_ENABLED` | `true` | Starting value, until an admin changes it. The saved setting then wins |
| `RECORDINGS_DIR` | `recordings` | Local recording directories |
| `RECORDING_MIN_FREE_GB` | `10` | Below this, new rooms are not recorded |
| `CLEANUP_WATERMARK_GB` | `30` | Below this free space, upload runs immediately |
| `CLEANUP_TIME` | `02:00` | Daily local time for the upload run, `HH:MM` |
| `CLEANUP_MAX_MBPS` | `200` | Upload cap. The live call rate is subtracted from `CAPACITY_MBPS` first |
| `FFMPEG_PATH` | `ffmpeg` | Used to remux IVF and Ogg into MP4 or WebM |
| `S3_ENDPOINT` | empty | Set for MinIO, R2, or any non-AWS endpoint |
| `S3_REGION` | `us-east-1` | |
| `S3_BUCKET` | empty | Upload stays off until this is set |
| `S3_ACCESS_KEY_ID` | empty | Required when `S3_BUCKET` is set |
| `S3_SECRET_ACCESS_KEY` | empty | Required when `S3_BUCKET` is set |
| `S3_PREFIX` | `recordings/` | Key prefix inside the bucket |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style URLs, which MinIO needs |

`pnpm cleanup` uploads every finalized recording once, ignoring the clock.

## HTTP API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `200` when at least one worker is up |
| `GET /config` | none | `{ iceServers, tokenRequiresApiKey }` for the browser |
| `POST /tokens` | `API_KEY` if set | Body `{ room, identity, name, ttlSec, canPublish, canSubscribe }` |
| `GET /stats` | `API_KEY` if set | Rooms, projected Mbps, worker counters, free disk |
| `GET /admin/settings` | admin | Current settings and how many rooms are recording |
| `PUT /admin/settings` | admin | Body `{ "recordingEnabled": true }` or `false` |
| `GET /ws` | room token | WebSocket signaling |

Room names match `[A-Za-z0-9_-]{1,48}`.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm test:native
pnpm e2e
```

`pnpm test` currently has no test files. The C tests and `pnpm e2e` are the checks that exercise the media path.
