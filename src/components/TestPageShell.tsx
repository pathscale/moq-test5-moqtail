import { Accessor, Component, For, Show } from "solid-js";

import { RELAY_OPTIONS } from "../helpers";
import { useTestSession } from "../hooks/useTestSession";

type Session = ReturnType<typeof useTestSession>;

export function SectionCard(props: {
  title: string;
  subtitle: string;
  enabled?: Accessor<boolean>;
  setEnabled?: (next: boolean) => void;
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
        <Show when={props.enabled && props.setEnabled}>
          <label class="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-sm text-gray-200">
            <input
              type="checkbox"
              checked={props.enabled?.()}
              onInput={(event) => props.setEnabled?.(event.currentTarget.checked)}
            />
            Enabled
          </label>
        </Show>
      </div>
      <Show when={props.enabled ? props.enabled() : true}>{props.children}</Show>
    </section>
  );
}

export const TestPageShell: Component<{
  title: string;
  subtitle: string;
  session: Session;
  children: any;
}> = (props) => {
  return (
    <div class="min-h-screen bg-gray-950 p-6 text-white">
      <div class="mx-auto max-w-6xl space-y-6">
        <div class="space-y-2">
          <h1 class="text-3xl font-bold">{props.title}</h1>
          <p class="max-w-3xl text-sm text-gray-400">{props.subtitle}</p>
        </div>

        <section class="space-y-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
          <div class="space-y-1">
            <div class="text-xs font-medium uppercase tracking-[0.2em] text-gray-400">
              Shared Controls
            </div>
            <p class="text-sm text-gray-400">
              Relay and room are shared for this scenario. The watch path can be
              overridden for targeted stream testing.
            </p>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-300">
                Relay URL
              </label>
              <select
                value={props.session.relayUrl()}
                onChange={(event) =>
                  props.session.handleRelayUrlChange(event.currentTarget.value)
                }
                class="w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              >
                <For each={RELAY_OPTIONS}>
                  {(relay) => <option value={relay.url}>{relay.name}</option>}
                </For>
              </select>
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
              If empty, the scenario watches the first discovered remote
              participant or falls back to the local publish path.
            </p>
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

        {props.children}
      </div>
    </div>
  );
};
