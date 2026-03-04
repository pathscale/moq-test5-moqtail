import { A } from "@solidjs/router";

export function IndexPage() {
  const linkClass =
    "block rounded-xl border border-gray-800 bg-gray-900/70 px-5 py-4 text-lg font-medium text-white transition hover:border-blue-500 hover:bg-gray-900";

  return (
    <div class="min-h-screen bg-gray-950 p-6 text-white">
      <div class="mx-auto flex max-w-4xl flex-col gap-6">
        <div class="space-y-2">
          <div class="text-xs font-medium uppercase tracking-[0.2em] text-blue-300">
            Launcher
          </div>
          <h1 class="text-4xl font-bold">MoQ Test Harness</h1>
          <p class="max-w-2xl text-sm text-gray-400">
            Choose a scenario page to test the MoQ integration path in
            isolation.
          </p>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <A href="/js" class={linkClass}>
            JS API Test
          </A>
          <A href="/wc" class={linkClass}>
            Web Components Test
          </A>
          <A href="/overlay" class={linkClass}>
            Solid Overlay Test
          </A>
        </div>
      </div>
    </div>
  );
}
