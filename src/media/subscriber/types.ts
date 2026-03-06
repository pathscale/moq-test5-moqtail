import type { MOQtailClient } from "moqtail";

export type TrackKind = "video";

export type TrackKey = {
  namespace: string;
  kind: TrackKind;
};

export type FrameObject = {
  key: TrackKey;
  group: bigint;
  object: bigint;
  isKey: boolean;
  timestampUs: number;
  payload: Uint8Array;
  receivedAtMs: number;
};

export type DecodedFrame = {
  key: TrackKey;
  frame: VideoFrame;
  decodedAtMs: number;
  sourceTimestampUs: number;
};

export type VideoRenderSink = {
  render: (frame: DecodedFrame) => void;
  clear: (key: TrackKey) => void;
};

export type StartSubscriptionParams = {
  client: MOQtailClient;
  key: TrackKey;
  sink: VideoRenderSink;
  log?: (tag: string, msg: string) => void;
};

export type WorkerInMessage =
  | {
      type: "INIT";
      generation: number;
      codec: string;
      hardwareAcceleration?: "prefer-software" | "prefer-hardware";
    }
  | {
      type: "DECODE";
      generation: number;
      timestampUs: number;
      isKey: boolean;
      payload: ArrayBuffer;
    }
  | {
      type: "RESET";
      generation: number;
    }
  | {
      type: "DISPOSE";
      generation: number;
    };

export type WorkerOutMessage =
  | {
      type: "INIT_OK";
      generation: number;
    }
  | {
      type: "INIT_ERROR";
      generation: number;
      error: string;
    }
  | {
      type: "DECODED";
      generation: number;
      timestampUs: number;
      frame: VideoFrame;
    }
  | {
      type: "ERROR";
      generation: number;
      error: string;
      fatal: boolean;
    };
