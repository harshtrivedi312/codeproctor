/**
 * In-memory holder for the phone link token (FR-405, PROVISIONAL, ARC-03 part 2). Same discipline
 * as the invitation token: memory only, never in storage, logs, analytics or a URL after it was
 * read. The phone page is reached as /t/phone/enter#<token> (the fragment never reaches the
 * server); that thin route moves the token here and replaces the route with /t/phone.
 */
export const PHONE_LINK_PATH = '/t/phone/enter';
export const PHONE_PAGE_PATH = '/t/phone';
const PHONE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

let linkToken: string | null = null;

export function capturePhoneToken(token: string): void {
  cancelClearPhoneToken();
  if (linkToken === null && PHONE_TOKEN_PATTERN.test(token)) linkToken = token;
}
export function getPhoneToken(): string | null {
  return linkToken;
}
export function clearPhoneToken(): void {
  linkToken = null;
}
export function readPhoneTokenFromHash(win: Pick<Window, 'location'> = window): string | null {
  const raw = win.location.hash.replace(/^#/, '').replace(/^token=/, '');
  return PHONE_TOKEN_PATTERN.test(raw) ? raw : null;
}
/** The link shown as a QR code. The token is in the fragment, so it is not sent to any server. */
export function phoneLinkUrl(origin: string, token: string): string {
  return `${origin}${PHONE_LINK_PATH}#${token}`;
}

let pendingClear: ReturnType<typeof setTimeout> | null = null;
/** Clears after the current tick, unless cancelled: a development double-mount must not lose it. */
export function scheduleClearPhoneToken(): void {
  pendingClear = setTimeout(() => {
    pendingClear = null;
    linkToken = null;
  }, 0);
}
export function cancelClearPhoneToken(): void {
  if (pendingClear !== null) clearTimeout(pendingClear);
  pendingClear = null;
}
