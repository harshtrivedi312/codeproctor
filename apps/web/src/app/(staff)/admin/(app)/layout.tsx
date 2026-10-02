import { ThemeToggle } from '@/components/theme-toggle';

// Staff shell placeholder. Sidebar, role-based navigation and auth arrive in FE-02 and FE-03.
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b bg-card px-4 py-2">
        <span className="font-semibold">CodeProctor staff</span>
        <ThemeToggle />
      </header>
      <main id="main" className="p-4">
        {children}
      </main>
    </div>
  );
}
