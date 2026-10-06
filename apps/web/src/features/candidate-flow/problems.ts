import type { Terminal } from './terminal-screens';

/** Maps a 409 problem `code` from the OTP routes to an end screen (BE-07 codes). */
export function terminalForConflict(code: string | null, windowStart?: string): Terminal {
  switch (code) {
    case 'LINK_ALREADY_USED':
      return { reason: 'ALREADY_USED' };
    case 'LINK_EXPIRED':
      return { reason: 'EXPIRED' };
    case 'LINK_DECLINED':
      return { reason: 'DECLINED' };
    case 'WINDOW_NOT_OPEN':
      return { reason: 'NOT_YET_OPEN', windowStart };
    default:
      return { reason: 'UNAVAILABLE' };
  }
}
