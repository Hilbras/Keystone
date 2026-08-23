import { useCallback, useEffect, useState } from "react";

export type UiMode = "simple" | "advanced";

const STORAGE_KEY = "keystone:ui-mode";

export function useUiMode(): {
  mode: UiMode;
  setMode: (mode: UiMode) => void;
  toggle: () => void;
  isSimple: boolean;
  isAdvanced: boolean;
} {
  const [mode, setModeState] = useState<UiMode>(() => {
    if (typeof window === "undefined") return "simple";
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "advanced" ? "advanced" : "simple";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = useCallback((value: UiMode) => {
    setModeState(value);
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => (prev === "simple" ? "advanced" : "simple"));
  }, []);

  return {
    mode,
    setMode,
    toggle,
    isSimple: mode === "simple",
    isAdvanced: mode === "advanced",
  };
}
