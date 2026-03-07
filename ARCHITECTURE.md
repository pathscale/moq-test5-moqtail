# moq-test5-moqtail

## Architecture

There are two distinct layers in this project: **app code** (media capture, encoding, decoding, rendering) and a **protocol package** (`moqtail` npm) that handles all MOQT wire format, control messages, and WebTransport session management. The app never touches the protocol — it only sends and receives `MoqtObject`s.

```mermaid
graph TB
    subgraph Browser["Browser"]
        subgraph AppCode["APP CODE (media capture, encode, decode, render)"]
            subgraph Publisher["Publisher (send)"]
                CAM[Camera/Mic<br/>getUserMedia]
                VE[VideoEncoder<br/>H.264 AVC]
                AE[AudioEncoder<br/>Opus]
            end

            subgraph Subscriber["Subscriber (receive)"]
                PB[PlayoutBuffer<br/>100ms target]
                SD[StallDetector<br/>auto-recovery]
                VD_W[VideoDecoder<br/>Web Worker]
                VD_M[VideoDecoder<br/>Main Thread fallback]
                AD[AudioDecoder<br/>Main Thread]
                CANVAS[Canvas 2D]
                SPEAKER[AudioContext]
            end
        end

        subgraph Package["PROTOCOL PACKAGE (moqtail v0.9.0)"]
            CLIENT[MOQtailClient<br/>WebTransport + MOQT draft-14]
            CTRL[ControlStream<br/>PUBLISH_NAMESPACE<br/>SUBSCRIBE / PUBLISH]
            DATA[DataStream<br/>Subgroup framing<br/>MoqtObject serialization]
        end
    end

    subgraph Relay["Relay Server"]
        R[Any MOQT draft-14 relay<br/>Cloudflare CDN / moqtail-rs / moq-dev]
    end

    CAM --> VE
    CAM --> AE
    VE -->|"MoqtObject"| CLIENT
    AE -->|"MoqtObject"| CLIENT
    CLIENT --> CTRL
    CTRL --> DATA
    DATA ==>|"QUIC Streams<br/>WebTransport"| R

    R ==>|"QUIC Streams<br/>WebTransport"| DATA
    DATA --> CLIENT
    CLIENT -->|"ReadableStream MoqtObject"| PB
    PB --> VD_W
    VD_W -.->|fallback| VD_M
    VD_W -->|VideoFrame| CANVAS
    VD_M -->|VideoFrame| CANVAS
    CLIENT -->|"ReadableStream MoqtObject"| AD
    AD --> SPEAKER

    style R fill:#e74c3c,color:#fff
    style Package fill:#9b59b6,color:#fff
    style AppCode fill:#2c3e50,color:#fff
```

### How it works

1. **App code (publisher)** captures camera/mic via `getUserMedia`, encodes with WebCodecs (H.264 + Opus), wraps each encoded chunk as a `MoqtObject`
2. **Protocol package** (`moqtail`) takes those `MoqtObject`s and handles everything else: WebTransport session, MOQT handshake, `PUBLISH_NAMESPACE`, subgroup framing, QUIC stream management
3. **Relay** receives published tracks and fans out to all subscribers. Compatible with any draft-14 relay (Cloudflare CDN, moqtail-rs, moq-dev)
4. **Protocol package** receives QUIC streams from the relay, parses them, and delivers a `ReadableStream<MoqtObject>` back to the app
5. **App code (subscriber)** takes those `MoqtObject`s, buffers them, decodes with WebCodecs, and renders to canvas + AudioContext

## Comparison with test2 (facebook-encoder)

The key difference is **what lives where**. A protocol package handles MOQT session management, control messages, and stream framing. Everything else (media capture, encoding, decoding, rendering, workers) is app-level code regardless of which approach you use.

In test2, protocol and media code are mixed together in workers. In test5, they are cleanly separated: the `moqtail` package owns all protocol work, the app only deals with media.

| Aspect | Layer | test2 (facebook-encoder) | test5 (moqtail) |
|--------|-------|--------------------------|-----------------|
| **MOQT session setup** | protocol | Hand-written in `moqt.js` (~800 lines): CLIENT_SETUP, SERVER_SETUP, version negotiation | `moqtail` package: `MOQtailClient.new({ url, supportedVersions })` |
| **Control messages** | protocol | Hand-written: PUBLISH, SUBSCRIBE, PUBLISH_NAMESPACE parsing and serialization in `moqt.js` | `moqtail` package: `client.subscribe()`, `client.publishNamespace()`, etc. |
| **Subgroup framing** | protocol | Hand-written in `moqt.js`: subgroup header `0x14`, varint encoding, object framing | `moqtail` package: handled internally, app never sees wire format |
| **MOQMI extensions** | protocol | Hand-written in `mi_packager.js`: extension headers embedded in subgroup objects | Not used — `moqtail` uses standard MOQT objects without custom extensions |
| **Stream management** | protocol | Hand-written in `moq_sender.js`: opens/closes QUIC unidirectional streams manually | `moqtail` package: stream lifecycle managed internally |
| **Wire format code** | protocol | ~2000 lines across `moqt.js` + `mi_packager.js` + `moq_sender.js` + `moq_demuxer_downloader.js` | 0 lines — all in `moqtail` npm package |
| | | | |
| **Video capture** | app | Worker: `v_capture.js` reads camera frames | App: `getUserMedia` on main thread |
| **Audio capture** | app | Worker: `a_capture.js` reads mic samples | App: `getUserMedia` on main thread |
| **Video encoding** | app | Worker: `v_encoder.js` (H.264 via WebCodecs) | App: `VideoEncoder` on main thread |
| **Audio encoding** | app | Worker: `a_encoder.js` (Opus via WebCodecs) | App: `AudioEncoder` on main thread |
| **Video decoding** | app | Main thread: `VideoDecoder` | App: Web Worker with main-thread fallback |
| **Audio decoding** | app | Worker: `audio_decoder.js` | App: `AudioDecoder` on main thread |
| **Audio playback** | app | `SharedArrayBuffer` circular buffer + `AudioWorklet` | App: `AudioBufferSourceNode` with scheduled playout |
| **Buffering** | app | 300ms jitter buffer per track (custom `jitter_buffer.js`) | App: `PlayoutBuffer` with 100ms target latency |
| **Stall recovery** | app | None — user must refresh the page | App: `StallDetector` with auto keyframe request + restart |
| **Participant discovery** | app | `localStorage` shared broadcastId or URL room name | App: `subscribeNamespace` prefix matching via relay announcements |
| **Connection model** | app | Separate WebTransport sessions for encoder and player | App: single `MOQtailClient` for both publish and subscribe |

**Summary**: If you extracted test2's protocol code into a package, you'd end up with the same split that test5 already has — the workers would stay in the app for media processing, and the protocol logic would move into the package. The `moqtail` package is essentially that extraction already done for you.

## Room / Video Call

```mermaid
graph LR
    subgraph A["Participant A"]
        CAM1["Camera + Mic"]
        SCREEN1["Screen + Speaker"]
    end

    subgraph B["Participant B"]
        CAM2["Camera + Mic"]
        SCREEN2["Screen + Speaker"]
    end

    RELAY["Relay Server"]

    CAM1 -->|"video + audio"| RELAY
    RELAY -->|"video + audio"| SCREEN2

    CAM2 -->|"video + audio"| RELAY
    RELAY -->|"video + audio"| SCREEN1
```

Each participant publishes their media to the relay and subscribes to the other's streams. The relay forwards without decoding or processing the media content.

### Join sequence

```mermaid
sequenceDiagram
    actor A as Alice
    participant M as MOQtailClient
    participant R as Relay
    actor B as Bob

    Note over A: Opens /myroom, generates broadcastId "abc123"
    A->>M: MOQtailClient.new({ url, supportedVersions: [DRAFT_14] })
    M->>R: CLIENT_SETUP (draft-14) via WebTransport
    R->>M: SERVER_SETUP
    M->>R: PUBLISH_NAMESPACE anon/myroom/abc123
    R->>M: PUBLISH_NAMESPACE_OK
    Note over A: Starts video + audio encoding

    A->>M: client.subscribeNamespace("anon/myroom")
    M->>R: SUBSCRIBE_NAMESPACE prefix=anon/myroom

    Note over B: Opens /myroom, generates broadcastId "xyz789"
    B->>R: CLIENT_SETUP + PUBLISH_NAMESPACE anon/myroom/xyz789
    R->>M: PUBLISH_NAMESPACE anon/myroom/xyz789

    Note over A: onNamespacePublished fires, discovers Bob
    A->>M: client.subscribe(video + audio on anon/myroom/xyz789)
    M->>R: SUBSCRIBE video, audio

    Note over A,B: Bidirectional media flow established
```

### Participant discovery

Each participant publishes under a unique namespace:

```
anon/{roomName}/{broadcastId}
```

The app calls `subscribeNamespace` with prefix `anon/{roomName}`. When the relay forwards a `PUBLISH_NAMESPACE` announcement from another participant, the `onNamespacePublished` callback fires and the subscriber auto-subscribes to their video and audio tracks.

```mermaid
flowchart TD
    PUB["Publisher.start -> PUBLISH_NAMESPACE anon/myroom/abc123"] --> LISTEN["subscribeNamespace prefix=anon/myroom"]
    LISTEN --> RECV{"onNamespacePublished: anon/myroom/xyz789"}
    RECV --> CHECK1{"Same room prefix?"}
    CHECK1 -->|Yes| CHECK2{"Different broadcastId?"}
    CHECK1 -->|No| IGNORE[Ignore]
    CHECK2 -->|Yes| SUB["subscribeToParticipant(anon/myroom/xyz789)"]
    CHECK2 -->|"No (own namespace)"| IGNORE
    SUB --> CONNECTED["Video + audio streams flowing"]
```

## Media pipeline

### Encoder pipeline (send)

```mermaid
graph TD
    subgraph Capture["APP: Capture"]
        CAM["Camera + Mic\n(getUserMedia)"]
        CAM -->|"raw VideoFrames\n(640x480 @ 30fps)"| VE["VideoEncoder\nH.264 Baseline\n(WebCodecs)"]
        CAM -->|"raw AudioData\n(48kHz mono)"| AE["AudioEncoder\nOpus 64kbps\n(WebCodecs)"]
    end

    subgraph Package_out["APP: Package as MoqtObject"]
        VE -->|"EncodedVideoChunk"| VS["Video MoqtObject\ngroup per keyframe\npriority=0"]
        AE -->|"EncodedAudioChunk"| AS["Audio MoqtObject\ngroup per 50 chunks\npriority=1"]
    end

    subgraph Send["PACKAGE: moqtail sends to relay"]
        VS --> LTS_V["LiveTrackSource\nvideo track"]
        AS --> LTS_A["LiveTrackSource\naudio track"]
        LTS_V --> CLIENT["MOQtailClient\naddOrUpdateTrack()"]
        LTS_A --> CLIENT
        CLIENT -->|"QUIC subgroup streams\n(WebTransport)"| RELAY["Relay"]
    end

    style Send fill:#9b59b6,color:#fff
```

1. **Capture** (app) -- `getUserMedia` provides raw video frames and audio samples on the main thread.

2. **Encode** (app) -- WebCodecs compresses the raw media:
   - **Video**: H.264 Baseline (`avc1.42001f`), 640x480 @ 30fps, 1 Mbps, `annexb` format. Key frames forced every 60 frames (~2s). Each keyframe starts a new MOQT group.
   - **Audio**: Opus at 64kbps, 48kHz mono. Chunks are grouped into batches of 50 (~1 second per group).

3. **Package** (app) -- Each encoded chunk is wrapped in a `MoqtObject` with location (group, object), priority, and forwarding preference (`Subgroup`). Video gets priority 0 (highest), audio gets priority 1.

4. **Send** (package) -- The `LiveTrackSource` wraps the `ReadableStream<MoqtObject>` and is registered with `client.addOrUpdateTrack()`. The moqtail library handles subgroup framing and QUIC stream management automatically.

### Subscriber pipeline (receive)

```mermaid
graph TD
    subgraph Receive["PACKAGE: moqtail receives from relay"]
        RELAY["Relay"] -->|"QUIC streams\n(WebTransport)"| CLIENT["MOQtailClient\nclient.subscribe()"]
    end

    subgraph VideoPath["APP: Video Pipeline"]
        CLIENT -->|"ReadableStream MoqtObject"| TS["TrackSubscription\nconsumes stream"]
        TS --> PB["PlayoutBuffer\n(100ms target, 120 max items)\ntick every 10ms"]
        PB -->|"release when due"| DEC{"Decode mode?"}
        DEC -->|"Worker available"| VD_W["VideoDecoder\n(Web Worker)\nH.264 -> VideoFrame"]
        DEC -->|"Worker unavailable"| VD_M["VideoDecoder\n(Main Thread)\nfallback"]
        VD_W -->|"postMessage(frame, transfer)"| SINK["VideoRenderSink"]
        VD_M --> SINK
        SINK --> CANVAS["VideoCanvas\nCanvas 2D drawImage"]
    end

    subgraph AudioPath["APP: Audio Pipeline"]
        CLIENT -->|"ReadableStream MoqtObject"| ADEC["AudioDecoder\nOpus -> AudioData"]
        ADEC -->|"AudioBufferSourceNode\nscheduled playout"| GAIN["GainNode\n(mute control)"]
        GAIN --> ANALYSER["AnalyserNode\n(RMS meter)"]
        ANALYSER --> DEST["AudioContext.destination\n(speaker)"]
    end

    subgraph Recovery["APP: Stall Recovery"]
        SD["StallDetector\n200ms tick"] -.->|"object stall (1500ms)\nor decode stall (800ms)"| REC["Recovery Handler"]
        REC -.->|"1. subscribeUpdate\n(keyframe request)"| CLIENT
        REC -.->|"2. if no progress:\nfull restart"| TS
    end

    style Receive fill:#9b59b6,color:#fff
```

4. **Receive** (package) -- `client.subscribe()` returns a `ReadableStream<MoqtObject>` with objects already parsed from QUIC streams. No manual wire-format parsing needed.

5. **Playout buffer** (app) -- Video objects enter a `PlayoutBuffer` (100ms target latency, max 120 items, 10ms tick). Objects are sorted by location (group, object) and released when their scheduled playout time arrives. Overflow drops oldest objects; late arrivals (already-released locations) are rejected.

6. **Decode** (app) -- WebCodecs decompresses the media:
   - Video: First attempts `VideoDecoder` in a dedicated Web Worker. If the worker fails to initialize (e.g., `VideoDecoder` not available in worker context), falls back to main-thread decoder. Decoded `VideoFrame`s are transferred back via `postMessage` with `Transferable`.
   - Audio: `AudioDecoder` on main thread. Decoded `AudioData` is converted to `AudioBuffer` and played via scheduled `AudioBufferSourceNode` with 50ms initial delay.

7. **Render** (app) -- Decoded frames are presented:
   - Video: drawn to a `<canvas>` element via `ctx.drawImage(frame)`. Local preview is horizontally flipped.
   - Audio: Routed through `GainNode` (speaker mute control) -> `AnalyserNode` (RMS metering) -> `AudioContext.destination`.

8. **Stall detection and recovery** (app) -- A `StallDetector` checks every 200ms for:
   - **Object stall** (1500ms no new objects): likely network issue -> request keyframe, then restart subscription
   - **Decode stall** (800ms no decoded frames while objects are arriving): likely decoder stuck -> reset decoder, request keyframe via `subscribeUpdate`, wait 1s for progress, then restart if no improvement
   - Rate-limited: max 3 recoveries per 30s window, minimum 3s between attempts

## Video key frames and grouping

```mermaid
graph LR
    subgraph G0["Group 0 (up to 60 frames, ~2s)"]
        KF0["Key frame\nobjectId=0\n(complete frame)"]
        DF1["Delta 1"]
        DF2["Delta 2"]
        DOTS["...up to 59 deltas..."]
    end

    subgraph G1["Group 1 (next 60 frames)"]
        KF1["Key frame\nobjectId=0"]
        DF61["Delta 1"]
        DOTS2["..."]
    end

    G0 --> G1
```

- **Key frames** are forced every 60 frames (~2s at 30fps). Each starts a new MOQT group (`groupId++`, `objectId=0`).
- **Delta frames** increment `objectId` within the current group.
- The `PlayoutBuffer` treats `objectId === 0` as a key frame for decode ordering.

## Audio grouping

```mermaid
graph LR
    subgraph G1["Group N (50 chunks, ~1s)"]
        C0["Chunk 0"]
        C1["Chunk 1"]
        DOTS["..."]
        C49["Chunk 49"]
    end

    subgraph G2["Group N+1"]
        C50["Chunk 50"]
        DOTS2["..."]
    end

    G1 --> G2
```

- Opus produces chunks at ~20ms intervals.
- Every 50 chunks (~1 second), `groupId` increments and `objectId` resets.
- All audio chunks are encoded as key frames (Opus is inherently a low-delay codec).

## Wire format

```mermaid
sequenceDiagram
    participant P as App (publisher)
    participant C as Package (MOQtailClient)
    participant R as Relay
    participant S as App (subscriber)

    P->>C: MOQtailClient.new({ url, [DRAFT_14] })
    C->>R: CLIENT_SETUP (draft-14)
    R->>C: SERVER_SETUP

    P->>C: publishNamespace(anon/room/id)
    C->>R: PUBLISH_NAMESPACE
    R->>C: PUBLISH_NAMESPACE_OK

    P->>C: addOrUpdateTrack(video, LiveTrackSource)
    P->>C: addOrUpdateTrack(audio, LiveTrackSource)

    Note over C: Tracks registered, awaiting subscribers

    S->>R: SUBSCRIBE video on anon/room/id
    R->>C: PUBLISH (request for video track)
    C->>R: PUBLISH_OK

    loop Media Streaming
        P->>C: MoqtObject (encoded frame)
        C->>R: Subgroup stream (header + object payload)
        R->>S: Subgroup stream (payload forwarded intact)
    end

    Note over P,S: App never touches wire format.<br/>Package handles subgroup headers,<br/>stream lifecycle, and object framing.
```

## File structure

```
src/                                    All app code (no protocol code here)
  App.tsx                               SolidJS router (single route -> Test5)
  pages/Test5.tsx                       Main page: wires publisher + subscriber + UI
  scenarios/
    MoqtailPublisher.ts                 Camera/mic capture -> WebCodecs encode -> moqtail publish
    MoqtailSubscriber.ts                Namespace discovery -> subscribe -> decode -> render
  media/subscriber/
    SubscriberEngine.ts                 Manages TrackSubscription lifecycle
    TrackSubscription.ts                Per-track: subscribe, playout buffer, decode, stall recovery
    PlayoutBuffer.ts                    Time-based release queue with overflow/late drop
    StallDetector.ts                    Periodic health check with auto-recovery triggers
    types.ts                            FrameObject, DecodedFrame, Worker message types
  workers/
    subscriberVideoDecodeWorker.ts      Dedicated VideoDecoder in Web Worker
  hooks/useTestSession.ts               Room state, relay URL, join/leave lifecycle
  components/
    TestShell.tsx                        Layout wrapper
    TestControls.tsx                     Relay URL, room name, join/leave controls
  VideoCanvas.tsx                       Canvas renderer for VideoFrame
  DebugPanel.tsx                        Diagnostics: connection status, RMS, event log
  helpers.ts                            URL normalization, relay URL persistence
  types.ts                              DiagEvent, RemoteParticipant interfaces

node_modules/moqtail/                   Protocol package (all protocol code lives here)
  MOQtailClient                         WebTransport session + MOQT handshake
  ControlStream                         Bidirectional control message stream
  DataStream                            Unidirectional data streams (subgroup framing)
  Message Handlers                      publish_namespace, subscribe, fetch, unsubscribe, ...
  Track + LiveTrackSource               Track registration and live content delivery
  Protocol Model                        ClientSetup, ServerSetup, MoqtObject, FullTrackName, Tuple, Location, ...
```
