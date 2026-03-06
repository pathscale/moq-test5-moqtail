import { Show } from "solid-js";
import { useTestSession } from "../hooks/useTestSession";

type Session = ReturnType<typeof useTestSession>;

export function TestControls(props: {
  session: Session;
  description?: string;
}) {
  return (
    <section class="space-y-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
      <div class="space-y-1">
        <div class="text-xs font-medium uppercase tracking-[0.2em] text-gray-400">
          Shared Controls
        </div>
        <p class="text-sm text-gray-400">
          {props.description ||
            "Relay and room are shared for this scenario. The watch path can be overridden for targeted stream testing."}
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <label class="block text-sm font-medium text-gray-300">
            Relay URL
          </label>
          <input
            type="url"
            value={props.session.relayUrl()}
            onInput={(event) =>
              props.session.handleRelayUrlChange(event.currentTarget.value)
            }
            class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
            placeholder="https://moq-relay.nofilter.io"
          />
        </div>

        <div class="space-y-2">
          <label class="block text-sm font-medium text-gray-300">Room</label>
          <input
            type="text"
            value={props.session.roomName()}
            onInput={(event) =>
              props.session.handleNameChange(event.currentTarget.value)
            }
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
          value={props.session.watchPathOverride()}
          onInput={(event) =>
            props.session.setWatchPathOverride(event.currentTarget.value)
          }
          class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
          placeholder="Optional: anon/my-room/participant-id"
        />
        <p class="text-xs text-gray-500">
          If empty, the scenario watches the first discovered remote participant
          or falls back to the local publish path.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Show
          when={props.session.joined()}
          fallback={
            <button
              class="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={props.session.handleJoin}
              disabled={props.session.joining()}
            >
              <Show when={props.session.joining()}>
                <span class="loading loading-spinner loading-sm" />
              </Show>
              {props.session.joining() ? "Connecting..." : "Join"}
            </button>
          }
        >
          <button
            class="rounded bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-700"
            onClick={props.session.handleLeave}
          >
            Leave
          </button>
        </Show>
      </div>

      <div class="grid gap-3 text-xs text-gray-400 md:grid-cols-2">
        <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
          <div class="text-gray-500">Resolved relay URL</div>
          <div class="break-all pt-1 text-gray-200">
            {props.session.resolvedSectionRelayUrl() || "invalid relay URL"}
          </div>
        </div>
        <div class="rounded border border-gray-800 bg-gray-950/70 p-3">
          <div class="text-gray-500">Resolved watch name</div>
          <div class="break-all pt-1 text-gray-200">
            {props.session.resolvedWatchName()}
          </div>
        </div>
      </div>
    </section>
  );
}
