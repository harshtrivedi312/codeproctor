import { RequireRole } from '@/features/auth/require-role';
import { SectionPlaceholder } from '@/features/admin/page-header';
import { rolesWith } from '@/features/staff/permissions';

export const metadata = { title: 'Review queue' };

export default function Page() {
  return (
    <RequireRole roles={rolesWith('review_queue:read')}>
      <SectionPlaceholder title="Review queue" step="Step 11">
        Flagged sessions waiting for a reviewer arrive here.
      </SectionPlaceholder>
    </RequireRole>
  );
}
