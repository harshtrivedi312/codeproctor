import { USER_ROLES } from '@codeproctor/shared';
import { describe, expect, it } from 'vitest';
import { navItemsFor, NAV_ITEMS } from './nav-config';
import { can, rolesWith } from './permissions';

const labels = (role: (typeof USER_ROLES)[number]) => navItemsFor(role).map((i) => i.label);

describe('role-based navigation (FR-103, TC-004 UI side)', () => {
  it('FR-103: the sidebar lists the eight sections in order for a role that may see all of them', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard',
      'Questions',
      'Tests',
      'Candidates',
      'Review queue',
      'Live',
      'Reports',
      'Settings',
    ]);
  });

  it('FR-103: SUPER_ADMIN sees every section', () => {
    expect(labels('SUPER_ADMIN')).toHaveLength(8);
  });

  it('FR-103 TC-004: RECRUITER sees tests and candidates but not settings, review or live', () => {
    expect(labels('RECRUITER')).toEqual([
      'Dashboard',
      'Questions',
      'Tests',
      'Candidates',
      'Reports',
    ]);
  });

  it('FR-103: AUTHOR sees only the dashboard and questions', () => {
    expect(labels('AUTHOR')).toEqual(['Dashboard', 'Questions']);
  });

  it('FR-103: REVIEWER sees the review queue, live and reports but not settings or questions', () => {
    expect(labels('REVIEWER')).toEqual(['Dashboard', 'Review queue', 'Live', 'Reports']);
  });

  it('FR-103: nothing is allowed without a role (deny by default)', () => {
    expect(navItemsFor(null).map((i) => i.label)).toEqual(['Dashboard']);
    expect(can(null, 'question:read')).toBe(false);
  });

  it('FR-103: only SUPER_ADMIN may manage users, settings and candidate erasure', () => {
    expect(rolesWith('user:manage')).toEqual(['SUPER_ADMIN']);
    expect(rolesWith('org_settings:manage')).toEqual(['SUPER_ADMIN']);
    expect(rolesWith('candidate:erase')).toEqual(['SUPER_ADMIN']);
  });
});
