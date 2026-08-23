import { useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import type { SidebarItem } from "./Sidebar.tsx";
import { Button } from "../ui/Button.tsx";

interface MobileNavProps {
  items: SidebarItem[];
  active: string;
  onChange: (id: string) => void;
  footer?: ReactNode;
}

export function MobileNav({ items, active, onChange, footer }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="md:hidden">
      <Button variant="secondary" size="icon" onClick={() => setOpen(true)} aria-label="Open menu" className="h-10 w-10">
        <Menu className="w-5 h-5" />
      </Button>

      <div
        className={`fixed inset-0 z-50 transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden={!open}
      >
        <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
        <div
          className={`absolute left-0 top-0 h-full w-72 max-w-[80vw] bg-background border-r border-theme/30 flex flex-col shadow-2xl transition-transform duration-300 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between px-4 h-16 border-b border-theme/30">
            <span className="text-[15px] font-semibold txt-head">Menu</span>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu" className="h-10 w-10">
              <X className="w-5 h-5" />
            </Button>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto py-2 px-3">
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
                    onClick={() => handleSelect(item.id)}
                    className={`nav-item w-full min-h-11 text-left transition-all duration-200 ${
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
          {footer && (
            <div className="border-t border-theme/30">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
