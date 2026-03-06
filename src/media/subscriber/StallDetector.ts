export type StallType = "object_stall" | "decode_stall";

export type StallEvent = {
  type: StallType;
  generation: number;
  detectedAtMs: number;
  lastObjectAtMs?: number;
  lastFrameAtMs?: number;
  playoutBufferDepth: number;
};

export type StallDetectorConfig = {
  objectStallMs: number;
  decodeStallMs: number;
  tickMs: number;
};

export const DEFAULT_STALL_DETECTOR_CONFIG: StallDetectorConfig = {
  objectStallMs: 1500,
  decodeStallMs: 800,
  tickMs: 200,
};

export type StallDetectorDeps = {
  getGeneration: () => number;
  getPlayoutBufferDepth: () => number;
  onStall: (event: StallEvent) => void;
  log?: (tag: string, msg: string) => void;
};

export class StallDetector {
  private readonly config: StallDetectorConfig;
  private readonly getGeneration: StallDetectorDeps["getGeneration"];
  private readonly getPlayoutBufferDepth: StallDetectorDeps["getPlayoutBufferDepth"];
  private readonly onStall: StallDetectorDeps["onStall"];
  private readonly log?: StallDetectorDeps["log"];

  private timerId?: number;
  private running = false;
  private generation = 0;

  private lastObjectAtMs?: number;
  private lastFrameAtMs?: number;
  private lastReportedObjectStallAtMs = 0;
  private lastReportedDecodeStallAtMs = 0;

  constructor(
    config: Partial<StallDetectorConfig> | undefined,
    deps: StallDetectorDeps,
  ) {
    this.config = { ...DEFAULT_STALL_DETECTOR_CONFIG, ...(config ?? {}) };
    this.getGeneration = deps.getGeneration;
    this.getPlayoutBufferDepth = deps.getPlayoutBufferDepth;
    this.onStall = deps.onStall;
    this.log = deps.log;
  }

  onObjectReceived(atMs = performance.now()): void {
    this.refreshGenerationIfChanged();
    this.lastObjectAtMs = atMs;
  }

  onFrameDecoded(atMs = performance.now()): void {
    this.refreshGenerationIfChanged();
    this.lastFrameAtMs = atMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation = this.getGeneration();
    const now = performance.now();
    this.lastObjectAtMs = now;
    this.lastFrameAtMs = now;
    this.timerId = window.setInterval(() => this.check(performance.now()), this.config.tickMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId !== undefined) {
      window.clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  private check(nowMs: number): void {
    if (!this.running) return;
    this.refreshGenerationIfChanged();

    const depth = this.getPlayoutBufferDepth();
    const objectAge = this.lastObjectAtMs === undefined ? Infinity : nowMs - this.lastObjectAtMs;
    const frameAge = this.lastFrameAtMs === undefined ? Infinity : nowMs - this.lastFrameAtMs;

    if (
      objectAge >= this.config.objectStallMs &&
      nowMs - this.lastReportedObjectStallAtMs >= this.config.objectStallMs
    ) {
      this.lastReportedObjectStallAtMs = nowMs;
      this.log?.("video", `stall detector: object stall (age=${Math.round(objectAge)}ms, depth=${depth})`);
      this.onStall({
        type: "object_stall",
        generation: this.generation,
        detectedAtMs: nowMs,
        lastObjectAtMs: this.lastObjectAtMs,
        lastFrameAtMs: this.lastFrameAtMs,
        playoutBufferDepth: depth,
      });
      return;
    }

    const objectsStillArriving = objectAge < this.config.objectStallMs;
    if (
      objectsStillArriving &&
      frameAge >= this.config.decodeStallMs &&
      depth > 0 &&
      nowMs - this.lastReportedDecodeStallAtMs >= this.config.decodeStallMs
    ) {
      this.lastReportedDecodeStallAtMs = nowMs;
      this.log?.("video", `stall detector: decode stall (age=${Math.round(frameAge)}ms, depth=${depth})`);
      this.onStall({
        type: "decode_stall",
        generation: this.generation,
        detectedAtMs: nowMs,
        lastObjectAtMs: this.lastObjectAtMs,
        lastFrameAtMs: this.lastFrameAtMs,
        playoutBufferDepth: depth,
      });
    }
  }

  private refreshGenerationIfChanged(): void {
    const nextGeneration = this.getGeneration();
    if (nextGeneration === this.generation) return;
    this.generation = nextGeneration;
    const now = performance.now();
    this.lastObjectAtMs = now;
    this.lastFrameAtMs = now;
    this.lastReportedObjectStallAtMs = 0;
    this.lastReportedDecodeStallAtMs = 0;
  }
}
