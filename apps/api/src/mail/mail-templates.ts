// Mail templates: pure typed functions, no templating dependency (FR-303, C-31).
// Rules: every interpolated value is HTML-escaped; every header field has CR and LF removed; the
// subject is a fixed string (never a URL, token or user text); each mail has a plain-text part;
// candidate mails carry no recruiter free text (only links, codes and dates).

import { MailError } from './mail-transport';

export interface TemplateParams {
  'password-reset': { resetUrl: string };
  'staff-invite': { inviteUrl: string };
  'staff-account-locked': { lockedEmail: string; lockedName: string; minutes: number };
  invitation: { inviteUrl: string; windowStartsAt: string; windowEndsAt: string };
  reminder: { inviteUrl: string; windowEndsAt: string };
  results: Record<string, never>;
  otp: { otp: string; minutes: number };
  'otp-lockout': {
    candidateEmail: string;
    minutes: number;
    candidateName?: string;
    testName?: string;
  };
  /** pdfKey for the queued path; the direct candidate path attaches the bytes itself. */
  'consent-copy': { pdfKey?: string; documentVersion?: string; signedAt?: string };
  'erasure-delayed': { delayedUntil: string };
  /** D-76: occurredAt is the server time (ISO UTC) right after the change committed. Nothing else. */
  'two-factor-enabled': { occurredAt: string };
  'two-factor-disabled': { occurredAt: string };
  'two-factor-reset': { occurredAt: string };
}
export type TemplateId = keyof TemplateParams;

/** What the queue holds: a template id plus the minimal params. Dates are ISO strings. */
export type EmailJob = {
  [K in TemplateId]: { template: K; to: string; params: TemplateParams[K] };
}[TemplateId];

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  /** Object key of a file to attach; the processor reads the bytes at send time. */
  attachmentKey?: string;
  attachmentFilename?: string;
}

/** Removes every CR and LF (header injection) and trims; other control characters become spaces. */
export function stripHeader(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    // C0 and C1 controls (includes U+0085), DEL, and the Unicode line and paragraph separators.
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formats an ISO instant as "YYYY-MM-DD HH:MM UTC" (server time). */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'unknown'
    : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const SIGNED_OUT = 'Every session of your account, the current one included, was signed out.';
const NOT_YOU = 'If you did not expect this, contact your administrator and change your password.';

function layout(heading: string, paragraphs: string[], link?: { url: string; label: string }) {
  const h = escapeHtml(heading);
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const a = link
    ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` +
      `<p>If the link does not work, copy this address into your browser: ${escapeHtml(link.url)}</p>`
    : '';
  const html = `<!doctype html><html><body><h1>${h}</h1>${body}${a}</body></html>`;
  const text = [
    heading,
    '',
    ...paragraphs,
    ...(link ? ['', `${link.label}: ${link.url}`] : []),
  ].join('\n');
  return { html, text };
}

function make(
  subject: string,
  heading: string,
  paragraphs: string[],
  link?: { url: string; label: string },
): RenderedMail {
  return { subject: stripHeader(subject), ...layout(heading, paragraphs, link) };
}

/** Only https links (http too when allowHttp, outside live environments); never javascript: etc. */
function assertSafeLink(raw: string, allowHttp: boolean): void {
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:' && !(allowHttp && protocol === 'http:')) {
    throw new MailError('unsafe link', 'none', true);
  }
}

export interface RenderOptions {
  /** Accept http: links. Set outside pilot and production only. */
  allowHttp?: boolean;
}

export function renderMail(job: EmailJob, opts: RenderOptions = {}): RenderedMail {
  const allowHttp = opts.allowHttp ?? false;
  if ('resetUrl' in job.params) assertSafeLink(job.params.resetUrl, allowHttp);
  if ('inviteUrl' in job.params) assertSafeLink(job.params.inviteUrl, allowHttp);
  switch (job.template) {
    case 'password-reset':
      return make(
        'Reset your CodeProctor password',
        'Reset your password',
        [
          'We received a request to reset your password. The link works once and expires in 30 minutes.',
          'If you did not ask for this, you can ignore this email.',
        ],
        { url: job.params.resetUrl, label: 'Choose a new password' },
      );
    case 'staff-invite':
      return make(
        'You are invited to CodeProctor',
        'Set up your account',
        ['You have been invited to CodeProctor. The link works once and expires in 72 hours.'],
        { url: job.params.inviteUrl, label: 'Set your password' },
      );
    case 'staff-account-locked':
      return make('A CodeProctor staff account was locked', 'Staff account locked', [
        `The account of ${stripHeader(job.params.lockedName)} (${stripHeader(job.params.lockedEmail)}) was locked for ${job.params.minutes} minutes after repeated failed sign-ins.`,
      ]);
    case 'invitation':
      return make(
        'You are invited to an assessment',
        'Your assessment invitation',
        [
          `You can start your assessment from ${when(job.params.windowStartsAt)} until ${when(job.params.windowEndsAt)}.`,
          'The link works once. Do not share it.',
        ],
        { url: job.params.inviteUrl, label: 'Open your assessment' },
      );
    case 'reminder':
      return make(
        'Reminder: your assessment closes soon',
        'Your assessment closes soon',
        [`Your assessment window ends at ${when(job.params.windowEndsAt)}.`],
        { url: job.params.inviteUrl, label: 'Open your assessment' },
      );
    case 'results':
      return make('Your assessment is complete', 'Assessment complete', [
        'Thank you for taking the assessment. The hiring team will contact you about next steps.',
      ]);
    case 'otp':
      // No recruiter-written text in a candidate mail (header rule): the test name is not included.
      return make('Your verification code', 'Your verification code', [
        'This code is for your assessment.',
        `Your code is ${job.params.otp}. It expires in ${job.params.minutes} minutes.`,
        'Never share this code with anyone.',
      ]);
    case 'otp-lockout':
      return make('A candidate link was blocked', 'Candidate link blocked', [
        `Too many wrong codes were entered for ${
          job.params.candidateName ? `${stripHeader(job.params.candidateName)} (` : ''
        }${stripHeader(job.params.candidateEmail)}${job.params.candidateName ? ')' : ''}${
          job.params.testName ? ` on the assessment "${stripHeader(job.params.testName)}"` : ''
        }. The link is blocked for ${job.params.minutes} minutes.`,
      ]);
    case 'consent-copy':
      return {
        ...make('Your signed consent copy', 'Your signed consent', [
          'A copy of the consent you signed is attached to this email.',
          ...(job.params.documentVersion
            ? [
                `Document version ${stripHeader(job.params.documentVersion)}${
                  job.params.signedAt ? `, signed ${when(job.params.signedAt)}` : ''
                }.`,
              ]
            : []),
        ]),
        attachmentKey: job.params.pdfKey,
        attachmentFilename: 'consent.pdf',
      };
    case 'erasure-delayed':
      return make('Your erasure request is delayed', 'Erasure request delayed', [
        `We cannot complete your erasure request yet. It will be completed by ${when(job.params.delayedUntil)}.`,
      ]);
    // D-76: fixed text only. No name, address, code, key, recovery code or link.
    case 'two-factor-enabled':
      return make(
        'Two-factor sign-in was turned on for your account',
        'Two-factor sign-in turned on',
        [
          `Two-factor sign-in was turned on for your CodeProctor account at ${when(job.params.occurredAt)}.`,
          NOT_YOU,
        ],
      );
    case 'two-factor-disabled':
      return make(
        'Two-factor sign-in was turned off for your account',
        'Two-factor sign-in turned off',
        [
          `Two-factor sign-in was turned off for your CodeProctor account at ${when(job.params.occurredAt)}.`,
          SIGNED_OUT,
          NOT_YOU,
        ],
      );
    case 'two-factor-reset':
      return make('Two-factor sign-in was reset on your account', 'Two-factor sign-in reset', [
        `An administrator reset two-factor sign-in on your CodeProctor account at ${when(job.params.occurredAt)}. It is now off.`,
        SIGNED_OUT,
        NOT_YOU,
      ]);
  }
}
