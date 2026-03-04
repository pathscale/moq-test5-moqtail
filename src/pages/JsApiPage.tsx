import { Show } from "solid-js";

import { DebugPanel } from "../DebugPanel";
import { useTestSession } from "../hooks/useTestSession";
import {
  SectionCard,
  TestPageShell,
} from "../components/TestPageShell";

export function JsApiPage() {
  const session = useTestSession();

  return (
    <TestPageShell
      title="MoQ JS API"
      subtitle="Placeholder page for the manual JS API scenario while the pipeline is restored."
      session={session}
    >
      <SectionCard
        title="JS API Scenario"
        subtitle="Manual publish and subscribe flow will return here in the next step."
      >
        <div class="space-y-4">
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
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-700"
                onClick={session.handleLeave}
              >
                Leave
              </button>
            </div>
          </Show>

          <div class="rounded-xl border border-dashed border-gray-700 bg-gray-950/60 p-6 text-sm text-gray-300">
            JS API scenario will be restored here.
          </div>

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
      </SectionCard>
    </TestPageShell>
  );
}
