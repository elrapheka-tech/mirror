# Contributing

Mirror is Apache-2.0. See [LICENSE](LICENSE).

## Build

[SETUP.md](SETUP.md) is the setup. Node 22.18 or newer is required because the TypeScript is run directly, with no compile step. Imports use the `.ts` extension.

Install with pnpm, not npm. The version is pinned in `package.json`.

```sh
pnpm install
pnpm build:native
pnpm typecheck
pnpm test:native
```

Format with `pnpm format` before sending a change. C formatting is the `.clang-format` file in `native/sfu-worker`. Prettier covers the TypeScript and the web client.

## Where a change goes

- Signaling, tokens, admission, and the admin setting live in `apps/signaling`.
- Anything that touches RTP, DTLS, or the send queue lives in `native/sfu-worker`. Keep Node off the media path. Node and the worker talk length-prefixed JSON on the worker's stdin and stdout. The message shapes are in `packages/protocol`.
- The one room file, its manifest, and upload live in `apps/egress`.
- The browser is plain files in `apps/web/public`. There is no bundler.

A room is pinned to one worker. Slot SSRCs are chosen by Node and stay fixed for the life of the peer connection. Switching who a tile shows rewrites the SSRC, sequence number, timestamp, and VP8/VP9 picture id in the worker. It does not renegotiate.

## Tests

`native/sfu-worker/tests/test_main.c` covers parsing and the send pacer. `pnpm e2e` starts the server and joins three headless Chromium pages with a fake camera and microphone, then checks that video is decoded, the send queue is not dropping on an idle link, and the recording becomes one room file.

When you change SDP, forwarding, or recording, run `pnpm e2e`. It needs the native binary and Playwright's Chromium.
