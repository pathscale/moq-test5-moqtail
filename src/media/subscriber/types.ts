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
