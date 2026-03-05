import {
    DRAFT_14,
    FullTrackName,
    LiveTrackSource,
    Location,
    MOQtailClient,
    MoqtObject,
    ObjectForwardingPreference,
    PublishNamespaceError,
    Tuple,
    TupleField,
} from "moqtail";
import { createSignal } from "solid-js";

type LogFn = (tag: string, msg: string) => void;

export function createMoqtailPublisher(log: LogFn) {
    const [connectionStatus, setConnectionStatus] = createSignal("disconnected");
    const [publishingVideo, setPublishingVideo] = createSignal(false);
    const [publishingAudio, setPublishingAudio] = createSignal(false);
    const [pubRms, setPubRms] = createSignal(0);
    const [localFrame, setLocalFrame] = createSignal<VideoFrame | undefined>(
        undefined,
    );

    let client: MOQtailClient | undefined;
    let videoTrack: MediaStreamTrack | undefined;
    let audioTrack: MediaStreamTrack | undefined;
    let audioStream: MediaStream | undefined;

    // Video encoding state
    let videoEncoder: VideoEncoder | undefined;
    let videoReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
    let videoStopped = false;

    // Audio encoding state
    let audioEncoder: AudioEncoder | undefined;
    let audioReader: ReadableStreamDefaultReader<AudioData> | undefined;
    let audioStopped = false;

    // Published namespace tuple
    let publishedNamespace: string[] | undefined;
    let publishedVideoFullTrackName: FullTrackName | undefined;
    let publishedAudioFullTrackName: FullTrackName | undefined;
    let startedRelayUrl: string | undefined;
    let startedPublishName: string | undefined;

    // RMS analyser
    let pubAnalyser: AnalyserNode | undefined;
    let audioContext: AudioContext | undefined;
    let rmsSignal = 0;
    const rmsBuf = new Uint8Array(1024);

    const rmsInterval = window.setInterval(() => {
        if (pubAnalyser) {
            pubAnalyser.getByteTimeDomainData(rmsBuf);
            let sum = 0;
            for (let i = 0; i < rmsBuf.length; i++) {
                const sample = (rmsBuf[i]! - 128) / 128;
                sum += sample * sample;
            }
            rmsSignal = Math.round(Math.sqrt(sum / rmsBuf.length) * 1000) / 1000;
            setPubRms(rmsSignal);
        } else {
            setPubRms(0);
        }
    }, 100);

    // Build a live ReadableStream of MoqtObjects from a video track
    function buildVideoStream(
        track: MediaStreamTrack,
        videoFullTrackName: FullTrackName,
    ): ReadableStream<MoqtObject> {
        let groupId = 0n;
        let objectId = 0n;
        videoStopped = false;

        return new ReadableStream<MoqtObject>({
            start(controller) {
                const encoder = new VideoEncoder({
                    output(chunk) {
                        const isKey = chunk.type === "key";
                        if (isKey) {
                            groupId++;
                            objectId = 0n;
                        }

                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);

                        const moqObj = MoqtObject.newWithPayload(
                            videoFullTrackName,
                            new Location(groupId, objectId++),
                            0,
                            ObjectForwardingPreference.Subgroup,
                            0n,
                            null,
                            data,
                        );
                        try {
                            controller.enqueue(moqObj);
                        } catch {
                            // controller closed
                        }
                    },
                    error(e) {
                        log("pub", `video encoder error: ${e}`);
                        try {
                            controller.error(e);
                        } catch {
                            /* ignore */
                        }
                    },
                });

                videoEncoder = encoder;

                encoder.configure({
                    codec: "avc1.42001f",
                    width: 640,
                    height: 480,
                    framerate: 30,
                    bitrate: 1_000_000,
                    latencyMode: "realtime",
                    avc: { format: "annexb" },
                });

                // Use MediaStreamTrackProcessor to get VideoFrames
                const processor = new (window as any).MediaStreamTrackProcessor({
                    track,
                }) as { readable: ReadableStream<VideoFrame> };
                const reader = processor.readable.getReader();
                videoReader = reader;

                let frameCount = 0n;
                const encodeLoop = async () => {
                    while (!videoStopped) {
                        try {
                            const { value: frame, done } = await reader.read();
                            if (done || !frame) break;

                            // Update preview with a clone before encoding
                            const previewFrame = frame.clone();
                            setLocalFrame(previewFrame);

                            const forceKey = frameCount % 60n === 0n;
                            try {
                                encoder.encode(frame, { keyFrame: forceKey });
                            } finally {
                                frame.close();
                            }
                            frameCount++;
                        } catch (e) {
                            if (!videoStopped) {
                                log("pub", `video read loop error: ${e}`);
                            }
                            break;
                        }
                    }
                    controller.close();
                };

                void encodeLoop();
            },
            cancel() {
                videoStopped = true;
                videoReader?.cancel().catch(() => { });
                videoEncoder?.close();
                videoReader = undefined;
                videoEncoder = undefined;
            },
        });
    }

    // Build a live ReadableStream of MoqtObjects from an audio track
    function buildAudioStream(
        track: MediaStreamTrack,
        audioFullTrackName: FullTrackName,
    ): ReadableStream<MoqtObject> {
        let groupId = 0n;
        let objectId = 0n;
        audioStopped = false;

        return new ReadableStream<MoqtObject>({
            start(controller) {
                const encoder = new AudioEncoder({
                    output(chunk) {
                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);

                        const moqObj = MoqtObject.newWithPayload(
                            audioFullTrackName,
                            new Location(groupId, objectId++),
                            1,
                            ObjectForwardingPreference.Subgroup,
                            0n,
                            null,
                            data,
                        );
                        try {
                            controller.enqueue(moqObj);
                        } catch {
                            /* ignore */
                        }

                        // New group every 50 objects (~1 second at 20ms per frame)
                        if (objectId % 50n === 0n) {
                            groupId++;
                            objectId = 0n;
                        }
                    },
                    error(e) {
                        log("pub", `audio encoder error: ${e}`);
                        try {
                            controller.error(e);
                        } catch {
                            /* ignore */
                        }
                    },
                });

                audioEncoder = encoder;

                encoder.configure({
                    codec: "opus",
                    sampleRate: 48000,
                    numberOfChannels: 1,
                    bitrate: 64_000,
                });

                const processor = new (window as any).MediaStreamTrackProcessor({
                    track,
                }) as { readable: ReadableStream<AudioData> };
                const reader = processor.readable.getReader();
                audioReader = reader;

                const encodeLoop = async () => {
                    while (!audioStopped) {
                        try {
                            const { value: data, done } = await reader.read();
                            if (done || !data) break;
                            encoder.encode(data);
                            data.close();
                        } catch (e) {
                            if (!audioStopped) {
                                log("pub", `audio read loop error: ${e}`);
                            }
                            break;
                        }
                    }
                    controller.close();
                };

                void encodeLoop();
            },
            cancel() {
                audioStopped = true;
                audioReader?.cancel().catch(() => { });
                audioEncoder?.close();
                audioReader = undefined;
                audioEncoder = undefined;
            },
        });
    }

    const start = async (relayUrl: string, publishName: string) => {

        if (
            startedRelayUrl === relayUrl &&
            startedPublishName === publishName &&
            client !== undefined
        ) {
            return;
        }

        if (client) {
            try {
                await client.disconnect("reconnect");
            } catch { }
            client = undefined;
        }

        startedRelayUrl = relayUrl;
        startedPublishName = publishName;

        log("conn", `moqtail relay: ${relayUrl}`);
        log("conn", `moqtail publish name: ${publishName}`);

        setConnectionStatus("connecting");

        try {
            client = await MOQtailClient.new({
                url: relayUrl,
                supportedVersions: [DRAFT_14],
                callbacks: {
                    onSessionTerminated: (reason) => {
                        log("conn", `session terminated: ${reason}`);
                        setConnectionStatus("disconnected");
                        client = undefined;
                    },
                },
            });

            setConnectionStatus("connected");
            log("conn", "moqtail connected");

            // parse namespace
            const parts = publishName.split("/").filter(Boolean);

            log("debug", `namespace parts: ${JSON.stringify(parts)}`);

            const namespace = Tuple.fromUtf8Path(parts.join("/"));

            publishedNamespace = parts;

            publishedVideoFullTrackName =
                FullTrackName.tryNew(namespace, "video");

            publishedAudioFullTrackName =
                FullTrackName.tryNew(namespace, "audio");

            // announce namespace
            const nsResult = await client.publishNamespace(namespace);

            if (nsResult instanceof PublishNamespaceError) {
                log("pub", `publishNamespace error: ${nsResult.reasonPhrase}`);
            } else {
                log("pub", `namespace announced: ${parts.join("/")}`);
            }

        } catch (e) {
            log("conn", `connection failed: ${e}`);
            setConnectionStatus("error");
            client = undefined;
        }
    };

    const stop = async () => {
        if (!client && !startedRelayUrl) return;

        stopVideoEncoding();
        stopAudioEncoding();
        setPublishingVideo(false);
        setPublishingAudio(false);
        setLocalFrame(undefined);

        if (client && publishedNamespace) {
            await client
                .publishNamespaceDone(publishedNamespace as unknown as Tuple)
                .catch(() => { });
        }

        await client?.disconnect("stop").catch(() => { });
        client = undefined;
        setConnectionStatus("disconnected");
        startedRelayUrl = undefined;
        startedPublishName = undefined;
        publishedNamespace = undefined;
        log("conn", "moqtail publisher stopped");
    };

    function stopVideoEncoding() {
        videoStopped = true;
        videoReader?.cancel().catch(() => { });
        videoEncoder?.close();
        videoReader = undefined;
        videoEncoder = undefined;
    }

    function stopAudioEncoding() {
        audioStopped = true;
        audioReader?.cancel().catch(() => { });
        audioEncoder?.close();
        audioReader = undefined;
        audioEncoder = undefined;
        pubAnalyser?.disconnect();
        pubAnalyser = undefined;
        audioContext?.close().catch(() => { });
        audioContext = undefined;
    }

    const toggleVideo = async () => {
        if (publishingVideo()) {
            // Soft mute: disable track
            if (videoTrack) videoTrack.enabled = false;
            setPublishingVideo(false);
            setLocalFrame(undefined);
            log("track", "video OFF (soft mute)");
            return;
        }

        if (!client || !publishedVideoFullTrackName) {
            log("pub", "not connected, cannot publish video");
            return;
        }

        setPublishingVideo(true);
        log("track", "video ON");

        stopVideoEncoding();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 30 },
                    facingMode: { ideal: "user" },
                },
            });
            const track = stream.getVideoTracks()[0];
            if (!track) {
                log("pub", "no video track from getUserMedia");
                setPublishingVideo(false);
                return;
            }
            videoTrack = track;

            const liveStream = buildVideoStream(track, publishedVideoFullTrackName);
            const liveSource = new LiveTrackSource(liveStream);

            client.addOrUpdateTrack({
                fullTrackName: publishedVideoFullTrackName,
                forwardingPreference: ObjectForwardingPreference.Subgroup,
                trackSource: { live: liveSource },
                publisherPriority: 0,
            });
            log("pub", "video track registered");
        } catch (e) {
            log("pub", `getUserMedia video error: ${e}`);
            setPublishingVideo(false);
        }
    };

    const toggleAudio = async () => {
        if (publishingAudio()) {
            if (audioTrack) audioTrack.enabled = false;
            setPublishingAudio(false);
            log("track", "mic OFF (soft mute)");
            return;
        }

        if (!client || !publishedAudioFullTrackName) {
            log("pub", "not connected, cannot publish audio");
            return;
        }

        setPublishingAudio(true);
        log("track", "mic ON");

        stopAudioEncoding();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: { ideal: 1, max: 2 },
                    autoGainControl: { ideal: true },
                    noiseSuppression: { ideal: true },
                    echoCancellation: { ideal: true },
                    sampleRate: 48000,
                },
            });
            audioStream = stream;
            const track = stream.getAudioTracks()[0];
            if (!track) {
                log("pub", "no audio track from getUserMedia");
                setPublishingAudio(false);
                return;
            }
            audioTrack = track;

            // Wire up analyser for RMS display
            audioContext = new AudioContext({ sampleRate: 48000 });
            const source = audioContext.createMediaStreamSource(stream);
            pubAnalyser = audioContext.createAnalyser();
            pubAnalyser.fftSize = 2048;
            source.connect(pubAnalyser);

            const liveStream = buildAudioStream(track, publishedAudioFullTrackName);
            const liveSource = new LiveTrackSource(liveStream);

            client.addOrUpdateTrack({
                fullTrackName: publishedAudioFullTrackName,
                forwardingPreference: ObjectForwardingPreference.Subgroup,
                trackSource: { live: liveSource },
                publisherPriority: 1,
            });
            log("pub", "audio track registered");
        } catch (e) {
            log("pub", `getUserMedia audio error: ${e}`);
            setPublishingAudio(false);
        }
    };

    const close = async () => {
        window.clearInterval(rmsInterval);
        await stop();
        videoTrack?.stop();
        audioTrack?.stop();
        audioStream?.getTracks().forEach((t) => t.stop());
    };

    return {
        close,
        connectionStatus,
        localFrame,
        publishingAudio,
        publishingVideo,
        pubRms,
        start,
        stop,
        toggleAudio,
        toggleVideo,
        getClient: () => client,
        getPublishedNamespace: () => publishedNamespace,
    };
}
