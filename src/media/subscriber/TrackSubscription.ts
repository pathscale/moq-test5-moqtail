import {
  FilterType,
  FullTrackName,
  GroupOrder,
  ObjectStatus,
  SubscribeError,
  type MOQtailClient,
} from "moqtail";

import {
  PlayoutBuffer,
  type PlayoutBufferDropReason,
} from "./PlayoutBuffer";
import type {
  DecodedFrame,
  FrameObject,
  StartSubscriptionParams,
  TrackKey,
  WorkerInMessage,
  WorkerOutMessage,
} from "./types";

type SubscriptionState = "idle" | "starting" | "running" | "stopping" | "disposed";

export class TrackSubscription {
  readonly key: TrackKey;

  private readonly client: MOQtailClient;
  private readonly sink: StartSubscriptionParams["sink"];
  private readonly log?: StartSubscriptionParams["log"];

  private state: SubscriptionState = "idle";
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private requestId?: bigint;
  private reader?: ReadableStreamDefaultReader<any>;
  private decodeMode: "worker" | "main" = "main";
  private decodeWorker?: Worker;
  private generation = 0;
  private decoder?: VideoDecoder;
  private playoutBuffer?: PlayoutBuffer;
  private canceled = false;
  private frameCount = 0;
  private playoutDropCount = 0;
  private playoutLateDropCount = 0;
  private queueDepthHighWater = 0;

  constructor(params: StartSubscriptionParams) {
    this.key = params.key;
    this.client = params.client;
    this.sink = params.sink;
    this.log = params.log;
  }

  start(): Promise<void> {
    if (this.state === "disposed") return Promise.resolve();
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.state = "starting";
    this.canceled = false;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
      if (this.state === "starting") this.state = "running";
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.state === "disposed") return Promise.resolve();
    if (this.state === "idle") return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;

    this.state = "stopping";
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = undefined;
      if (this.state !== "disposed") this.state = "idle";
    });
    return this.stopPromise;
  }

  dispose(): Promise<void> {
    if (this.state === "disposed") return Promise.resolve();
    this.state = "disposed";
    return this.stopInternal();
  }

  private async startInternal(): Promise<void> {
    const fullTrackName = FullTrackName.tryNew(this.key.namespace, this.key.kind);
    const result = await this.client.subscribe({
      fullTrackName,
      filterType: FilterType.LatestObject,
      forward: true,
      groupOrder: GroupOrder.Original,
      priority: 0,
    });

    if (result instanceof SubscribeError) {
      this.log?.("sub", `video subscribe error for ${this.key.namespace}: code=${result.errorCode}`);
      this.state = "idle";
      return;
    }

    this.requestId = result.requestId;
    this.reader = result.stream.getReader();
    this.frameCount = 0;
    this.playoutDropCount = 0;
    this.playoutLateDropCount = 0;
    this.queueDepthHighWater = 0;
    this.generation += 1;

    const workerStarted = await this.startWorkerDecoder(this.generation);
    if (!workerStarted) {
      const fallbackReady = this.setupMainThreadDecoder();
      const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
      if (fallbackReady) {
        this.log?.("video", `...${shortId} decode mode: main (worker unavailable)`);
      } else {
        this.log?.("video", `...${shortId} no decode backend available`);
      }
    }

    if (this.canceled || this.state === "stopping" || this.state === "disposed") {
      this.cleanupDecodeResources();
      return;
    }

    this.playoutBuffer = new PlayoutBuffer(undefined, {
      onRelease: (frameObject) => this.decodeFrameObject(frameObject),
      onDrop: (_frameObject, reason, queueDepth) => {
        this.onPlayoutDrop(reason, queueDepth);
      },
    });
    this.playoutBuffer.start();

    void this.consumeStream();
  }

  private async consumeStream(): Promise<void> {
    if (!this.reader) return;

    try {
      for (;;) {
        const { value: obj, done } = await this.reader.read();
        if (done || this.canceled || this.state === "disposed") break;
        if (!obj || !obj.payload) continue;
        if (obj.objectStatus !== ObjectStatus.Normal) continue;

        const frameObject = this.toFrameObject(obj);
        this.playoutBuffer?.enqueue(frameObject);

        const depth = this.playoutBuffer?.getDepth() ?? 0;
        if (depth > this.queueDepthHighWater) {
          this.queueDepthHighWater = depth;
          if (depth === 1 || depth % 20 === 0) {
            const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
            this.log?.("video", `...${shortId} playout depth: ${depth}`);
          }
        }
      }
    } finally {
      this.cleanupPlayoutBuffer();
      this.reader?.releaseLock();
      this.reader = undefined;
      this.cleanupDecodeResources();
    }
  }

  private decodeFrameObject(frameObject: FrameObject): void {
    if (this.canceled || this.state === "stopping" || this.state === "disposed") {
      return;
    }
    if (this.decodeMode === "worker" && this.decodeWorker) {
      const payload = this.toTransferableBuffer(frameObject.payload);
      const message: WorkerInMessage = {
        type: "DECODE",
        generation: this.generation,
        timestampUs: frameObject.timestampUs,
        isKey: frameObject.isKey,
        payload,
      };
      try {
        this.decodeWorker.postMessage(message, [payload]);
        return;
      } catch (error) {
        this.switchToMainThreadDecoder(`worker postMessage failed: ${String(error)}`);
      }
    }

    this.decodeFrameObjectOnMainThread(frameObject);
  }

  private decodeFrameObjectOnMainThread(frameObject: FrameObject): void {
    if (!this.decoder) return;

    const chunk = new EncodedVideoChunk({
      type: frameObject.isKey ? "key" : "delta",
      timestamp: frameObject.timestampUs,
      data: frameObject.payload,
    });

    try {
      this.decoder.decode(chunk);
    } catch (error) {
      const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
      this.log?.("video", `...${shortId} decode error: ${error}`);
    }
  }

  private async startWorkerDecoder(generation: number): Promise<boolean> {
    if (typeof Worker === "undefined") return false;

    try {
      const worker = new Worker(
        new URL("../../workers/subscriberVideoDecodeWorker.ts", import.meta.url),
        { type: "module" },
      );

      const initOk = await new Promise<boolean>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          cleanup();
          resolve(false);
        }, 2000);

        const onMessage = (event: MessageEvent) => {
          const message = event.data as WorkerOutMessage;
          if (message.generation !== generation) {
            if (message.type === "DECODED") {
              message.frame.close();
            }
            return;
          }
          if (message.type === "INIT_OK") {
            cleanup();
            resolve(true);
          } else if (message.type === "INIT_ERROR") {
            cleanup();
            resolve(false);
          }
        };

        const onError = () => {
          cleanup();
          resolve(false);
        };

        const cleanup = () => {
          window.clearTimeout(timeoutId);
          worker.removeEventListener("message", onMessage as EventListener);
          worker.removeEventListener("error", onError);
        };

        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError);
        const initMessage: WorkerInMessage = {
          type: "INIT",
          generation,
          codec: "avc1.42001f",
          hardwareAcceleration: "prefer-software",
        };
        worker.postMessage(initMessage);
      });

      if (!initOk || generation !== this.generation) {
        worker.terminate();
        return false;
      }

      worker.onmessage = (event: MessageEvent) => {
        this.handleWorkerMessage(event.data as WorkerOutMessage);
      };
      worker.onerror = (event: Event) => {
        this.switchToMainThreadDecoder(`worker runtime error: ${String(event.type)}`);
      };

      this.decodeWorker = worker;
      this.decodeMode = "worker";
      const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
      this.log?.("video", `...${shortId} decode mode: worker`);
      return true;
    } catch (error) {
      return false;
    }
  }

  private handleWorkerMessage(message: WorkerOutMessage): void {
    if (message.generation !== this.generation) {
      if (message.type === "DECODED") {
        message.frame.close();
      }
      return;
    }

    switch (message.type) {
      case "DECODED":
        this.handleDecodedFrame(message.frame, message.timestampUs);
        return;
      case "ERROR": {
        const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
        this.log?.("video", `...${shortId} worker decode error: ${message.error}`);
        if (message.fatal) {
          this.switchToMainThreadDecoder("worker reported fatal error");
        }
        return;
      }
      case "INIT_OK":
      case "INIT_ERROR":
      default:
        return;
    }
  }

  private setupMainThreadDecoder(): boolean {
    if (typeof VideoDecoder === "undefined") {
      return false;
    }

    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.handleDecodedFrame(frame, frame.timestamp ?? 0);
      },
      error: (error) => {
        const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
        this.log?.("video", `...${shortId} decoder error: ${error}`);
      },
    });

    this.decoder.configure({
      codec: "avc1.42001f",
      hardwareAcceleration: "prefer-software",
    });

    this.decodeMode = "main";
    return true;
  }

  private switchToMainThreadDecoder(reason: string): void {
    if (this.canceled || this.state === "stopping" || this.state === "disposed") return;
    if (this.decodeMode === "main" && this.decoder) return;

    const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
    this.log?.("video", `...${shortId} falling back to main decoder: ${reason}`);

    this.teardownWorker();
    if (!this.setupMainThreadDecoder()) {
      this.log?.("video", `...${shortId} main-thread decoder unavailable after fallback`);
    }
  }

  private handleDecodedFrame(frame: VideoFrame, sourceTimestampUs: number): void {
    if (this.canceled || this.state === "stopping" || this.state === "disposed") {
      frame.close();
      return;
    }

    const decodedFrame: DecodedFrame = {
      key: this.key,
      frame,
      decodedAtMs: performance.now(),
      sourceTimestampUs,
    };
    this.sink.render(decodedFrame);
    this.frameCount++;
    if (this.frameCount === 1 || this.frameCount % 100 === 0) {
      const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
      this.log?.("video", `...${shortId} frame #${this.frameCount} (${frame.displayWidth}x${frame.displayHeight})`);
    }
  }

  private toTransferableBuffer(payload: Uint8Array): ArrayBuffer {
    if (payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength) {
      return payload.buffer;
    }
    return payload.slice().buffer;
  }

  private toFrameObject(obj: any): FrameObject {
    return {
      key: this.key,
      group: obj.location.group as bigint,
      object: obj.location.object as bigint,
      isKey: (obj.location.object as bigint) === 0n,
      timestampUs:
        Number(obj.location.group as bigint) * 1_000_000 +
        Number(obj.location.object as bigint) * 33_333,
      payload: obj.payload as Uint8Array,
      receivedAtMs: performance.now(),
    };
  }

  private async stopInternal(): Promise<void> {
    this.canceled = true;
    this.cleanupPlayoutBuffer();

    try {
      await this.reader?.cancel();
    } catch {
      // Ignore reader cancel failures during teardown.
    }

    this.reader = undefined;
    this.cleanupDecodeResources();

    if (this.requestId !== undefined) {
      try {
        await this.client.unsubscribe(this.requestId);
      } catch {
        // Ignore unsubscribe failures during teardown.
      }
      this.requestId = undefined;
    }

    this.sink.clear(this.key);
  }

  private cleanupPlayoutBuffer(): void {
    this.playoutBuffer?.stop();
    this.playoutBuffer?.drain();
    this.playoutBuffer = undefined;
  }

  private cleanupDecodeResources(): void {
    this.teardownWorker();
    try {
      this.decoder?.close();
    } catch {
      // Ignore decoder close failures during teardown.
    }
    this.decoder = undefined;
    this.decodeMode = "main";
  }

  private teardownWorker(): void {
    if (!this.decodeWorker) return;
    try {
      const disposeMessage: WorkerInMessage = {
        type: "DISPOSE",
        generation: this.generation,
      };
      this.decodeWorker.postMessage(disposeMessage);
    } catch {
      // Ignore worker dispose post failures during teardown.
    }
    this.decodeWorker.onmessage = null;
    this.decodeWorker.onerror = null;
    this.decodeWorker.terminate();
    this.decodeWorker = undefined;
  }

  private onPlayoutDrop(reason: PlayoutBufferDropReason, queueDepth: number): void {
    const shortId = this.key.namespace.split("/").slice(-1)[0] ?? "participant";
    if (reason === "overflow") {
      this.playoutDropCount++;
      if (this.playoutDropCount === 1 || this.playoutDropCount % 20 === 0) {
        this.log?.(
          "video",
          `...${shortId} playout overflow drops: ${this.playoutDropCount} (depth=${queueDepth})`,
        );
      }
      return;
    }

    this.playoutLateDropCount++;
    if (this.playoutLateDropCount === 1 || this.playoutLateDropCount % 20 === 0) {
      this.log?.(
        "video",
        `...${shortId} playout late drops: ${this.playoutLateDropCount} (depth=${queueDepth})`,
      );
    }
  }
}
