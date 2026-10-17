import { useEffect, useState } from "react";
import { api, SESSION_EXPIRED_EVENT } from "../api.ts";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  role?: string;
  isActive?: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for Keystone cookie-based admin authentication.
 */
export function useAuth(): AuthState & { logout: () => void } {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((result) => {
        if (!cancelled) setUser(result.user as AuthUser);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        if (lower.includes("unauthorized") || lower.includes("401")) {
          // Being signed out is a state, not an error to surface.
          setUser(null);
          setError(null);
        } else {
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setLoading(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const logout = () => {
    // Fire-and-forget: the reload below tears the page down either way.
    api.logout().catch(() => {});
    window.location.reload();
  };

  return { user, loading, error, logout };
}