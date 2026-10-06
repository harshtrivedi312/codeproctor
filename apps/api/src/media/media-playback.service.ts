// Staff playback (FR-703, ADR 0013 section 5.7): a playlist of signed GET URLs valid 15 minutes,
// grouped by stream and segment in seq order. The route GET /review/sessions/:id/media belongs to
// BE-13's review module; it calls `playlist` from inside the staff org scope, so a session of
// another org is simply not found (404) and no URL is ever signed for it.
//
// Every URL forces the response type and `attachment` (storage-keys and StorageService), and the
// keys come only from media_chunks rows of this session, never from the caller.
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { MediaStream } from '../generated/prisma/enums.js';
import { contentTypeFor } from './media.constants';
import { GET_URL_TTL_SECONDS, StorageService } from './storage.service';

export interface PlaylistChunk {
  readonly seq: number;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly url: string;
}

export interface PlaylistSegment {
  readonly segment: number;
  readonly chunks: PlaylistChunk[];
}

export interface PlaylistStream {
  readonly stream: MediaStream;
  readonly segments: PlaylistSegment[];
}

export interface MediaPlaylist {
  readonly expiresAt: Date;
  readonly streams: PlaylistStream[];
}

const SIGN_CONCURRENCY = 20;

@Injectable()
export class MediaPlaybackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Call inside the caller's org scope. Throws 404 for a session outside it. */
  async playlist(sessionId: string, now: Date = new Date()): Promise<MediaPlaylist> {
    const session = await this.prisma.client.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (session === null) throw new NotFoundException();

    const rows = await this.prisma.client.mediaChunk.findMany({
      where: {
        sessionId,
        uploadedAt: { not: null },
        deletedAt: null,
        objectKey: { not: null },
      },
      orderBy: [{ stream: 'asc' }, { segment: 'asc' }, { seq: 'asc' }],
      select: {
        stream: true,
        segment: true,
        seq: true,
        objectKey: true,
        startedAt: true,
        durationMs: true,
        sizeBytes: true,
      },
    });

    // Sign with bounded concurrency (a 90-minute session has about 1,600 chunks per stream).
    const keyed = rows.filter((r): r is typeof r & { objectKey: string } => r.objectKey !== null);
    const urls: string[] = new Array<string>(keyed.length);
    for (let i = 0; i < keyed.length; i += SIGN_CONCURRENCY) {
      await Promise.all(
        keyed.slice(i, i + SIGN_CONCURRENCY).map(async (row, n) => {
          const signed = await this.storage.presignGet({
            key: row.objectKey,
            contentType: contentTypeFor(row.stream),
            now,
          });
          urls[i + n] = signed.url;
        }),
      );
    }

    // Rows are already in (stream, segment, seq) order; Maps keep that insertion order.
    const grouped = new Map<MediaStream, Map<number, PlaylistChunk[]>>();
    keyed.forEach((row, i) => {
      const segments = grouped.get(row.stream) ?? new Map<number, PlaylistChunk[]>();
      grouped.set(row.stream, segments);
      const chunks = segments.get(row.segment) ?? [];
      segments.set(row.segment, chunks);
      chunks.push({
        seq: row.seq,
        startedAt: row.startedAt,
        durationMs: row.durationMs,
        sizeBytes: Number(row.sizeBytes ?? 0n),
        url: urls[i] as string,
      });
    });
    const streams: PlaylistStream[] = [...grouped].map(([stream, segments]) => ({
      stream,
      segments: [...segments].map(([segment, chunks]) => ({ segment, chunks })),
    }));
    return { expiresAt: new Date(now.getTime() + GET_URL_TTL_SECONDS * 1000), streams };
  }
}
