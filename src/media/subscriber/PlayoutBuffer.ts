import type { FrameObject } from "./types";

export type PlayoutBufferDropReason = "overflow" | "late";

export type PlayoutBufferConfig = {
  targetLatencyMs: number;
  maxItems: number;
  tickMs: number;
};

export const DEFAULT_PLAYOUT_BUFFER_CONFIG: PlayoutBufferConfig = {
  targetLatencyMs: 100,
  maxItems: 120,
  tickMs: 10,
};

export type PlayoutBufferCallbacks = {
  onRelease: (frameObject: FrameObject) => void;
  onDrop?: (
    frameObject: FrameObject,
    reason: PlayoutBufferDropReason,
    queueDepth: number,
  ) => void;
};

function compareLocation(a: FrameObject, b: FrameObject): number {
  if (a.group < b.group) return -1;
  if (a.group > b.group) return 1;
  if (a.object < b.object) return -1;
  if (a.object > b.object) return 1;
  return 0;
}

export class PlayoutBuffer {
  private readonly config: PlayoutBufferConfig;
  private readonly onRelease: PlayoutBufferCallbacks["onRelease"];
  private readonly onDrop?: PlayoutBufferCallbacks["onDrop"];

  private readonly queue: FrameObject[] = [];
  private timerId?: number;
  private running = false;

  private anchorTimestampUs?: number;
  private anchorWallClockMs?: number;
  private lastReleased?: { group: bigint; object: bigint };

  constructor(
    config: Partial<PlayoutBufferConfig> | undefined,
    callbacks: PlayoutBufferCallbacks,
  ) {
    this.config = { ...DEFAULT_PLAYOUT_BUFFER_CONFIG, ...(config ?? {}) };
    this.onRelease = callbacks.onRelease;
    this.onDrop = callbacks.onDrop;
  }

  enqueue(frameObject: FrameObject): void {
    // Protect decode ordering: once a location has been released, do not
    // allow older/duplicate objects to re-enter the queue.
    if (this.lastReleased) {
      const isOlderGroup = frameObject.group < this.lastReleased.group;
      const isOlderObject =
        frameObject.group === this.lastReleased.group &&
        frameObject.object <= this.lastReleased.object;
      if (isOlderGroup || isOlderObject) {
        this.onDrop?.(frameObject, "late", this.queue.length);
        return;
      }
    }

    this.insertSorted(frameObject);

    while (this.queue.length > this.config.maxItems) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.onDrop?.(dropped, "overflow", this.queue.length);
      this.resetAnchorIfDropped(dropped);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timerId = window.setInterval(() => {
      this.releaseDue(performance.now());
    }, this.config.tickMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId !== undefined) {
      window.clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  drain(): void {
    this.queue.length = 0;
    this.anchorTimestampUs = undefined;
    this.anchorWallClockMs = undefined;
    this.lastReleased = undefined;
  }

  getDepth(): number {
    return this.queue.length;
  }

  private insertSorted(frameObject: FrameObject): void {
    let i = this.queue.length;
    while (i > 0 && compareLocation(frameObject, this.queue[i - 1]!) < 0) {
      i--;
    }
    this.queue.splice(i, 0, frameObject);
  }

  private releaseDue(nowMs: number): void {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;

      if (
        this.anchorTimestampUs === undefined ||
        this.anchorWallClockMs === undefined
      ) {
        this.anchorTimestampUs = head.timestampUs;
        this.anchorWallClockMs = nowMs + this.config.targetLatencyMs;
      }

      const deltaUs = Math.max(0, head.timestampUs - this.anchorTimestampUs);
      const dueAtMs = this.anchorWallClockMs + deltaUs / 1000;
      if (dueAtMs > nowMs) return;

      this.queue.shift();
      this.lastReleased = { group: head.group, object: head.object };
      this.onRelease(head);
    }
  }

  private resetAnchorIfDropped(dropped: FrameObject): void {
    if (this.anchorTimestampUs === undefined) return;
    if (dropped.timestampUs === this.anchorTimestampUs) {
      this.anchorTimestampUs = undefined;
      this.anchorWallClockMs = undefined;
    }
  }
}
