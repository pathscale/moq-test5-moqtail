# MoQ Test Harness

Standalone test app for debugging MoQ (Media over QUIC) audio/video streaming. Connects to the public MoQ CDN relay — no auth required.

## Run

```bash
bun install
bun dev
```

Opens on `http://localhost:3001`.

## Test

1. Open two browser tabs to `http://localhost:3001`
2. Both tabs should show the same stream name (auto-generated, persisted in localStorage)
3. Click **Join** on both tabs
4. Enable **Mic** and **Spkr** on both tabs
5. Speak — check the RMS meters and event log for audio activity

To share a specific room, use the URL: `http://localhost:3001/my-room-name`

## Local Relay

To run a local MoQ relay server instead of the public CDN:

**Requirements:** [Just](https://github.com/casey/just), [Rust](https://www.rust-lang.org/tools/install), [Bun](https://bun.sh/), [FFmpeg](https://ffmpeg.org/download.html)

```bash
# From the moq repo (../moq)
cd ../moq
just install

# Terminal 1: Start the relay server (listens on localhost:4443)
just relay

# Terminal 2 (optional): Publish a demo video
just pub tos
```

Then set relay URL to `http://localhost:4443` in the app. The `@moq/lite` library automatically fetches the self-signed certificate fingerprint from `http://localhost:4443/certificate.sha256` and upgrades to HTTPS for WebTransport.

If you have [Nix](https://nixos.org/download.html) with flakes enabled, you can skip manual installs:

```bash
cd ../moq
nix develop -c just relay
```

## CDN

Set relay URL to any public CDN node (for example `https://moq-relay.nofilter.io/`) — no local setup needed.

## Stack

- SolidJS 1.9 + @solidjs/router
- @moq/lite, @moq/publish, @moq/watch, @moq/signals
- RSBuild with SWC loader for @moq/* packages
- Tailwind 4 + DaisyUI 5
