import { Show } from "solid-js";

import { DebugPanel } from "../DebugPanel";
import { useTestSession } from "../hooks/useTestSession";
import {
  SectionCard,
  TestPageShell,
} from "../components/TestPageShell";
import { WatchOverlayShowcase } from "../WatchShowcases";

export function SolidOverlayPage() {
  const session = useTestSession();

  return (
    <TestPageShell
      title="MoQ Solid Overlay"
      subtitle="Isolated test page for the Solid-powered MoQ watch overlay."
      session={session}
    >
      <SectionCard
        title="Overlay Scenario"
        subtitle="Overlay-only watch page using the shared session state and announce discovery."
      >
        <Show
          when={session.joined()}
          fallback={
            <button
              class="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={session.handleJoin}
              disabled={session.joining()}
            >
              <Show when={session.joining()}>
                <span class="loading loading-spinner loading-sm" />
              </Show>
              {session.joining() ? "Connecting..." : "Join"}
            </button>
          }
        >
          <div class="space-y-4">
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-700"
                onClick={session.handleLeave}
              >
                Leave
              </button>
            </div>

            <WatchOverlayShowcase
              enabled={session.joined}
              relayUrl={session.resolvedSectionRelayUrl}
              watchName={session.resolvedWatchName}
            />

            <DebugPanel
              connectionStatus={session.connectionStatus}
              roomName={session.joinedRoomName}
              publishingAudio={() => undefined}
              speakerOn={() => undefined}
              participantCount={() => session.participants().length}
              pubRms={() => undefined}
              subRms={() => undefined}
              diagLog={session.diagLog}
            />
          </div>
        </Show>
      </SectionCard>
    </TestPageShell>
  );
}
