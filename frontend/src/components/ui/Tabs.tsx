import { type ReactNode } from "react";

export interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 p-1 bg-surface border border-theme/30 rounded-xl">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
            active === tab.id
              ? "bg-gold text-white shadow-sm shadow-gold/10"
              : "text-muted-foreground hover:text-foreground hover:bg-theme/30"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
