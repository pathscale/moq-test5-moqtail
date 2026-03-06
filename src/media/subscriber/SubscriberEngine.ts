import { TrackSubscription } from "./TrackSubscription";
import type { StartSubscriptionParams, TrackKey } from "./types";

function keyToId(key: TrackKey): string {
  return `${key.namespace}::${key.kind}`;
}

export class SubscriberEngine {
  private readonly subscriptions = new Map<string, TrackSubscription>();
  private disposed = false;

  async startSubscription(params: StartSubscriptionParams): Promise<void> {
    if (this.disposed) return;

    const id = keyToId(params.key);
    let subscription = this.subscriptions.get(id);
    if (!subscription) {
      subscription = new TrackSubscription(params);
      this.subscriptions.set(id, subscription);
    }

    await subscription.start();
  }

  async stopSubscription(key: TrackKey): Promise<void> {
    if (this.disposed) return;

    const id = keyToId(key);
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;

    await subscription.stop();
    this.subscriptions.delete(id);
  }

  hasSubscription(key: TrackKey): boolean {
    return this.subscriptions.has(keyToId(key));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const tasks = [...this.subscriptions.values()].map((subscription) =>
      subscription.dispose(),
    );
    this.subscriptions.clear();
    await Promise.all(tasks);
  }
}
