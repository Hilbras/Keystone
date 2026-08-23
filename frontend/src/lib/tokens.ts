/**
 * Design tokens shared across the Keystone admin UI.
 *
 * Prefer Tailwind utility classes in components. Use these tokens for
 * dynamic values or when utilities are not enough.
 */

export const tokens = {
  colors: {
    gold: "#d4af37",
    goldLight: "#e4c45a",
    emerald: "#10b981",
    blue: "#3b82f6",
    purple: "#8b5cf6",
    red: "#ef4444",
  },
  spacing: {
    page: "p-4 md:p-6",
    section: "gap-4",
    card: "p-5",
  },
  radius: {
    DEFAULT: "0.75rem",
    xl: "1rem",
    "2xl": "1.25rem",
  },
  typography: {
    xs: "text-[11px]",
    sm: "text-[12px]",
    base: "text-[13px]",
    lg: "text-[14px]",
    xl: "text-[15px]",
    "2xl": "text-xl",
  },
} as const;

export type Size = "sm" | "md" | "lg";
