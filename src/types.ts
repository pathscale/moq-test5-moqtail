export interface DiagEvent {
  t: number;
  tag: string;
  msg: string;
}

export interface RemoteParticipant {
  id: string;
  videoFrame: () => VideoFrame | undefined;
  getAnalyser: () => AnalyserNode | undefined;
  close: () => void;
}
