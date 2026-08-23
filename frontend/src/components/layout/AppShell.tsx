import { memo, useMemo, type ReactNode } from "react";
import { Header } from "./Header.tsx";
import { Sidebar, type SidebarItem } from "./Sidebar.tsx";
import { MobileNav } from "./MobileNav.tsx";

interface AppShellProps {
  title: string;
  subtitle?: string;
  logo?: ReactNode;
  sidebarItems: SidebarItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  headerActions?: ReactNode;
  modeToggle?: ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}

function AppShellBase({
  title,
  subtitle,
  logo,
  sidebarItems,
  activeTab,
  onTabChange,
  headerActions,
  modeToggle,
  sidebarFooter,
  children,
}: AppShellProps) {
  const mobileDrawerFooter = useMemo(
    () =>
      (modeToggle || headerActions) ? (
        <div className="p-3 space-y-3">
          {modeToggle && <div className="flex justify-center">{modeToggle}</div>}
          {headerActions && <div className="flex flex-wrap items-center justify-center gap-2">{headerActions}</div>}
        </div>
      ) : null,
    [modeToggle, headerActions]
  );

  const headerActionsNode = useMemo(
    () => (
      <>
        <div className="md:hidden">
          <MobileNav items={sidebarItems} active={activeTab} onChange={onTabChange} footer={mobileDrawerFooter} />
        </div>
        {headerActions && (
          <div className="hidden md:flex items-center gap-2">
            {headerActions}
          </div>
        )}
      </>
    ),
    [sidebarItems, activeTab, onTabChange, headerActions, mobileDrawerFooter]
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header logo={logo} title={title} subtitle={subtitle} modeToggle={<div className="hidden md:block">{modeToggle}</div>} actions={headerActionsNode} />

      <div className="flex">
        <Sidebar
          items={sidebarItems}
          active={activeTab}
          onChange={onTabChange}
          footer={sidebarFooter}
        />

        <main className="flex-1 min-w-0 p-3 sm:p-4 md:p-6 md:pl-72 max-w-7xl mx-auto w-full">
          {children}
        </main>
      </div>
    </div>
  );
}

export const AppShell = memo(AppShellBase);
