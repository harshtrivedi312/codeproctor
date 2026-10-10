'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  formatDateTime,
  formatDuration,
  KIND_LABEL,
  partsComplete,
  playbackParts,
  type ReviewRecording,
} from './model';
import {
  downloadParts,
  ExpiredPartError,
  PartDownloadError,
  RecordingTooLargeError,
} from './playback-download';
import { fetchPlayback, isPlaybackUnavailable } from './queries';

/* eslint-disable jsx-a11y/media-has-caption -- reviewer recordings carry no captions (follow-up) */
export function RecordingsPanel({
  sessionId,
  recordings,
}: {
  sessionId: string;
  recordings: readonly ReviewRecording[];
}): React.JSX.Element {
  return (
    <section aria-labelledby="rec-h" className="space-y-3">
      <h2 id="rec-h" className="text-lg font-semibold">
        Recordings
      </h2>
      {recordings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recordings exist for this session.</p>
      ) : (
        <ul className="space-y-3">
          {recordings.map((r) => (
            <RecordingRow key={r.id} sessionId={sessionId} recording={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

type RowState = 'idle' | 'loading' | 'unavailable' | 'error' | 'toolarge';

/**
 * One recording. On Play every part is downloaded in seq order into one Blob and played from an
 * object URL (see playback-download.ts). The signed urls and the object URL live only in this
 * component: never cached, logged, stored or put in a label. The object URL is revoked on a new
 * Play, on error and on unmount; a late download cannot set state (AbortController).
 */
function RecordingRow({
  sessionId,
  recording,
}: {
  sessionId: string;
  recording: ReviewRecording;
}): React.JSX.Element {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [state, setState] = React.useState<RowState>('idle');
  const [incomplete, setIncomplete] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const urlRef = React.useRef<string | null>(null);
  const label = `${KIND_LABEL[recording.kind]} recording`;

  const dropUrl = React.useCallback((): void => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setObjectUrl(null);
  }, []);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const play = async (): Promise<void> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    dropUrl();
    setState('loading');
    setProgress(null);
    setIncomplete(false);
    let complete = true;
    const onProgress = (done: number, total: number): void => {
      if (!ctrl.signal.aborted) setProgress({ done, total });
    };
    const fetchAndDownload = async (): Promise<Blob> => {
      const p = await fetchPlayback(sessionId, recording.id, ctrl.signal);
      const parts = playbackParts(p);
      complete = partsComplete(p);
      if (parts.length === 0) throw new PartDownloadError('empty');
      return downloadParts(parts, p.contentType, ctrl.signal, onProgress);
    };
    try {
      let blob: Blob;
      try {
        blob = await fetchAndDownload();
      } catch (e) {
        // An expired link: one automatic refresh of the playback answer per Play click.
        if (!(e instanceof ExpiredPartError)) throw e;
        blob = await fetchAndDownload();
      }
      if (ctrl.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setObjectUrl(url);
      setIncomplete(!complete);
      setState('idle');
      setProgress(null);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      dropUrl();
      setProgress(null);
      setState(
        e instanceof RecordingTooLargeError
          ? 'toolarge'
          : isPlaybackUnavailable(e)
            ? 'unavailable'
            : 'error',
      );
    }
  };

  const onMediaError = (): void => {
    dropUrl();
    setState('error');
  };

  return (
    <li className="rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">
          {formatDateTime(recording.startedAt)}, {formatDuration(recording.durationMs)}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={state === 'loading'}
          aria-label={`${objectUrl ? 'Reload' : 'Play'} ${label}`}
          onClick={() => void play()}
        >
          {state === 'loading' ? 'Loading…' : objectUrl ? 'Reload' : 'Play'}
        </Button>
      </div>
      {state === 'loading' ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Loading recording…
          {progress && progress.total > 1
            ? ` part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
            : ''}
        </p>
      ) : null}
      {objectUrl ? (
        recording.kind === 'AUDIO' ? (
          <audio
            src={objectUrl}
            controls
            autoPlay
            aria-label={label}
            onError={onMediaError}
            className="mt-2 w-full"
          />
        ) : (
          <video
            src={objectUrl}
            controls
            autoPlay
            aria-label={label}
            onError={onMediaError}
            className="mt-2 max-h-80 w-full rounded-md bg-black"
          />
        )
      ) : null}
      {objectUrl && incomplete ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Part of this recording is missing. What exists is playing.
        </p>
      ) : null}
      {state === 'unavailable' ? (
        <Alert tone="info" role="status" className="mt-2">
          Playback is not available yet. Recordings will play here once storage is connected.
        </Alert>
      ) : null}
      {state === 'toolarge' ? (
        <Alert tone="info" role="status" className="mt-2">
          This recording is too large to play in the browser (over 500 MB). Ask an administrator to
          export it.
        </Alert>
      ) : null}
      {state === 'error' ? (
        <Alert tone="error" role="alert" className="mt-2">
          We could not load this recording. Press Play to try again. If it keeps failing, the
          recording storage may not be reachable from this browser: ask your administrator to check
          the storage address and its browser access (CORS) settings.
        </Alert>
      ) : null}
    </li>
  );
}
