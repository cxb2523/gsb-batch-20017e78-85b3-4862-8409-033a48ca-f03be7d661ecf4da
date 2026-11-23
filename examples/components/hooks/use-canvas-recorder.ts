import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * MediaRecorder state.
 * @category type
 */
export type RecordingState = "inactive" | "recording" | "paused";

/**
 * Canvas recording options.
 * @category type
 * @expand
 */
export interface CanvasRecorderOptions {
  /**
   * Preferred MIME type; falls back to the first supported type.
   * @default 'video/webm;codecs=vp9'
   */
  mimeType?: string;

  /**
   * Video bitrate, bits per second.
   * @default 5_000_000 (5 Mbps)
   */
  videoBitsPerSecond?: number;

  /** Receives the finished video; `createDownloadHandler(filename)` downloads it */
  onComplete?: (blob: Blob) => void;
}

/**
 * {@link useCanvasRecorder} controls and state.
 * @category hook
 * @expand
 */
export interface UseCanvasRecorderReturn {
  startRecording: () => void;

  /** Stops and fires `onComplete` */
  stopRecording: () => void;

  pauseRecording: () => void;

  resumeRecording: () => void;

  recordingState: RecordingState;

  /** True while recording; false while paused */
  isRecording: boolean;

  /** Last error; cleared by a successful start */
  error: Error | null;
}

const DEFAULT_MIME_TYPE = "video/webm;codecs=vp9";
const DEFAULT_BITRATE = 5_000_000;

/**
 * `onComplete` handler downloading the blob as `{filename}-{timestamp}.{webm|mp4}`.
 *
 * @category utility
 * @example
 * ```tsx
 * const { startRecording } = useCanvasRecorder(canvasRef, {
 *   onComplete: createDownloadHandler('my-recording'),
 * });
 * ```
 */
export function createDownloadHandler(filename: string): (blob: Blob) => void {
  return (blob: Blob) => {
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}-${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
}

/** First MediaRecorder-supported type, `preferred` first; throws if none */
function getSupportedMimeType(preferred?: string): string {
  const fallbacks = [
    preferred,
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ].filter(Boolean) as string[];

  for (const mimeType of fallbacks) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  throw new Error("No supported video MIME type found for MediaRecorder");
}

/**
 * Records canvas content to video via MediaRecorder.
 *
 * @category hook
 * @example
 * ```tsx
 * const canvasRef = useRef<HTMLCanvasElement>(null);
 * const {
 *   startRecording,
 *   stopRecording,
 *   isRecording,
 * } = useCanvasRecorder(canvasRef, {
 *   onComplete: createDownloadHandler('my-animation'),
 * });
 * ```
 */
export function useCanvasRecorder(
  canvasRef: RefObject<HTMLCanvasElement | null> | undefined,
  options: CanvasRecorderOptions = {},
): UseCanvasRecorderReturn {
  const {
    mimeType: preferredMimeType = DEFAULT_MIME_TYPE,
    videoBitsPerSecond = DEFAULT_BITRATE,
    onComplete,
  } = options;

  const [recordingState, setRecordingState] =
    useState<RecordingState>("inactive");
  const [error, setError] = useState<Error | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const mimeType = getSupportedMimeType(preferredMimeType);

  if (mimeType !== preferredMimeType) {
    console.warn(
      `MIME type ${preferredMimeType} not supported, using ${mimeType}`,
    );
  }

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
    };
  }, []);

  function startRecording() {
    const canvas = canvasRef?.current;
    if (!canvas) {
      setError(new Error("Canvas element not available"));
      return;
    }

    try {
      const stream = canvas.captureStream();

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond,
      });

      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onerror = (ev) => {
        setError(
          new Error(
            `MediaRecorder error: ${ev.error?.message ?? JSON.stringify(ev.error)}`,
          ),
        );
        setRecordingState("inactive");
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        onComplete?.(blob);

        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;

        setRecordingState("inactive");
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();

      setRecordingState("recording");
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Failed to start recording"),
      );
      setRecordingState("inactive");
    }
  }

  function stopRecording() {
    const mediaRecorder = mediaRecorderRef.current;

    if (!mediaRecorder || recordingState === "inactive") {
      return;
    }

    mediaRecorder.stop();
  }

  function pauseRecording() {
    if (mediaRecorderRef.current && recordingState === "recording") {
      mediaRecorderRef.current.pause();
      setRecordingState("paused");
    }
  }

  function resumeRecording() {
    if (mediaRecorderRef.current && recordingState === "paused") {
      mediaRecorderRef.current.resume();
      setRecordingState("recording");
    }
  }

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    recordingState,
    isRecording: recordingState === "recording",
    error,
  };
}
