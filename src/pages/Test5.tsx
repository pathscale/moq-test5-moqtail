import { For, Show, createEffect, onCleanup } from "solid-js";

import { joinUrl, normalizePath } from "../helpers";
import { useTestSession } from "../hooks/useTestSession";
import { VideoCanvas } from "../VideoCanvas";
import { SectionCard, TestShell } from "../components/TestShell";
import { createMoqtailPublisher } from "../scenarios/MoqtailPublisher";
import { createMoqtailSubscriber } from "../scenarios/MoqtailSubscriber";

export function Test5() {
  const session = useTestSession();
  const publisher = createMoqtailPublisher(session.log);
  const subscriber = createMoqtailSubscriber({
    getClient: publisher.getClient,
    log: session.log,
  });

  const subscriptionTargets = () => {
    const override = normalizePath(session.watchPathOverride());
    if (override) return [session.resolvedWatchName()];
    return session.participants();
  };

  createEffect(() => {
    if (!session.joined()) {
      // Stop publisher when leaving
      void publisher.stop();
      return;
    }

    const relayUrl = joinUrl(
      session.joinedRelayUrl(),
      session.joinedRelayPath(),
    );
    void publisher.start(relayUrl, session.localPublishPath());
  });

  createEffect(() => {
    if (!session.joined()) {
      subscriber.stopNamespaceWatch();
      subscriber.clear();
      return;
    }

    // Start watching for namespace announcements from other participants
    const prefixParts = session.joinedRelayPath().split("/").filter(Boolean);
    void subscriber.startNamespaceWatch(prefixParts, session.localPublishPath());

    // Also reconcile any explicit targets
    void subscriber.reconcile(subscriptionTargets());
  });

  onCleanup(() => {
    subscriber.close();
    void publisher.close();
  });

  return (
    <TestShell
      title="MoQ JS API"
      subtitle="Direct MoQ publish and watch pipeline using the manual JavaScript API."
      session={session}
      debugPanel={{
        connectionStatus: publisher.connectionStatus,
        roomName: session.joinedRoomName,
        publishingAudio: publisher.publishingAudio,
        speakerOn: subscriber.speakerOn,
        participantCount: () =>
          subscriber.participants().length + (session.joined() ? 1 : 0),
        pubRms: publisher.pubRms,
        subRms: subscriber.subRms,
        diagLog: session.diagLog,
      }}
    >
      <SectionCard
        title="JS API Scenario"
        subtitle="Manual publish, announce, subscribe, decode, and audio routing flow restored from the original harness."
      >
        <Show when={session.joined()}>
          <div class="space-y-4">
            <div class="flex flex-wrap items-center gap-2">
              <button
                class={`rounded px-4 py-2 text-sm font-medium ${
                  publisher.publishingAudio()
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                onClick={() => void publisher.toggleAudio()}
              >
                Mic
              </button>
              <button
                class={`rounded px-4 py-2 text-sm font-medium ${
                  publisher.publishingVideo()
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                onClick={() => void publisher.toggleVideo()}
              >
                Cam
              </button>
              <button
                class={`rounded px-4 py-2 text-sm font-medium ${
                  subscriber.speakerOn()
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }`}
                onClick={subscriber.toggleSpeaker}
              >
                Spkr
              </button>
            </div>

            <div class="grid gap-3 text-xs text-gray-400 md:grid-cols-2">
              <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
                <div class="text-gray-500">Active room path</div>
                <div class="break-all pt-1 text-gray-200">
                  {session.joinedRelayPath()}
                </div>
              </div>
              <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
                <div class="text-gray-500">Local publish path</div>
                <div class="break-all pt-1 text-gray-200">
                  {session.localPublishPath()}
                </div>
              </div>
            </div>

            <div class="space-y-2">
              <div class="text-xs font-medium uppercase tracking-[0.2em] text-gray-400">
                Streams
              </div>
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div class="relative aspect-video overflow-hidden rounded-md bg-gray-800">
                  <Show
                    when={publisher.publishingVideo()}
                    fallback={
                      <div class="flex h-full items-center justify-center text-gray-500">
                        Video Paused
                      </div>
                    }
                  >
                    <VideoCanvas frame={publisher.localFrame} flip />
                  </Show>
                  <div class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs">
                    You
                  </div>
                </div>

                <For each={subscriber.participants()}>
                  {(participant) => {
                    return (
                      <div class="relative aspect-video overflow-hidden rounded-md bg-gray-800">
                        <VideoCanvas frame={participant.videoFrame} />
                        <div class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs">
                          {participant.id.split("/").slice(-1)[0] ||
                            "Participant"}
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              <Show when={subscriber.participants().length === 0}>
                <div class="rounded border border-dashed border-gray-700 bg-gray-950/60 p-4 text-sm text-gray-400">
                  No remote participants subscribed yet.
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </SectionCard>
    </TestShell>
  );
}
