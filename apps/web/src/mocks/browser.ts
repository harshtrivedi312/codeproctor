import { setupWorker } from 'msw/browser';
import {
  resetMockFaults,
  setMockAuditFailure,
  setMockBusy,
  setMockPlain503,
} from './fault-handlers';
import { handlers } from './handlers';
import { setInvitationScenario } from './invitation-handlers';

export const worker = setupWorker(...handlers);

// Demo switches, in the browser console of a mocked build only: for example
//   __cpMockFaults.setMockBusy({ route: '/v1/admin/users', count: 2 })
// answers 503 BUSY twice (the app retries by itself), __cpMockFaults.setMockAuditFailure({ route,
// methods: ['POST'], count: 1 }) answers the fixed 500, __cpMockFaults.resetMockFaults() clears them.
declare global {
  interface Window {
    __cpMockFaults?: typeof faultSwitches;
    /** Demo and e2e: choose the mail outcome of the invitation mock, for example { mail: 'disabled' }. */
    __cpMockInvitations?: { setInvitationScenario: typeof setInvitationScenario };
  }
}
const faultSwitches = { setMockBusy, setMockAuditFailure, setMockPlain503, resetMockFaults };
if (typeof window !== 'undefined') {
  window.__cpMockFaults = faultSwitches;
  window.__cpMockInvitations = { setInvitationScenario };
}
