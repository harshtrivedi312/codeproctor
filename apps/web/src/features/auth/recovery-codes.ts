/** Recovery codes are shown as XXXX-XXXX-XXXX-XXXX (ADR 0003 section 1: 16 base32 characters). */
export function formatRecoveryCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export function recoveryCodesFileText(email: string, codes: readonly string[]): string {
  return [
    'CodeProctor recovery codes',
    `Account: ${email}`,
    '',
    'Each code works once, in place of the 6-digit authenticator code.',
    'Keep this file somewhere private, such as a password manager. Anyone with a code can sign in',
    'if they also know your password.',
    '',
    ...codes.map(formatRecoveryCode),
    '',
  ].join('\n');
}

/** Saves text as a file through a short-lived blob URL. Nothing is stored by the page. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
