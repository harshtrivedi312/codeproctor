import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Retention schedule', robots: { index: false } };

/**
 * C-05: the candidate portal links to the written retention and destruction schedule. The text in
 * docs/compliance/retention-schedule.md is a draft until the owner approves it, so it is not shown
 * as policy here. Once approved, publish it (or set NEXT_PUBLIC_RETENTION_SCHEDULE_URL).
 */
export default function RetentionSchedulePage() {
  return (
    <main id="main" className="mx-auto max-w-2xl space-y-4 px-4 py-16">
      <h1 className="text-2xl font-semibold">Retention and destruction schedule</h1>
      <p>
        The schedule that says what we keep from your test, for how long, and how we destroy it has
        not been published yet.
      </p>
      <p>
        You can still ask. Contact your recruiter, or the privacy contact named in your consent
        document, and we will tell you in writing.
      </p>
    </main>
  );
}
