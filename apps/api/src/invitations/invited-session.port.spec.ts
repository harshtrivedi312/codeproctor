import { ServiceUnavailableException } from '@nestjs/common';
import { FailClosedInvitedSessionPort } from './invited-session.port';

describe('FR-303: the default INVITED session port fails closed', () => {
  it('FR-303: createInvited answers 503 with a fixed detail so the invitation rolls back', async () => {
    const port = new FailClosedInvitedSessionPort();
    const err: unknown = await port.createInvited().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as Error).message).toBe('Invitations are not available yet. Try again later.');
  });
});
