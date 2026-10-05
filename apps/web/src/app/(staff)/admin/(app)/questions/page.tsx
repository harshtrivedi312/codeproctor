import { RequireRole } from '@/features/auth/require-role';
import { SectionPlaceholder } from '@/features/admin/page-header';
import { rolesWith } from '@/features/staff/permissions';

export const metadata = { title: 'Questions' };

export default function Page() {
  return (
    <RequireRole roles={rolesWith('question:read')}>
      <SectionPlaceholder title="Questions" step="Step 4">
        The question bank, editor and validation arrive here.
      </SectionPlaceholder>
    </RequireRole>
  );
}
