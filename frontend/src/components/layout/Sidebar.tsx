import { memo, type ReactNode } from "react";

export interface SidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
  group?: string;
  mode?: "simple" | "advanced";
}

interface SidebarProps {
  items: SidebarItem[];
  active: string;
  onChange: (id: string) => void;
  footer?: ReactNode;
  className?: string;
}

function SidebarBase({ items, active, onChange, footer, className = "" }: SidebarProps) {
  return (
    <aside className={`hidden md:flex flex-col w-64 h-[calc(100vh-4rem)] fixed left-0 top-16 z-10 border-r border-theme/30 bg-background ${className}`}>
      <nav className="flex-1 overflow-y-auto py-2 px-3 space-y-1">
        {items.map((item, idx) => {
          const isActive = item.id === active;
          const showGroup = item.group && (idx === 0 || items[idx - 1].group !== item.group);
          return (
            <div key={item.id} className={showGroup ? "pt-2 first:pt-0" : undefined}>
              {showGroup && (
                <p className="px-3 mb-1 text-[10px] font-semibold txt-muted uppercase tracking-wider">
                  {item.group}
                </p>
              )}
              <button
                onClick={() => onChange(item.id)}
                className={`nav-item w-full text-left transition-all duration-200 ${
                  isActive ? "nav-item-active txt-head" : "txt-nav-muted hover:text-foreground"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
              </button>
            </div>
          );
        })}
      </nav>
      {footer && <div className="p-3 border-t border-theme/30">{footer}</div>}
    </aside>
  );
}

export const Sidebar = memo(SidebarBase);
