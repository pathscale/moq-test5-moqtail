# moq-test5-moqtail

## Architecture

```mermaid
graph TB
    subgraph Browser["Browser (SolidJS UI)"]
        subgraph Publisher["MoqtailPublisher.ts"]
            CAM[Camera/Mic<br/>getUserMedia]
            VE[VideoEncoder<br/>Main Thread<br/>H.264 AVC]
            AE[AudioEncoder<br/>Main Thread<br/>Opus]
            LTS[LiveTrackSource<br/>ReadableStream&lt;MoqtObject&gt;]
        end

        subgraph Subscriber["MoqtailSubscriber.ts"]
            SE[SubscriberEngine<br/>TrackSubscription]
            PB[PlayoutBuffer<br/>100ms target latency]
            SD[StallDetector<br/>auto-recovery]
            VD_W[VideoDecoder<br/>Web Worker]
            VD_M[VideoDecoder<br/>Main Thread<br/>fallback]
            AD[AudioDecoder<br/>Main Thread]
            CANVAS[VideoCanvas<br/>Canvas 2D]
            SPEAKER[AudioContext<br/>+ BufferSource]
        end

        subgraph MOQtail["moqtail npm package (v0.9.0)"]
            CLIENT[MOQtailClient<br/>WebTransport session<br/>MOQT draft-14]
            CTRL[ControlStream<br/>PUBLISH / SUBSCRIBE<br/>PUBLISH_NAMESPACE]
            DATA[DataStream<br/>SubgroupHeader<br/>SubgroupObject]
        end
    end

    subgraph Relay["Relay Server"]
        R[Any MOQT relay<br/>Cloudflare CDN<br/>or moqtail-rs<br/>or moq-dev relay]
    end

    CAM --> VE
    CAM --> AE
    VE -->|MoqtObject| LTS
    AE -->|MoqtObject| LTS
    LTS --> CLIENT
    CLIENT --> CTRL
    CTRL --> DATA
    DATA ==>|"QUIC Streams<br/>WebTransport"| R

    R ==>|"QUIC Streams<br/>WebTransport"| CLIENT
    CLIENT -->|ReadableStream&lt;MoqtObject&gt;| SE
    SE --> PB
    PB -->|video objects| VD_W
    VD_W -.->|fallback| VD_M
    PB -->|release tick| VD_M
    VD_W -->|VideoFrame| CANVAS
    VD_M -->|VideoFrame| CANVAS
    CLIENT -->|ReadableStream&lt;MoqtObject&gt;| AD
    AD --> SPEAKER

    style R fill:#e74c3c,color:#fff
    style CLIENT fill:#9b59b6,color:#fff
    style LTS fill:#3498db,color:#fff
    style SE fill:#2ecc71,color:#fff
```

### How it works

1. **Publisher** captures camera/mic via `getUserMedia`, encodes with WebCodecs (H.264 + Opus), wraps each encoded chunk as a `MoqtObject`, and hands it to the `moqtail` client via `LiveTrackSource`
2. **moqtail client** handles all MOQT protocol details: WebTransport session setup, `PUBLISH_NAMESPACE`, subgroup framing, stream multiplexing -- the app never touches wire format
3. **Relay** receives published tracks and fans out to all subscribers. Compatible with any draft-14 relay (Cloudflare CDN, moqtail-rs, moq-dev)
4. **Subscriber** uses `subscribeNamespace` to discover remote participants, subscribes to their video/audio tracks, receives `MoqtObject` streams, decodes with WebCodecs, and renders to canvas + AudioContext

## Comparison with test2 (facebook-encoder)

| Aspect | test2 (facebook-encoder) | test5 (moqtail) |
|--------|--------------------------|-----------------|
| **Protocol layer** | Hand-written MOQT in JS (`moqt.js`, `mi_packager.js`) | `moqtail` npm package handles everything |
| **Encoding** | Workers: `v_capture.js` + `v_encoder.js` + `a_capture.js` + `a_encoder.js` | Main-thread `VideoEncoder` + `AudioEncoder` |
| **Sending** | Dedicated `moq_sender.js` worker writes QUIC streams directly | `LiveTrackSource` wraps a `ReadableStream<MoqtObject>`, library writes streams |
| **Receiving** | `moq_demuxer_downloader.js` worker reads QUIC streams + parses MOQMI framing | `client.subscribe()` returns `ReadableStream<MoqtObject>` already parsed |
| **Video decode** | `VideoDecoder` on main thread | Web Worker with main-thread fallback |
| **Audio playback** | `SharedArrayBuffer` circular buffer + `AudioWorklet` | `AudioContext.createBufferSource()` with scheduled playout |
| **Jitter/buffering** | 300ms jitter buffer per track (custom) | `PlayoutBuffer` with 100ms target latency + `StallDetector` auto-recovery |
| **Stall recovery** | Manual (user must refresh) | Automatic: keyframe request via `subscribeUpdate`, then full restart fallback |
| **Participant discovery** | `localStorage` shared broadcastId or URL room name | `subscribeNamespace` prefix matching via relay announcements |
| **Connection model** | Separate encoder/player WebTransport sessions | Single `MOQtailClient` for both publish and subscribe |
| **Wire format** | MOQMI extensions embedded in MOQT subgroup headers | Standard MOQT subgroup objects (no custom extensions) |
| **Lines of protocol code** | ~2000 (moqt.js + mi_packager.js + moq_sender.js + moq_demuxer_downloader.js) | 0 (all in npm package) |

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
    PUB["Publisher.start → PUBLISH_NAMESPACE anon/myroom/abc123"] --> LISTEN["subscribeNamespace prefix=anon/myroom"]
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
    subgraph Capture
        CAM["Camera + Mic\n(getUserMedia)"]
        CAM -->|"raw VideoFrames\n(640x480 @ 30fps)"| VE["VideoEncoder\nH.264 Baseline\n(WebCodecs)"]
        CAM -->|"raw AudioData\n(48kHz mono)"| AE["AudioEncoder\nOpus 64kbps\n(WebCodecs)"]
    end

    subgraph Package["Package as MoqtObject"]
        VE -->|"EncodedVideoChunk\n→ MoqtObject"| VS["Video ReadableStream\ngroup per keyframe\npriority=0"]
        AE -->|"EncodedAudioChunk\n→ MoqtObject"| AS["Audio ReadableStream\ngroup per 50 chunks\npriority=1"]
    end

    subgraph Send["moqtail client"]
        VS --> LTS_V["LiveTrackSource\nvideo track"]
        AS --> LTS_A["LiveTrackSource\naudio track"]
        LTS_V --> CLIENT["MOQtailClient\naddOrUpdateTrack()"]
        LTS_A --> CLIENT
        CLIENT -->|"QUIC subgroup streams\n(WebTransport)"| RELAY["Relay"]
    end
```

1. **Capture** -- `getUserMedia` provides raw video frames and audio samples on the main thread.

2. **Encode** -- WebCodecs compresses the raw media:
   - **Video**: H.264 Baseline (`avc1.42001f`), 640x480 @ 30fps, 1 Mbps, `annexb` format. Key frames forced every 60 frames (~2s). Each keyframe starts a new MOQT group.
   - **Audio**: Opus at 64kbps, 48kHz mono. Chunks are grouped into batches of 50 (~1 second per group).

3. **Package** -- Each encoded chunk is wrapped in a `MoqtObject` with location (group, object), priority, and forwarding preference (`Subgroup`). Video gets priority 0 (highest), audio gets priority 1.

4. **Send** -- The `LiveTrackSource` wraps the `ReadableStream<MoqtObject>` and is registered with `client.addOrUpdateTrack()`. The moqtail library handles subgroup framing and QUIC stream management automatically.

### Subscriber pipeline (receive)

```mermaid
graph TD
    subgraph Receive
        RELAY["Relay"] -->|"QUIC streams\n(WebTransport)"| CLIENT["MOQtailClient\nclient.subscribe()"]
    end

    subgraph VideoPath["Video Pipeline"]
        CLIENT -->|"ReadableStream&lt;MoqtObject&gt;"| TS["TrackSubscription\nconsumes stream"]
        TS --> PB["PlayoutBuffer\n(100ms target, 120 max items)\ntick every 10ms"]
        PB -->|"release when due"| DEC{"Decode mode?"}
        DEC -->|"Worker available"| VD_W["VideoDecoder\n(Web Worker)\nH.264 → VideoFrame"]
        DEC -->|"Worker unavailable"| VD_M["VideoDecoder\n(Main Thread)\nfallback"]
        VD_W -->|"postMessage(frame, transfer)"| SINK["VideoRenderSink"]
        VD_M --> SINK
        SINK --> CANVAS["VideoCanvas\nCanvas 2D drawImage"]
    end

    subgraph AudioPath["Audio Pipeline"]
        CLIENT -->|"ReadableStream&lt;MoqtObject&gt;"| ADEC["AudioDecoder\nOpus → AudioData"]
        ADEC -->|"AudioBufferSourceNode\nscheduled playout"| GAIN["GainNode\n(mute control)"]
        GAIN --> ANALYSER["AnalyserNode\n(RMS meter)"]
        ANALYSER --> DEST["AudioContext.destination\n(speaker)"]
    end

    subgraph Recovery["Stall Recovery"]
        SD["StallDetector\n200ms tick"] -.->|"object stall (1500ms)\nor decode stall (800ms)"| REC["Recovery Handler"]
        REC -.->|"1. subscribeUpdate\n(keyframe request)"| CLIENT
        REC -.->|"2. if no progress:\nfull restart"| TS
    end
```

4. **Receive** -- `client.subscribe()` returns a `ReadableStream<MoqtObject>` with objects already parsed from QUIC streams. No manual wire-format parsing needed.

5. **Playout buffer** -- Video objects enter a `PlayoutBuffer` (100ms target latency, max 120 items, 10ms tick). Objects are sorted by location (group, object) and released when their scheduled playout time arrives. Overflow drops oldest objects; late arrivals (already-released locations) are rejected.

6. **Decode** -- WebCodecs decompresses the media:
   - Video: First attempts `VideoDecoder` in a dedicated Web Worker. If the worker fails to initialize (e.g., `VideoDecoder` not available in worker context), falls back to main-thread decoder. Decoded `VideoFrame`s are transferred back via `postMessage` with `Transferable`.
   - Audio: `AudioDecoder` on main thread. Decoded `AudioData` is converted to `AudioBuffer` and played via scheduled `AudioBufferSourceNode` with 50ms initial delay.

7. **Render** -- Decoded frames are presented:
   - Video: drawn to a `<canvas>` element via `ctx.drawImage(frame)`. Local preview is horizontally flipped.
   - Audio: Routed through `GainNode` (speaker mute control) → `AnalyserNode` (RMS metering) → `AudioContext.destination`.

8. **Stall detection and recovery** -- A `StallDetector` checks every 200ms for:
   - **Object stall** (1500ms no new objects): likely network issue → request keyframe, then restart subscription
   - **Decode stall** (800ms no decoded frames while objects are arriving): likely decoder stuck → reset decoder, request keyframe via `subscribeUpdate`, wait 1s for progress, then restart if no improvement
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
    participant P as Publisher App
    participant C as MOQtailClient
    participant R as Relay
    participant S as Subscriber App

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

    Note over P,S: App never touches wire format.<br/>moqtail handles subgroup headers,<br/>stream lifecycle, and object framing.
```

## File structure

```
src/
  App.tsx                          # SolidJS router (single route → Test5)
  pages/Test5.tsx                  # Main page: wires publisher + subscriber + UI
  scenarios/
    MoqtailPublisher.ts            # Camera/mic capture → WebCodecs encode → moqtail publish
    MoqtailSubscriber.ts           # Namespace discovery → subscribe → decode → render
  media/subscriber/
    SubscriberEngine.ts            # Manages TrackSubscription lifecycle
    TrackSubscription.ts           # Per-track: subscribe, playout buffer, decode, stall recovery
    PlayoutBuffer.ts               # Time-based release queue with overflow/late drop
    StallDetector.ts               # Periodic health check with auto-recovery triggers
    types.ts                       # FrameObject, DecodedFrame, Worker message types
  workers/
    subscriberVideoDecodeWorker.ts # Dedicated VideoDecoder in Web Worker
  hooks/useTestSession.ts          # Room state, relay URL, join/leave lifecycle
  components/
    TestShell.tsx                   # Layout wrapper
    TestControls.tsx                # Relay URL, room name, join/leave controls
  VideoCanvas.tsx                  # Canvas renderer for VideoFrame
  DebugPanel.tsx                   # Diagnostics: connection status, RMS, event log
  helpers.ts                       # URL normalization, relay URL persistence
  types.ts                         # DiagEvent, RemoteParticipant interfaces

package.json dependencies:
  moqtail@0.9.0                   # MOQT protocol client (WebTransport, draft-14)
  solid-js@1.9                    # Reactive UI framework
  @solidjs/router                 # Client-side routing
  @pathscale/ui                   # UI component library
```

## Key abstraction: moqtail npm package

The `moqtail` package (`libs/moqtail-ts` in the [moqtail repo](https://github.com/moqtail/moqtail)) encapsulates the entire MOQT protocol stack:

```mermaid
graph TB
    subgraph App["test5 app code"]
        PUB["MoqtailPublisher"]
        SUB["MoqtailSubscriber"]
    end

    subgraph Package["moqtail npm package"]
        MC["MOQtailClient"]
        CS["ControlStream\n(bidirectional)"]
        DS["DataStream\n(uni streams)"]
        DG["DatagramStream\n(optional)"]
        HANDLERS["Message Handlers\npublish_namespace, subscribe,\nfetch, unsubscribe, ..."]
        TRACK["Track + LiveTrackSource\n+ ObjectCache"]
        MODEL["Protocol Model\nClientSetup, ServerSetup,\nSubscribe, Publish, MoqtObject,\nFullTrackName, Tuple, Location, ..."]
    end

    subgraph Transport["Browser WebTransport"]
        WT["WebTransport\n(HTTP/3 + QUIC)"]
    end

    PUB -->|"LiveTrackSource\naddOrUpdateTrack()"| MC
    SUB -->|"subscribe()\nsubscribeNamespace()"| MC
    MC --> CS
    MC --> DS
    MC --> DG
    CS --> HANDLERS
    HANDLERS --> MODEL
    DS --> MODEL
    MC --> TRACK
    CS --> WT
    DS --> WT
    DG --> WT

    style Package fill:#9b59b6,color:#fff
```

The app only interacts with high-level APIs:
- `MOQtailClient.new()` -- establish WebTransport + MOQT session
- `publishNamespace()` / `publishNamespaceDone()` -- announce/withdraw namespaces
- `addOrUpdateTrack()` -- register tracks with `LiveTrackSource`
- `subscribe()` -- get a `ReadableStream<MoqtObject>`
- `subscribeNamespace()` -- discover remote participants
- `subscribeUpdate()` -- request keyframes for stall recovery
- `unsubscribe()` / `disconnect()` -- teardown

All MOQT wire format details (subgroup headers, varint encoding, stream lifecycle, control messages) are handled internally by the package.
