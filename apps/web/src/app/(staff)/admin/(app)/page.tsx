import { WelcomePanel } from '@/features/auth/welcome-panel';

export const metadata = { title: 'Staff' };

export default function AdminHome() {
  return (
    <>
      <h1 className="text-xl font-semibold">Staff dashboard</h1>
      <WelcomePanel />
    </>
  );
}
