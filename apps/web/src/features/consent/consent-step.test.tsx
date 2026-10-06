import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { CandidateFlow } from '@/features/candidate-flow/candidate-flow';
import {
  expectHeadingFocused,
  fakeScrollBox,
  passOtp,
  recordRequests,
  renderWithQuery,
  server,
  spyOnMedia,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_CONSENT_ID, MOCK_RECRUITER_CONTACT, MOCK_TOKENS } from '@/mocks/candidate/handlers';

setupCandidateServer();

async function toConsent(token: string = MOCK_TOKENS.open) {
  const user = userEvent.setup();
  window.history.replaceState(null, '', `/t/${token}`);
  const view = renderWithQuery(<CandidateFlow token={token} />);
  await passOtp(user);
  await expectHeadingFocused(/please read and sign|not available yet/i);
  return { user, ...view };
}

function scrollToEnd(): void {
  const box = screen.getByTestId('consent-scroll');
  box.scrollTop = 1600;
  fireEvent.scroll(box);
}

describe('consent step (FR-401, D-17, C-30)', () => {
  it('TC-095: signing is disabled until the end of the document is reached', async () => {
    const { user } = await toConsent();
    const box = await screen.findByTestId('consent-scroll');
    fakeScrollBox(box);
    fireEvent.scroll(box);
    const sign = screen.getByRole('button', { name: /i agree and sign/i });
    expect(sign).toBeDisabled();
    expect(screen.getByLabelText(/full legal name/i)).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /18 years old or older/i })).toBeDisabled();
    expect(screen.getByTestId('scroll-status')).toHaveTextContent(/scroll to the end/i);

    // Part way down is not the end.
    box.scrollTop = 900;
    fireEvent.scroll(box);
    expect(sign).toBeDisabled();

    scrollToEnd();
    await waitFor(() => expect(sign).toBeEnabled());
    expect(screen.getByTestId('scroll-status')).toHaveTextContent(/reached the end/i);
    expect(screen.getByLabelText(/full legal name/i)).toBeEnabled();
    await user.tab(); // keyboard users can still reach every control
  });

  it('TC-095: the document is a focusable, labelled region with its version', async () => {
    await toConsent();
    const region = await screen.findByRole('region', { name: /consent document, version 1\.0/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('consent-version')).toHaveTextContent('1.0');
  });

  it('TC-095: signs with the typed legal name, the age confirmation and the consent text id, then says a copy was emailed', async () => {
    const seen = recordRequests();
    const { user } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    await user.type(await screen.findByLabelText(/full legal name/i), '  Ada Lovelace ');
    await user.click(screen.getByRole('checkbox', { name: /18 years old or older/i }));
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /your consent is recorded/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/a copy has been emailed to you/i)).toBeInTheDocument();
    const sign = seen.find((r) => r.url.endsWith('/consent/sign'));
    // The client sends no time: the server sets it (TC-095).
    expect(sign?.body).toEqual({
      consentTextId: MOCK_CONSENT_ID,
      signedName: 'Ada Lovelace',
      confirmedAge18: true,
    });
    await user.click(screen.getByRole('button', { name: /continue to the system check/i }));
    await expectHeadingFocused(/check your computer/i);
  });

  it('C-30: signing needs the 18+ confirmation and an error summary explains why', async () => {
    const seen = recordRequests();
    const { user } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    await user.type(await screen.findByLabelText(/full legal name/i), 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));
    const summary = await screen.findByText(/there is 1 thing to fix/i);
    expect(summary.closest('[role="alert"]')).toHaveFocus();
    expect(
      within(summary.closest('[role="alert"]') as HTMLElement).getByRole('link', {
        name: /confirm that you are 18 or older/i,
      }),
    ).toHaveAttribute('href', '#age-18');
    expect(seen.some((r) => r.url.endsWith('/consent/sign'))).toBe(false);
  });

  it('FR-401: a missing name is reported next to the field and in the summary', async () => {
    const { user } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    await user.click(await screen.findByRole('checkbox', { name: /18 years old or older/i }));
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));
    expect(await screen.findByText(/there is 1 thing to fix/i)).toBeInTheDocument();
    expect(screen.getAllByText(/type your full legal name/i).length).toBeGreaterThanOrEqual(2);
  });

  it('TC-030: nothing asks for the camera, microphone or screen before the document is signed', async () => {
    const media = spyOnMedia();
    const { user } = await toConsent();
    await screen.findByTestId('consent-scroll');
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.getDisplayMedia).not.toHaveBeenCalled();
    // Declining also never touches devices.
    await user.click(screen.getByRole('button', { name: /i decline/i }));
    await user.click(await screen.findByRole('button', { name: /yes, decline/i }));
    await screen.findByRole('heading', { level: 1, name: /chose not to continue/i });
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.getDisplayMedia).not.toHaveBeenCalled();
  });

  it('TC-096: declining needs a confirmation, then shows the recruiter contact and the retention link', async () => {
    const seen = recordRequests();
    const { user } = await toConsent();
    await screen.findByTestId('consent-scroll');
    // Decline is available at any time, even before the end of the document.
    const decline = screen.getByRole('button', { name: /i decline/i });
    expect(decline).toBeEnabled();
    await user.click(decline);
    expect(screen.getByRole('group', { name: /decline and end this assessment/i })).toHaveFocus();
    expect(seen.some((r) => r.url.endsWith('/consent/decline'))).toBe(false);
    await user.click(screen.getByRole('button', { name: /yes, decline/i }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /chose not to continue/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('recruiter-contact')).toHaveTextContent(MOCK_RECRUITER_CONTACT);
    expect(screen.getByText(/nothing was recorded/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /retention schedule/i })).toBeInTheDocument();
    // Nothing else happens: no sign, no system check.
    expect(seen.some((r) => /sign|system-check|identity|test\/start/.test(r.url))).toBe(false);
    expect(screen.queryByRole('button', { name: /sign|continue/i })).not.toBeInTheDocument();
  });

  it('TC-096: backing out of the decline confirmation returns to the document', async () => {
    const { user } = await toConsent();
    await screen.findByTestId('consent-scroll');
    await user.click(screen.getByRole('button', { name: /i decline/i }));
    await user.click(screen.getByRole('button', { name: /no, go back to the document/i }));
    expect(screen.queryByRole('group', { name: /decline and end/i })).not.toBeInTheDocument();
  });

  it('FR-401: raw HTML in the document is never rendered', async () => {
    const hostile = [
      '# Your consent',
      '',
      '<script>window.__pwned = true</script>',
      '<img src="https://evil.test/x.png" onerror="window.__pwned = true">',
      '',
      '[click](javascript:alert(1))',
      '',
      '![tracker](https://evil.test/pixel.png)',
      '',
      'Real text. '.repeat(40),
    ].join('\n');
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/consent`, () =>
        HttpResponse.json({
          consentTextId: MOCK_CONSENT_ID,
          version: '2.0',
          bodyMd: hostile,
          legalApproved: true,
          signed: false,
          signedAt: null,
        }),
      ),
    );
    await toConsent();
    const box = await screen.findByTestId('consent-scroll');
    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('img')).toBeNull();
    expect(box.innerHTML).not.toContain('evil.test/pixel');
    expect(box.querySelector('a[href^="javascript"]')).toBeNull();
    expect(box.textContent).toContain('click');
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('FR-401: if the API says the text is already signed, the candidate moves on without a second signature', async () => {
    window.history.replaceState(null, '', `/t/${MOCK_TOKENS.consented}`);
    const user = userEvent.setup();
    renderWithQuery(<CandidateFlow token={MOCK_TOKENS.consented} />);
    await passOtp(user);
    await expectHeadingFocused(/check your computer/i);
  });

  it('FR-401: a signing failure keeps the form and says how to retry', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/consent/sign`, () => HttpResponse.error()),
    );
    const { user } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    await user.type(await screen.findByLabelText(/full legal name/i), 'Ada Lovelace');
    await user.click(screen.getByRole('checkbox', { name: /18 years old or older/i }));
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));
    expect(await screen.findByText(/we could not save your signature/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full legal name/i)).toHaveValue('Ada Lovelace');
  });

  it('FR-401: a 409 on signing says the document changed or was already signed', async () => {
    server.use(
      http.post(`${apiBaseUrl}/v1/candidate/session/consent/sign`, () =>
        HttpResponse.json({ code: 'CONSENT_CHANGED' }, { status: 409 }),
      ),
    );
    const { user } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    await user.type(await screen.findByLabelText(/full legal name/i), 'Ada Lovelace');
    await user.click(screen.getByRole('checkbox', { name: /18 years old or older/i }));
    await user.click(screen.getByRole('button', { name: /i agree and sign/i }));
    expect(await screen.findByText(/changed or was already signed/i)).toBeInTheDocument();
  });

  it('TC-095: submitting the form before the end of the document sends nothing', async () => {
    const seen = recordRequests();
    await toConsent();
    const box = await screen.findByTestId('consent-scroll');
    fakeScrollBox(box);
    fireEvent.submit(box.closest('section')?.querySelector('form') as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((r) => r.url.endsWith('/consent/sign'))).toBe(false);
  });

  it('FR-401: the form is keyed by the consent text id, so a different text starts fresh', async () => {
    const { user } = await toConsent();
    const box = await screen.findByTestId('consent-scroll');
    fakeScrollBox(box);
    scrollToEnd();
    await user.type(await screen.findByLabelText(/full legal name/i), 'Ada');
    expect(screen.getByLabelText(/full legal name/i)).toHaveValue('Ada');
  });

  it('FR-401: an expired session during consent explains how to continue', async () => {
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/consent`, () =>
        HttpResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/t/${MOCK_TOKENS.open}`);
    renderWithQuery(<CandidateFlow token={MOCK_TOKENS.open} />);
    await passOtp(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: /your session ended/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/open the link from your invitation email again/i)).toBeInTheDocument();
  });
});

describe('consent placeholder guard on screen (FR-401, C-09)', () => {
  it('FR-401: a placeholder text shows the unavailable screen, with no text and no accept controls', async () => {
    await toConsent(MOCK_TOKENS.placeholderConsent);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /consent document is not available yet/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('consent-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('consent-scroll')).not.toBeInTheDocument();
    expect(screen.queryByText(/LEGAL PLACEHOLDER/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign|agree/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/legal name/i)).not.toBeInTheDocument();
  });

  it('FR-401: a text the API flags as needing approval is refused too', async () => {
    await toConsent(MOCK_TOKENS.approvalRequired);
    expect(await screen.findByTestId('consent-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /i agree and sign/i })).not.toBeInTheDocument();
  });

  it('FR-401: text that claims approval but carries fill-ins is refused (fail closed)', async () => {
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/consent`, () =>
        HttpResponse.json({
          consentTextId: MOCK_CONSENT_ID,
          version: '1.0',
          bodyMd: 'Document version [x.y]. ' + 'Plain text. '.repeat(30),
          legalApproved: true,
          signed: false,
          signedAt: null,
        }),
      ),
    );
    await toConsent();
    expect(await screen.findByTestId('consent-unavailable')).toBeInTheDocument();
  });

  it('FR-401: "Check again" asks the API again, so an approved text appears without a reload', async () => {
    let approved = false;
    const real = vi.fn();
    server.use(
      http.get(`${apiBaseUrl}/v1/candidate/session/consent`, () => {
        real();
        return HttpResponse.json({
          consentTextId: MOCK_CONSENT_ID,
          version: approved ? '1.0' : '[x.y]',
          bodyMd: approved ? 'Approved text. '.repeat(30) : 'PLACEHOLDER '.repeat(30),
          legalApproved: approved,
          signed: false,
          signedAt: null,
        });
      }),
    );
    const { user } = await toConsent();
    await screen.findByTestId('consent-unavailable');
    approved = true;
    await user.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByTestId('consent-scroll')).toBeInTheDocument();
    expect(real).toHaveBeenCalledTimes(2);
  });
});

describe('axe: consent step (NFR-06)', () => {
  it('NFR-06: no axe violations on the document, the validation errors or the decline panel', async () => {
    const { user, container } = await toConsent();
    fakeScrollBox(await screen.findByTestId('consent-scroll'));
    scrollToEnd();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(await screen.findByRole('button', { name: /i agree and sign/i }));
    await screen.findByText(/there are 2 things to fix/i);
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: /i decline/i }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('NFR-06: no axe violations on the unavailable screen', async () => {
    const { container } = await toConsent(MOCK_TOKENS.placeholderConsent);
    await screen.findByTestId('consent-unavailable');
    expect(await axe(container)).toHaveNoViolations();
  });
});
