import { RequireRole } from '@/features/auth/require-role';
import { SectionPlaceholder } from '@/features/admin/page-header';
import { rolesWith } from '@/features/staff/permissions';

export const metadata = { title: 'Tests' };

export default function Page() {
  return (
    <RequireRole roles={rolesWith('test:read')}>
      <SectionPlaceholder title="Tests" step="Step 5">
        The test builder and invitations arrive here.
      </SectionPlaceholder>
    </RequireRole>
  );
}
