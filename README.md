# Mirror

Self-hosted video rooms. A Node.js process handles tokens, rooms, and the browser, and a C process per CPU core forwards the media. Calls are recorded on local disk and can be uploaded to S3-compatible storage later.

Mirror is an SFU: each person sends one audio and one video track, and the server forwards a selection of other people back. A room page shows at most 10 video tiles. Tiles follow who is talking, and audio is forwarded only for people who are speaking.

## What you get

- Browser client at `/`, with mute, camera, pin, and paging.
- Admin switch at `/admin` to turn recording of new rooms on or off. The choice is saved in `data/settings.json`.
- One recording of the room when it ends: everyone's audio mixed, and every camera in one 16:9 grid (MP4 for VP9, WebM for VP8), plus `manifest.json`.
- VP9 preferred, VP8 if the room's first participant cannot send VP9.
- A single tile keeps the full frame rate. Grid video is capped around 15 fps by dropping the top temporal layer, and under loss it drops further.

## Run it locally

Setup steps, system packages, and every environment variable are in [SETUP.md](SETUP.md).

```sh
pnpm install
pnpm build:native
pnpm dev
```

Open `http://127.0.0.1:7880`. `ANNOUNCED_IP` must be an address the browser can send UDP to. `127.0.0.1` is correct when the browser is on the same machine.

## Layout

| Path | Role |
| --- | --- |
| `apps/signaling` | HTTP API, WebSocket signaling, worker processes |
| `native/sfu-worker` | UDP, ICE-lite, DTLS, SRTP, forwarding, raw recording |
| `apps/egress` | Compose one room file with ffmpeg, manifest, upload, delete |
| `apps/web/public` | The room page and the admin page |
| `packages/protocol` | Message types shared by the Node apps |

## Limits worth knowing

- Bandwidth control is loss-based. A receiver bandwidth report (REMB) caps the send rate only after that receiver reports loss, so a report that merely echoes the current video bitrate does not shrink the queue. This is not full transport-cc congestion control.
- UDP generic segmentation offload is not used. Packet sizes vary, so the sender batches with `sendmmsg` on Linux and a normal send loop elsewhere.
- Subscribers are not sent sender reports, so players cannot use RTCP to line up audio and video.
- There is no simulcast. Each publisher sends one encoded video stream.
- A room lives on a single media worker. Workers do not share a room.
- Recording produces one file for the room, not one file per participant. The picture is a 16:9 grid of every camera, in join order. The live page still shows at most 10 tiles and follows who is talking; the file keeps every camera. Audio in the file is everyone mixed.
- Recording on or off applies to rooms created after the change. A room already recording keeps recording until it ends.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
