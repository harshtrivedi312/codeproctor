import type { Schemas } from '@/lib/api/client';

/*
 * What the invitation API answered about the email (FR-303), and what a 422 means. Pure words, no
 * React. A mail outcome other than "queued" means NO email left: the invitation exists, a new invite
 * for the same candidate and test is a 409 until the window ends, and there is no resend route yet.
 */

export type MailOutcome = Schemas['MailOutcome'];

/** The reason, in plain words, for an outcome that is not "queued". Unknown values read as not sent. */
export function mailReason(mail: string): string {
  if (mail === 'disabled') {
    return 'No email service is set up for this environment, so no email was sent.';
  }
  if (mail === 'failed') {
    return 'The email could not be queued for delivery, so no email was sent.';
  }
  return 'The email was not queued for delivery, so no email was sent.';
}

export const MAIL_NOT_SENT_TITLE = 'Invitation created, but the email could not be sent';

/** What the recruiter can do. The invitation exists; there is no resend route in the product yet. */
export function mailNextStep(windowEnd?: string): string {
  const until = windowEnd
    ? ` until ${new Date(windowEnd).toLocaleString()}`
    : ' until its window ends';
  return `The invitation exists and is active${until}, but the candidate has not been told. Inviting the same person to this test again is refused while it is active, and there is no resend option yet. Ask an administrator to check the email setup and how to get this candidate their link. Do not tell the candidate to expect an email.`;
}

/** Single invite: the success line for a queued email. "Queued" is not proof of delivery. */
export const MAIL_QUEUED_MESSAGE =
  'Invitation created. The email is queued for delivery; a queued email is not proof that it arrived.';

/** The API's words for a problem: the errors[] when there are some (the detail is then a generic
 * "Request validation failed"), else the detail. */
export function problemWords(message: string, errors: readonly string[]): string {
  return errors.length > 0 ? errors.join(' ') : message;
}

/**
 * A 409 on invitation creation. The API sends two different 409s with no code: "already has an
 * active invitation for this test" and "cannot be invited" (an erasure request). Show its words.
 */
export function conflictText(message: string): string {
  if (message) return `${message} Nothing was created.`;
  return 'The server says this candidate cannot be invited to this test right now. Nothing was created. Check the candidates list, or ask an administrator.';
}

/**
 * A 422 on invitation creation. The real API answers 422 when the test cannot be given right now
 * (a random slot has no question left, a question was archived): `errors` names the slots. A window
 * in the past is a 400 there. `REASON_NOT_ENABLED` is the ADR 0015 code for a waiver reason that is
 * switched off. Anything else shows the API's own words, as text. The closed-window text is never
 * the fallback.
 */
export function unprocessableText(
  code: string,
  message: string,
  errors: readonly string[],
): string {
  if (code === 'REASON_NOT_ENABLED') {
    return 'This reason is not available yet in this build. Choose another reason.';
  }
  const said = [message, ...errors].filter(Boolean);
  if (errors.length > 0) {
    return `This test cannot be given to candidates yet. Nothing was created. Open the test, fix the questions listed here, and try again: ${errors.join('; ')}`;
  }
  if (said.length > 0) {
    return `The server could not create this invitation: ${said.join(' ')} Nothing was created. Check the test and the options you chose, then try again.`;
  }
  return 'The server could not create this invitation. Nothing was created. Check the test and the options you chose, then try again, or ask an administrator.';
}
