// Test helper for fixed-window rate limits (users invite `invite:org:<org>:<hour>`, invitations
// `invitation:org:<org>:<hour>`): the counter key contains the wall-clock window index, so a test
// that takes its slots before a window boundary and checks the limit after it sees a fresh counter
// (201 instead of 429, seen on CI at 18:00:02 UTC). Waiting until the window has `safeMs` left makes
// the whole test sit inside one window.
export async function awaitSafeWindow(windowSeconds = 3600, safeMs = 30_000): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const left = windowMs - (Date.now() % windowMs);
  if (left < safeMs) await new Promise((resolve) => setTimeout(resolve, left + 100));
}
