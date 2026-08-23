import { useEffect, useMemo, useState, useRef } from "react";
import { Search, Command } from "lucide-react";
import { Input } from "./Input.tsx";

export interface CommandItem {
  id: string;
  label: string;
  group?: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  items: CommandItem[];
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ items, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-card border border-theme rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-theme/30">
          <Search className="w-4 h-4 txt-muted" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, actions, settings..."
            className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-0"
          />
          <div className="flex items-center gap-1 text-[10px] txt-muted border border-theme/30 rounded-md px-1.5 py-0.5">
            <Command className="w-3 h-3" />
            <span>K</span>
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="text-[13px] txt-muted text-center py-8">No results found.</p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  item.onSelect();
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left hover:bg-gold/5 transition-colors"
              >
                <span className="text-[13px] txt-body">{item.label}</span>
                {item.group && <span className="text-[10px] txt-muted">{item.group}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
