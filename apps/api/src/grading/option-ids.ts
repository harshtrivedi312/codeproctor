// MCQ option ids as the candidate sees them (ADR 0013 section 5.10 CS-4.6): opaque PER SESSION,
// `opt_` plus the first 10 base32 characters of HMAC-SHA256(QUESTION_OPTION_ID_SECRET,
// sessionId + ":" + optionId). Two candidates therefore never see the same id for the same option,
// so ids cannot be shared between colluding candidates, and an author id such as `correct` never
// reaches a browser. Nothing is stored: the render, the draft check and grade-session all
// recompute the mapping, and a reverse lookup is a recomputation over the session's options.
// The 50-bit ids are collision-checked per question when the options are mapped.
import { createHmac } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodedHttpException } from '../common/coded.exception';
import type { Env } from '../config/env';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_CHARS = 10;

/** RFC 4648 base32 (lower case, no padding) of the first `chars` characters. */
function base32(bytes: Buffer, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/** The candidate-facing id of one option. Pure: the secret is passed in. */
export function deriveOptionId(secret: string, sessionId: string, optionId: string): string {
  const mac = createHmac('sha256', secret).update(`${sessionId}:${optionId}`).digest();
  return `opt_${base32(mac, ID_CHARS)}`;
}

@Injectable()
export class OptionIdService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private secret(): string {
    const secret = this.config.get('QUESTION_OPTION_ID_SECRET', { infer: true });
    if (secret === undefined) {
      // Same answer as the other unconfigured candidate secrets; pilot and production refuse to boot
      // without it (env.ts).
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'The candidate portal is not configured.',
        'CANDIDATE_PORTAL_UNCONFIGURED',
      );
    }
    return secret;
  }

  /** The candidate id of one option of this session. */
  of(sessionId: string, optionId: string): string {
    return deriveOptionId(this.secret(), sessionId, optionId);
  }

  /** author id -> candidate id for every option of a question; a collision fails closed. */
  mapAll(sessionId: string, optionIds: readonly string[]): ReadonlyMap<string, string> {
    const secret = this.secret();
    const map = new Map(optionIds.map((id) => [id, deriveOptionId(secret, sessionId, id)]));
    if (new Set(map.values()).size !== map.size) {
      throw new Error('MCQ option id collision');
    }
    return map;
  }
}
