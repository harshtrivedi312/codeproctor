import { PROCTOR_DETECTORS } from '@codeproctor/shared';
import { z } from 'zod';
import type { Schemas } from '@/lib/api/client';
import { MAX_NAME, MAX_EXTERNAL_REF, isEmail } from './csv';

/*
 * The invite form's rules (FR-303, FR-305, ADR 0015). Web-local and PROVISIONAL [BE-06b, ARC-02]:
 * the API has no invitations module yet. Limits that the docs do not give (extra time up to 200%,
 * 10 assistive tools, 1000 characters of notes) are the web's proposal.
 */

export const WAIVER_REASONS = [
  'REFUSED_BIOMETRIC_PROCESSING',
  'CANNOT_COMPLETE_ID_CHECK',
  'OTHER',
] as const;
export type WaiverReason = (typeof WAIVER_REASONS)[number];

export const WAIVER_REASON_LABEL: Record<WaiverReason, string> = {
  REFUSED_BIOMETRIC_PROCESSING: 'The candidate refuses biometric processing (face matching)',
  CANNOT_COMPLETE_ID_CHECK: 'The candidate cannot complete the ID check',
  OTHER: 'Another reason',
};

/** Detectors a recruiter may switch off for one candidate. SIDE_CAMERA stays: a STRICT test needs it. */
export const ACCOMMODATION_DETECTORS = PROCTOR_DETECTORS.filter((d) => d !== 'SIDE_CAMERA');
export type AccommodationDetector = (typeof ACCOMMODATION_DETECTORS)[number];

export const DETECTOR_LABEL: Record<AccommodationDetector, string> = {
  FACE: 'Face detection (no face, several faces; also stops the face re-check during the test)',
  GAZE: 'Gaze and head direction',
  OBJECT: 'Objects (phone, book)',
  VOICE: 'Speech detection',
  MULTI_MONITOR: 'Several screens',
  DEVTOOLS: 'Developer tools',
  VIRTUAL_CAMERA: 'Virtual camera',
  EXTENSION: 'Browser extensions',
};

export const MAX_EXTRA_TIME_PCT = 200;
export const MAX_TOOLS = 10;
export const MAX_TOOL = 80;
export const MAX_NOTES = 1000;
export const MAX_WAIVER_NOTE = 500;

export interface InviteFormValues {
  testId: string;
  mode: 'one' | 'many';
  name: string;
  email: string;
  /** datetime-local strings (the browser's local time). */
  windowStart: string;
  windowEnd: string;
  extraTime: string;
  disabledDetectors: AccommodationDetector[];
  toolsText: string;
  notes: string;
  waiver: boolean;
  waiverReason: '' | WaiverReason;
  waiverNote: string;
}

export const parseTools = (text: string): string[] => {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
};

export const toIso = (local: string): string => new Date(local).toISOString();

/** `now` is passed in so the rules are testable. */
export function inviteSchema(now: () => Date = () => new Date(), testFixed = false) {
  return z
    .object({
      testId: z.string(),
      mode: z.enum(['one', 'many']),
      name: z.string(),
      email: z.string(),
      windowStart: z.string().min(1, 'Choose when the window opens.'),
      windowEnd: z.string().min(1, 'Choose when the window closes.'),
      extraTime: z.string(),
      disabledDetectors: z.array(
        z.enum(ACCOMMODATION_DETECTORS as [AccommodationDetector, ...AccommodationDetector[]]),
      ),
      toolsText: z.string(),
      notes: z.string().max(MAX_NOTES, `Keep the notes under ${MAX_NOTES} characters.`),
      waiver: z.boolean(),
      waiverReason: z.enum(['', ...WAIVER_REASONS]),
      waiverNote: z.string(),
    })
    .superRefine((v, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (!testFixed && v.testId === '') issue('testId', 'Choose the test.');
      if (v.mode === 'one') {
        const name = v.name.trim();
        if (name === '') issue('name', "Enter the candidate's name.");
        else if (name.length > MAX_NAME)
          issue('name', `Keep the name under ${MAX_NAME} characters.`);
        const email = v.email.trim();
        if (email === '') issue('email', "Enter the candidate's email address.");
        else if (!isEmail(email))
          issue('email', 'This is not a valid email address. Check for typos and spaces.');
      }
      const start = new Date(v.windowStart);
      const end = new Date(v.windowEnd);
      if (v.windowStart !== '' && Number.isNaN(start.getTime()))
        issue('windowStart', 'This is not a valid date and time.');
      if (v.windowEnd !== '' && Number.isNaN(end.getTime()))
        issue('windowEnd', 'This is not a valid date and time.');
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        if (end.getTime() <= start.getTime())
          issue('windowEnd', 'The window must close after it opens.');
        else if (end.getTime() <= now().getTime())
          issue('windowEnd', 'The window has already closed. Choose a later end.');
      }
      // Accommodations apply to ONE candidate; a bulk upload sends none (and never a waiver).
      if (v.mode === 'one') {
        const pct = v.extraTime.trim();
        if (pct !== '') {
          const n = Number(pct);
          if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_TIME_PCT) {
            issue('extraTime', `Use a whole number from 0 to ${MAX_EXTRA_TIME_PCT}.`);
          }
        }
        const tools = parseTools(v.toolsText);
        if (tools.length > MAX_TOOLS) issue('toolsText', `List at most ${MAX_TOOLS} tools.`);
        if (tools.some((t) => t.length > MAX_TOOL))
          issue('toolsText', `Keep each tool name under ${MAX_TOOL} characters.`);
        if (v.waiver) {
          if (v.waiverReason === '')
            issue(
              'waiverReason',
              'Choose why the identity check is waived. This is required and is recorded.',
            );
          if (v.waiverReason === 'OTHER') {
            const note = v.waiverNote.trim();
            if (note === '')
              issue(
                'waiverNote',
                'Describe the reason in a few words. Do not enter health details.',
              );
            else if (note.length > MAX_WAIVER_NOTE)
              issue('waiverNote', `Keep the reason under ${MAX_WAIVER_NOTE} characters.`);
          }
        }
      }
    });
}

/** The accommodations of a single invitation as the API would take them; null when nothing was set. */
export function toAccommodations(v: InviteFormValues): Schemas['InvitationAccommodations'] | null {
  if (v.mode !== 'one') return null;
  const pct = v.extraTime.trim();
  const tools = parseTools(v.toolsText);
  // Refusing biometric processing switches off every face-based detector (ADR 0015 section 3):
  // the form shows it, and the request says so too instead of relying on the server to add them.
  const detectors = new Set<AccommodationDetector>(v.disabledDetectors);
  if (v.waiver && v.waiverReason === 'REFUSED_BIOMETRIC_PROCESSING') {
    detectors.add('FACE');
    detectors.add('GAZE');
  }
  const out: Schemas['InvitationAccommodations'] = {
    ...(pct !== '' && Number(pct) > 0 ? { extraTimePct: Number(pct) } : {}),
    ...(detectors.size > 0
      ? { disabledDetectors: ACCOMMODATION_DETECTORS.filter((d) => detectors.has(d)) }
      : {}),
    ...(tools.length > 0 ? { allowedAssistiveTools: tools } : {}),
    ...(v.notes.trim() !== '' ? { notes: v.notes.trim() } : {}),
    ...(v.waiver && v.waiverReason !== ''
      ? {
          identityCheckWaiver: {
            reasonCode: v.waiverReason,
            ...(v.waiverReason === 'OTHER' ? { reasonNote: v.waiverNote.trim() } : {}),
          },
        }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

export { MAX_EXTERNAL_REF };
