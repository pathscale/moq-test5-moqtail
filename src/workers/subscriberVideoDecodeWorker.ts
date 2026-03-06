import type {
  WorkerInMessage,
  WorkerOutMessage,
} from "../media/subscriber/types";

const workerScope: DedicatedWorkerGlobalScope =
  self as DedicatedWorkerGlobalScope;

let decoder: VideoDecoder | undefined;
let generation = 0;

function postMessageToMain(message: WorkerOutMessage, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer ?? []);
}

function closeDecoder(): void {
  try {
    decoder?.close();
  } catch {
    // Ignore decoder close failures during worker teardown.
  }
  decoder = undefined;
}

function handleInit(message: Extract<WorkerInMessage, { type: "INIT" }>): void {
  generation = message.generation;
  closeDecoder();

  if (typeof VideoDecoder === "undefined") {
    postMessageToMain({
      type: "INIT_ERROR",
      generation,
      error: "VideoDecoder is not supported in worker context",
    });
    return;
  }

  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        if (message.generation !== generation) {
          frame.close();
          return;
        }
        postMessageToMain(
          {
            type: "DECODED",
            generation,
            timestampUs: frame.timestamp ?? 0,
            frame,
          },
          [frame],
        );
      },
      error: (error) => {
        postMessageToMain({
          type: "ERROR",
          generation,
          error: String(error),
          fatal: false,
        });
      },
    });

    decoder.configure({
      codec: message.codec,
      hardwareAcceleration: message.hardwareAcceleration ?? "prefer-software",
    });

    postMessageToMain({ type: "INIT_OK", generation });
  } catch (error) {
    closeDecoder();
    postMessageToMain({
      type: "INIT_ERROR",
      generation,
      error: String(error),
    });
  }
}

function handleDecode(message: Extract<WorkerInMessage, { type: "DECODE" }>): void {
  if (message.generation !== generation) return;
  if (!decoder) {
    postMessageToMain({
      type: "ERROR",
      generation,
      error: "Decoder not initialized",
      fatal: true,
    });
    return;
  }

  try {
    const chunk = new EncodedVideoChunk({
      type: message.isKey ? "key" : "delta",
      timestamp: message.timestampUs,
      data: new Uint8Array(message.payload),
    });
    decoder.decode(chunk);
  } catch (error) {
    postMessageToMain({
      type: "ERROR",
      generation,
      error: String(error),
      fatal: false,
    });
  }
}

function handleReset(message: Extract<WorkerInMessage, { type: "RESET" }>): void {
  if (message.generation !== generation) return;
  try {
    decoder?.reset();
  } catch (error) {
    postMessageToMain({
      type: "ERROR",
      generation,
      error: String(error),
      fatal: false,
    });
  }
}

function handleDispose(message: Extract<WorkerInMessage, { type: "DISPOSE" }>): void {
  if (message.generation !== generation) return;
  closeDecoder();
}

workerScope.onmessage = (
  event: MessageEvent<WorkerInMessage>,
): void => {
  const message = event.data;
  switch (message.type) {
    case "INIT":
      handleInit(message);
      break;
    case "DECODE":
      handleDecode(message);
      break;
    case "RESET":
      handleReset(message);
      break;
    case "DISPOSE":
      handleDispose(message);
      break;
    default:
      break;
  }
};
