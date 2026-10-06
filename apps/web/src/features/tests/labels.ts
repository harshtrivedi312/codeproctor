import type { Schemas } from '@/lib/api/client';

export const PROFILE_LABEL: Record<Schemas['TestProfile'], string> = {
  STANDARD: 'Standard',
  STRICT: 'Strict',
};

/** What each proctoring profile records, in plain words (FR-302). LOCKDOWN is not offered in this build. */
export const PROFILE_EXPLANATION: Record<
  Schemas['TestProfile'],
  { summary: string; records: string }
> = {
  STANDARD: {
    summary: 'The candidate works in the browser on their own computer.',
    records:
      "Records the candidate's screen, webcam and microphone, their typing in the code editor, and browser events such as leaving full screen, switching tabs or pasting. A person reviews every session.",
  },
  STRICT: {
    summary: 'Everything in Standard, plus a second camera.',
    records:
      'Records everything Standard records, and also a second camera: the candidate connects their phone as a side view of their desk and room before the test starts. Candidates need a phone and a few more minutes to set up, so use it when the desk and surroundings matter.',
  },
};

export const SECTION_RULES =
  'Sections run in the order shown. A candidate cannot go back to a finished section, and when a section time limit ends the section closes. The section limits together may not be more than the total duration.';
