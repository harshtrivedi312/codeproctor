'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { downloadTextFile, formatRecoveryCode, recoveryCodesFileText } from './recovery-codes';

/** The one-time recovery code list with a download button. Shared by forced enrollment and the Security page. */
export function RecoveryCodesPanel({
  email,
  codes,
}: {
  email: string;
  codes: readonly string[];
}): React.JSX.Element {
  const [downloaded, setDownloaded] = React.useState(false);
  return (
    <>
      <ul
        aria-label="Recovery codes"
        data-testid="recovery-codes"
        className="grid grid-cols-1 gap-2 rounded bg-muted p-3 font-mono text-sm sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>{formatRecoveryCode(code)}</li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          downloadTextFile('codeproctor-recovery-codes.txt', recoveryCodesFileText(email, codes));
          setDownloaded(true);
        }}
      >
        Download recovery codes
      </Button>
      {downloaded ? (
        <p role="status" className="text-sm text-muted-foreground">
          Downloaded. Move the file somewhere private, such as a password manager.
        </p>
      ) : null}
    </>
  );
}
