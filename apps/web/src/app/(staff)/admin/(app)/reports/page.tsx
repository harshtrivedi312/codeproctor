import { RequireRole } from '@/features/auth/require-role';
import { SectionPlaceholder } from '@/features/admin/page-header';
import { rolesWith } from '@/features/staff/permissions';

export const metadata = { title: 'Reports' };

export default function Page() {
  return (
    <RequireRole roles={rolesWith('report:read')}>
      <SectionPlaceholder title="Reports" step="Step 14">
        Reports and exports arrive here.
      </SectionPlaceholder>
    </RequireRole>
  );
}
