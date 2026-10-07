import { UnauthorizedException } from '@nestjs/common';

/**
 * The refresh rotation's commit may or may not have landed (FR-104, TC-005, api-contract section 8,
 * Refresh bullet). The body is exactly the ordinary failed-refresh 401, so a client cannot tell it
 * apart; only the controller does, to clear the refresh cookie. It is thrown for nothing else.
 */
export class RefreshOutcomeUnknownException extends UnauthorizedException {
  constructor() {
    super('Authentication required.');
  }
}
