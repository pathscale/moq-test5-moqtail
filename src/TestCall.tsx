import {
  Accessor,
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { useParams } from "@solidjs/router";
import * as Moq from "@moq/lite";
import * as Publish from "@moq/publish";
import * as Watch from "@moq/watch";
import { Effect, Signal } from "@moq/signals";
import solid from "@moq/signals/solid";
import { createAccessor } from "@moq/signals/solid";

import { DebugPanel } from "./DebugPanel";
import {
  diagTime,
  getOrCreateRelayUrl,
  getOrCreateStreamName,
  joinUrl,
  normalizePath,
  RELAY_OPTIONS,
} from "./helpers";
import type { DiagEvent, RemoteParticipant } from "./types";
import { VideoCanvas } from "./VideoCanvas";
import {
  WatchOverlayShowcase,
  WatchWebComponentShowcase,
} from "./WatchShowcases";

function SectionCard(props: {
  title: string;
  subtitle: string;
  enabled: Accessor<boolean>;
  setEnabled: (next: boolean) => void;
  children: any;
}) {
  return (
    <section class="space-y-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div class="space-y-1">
          <div class="text-xs font-medium uppercase tracking-[0.2em] text-blue-300">
            {props.title}
          </div>
          <p class="text-sm text-gray-400">{props.subtitle}</p>
        </div>
        <label class="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-sm text-gray-200">
          <input
            type="checkbox"
            checked={props.enabled()}
            onInput={(event) => props.setEnabled(event.currentTarget.checked)}
          />
          Enabled
        </label>
      </div>
      <Show when={props.enabled()}>
        {props.children}
      </Show>
    </section>
  );
}

export const TestCall: Component = () => {
  const [diagLog, setDiagLog] = createSignal<DiagEvent[]>([]);
  const log = (tag: string, msg: string) => {
    const evt = { t: diagTime(), tag, msg };
    console.log(`[${evt.t}ms] [${tag}] ${msg}`);
    setDiagLog((prev) => [evt, ...prev].slice(0, 50));
  };

  const params = useParams<{ streamName?: string }>();
  const urlStream = () =>
    params.streamName?.toLowerCase().replace(/[^a-z0-9-]/g, "");

  const [roomName, setRoomName] = createSignal(
    urlStream() || getOrCreateStreamName(),
  );
  const [relayUrl, setRelayUrl] = createSignal(getOrCreateRelayUrl());
  const [watchPathOverride, setWatchPathOverride] = createSignal("");

  const handleNameChange = (value: string) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setRoomName(clean);
    localStorage.setItem("moq-test-stream-name", clean);
  };

  const handleRelayUrlChange = (value: string) => {
    setRelayUrl(value);
    localStorage.setItem("moq-relay-url", value);
    window.location.reload();
  };


  const connection = new Moq.Connection.Reload({
    enabled: false,
    websocket: {
      enabled: false,
    },
  });
  const connectionStatus = createAccessor(connection.status);
  const broadcastId = crypto.randomUUID().slice(0, 8);

  const [joinConfig, setJoinConfig] = createSignal<{
    relayUrl: string;
    roomName: string;
  }>();
  const joinedRoomName = () => joinConfig()?.roomName ?? roomName();
  const joinedRelayUrl = () => joinConfig()?.relayUrl ?? relayUrl();
  const joinedRelayPath = () => `anon/${joinedRoomName()}`;
  const localPublishPath = () => `${joinedRelayPath()}/${broadcastId}`;

  const resolvedWatchName = () => {
    const override = normalizePath(watchPathOverride());
    if (override) return override;
    const remote = participants()[0]?.id;
    return remote ?? localPublishPath();
  };

  const resolvedSectionRelayUrl = () => {
    const relay = normalizePath(joinedRelayPath());
    try {
      return joinUrl(joinedRelayUrl(), relay);
    } catch {
      return undefined;
    }
  };

  const micEnabled = new Signal<boolean>(false);
  const broadcastVideoEnabled = Signal.from(false);
  const audioOutputEnabled = Signal.from(false);

  const localVideoSource = new Publish.Source.Camera({
    enabled: false,
    constraints: {
      width: { ideal: 640 },
      height: { ideal: 640 },
      frameRate: { ideal: 60 },
      facingMode: { ideal: "user" },
      resizeMode: "none",
    },
  });

  const localAudioSource = new Publish.Source.Microphone({
    enabled: micEnabled,
    constraints: {
      channelCount: { ideal: 1, max: 2 },
      autoGainControl: { ideal: true },
      noiseSuppression: { ideal: true },
      echoCancellation: { ideal: true },
    },
  });

  const localBroadcast = new Publish.Broadcast({
    enabled: false,
    connection: connection.established,
    user: {
      enabled: true,
      name: Signal.from("User"),
    },
    video: {
      source: localVideoSource.source,
      hd: {
        enabled: broadcastVideoEnabled,
        config: { maxPixels: 640 * 640 },
      },
      sd: {
        enabled: broadcastVideoEnabled,
        config: { maxPixels: 320 * 320 },
      },
      flip: true,
    },
    audio: {
      enabled: micEnabled,
      volume: 1.0,
      source: localAudioSource.source,
    },
    location: {
      window: {
        enabled: true,
        handle: Math.random().toString(36).substring(2, 15),
      },
      peers: { enabled: true },
    },
    chat: { message: { enabled: true }, typing: { enabled: true } },
    preview: {
      enabled: true,
      info: { chat: false, typing: false, screen: false },
    },
  });

  const pubSignals = new Effect();
  pubSignals.effect((eff) => {
    const active = eff.get(localBroadcast.audio.active);
    log("pub", `encoder active: ${active}`);
  });
  pubSignals.effect((eff) => {
    const root = eff.get(localBroadcast.audio.root);
    log("pub", `encoder root: ${root ? "connected" : "none"}`);
  });
  pubSignals.effect((eff) => {
    const config = eff.get(localBroadcast.audio.config);
    log("pub", `encoder config: ${config ? config.codec : "none"}`);
  });

  const localFrame = solid(localBroadcast.video.frame);

  const [publishingVideo, setPublishingVideo] = createSignal(false);
  const [publishingAudio, setPublishingAudio] = createSignal(false);
  const [speakerOn, setSpeakerOn] = createSignal(false);

  const toggleVideo = () => {
    if (publishingVideo()) {
      broadcastVideoEnabled.set(false);
      setPublishingVideo(false);
      log("track", "video OFF");
    } else {
      localVideoSource.enabled.set(true);
      broadcastVideoEnabled.set(true);
      setPublishingVideo(true);
      log("track", "video ON");
    }
  };

  const toggleAudio = () => {
    if (publishingAudio()) {
      micEnabled.set(false);
      setPublishingAudio(false);
      log("track", "mic OFF");
    } else {
      micEnabled.set(true);
      setPublishingAudio(true);
      log("track", "mic ON");
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerOn();
    setSpeakerOn(next);
    audioOutputEnabled.set(next);
    log("track", `speaker ${next ? "ON" : "OFF"}`);
  };

  const [participants, setParticipants] = createSignal<RemoteParticipant[]>([]);
  let announcedEffect: Effect | undefined;
  let unloading = false;

  const getRoomPrefix = (name: string) => `anon/${name}`;
  const getPublishName = (prefix: string) => `${prefix}/${broadcastId}`;

  const closeParticipant = (participant: RemoteParticipant) => {
    participant.signals.close();
    participant.sync.close();
    participant.videoDecoder.close();
    participant.videoSource.close();
    participant.audioDecoder.close();
    participant.audioSource.close();
    participant.broadcast.close();
  };

  const removeParticipant = (pathString: string) => {
    let removed: RemoteParticipant | undefined;

    setParticipants((prev) =>
      prev.filter((participant) => {
        if (participant.id !== pathString) return true;
        removed = participant;
        return false;
      }),
    );

    if (!removed) {
      log("sub", `remove requested for unknown participant: ${pathString}`);
      return;
    }

    closeParticipant(removed);
    console.log("Participant removed:", pathString);
    log("sub", `participant removed: ${pathString}`);
  };

  const runAnnounced = (streamPrefix: string) => {
    if (announcedEffect) {
      announcedEffect.close();
    }
    announcedEffect = new Effect();

    announcedEffect.effect((effect) => {
      const conn = effect.get(connection.established);
      if (!conn) {
        log("announced", "waiting for connection...");
        return;
      }
      log("announced", "connection available, starting listener");

      const prefix = Moq.Path.from(streamPrefix);
      console.log("ANNOUNCE prefix:", String(prefix));
      log("announced", `listening on prefix: ${String(prefix)}`);
      const announced = conn.announced(prefix);
      effect.cleanup(() => announced.close());

      effect.spawn(async () => {
        log("announced", "loop started");
        try {
          for (;;) {
            const update = await announced.next();
            if (!update) {
              log("announced", "loop ended");
              break;
            }

            const localPath = localBroadcast.name.peek();
            console.log("Announced event:", update);
            log(
              "announced",
              `event active=${update.active} path=${String(update.path)}`,
            );
            if (String(update.path) === String(localPath)) {
              log("announced", `ignoring local broadcast: ${String(update.path)}`);
              continue;
            }

            if (update.active) {
              console.log("Announce active:", String(update.path));
              log("announced", `REMOTE ACTIVE: ${update.path}`);
              subscribeToParticipant(String(update.path));
            } else {
              console.log("Announce active:", false, String(update.path));
              log("announced", `REMOTE INACTIVE: ${update.path}`);
              removeParticipant(String(update.path));
            }
          }
        } catch (err) {
          log("announced", `ERROR: ${err}`);
        }
      });
    });
  };

  const subscribeToParticipant = (pathString: string) => {
    if (participants().find((participant) => participant.id === pathString)) {
      log("sub", `already tracking participant: ${pathString}`);
      return;
    }

    const path = Moq.Path.from(pathString);
    const broadcast = new Watch.Broadcast({
      connection: connection.established,
      enabled: true,
      name: path,
      reload: true,
    });

    const sync = new Watch.Sync();
    const videoSource = new Watch.Video.Source(sync, { broadcast });
    const videoDecoder = new Watch.Video.Decoder(videoSource, { enabled: true });
    const audioSource = new Watch.Audio.Source(sync, { broadcast });
    const audioDecoder = new Watch.Audio.Decoder(audioSource, { enabled: true });

    const shortPath = pathString.slice(-20);
    const signals = new Effect();

    signals.effect((eff) => {
      const status = eff.get(broadcast.status);
      log("sub", `...${shortPath} status → ${status}`);
    });
    signals.effect((eff) => {
      const audioCatalog = eff.get(audioSource.catalog);
      if (audioCatalog) log("sub", `...${shortPath} audio catalog received`);
    });
    signals.effect((eff) => {
      const videoCatalog = eff.get(videoSource.catalog);
      log("video", `...${shortPath} video catalog: ${videoCatalog ? "received" : "none"}`);
    });
    signals.effect((eff) => {
      const stalled = eff.get(videoDecoder.stalled);
      log("video", `...${shortPath} video decoder stalled: ${stalled}`);
    });
    let videoFrameCount = 0;
    signals.effect((eff) => {
      const frame = eff.get(videoDecoder.frame);
      if (!frame) return;
      videoFrameCount++;
      if (videoFrameCount === 1 || videoFrameCount % 100 === 0) {
        log("video", `...${shortPath} video frame #${videoFrameCount} (${frame.displayWidth}x${frame.displayHeight})`);
      }
    });
    signals.effect((eff) => {
      const root = eff.get(audioDecoder.root);
      if (root) {
        log(
          "audio",
          `...${shortPath} audio root available (ctx: ${root.context.state})`,
        );
      }
    });
    let lastLoggedBytes = 0;
    signals.effect((eff) => {
      const stats = eff.get(audioDecoder.stats);
      if (!stats || stats.bytesReceived <= 0) return;
      const bytes = stats.bytesReceived;
      if (lastLoggedBytes === 0 || bytes - lastLoggedBytes >= 1024) {
        log("audio", `...${shortPath} audio bytes: ${bytes}`);
        lastLoggedBytes = bytes;
      }
    });

    let participantGain: GainNode | undefined;
    let participantAnalyser: AnalyserNode | undefined;

    signals.effect((eff) => {
      const root = eff.get(audioDecoder.root);
      if (!root) return;

      if (root.context.state === "suspended") {
        (root.context as AudioContext).resume();
        log("audio", "resuming suspended AudioContext");
      }

      const gain = new GainNode(root.context, { gain: 0 });
      const analyser = new AnalyserNode(root.context, { fftSize: 2048 });
      root.connect(gain);
      gain.connect(analyser);
      analyser.connect(root.context.destination);
      participantGain = gain;
      participantAnalyser = analyser;
      log("audio", `wired gain+analyser for ...${shortPath}`);

      eff.cleanup(() => {
        analyser.disconnect();
        gain.disconnect();
        if (participantGain === gain) participantGain = undefined;
        if (participantAnalyser === analyser) participantAnalyser = undefined;
      });
    });

    signals.effect((eff) => {
      const speaker = eff.get(audioOutputEnabled);
      if (participantGain) {
        participantGain.gain.value = speaker ? 1.0 : 0.0;
        log("audio", `...${shortPath} gain → ${speaker ? 1 : 0}`);
      }
    });

    videoSource.target.set({ pixels: 640 * 640 });

    const getAnalyser = () => participantAnalyser;

    setParticipants((prev) => [
      ...prev,
      {
        id: pathString,
        broadcast,
        sync,
        videoSource,
        videoDecoder,
        audioSource,
        audioDecoder,
        signals,
        getAnalyser,
      },
    ]);

    log("sub", `subscribed to ${pathString}`);
  };

  const [joined, setJoined] = createSignal(false);
  const [joining, setJoining] = createSignal(false);
  const [showJsApi, setShowJsApi] = createSignal(true);
  const [showWebComponent, setShowWebComponent] = createSignal(true);
  const [showSolidOverlay, setShowSolidOverlay] = createSignal(true);

  const handleJoin = () => {
    setJoining(true);

    const currentRelayUrl = relayUrl().trim();
    const currentRoomName = roomName().trim();
    if (!currentRelayUrl || !currentRoomName) {
      log("conn", "relay URL and room are required");
      setJoining(false);
      return;
    }

    const relayPath = getRoomPrefix(currentRoomName);
    const publishName = getPublishName(relayPath);
    let url: URL;
    try {
      url = new URL(joinUrl(currentRelayUrl, relayPath));
    } catch {
      log("conn", "invalid relay URL");
      setJoining(false);
      return;
    }

    setJoinConfig({ relayUrl: currentRelayUrl, roomName: currentRoomName });
    connection.url.set(url);
    connection.enabled.set(true);

    console.log("JOIN publish name:", publishName);
    console.log("JOIN broadcast ID:", broadcastId);
    console.log("JOIN room prefix:", relayPath);
    console.log("JOIN final stream name:", publishName);
    log("conn", `join room prefix: ${relayPath}`);
    log("conn", `join publish name: ${publishName}`);

    localBroadcast.name.set(Moq.Path.from(publishName));
    log("announced", `announce requested: ${publishName}`);
    localBroadcast.enabled.set(true);

    log("conn", "connection + broadcast enabled");
    setJoined(true);
    setJoining(false);

    runAnnounced(relayPath);
  };

  const handleLeave = () => {
    if (announcedEffect) {
      announcedEffect.close();
      announcedEffect = undefined;
    }

    broadcastVideoEnabled.set(false);
    micEnabled.set(false);
    localVideoSource.enabled.set(false);
    setPublishingVideo(false);
    setPublishingAudio(false);

    log("conn", "teardown local broadcast");
    localBroadcast.enabled.set(false);
    localBroadcast.name.set(undefined);
    connection.url.set(undefined);
    connection.enabled.set(false);

    for (const participant of participants()) {
      closeParticipant(participant);
    }
    setParticipants([]);

    setJoinConfig(undefined);
    setJoined(false);
    log("conn", "disconnected");
  };

  onCleanup(() => {
    handleLeave();
    pubSignals.close();
    localVideoSource.close();
    localAudioSource.close();
    localBroadcast.close();
    connection.close();
  });

  const handleBeforeUnload = () => {
    unloading = true;
    log("conn", "beforeunload -> leave");
    handleLeave();
  };

  window.addEventListener("beforeunload", handleBeforeUnload);
  onCleanup(() => {
    if (unloading) return;
    window.removeEventListener("beforeunload", handleBeforeUnload);
  });

  const [pubRms, setPubRms] = createSignal(0);
  let pubAnalyser: AnalyserNode | undefined;

  const pubAudioRoot = createAccessor(localBroadcast.audio.root);
  createEffect(() => {
    const root = pubAudioRoot();
    if (!root) return;
    pubAnalyser = new AnalyserNode(root.context, { fftSize: 2048 });
    root.connect(pubAnalyser);
    onCleanup(() => {
      pubAnalyser?.disconnect();
      pubAnalyser = undefined;
    });
  });

  const [subRms, setSubRms] = createSignal(0);
  const rmsBuf = new Uint8Array(1024);

  function computeRms(analyser: AnalyserNode): number {
    analyser.getByteTimeDomainData(rmsBuf);
    let sum = 0;
    for (let i = 0; i < rmsBuf.length; i++) {
      const sample = (rmsBuf[i]! - 128) / 128;
      sum += sample * sample;
    }
    return Math.round(Math.sqrt(sum / rmsBuf.length) * 1000) / 1000;
  }

  const rmsInterval = setInterval(() => {
    if (pubAnalyser) {
      setPubRms(computeRms(pubAnalyser));
    }
    let maxRms = 0;
    for (const participant of participants()) {
      const analyser = participant.getAnalyser();
      if (analyser) {
        const rms = computeRms(analyser);
        if (rms > maxRms) maxRms = rms;
      }
    }
    setSubRms(maxRms);
  }, 100);
  onCleanup(() => clearInterval(rmsInterval));

  return (
    <div class="min-h-screen bg-gray-950 p-6 text-white">
      <div class="mx-auto max-w-6xl space-y-6">
        <div class="space-y-2">
          <h1 class="text-3xl font-bold">MoQ Watch Comparison Harness</h1>
          <p class="max-w-3xl text-sm text-gray-400">
            Side-by-side comparisons for the existing JS API flow, the
            <code> @moq/watch </code>
            web component, and the Solid-powered overlay.
          </p>
        </div>

        <section class="space-y-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
          <div class="space-y-1">
            <div class="text-xs font-medium uppercase tracking-[0.2em] text-gray-400">
              Shared Controls
            </div>
            <p class="text-sm text-gray-400">
              Relay and room are shared across all three sections. Sections B and
              C can optionally watch an explicit broadcast path.
            </p>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-300">
                Relay URL
              </label>
              <select
                value={relayUrl()}
                onChange={(event) =>
                  handleRelayUrlChange(event.currentTarget.value)
                }
                class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              >
                <For each={RELAY_OPTIONS}>
                  {(relay) => (
                    <option value={relay.url}>
                      {relay.name}
                    </option>
                  )}
                </For>
              </select>
            </div>

            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-300">
                Room
              </label>
              <input
                type="text"
                value={roomName()}
                onInput={(event) => handleNameChange(event.currentTarget.value)}
                class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
                placeholder="my-room"
              />
            </div>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium text-gray-300">
              Watch Path Override
            </label>
            <input
              type="text"
              value={watchPathOverride()}
              onInput={(event) => setWatchPathOverride(event.currentTarget.value)}
              class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              placeholder="Optional: anon/my-room/participant-id"
            />
            <p class="text-xs text-gray-500">
              If empty, Sections B and C watch the first discovered remote
              participant, or the current JS API local publish path.
            </p>
          </div>

          <div class="grid gap-3 text-xs text-gray-400 md:grid-cols-2">
            <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
              <div class="text-gray-500">Resolved relay URL for Sections B/C</div>
              <div class="break-all pt-1 text-gray-200">
                {resolvedSectionRelayUrl() || "invalid relay URL"}
              </div>
            </div>
            <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
              <div class="text-gray-500">Resolved watch name for Sections B/C</div>
              <div class="break-all pt-1 text-gray-200">
                {resolvedWatchName()}
              </div>
            </div>
          </div>
        </section>

        <SectionCard
          title="Section A -> JS API"
          subtitle="Existing manual publish / announce / subscribe flow kept intact for comparison."
          enabled={showJsApi}
          setEnabled={setShowJsApi}
        >
          <Show
            when={joined()}
            fallback={
              <button
                class="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleJoin}
                disabled={joining()}
              >
                <Show when={joining()}>
                  <span class="loading loading-spinner loading-sm" />
                </Show>
                {joining() ? "Connecting..." : "Join"}
              </button>
            }
          >
            <div class="space-y-4">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  class={`rounded px-4 py-2 text-sm font-medium ${
                    publishingAudio()
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                  onClick={toggleAudio}
                >
                  Mic
                </button>
                <button
                  class={`rounded px-4 py-2 text-sm font-medium ${
                    publishingVideo()
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                  onClick={toggleVideo}
                >
                  Cam
                </button>
                <button
                  class={`rounded px-4 py-2 text-sm font-medium ${
                    speakerOn()
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-gray-700 hover:bg-gray-600"
                  }`}
                  onClick={toggleSpeaker}
                >
                  Spkr
                </button>
                <button
                  class="rounded bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-700"
                  onClick={handleLeave}
                >
                  Leave
                </button>
              </div>

              <div class="grid gap-3 text-xs text-gray-400 md:grid-cols-2">
                <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
                  <div class="text-gray-500">Active room path</div>
                  <div class="break-all pt-1 text-gray-200">
                    {joinedRelayPath()}
                  </div>
                </div>
                <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
                  <div class="text-gray-500">Local publish path</div>
                  <div class="break-all pt-1 text-gray-200">
                    {String(localBroadcast.name.peek() || localPublishPath())}
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div class="relative aspect-video overflow-hidden rounded-md bg-gray-800">
                  <Show
                    when={publishingVideo()}
                    fallback={
                      <div class="flex h-full items-center justify-center text-gray-500">
                        Video Paused
                      </div>
                    }
                  >
                    <VideoCanvas frame={localFrame} flip />
                  </Show>
                  <div class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs">
                    You
                  </div>
                </div>

                <For each={participants()}>
                  {(participant) => {
                    const remoteFrame = solid(participant.videoDecoder.frame);
                    return (
                      <div class="relative aspect-video overflow-hidden rounded-md bg-gray-800">
                        <VideoCanvas frame={remoteFrame} />
                        <div class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs">
                          Participant
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              <DebugPanel
                connectionStatus={connectionStatus}
                roomName={joinedRoomName}
                publishingAudio={publishingAudio}
                speakerOn={speakerOn}
                participantCount={() =>
                  participants().length + (joined() ? 1 : 0)
                }
                pubRms={pubRms}
                subRms={subRms}
                diagLog={diagLog}
              />
            </div>
          </Show>
        </SectionCard>

        <SectionCard
          title="Section B -> Web Component"
          subtitle="Official bare <moq-watch> element with only relay URL + name wiring."
          enabled={showWebComponent}
          setEnabled={setShowWebComponent}
        >
          <WatchWebComponentShowcase
            enabled={joined}
            relayUrl={resolvedSectionRelayUrl}
            watchName={resolvedWatchName}
          />
        </SectionCard>

        <SectionCard
          title="Section C -> SolidJS Overlay"
          subtitle="Official Solid-powered watch UI layered over the same <moq-watch> target."
          enabled={showSolidOverlay}
          setEnabled={setShowSolidOverlay}
        >
          <WatchOverlayShowcase
            enabled={joined}
            relayUrl={resolvedSectionRelayUrl}
            watchName={resolvedWatchName}
          />
        </SectionCard>
      </div>
    </div>
  );
};
