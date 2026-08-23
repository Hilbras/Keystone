import { useEffect, useState } from "react";
import { api, getKeystoneAccessToken } from "../api.ts";

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  role?: string;
}

export interface AuthState {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for Keystone token-based admin authentication.
 */
export function useAuth(): AuthState & { logout: () => void } {
  const [token, setToken] = useState<string | null>(getKeystoneAccessToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(getKeystoneAccessToken());
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    api
      .getMe()
      .then((result) => {
        setUser(result.user as AuthUser);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("invalid token") || message.toLowerCase().includes("unauthorized")) {
          localStorage.removeItem("keystone-access-token");
          window.location.reload();
          return;
        }
        setError(message);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const logout = () => {
    localStorage.removeItem("keystone-access-token");
    window.location.reload();
  };

  return { token, user, loading, error, logout };
}
