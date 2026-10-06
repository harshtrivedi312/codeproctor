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

    const streams: PlaylistStream[] = [];
    for (const row of rows) {
      if (row.objectKey === null) continue;
      const signed = await this.storage.presignGet({
        key: row.objectKey,
        contentType: row.stream === 'AUDIO' ? 'audio/webm' : 'video/webm',
        now,
      });
      let stream = streams.find((s) => s.stream === row.stream);
      if (stream === undefined) {
        stream = { stream: row.stream, segments: [] };
        streams.push(stream);
      }
      let segment = stream.segments.find((s) => s.segment === row.segment);
      if (segment === undefined) {
        segment = { segment: row.segment, chunks: [] };
        stream.segments.push(segment);
      }
      segment.chunks.push({
        seq: row.seq,
        startedAt: row.startedAt,
        durationMs: row.durationMs,
        sizeBytes: Number(row.sizeBytes ?? 0n),
        url: signed.url,
      });
    }
    return { expiresAt: new Date(now.getTime() + GET_URL_TTL_SECONDS * 1000), streams };
  }
}
