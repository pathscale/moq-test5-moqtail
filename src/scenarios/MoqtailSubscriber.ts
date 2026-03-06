import {
    FilterType,
    FullTrackName,
    GroupOrder,
    MOQtailClient,
    ObjectStatus,
    PublishNamespace,
    PublishNamespaceDone,
    SubscribeError,
    SubscribeNamespaceError,
    Tuple,
} from "moqtail";
import { createSignal } from "solid-js";
import { SubscriberEngine } from "../media/subscriber/SubscriberEngine";

type LogFn = (tag: string, msg: string) => void;

export interface RemoteParticipant {
    id: string;
    videoFrame: () => VideoFrame | undefined;
    getAnalyser: () => AnalyserNode | undefined;
    close: () => void;
}

function tupleToString(tuple: Tuple): string {
    return tuple.fields.map((f) => f.toUtf8()).join("/");
}


function buildNamespaceTuple(parts: string[]): Tuple {
    return Tuple.fromUtf8Path(parts.join("/"));
}

export function createMoqtailSubscriber(props: {
    getClient: () => MOQtailClient | undefined;
    log: LogFn;
}) {
    const [participants, setParticipants] = createSignal<RemoteParticipant[]>([]);
    const [speakerOn, setSpeakerOn] = createSignal(false);
    const [subRms, setSubRms] = createSignal(0);

    let speakerEnabled = false;
    const subscribedParticipants = new Map<string, RemoteParticipant>();
    const participantCleanups = new Map<string, () => void>();

    let namespaceSub: (() => void) | undefined;
    let currentPrefix: string | undefined;
    const videoEngine = new SubscriberEngine();

    const rmsBuf = new Uint8Array(1024);
    const computeRms = (analyser: AnalyserNode): number => {
        analyser.getByteTimeDomainData(rmsBuf);
        let sum = 0;
        for (let i = 0; i < rmsBuf.length; i++) {
            const sample = (rmsBuf[i]! - 128) / 128;
            sum += sample * sample;
        }
        return Math.round(Math.sqrt(sum / rmsBuf.length) * 1000) / 1000;
    };

    const rmsInterval = window.setInterval(() => {
        let maxRms = 0;
        for (const p of participants()) {
            const analyser = p.getAnalyser();
            if (!analyser) continue;
            const rms = computeRms(analyser);
            if (rms > maxRms) maxRms = rms;
        }
        setSubRms(maxRms);
    }, 100);

    async function subscribeAudio(
        client: MOQtailClient,
        namespace: string,
        participantId: string,
        onAnalyser: (analyser: AnalyserNode | undefined) => void,
    ): Promise<(() => void) | undefined> {
        const fullTrackName = FullTrackName.tryNew(namespace, "audio");
        let canceled = false;
        let requestId: bigint | undefined;
        let audioDecoder: AudioDecoder | undefined;

        const result = await client.subscribe({
            fullTrackName,
            filterType: FilterType.LatestObject,
            forward: true,
            groupOrder: GroupOrder.Original,
            priority: 1,
        });

        if (result instanceof SubscribeError) {
            props.log("sub", `audio subscribe error for ${participantId}: code=${result.errorCode}`);
            return undefined;
        }

        requestId = result.requestId;
        const stream = result.stream;
        const shortId = participantId.split("/").slice(-1)[0] ?? "participant";

        const audioCtx = new AudioContext({ sampleRate: 48000 });
        if (audioCtx.state === "suspended") {
            await audioCtx.resume().catch(() => { });
        }

        const gain = new GainNode(audioCtx, { gain: speakerEnabled ? 1.0 : 0.0 });
        const analyser = new AnalyserNode(audioCtx, { fftSize: 2048 });
        gain.connect(analyser);
        analyser.connect(audioCtx.destination);
        onAnalyser(analyser);

        let scheduledAt = 0;

        audioDecoder = new AudioDecoder({
            output(audioData) {
                if (canceled) {
                    audioData.close();
                    return;
                }
                const numChannels = audioData.numberOfChannels;
                const numSamples = audioData.numberOfFrames;
                const buffer = audioCtx.createBuffer(numChannels, numSamples, audioData.sampleRate);

                for (let c = 0; c < numChannels; c++) {
                    audioData.copyTo(buffer.getChannelData(c), {
                        planeIndex: c,
                        format: "f32-planar",
                    });
                }
                audioData.close();

                const source = audioCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(gain);

                const now = audioCtx.currentTime;
                if (scheduledAt < now) scheduledAt = now + 0.05;
                source.start(scheduledAt);
                scheduledAt += buffer.duration;
            },
            error(e) {
                props.log("audio", `...${shortId} audio decoder error: ${e}`);
            },
        });

        audioDecoder.configure({
            codec: "opus",
            sampleRate: 48000,
            numberOfChannels: 1,
        });

        let bytesReceived = 0;
        let lastLogBytes = 0;

        (async () => {
            const reader = stream.getReader();
            try {
                for (; ;) {
                    const { value: obj, done } = await reader.read();
                    if (done || canceled) break;
                    if (!obj || !obj.payload) continue;
                    if (obj.objectStatus !== ObjectStatus.Normal) continue;

                    bytesReceived += obj.payload.byteLength;
                    if (lastLogBytes === 0 || bytesReceived - lastLogBytes >= 1024) {
                        props.log("audio", `...${shortId} audio bytes: ${bytesReceived}`);
                        lastLogBytes = bytesReceived;
                    }

                    const chunk = new EncodedAudioChunk({
                        type: "key",
                        timestamp: Number(obj.location.group) * 1_000_000_000 + Number(obj.location.object) * 20_000,
                        data: obj.payload,
                    });

                    try {
                        audioDecoder?.decode(chunk);
                    } catch (e) {
                        props.log("audio", `...${shortId} audio decode error: ${e}`);
                    }
                }
            } finally {
                reader.releaseLock();
                audioDecoder?.close();
            }
        })();

        return () => {
            canceled = true;
            if (requestId !== undefined) {
                client.unsubscribe(requestId).catch(() => { });
            }
            onAnalyser(undefined);
            gain.disconnect();
            analyser.disconnect();
            audioDecoder?.close();
            audioCtx.close().catch(() => { });
        };
    }

    async function subscribeToParticipant(client: MOQtailClient, namespace: string) {
        if (subscribedParticipants.has(namespace)) {
            props.log("sub", `already tracking: ${namespace}`);
            return;
        }

        props.log("sub", `subscribing to ${namespace}`);

        const [videoFrame, setVideoFrame] = createSignal<VideoFrame | undefined>(undefined);
        let participantAnalyser: AnalyserNode | undefined;
        const cleanups: (() => void)[] = [];

        const participant: RemoteParticipant = {
            id: namespace,
            videoFrame,
            getAnalyser: () => participantAnalyser,
            close: () => {
                for (const cleanup of cleanups) cleanup();
                cleanups.length = 0;
            },
        };

        subscribedParticipants.set(namespace, participant);
        setParticipants((prev) => [...prev, participant]);

        await videoEngine.startSubscription({
            client,
            key: { namespace, kind: "video" },
            sink: {
                render: (decodedFrame) => {
                    const prev = videoFrame();
                    prev?.close();
                    setVideoFrame(decodedFrame.frame);
                },
                clear: () => {
                    const prev = videoFrame();
                    prev?.close();
                    setVideoFrame(undefined);
                },
            },
            log: props.log,
        });
        cleanups.push(() => {
            void videoEngine.stopSubscription({ namespace, kind: "video" });
        });

        const audioCleanup = await subscribeAudio(client, namespace, namespace, (a) => {
            participantAnalyser = a;
        });
        if (audioCleanup) cleanups.push(audioCleanup);

        participantCleanups.set(namespace, () => {
            participant.close();
        });
    }

    function removeParticipant(namespace: string) {
        const cleanup = participantCleanups.get(namespace);
        cleanup?.();
        participantCleanups.delete(namespace);
        subscribedParticipants.delete(namespace);
        setParticipants((prev) => prev.filter((p) => p.id !== namespace));
        props.log("sub", `participant removed: ${namespace}`);
    }

    async function watchNamespace(
        client: MOQtailClient,
        prefixParts: string[],
        localPublishPath: string,
    ) {
        namespaceSub?.();
        namespaceSub = undefined;

        const prefix = buildNamespaceTuple(prefixParts);
        const localNs = localPublishPath.split("/").filter(Boolean).join("/");
        let canceled = false;

        props.log("sub", `subscribeNamespace prefix: ${prefixParts.join("/")}`);

        const prevPublished = client.onNamespacePublished;
        const prevDone = client.onNamespaceDone;

        client.onNamespacePublished = (msg: PublishNamespace) => {
            prevPublished?.(msg);
            if (canceled) return;

            const namespace = tupleToString(msg.trackNamespace);
            if (!namespace.startsWith(prefixParts.join("/"))) return;
            if (namespace === localNs) return;

            props.log("announced", `remote active: ${namespace}`);
            void subscribeToParticipant(client, namespace);
        };

        client.onNamespaceDone = (msg: PublishNamespaceDone) => {
            prevDone?.(msg);
            if (canceled) return;

            const namespace = tupleToString(msg.trackNamespace);
            if (subscribedParticipants.has(namespace)) {
                removeParticipant(namespace);
            }
        };

        await client
            .subscribeNamespace(prefix)
            .then((res) => {
                if (res instanceof SubscribeNamespaceError) {
                    props.log("sub", `subscribeNamespace error: ${res.reasonPhrase}`);
                } else {
                    props.log("sub", `subscribeNamespace ok for prefix: ${prefixParts.join("/")}`);
                }
            })
            .catch((e: unknown) => {
                props.log("sub", `subscribeNamespace exception: ${e}`);
            });

        namespaceSub = () => {
            canceled = true;
            client.onNamespacePublished = prevPublished;
            client.onNamespaceDone = prevDone;
        };
    }

    const reconcile = async (nextPaths: string[]) => {
        const client = props.getClient();
        if (!client) return;

        const next = [...new Set(nextPaths)];
        const current = [...subscribedParticipants.keys()];

        for (const path of next) {
            if (!subscribedParticipants.has(path)) {
                await subscribeToParticipant(client, path);
            }
        }
        for (const path of current) {
            if (!next.includes(path)) {
                removeParticipant(path);
            }
        }
    };

    const startNamespaceWatch = async (prefixParts: string[], localPublishPath: string) => {
        const client = props.getClient();
        if (!client) return;

        const prefixKey = prefixParts.join("/");
        if (currentPrefix === prefixKey) return;
        currentPrefix = prefixKey;

        await watchNamespace(client, prefixParts, localPublishPath);
    };

    const stopNamespaceWatch = () => {
        namespaceSub?.();
        namespaceSub = undefined;
        currentPrefix = undefined;
    };

    const clear = () => {
        for (const cleanup of participantCleanups.values()) cleanup();
        participantCleanups.clear();
        subscribedParticipants.clear();
        setParticipants([]);
        setSubRms(0);
    };

    const toggleSpeaker = () => {
        const next = !speakerOn();
        setSpeakerOn(next);
        speakerEnabled = next;
        props.log("track", `speaker ${next ? "ON" : "OFF"}`);
    };

    const close = () => {
        window.clearInterval(rmsInterval);
        stopNamespaceWatch();
        clear();
        void videoEngine.dispose();
    };

    return {
        clear,
        close,
        participants,
        reconcile,
        speakerOn,
        startNamespaceWatch,
        stopNamespaceWatch,
        subRms,
        toggleSpeaker,
    };
}
