import { RequireRole } from '@/features/auth/require-role';
import { SectionPlaceholder } from '@/features/admin/page-header';
import { rolesWith } from '@/features/staff/permissions';

export const metadata = { title: 'Live' };

export default function Page() {
  return (
    <RequireRole roles={rolesWith('live:view')}>
      <SectionPlaceholder title="Live" step="Step 12">
        The live grid of active sessions arrives here.
      </SectionPlaceholder>
    </RequireRole>
  );
}
