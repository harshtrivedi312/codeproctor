'use client';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BUSY_CODE } from '@/lib/api/busy';
import { ApiFailure } from '@/features/admin/queries';
import {
  formatDateTime,
  formatDuration,
  KIND_LABEL,
  playbackParts,
  type PlaybackPart,
  type ReviewRecording,
} from './model';
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

interface Loaded {
  parts: PlaybackPart[];
  expiresAt: number;
}

/**
 * One recording. The signed url lives only in this component's state: it is fetched on Play,
 * fetched again when it has expired, and never cached, logged or put in an address.
 */
function RecordingRow({
  sessionId,
  recording,
}: {
  sessionId: string;
  recording: ReviewRecording;
}): React.JSX.Element {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [index, setIndex] = React.useState(0);
  const [state, setState] = React.useState<'idle' | 'loading' | 'unavailable' | 'error'>('idle');
  const label = `${KIND_LABEL[recording.kind]} recording`;

  const play = async (): Promise<void> => {
    setState('loading');
    try {
      const p = await fetchPlayback(sessionId, recording.id);
      const parts = playbackParts(p);
      if (parts.length === 0) throw new ApiFailure(502, '');
      setLoaded({ parts, expiresAt: Date.parse(p.expiresAt) });
      setIndex(0);
      setState('idle');
    } catch (e) {
      setLoaded(null);
      setState(
        isPlaybackUnavailable(e) && !(e instanceof ApiFailure && e.code === BUSY_CODE)
          ? 'unavailable'
          : 'error',
      );
    }
  };

  const part = loaded?.parts[index];
  const mediaProps = part
    ? {
        src: part.url,
        controls: true,
        autoPlay: true,
        'aria-label': `${label}, part ${index + 1} of ${loaded?.parts.length ?? 1}`,
        onEnded: () => setIndex((i) => (loaded && i + 1 < loaded.parts.length ? i + 1 : i)),
        // An expired link stops the media with an error: ask for a fresh one.
        onError: () => {
          if (loaded && Date.now() >= loaded.expiresAt) void play();
          else setState('error');
        },
      }
    : null;

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
          aria-label={`${loaded ? 'Reload' : 'Play'} ${label}`}
          onClick={() => void play()}
        >
          {state === 'loading' ? 'Loading…' : loaded ? 'Reload' : 'Play'}
        </Button>
      </div>
      {mediaProps ? (
        recording.kind === 'AUDIO' ? (
          <audio {...mediaProps} className="mt-2 w-full" />
        ) : (
          <video {...mediaProps} className="mt-2 max-h-80 w-full rounded-md bg-black" />
        )
      ) : null}
      {state === 'unavailable' ? (
        <Alert tone="info" role="status" className="mt-2">
          Playback is not available yet. Recordings will play here once storage is connected.
        </Alert>
      ) : null}
      {state === 'error' ? (
        <Alert tone="error" role="alert" className="mt-2">
          We could not load this recording. Press Play to try again.
        </Alert>
      ) : null}
    </li>
  );
}
