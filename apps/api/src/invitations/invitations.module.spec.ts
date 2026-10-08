import { MODULE_METADATA } from '@nestjs/common/constants';
import { SessionStateService } from '../session/session-state.service';
import { InvitationsModule } from './invitations.module';
import { INVITED_SESSION_PORT, type InvitedSessionPort } from './invited-session.port';

describe('FR-303: the INVITED session port is bound to SessionStateService', () => {
  it('FR-303: INVITED_SESSION_PORT is provided with useExisting SessionStateService', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InvitationsModule) as {
      provide?: unknown;
      useExisting?: unknown;
    }[];
    const bound = providers.find((p) => p.provide === INVITED_SESSION_PORT);
    expect(bound?.useExisting).toBe(SessionStateService);
  });

  it('FR-303: SessionStateService.createInvited satisfies the port (compile-time check)', () => {
    const check = (s: SessionStateService): InvitedSessionPort => s;
    expect(typeof check).toBe('function');
  });
});
