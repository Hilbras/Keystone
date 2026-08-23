import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface KeystoneUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  avatarUrl?: string | null;
  emailVerified: boolean;
  metadata?: Record<string, unknown>;
}

export interface KeystoneClientConfig {
  /** Keystone API base URL, e.g. https://auth.example.com */
  url: string;
  /** Application client id (optional) */
  clientId?: string;
}

interface KeystoneContextValue {
  user: KeystoneUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { username: string; email: string; password: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const KeystoneContext = createContext<KeystoneContextValue | null>(null);

class KeystoneHttpClient {
  constructor(private config: KeystoneClientConfig) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.url}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  me() {
    return this.request<{ user: KeystoneUser | null }>("/auth/me");
  }

  login(email: string, password: string, clientId?: string) {
    return this.request<{ user: KeystoneUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, client_id: clientId }),
    });
  }

  register(input: { username: string; email: string; password: string; name?: string }, clientId?: string) {
    return this.request<{ user: KeystoneUser }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...input, client_id: clientId }),
    });
  }

  logout(clientId?: string) {
    return this.request<{ success: boolean }>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ client_id: clientId }),
    });
  }
}

export function KeystoneProvider({ config, children }: { config: KeystoneClientConfig; children: ReactNode }) {
  const client = useMemo(() => new KeystoneHttpClient(config), [config.url, config.clientId]);
  const [user, setUser] = useState<KeystoneUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { user } = await client.me();
      setUser(user);
    } catch {
      setUser(null);
    }
  }, [client]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const { user } = await client.login(email, password, config.clientId);
        setUser(user);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Login failed";
        setError(message);
        throw err;
      }
    },
    [client, config.clientId]
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string; name?: string }) => {
      setError(null);
      try {
        const { user } = await client.register(input, config.clientId);
        setUser(user);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Registration failed";
        setError(message);
        throw err;
      }
    },
    [client, config.clientId]
  );

  const logout = useCallback(async () => {
    try {
      await client.logout(config.clientId);
    } finally {
      setUser(null);
    }
  }, [client, config.clientId]);

  const value = useMemo(
    () => ({ user, loading, error, login, register, logout, refresh }),
    [user, loading, error, login, register, logout, refresh]
  );

  return <KeystoneContext.Provider value={value}>{children}</KeystoneContext.Provider>;
}

/** Access the full Keystone auth context (user, loading, login, logout, …). */
export function useKeystone(): KeystoneContextValue {
  const ctx = useContext(KeystoneContext);
  if (!ctx) throw new Error("useKeystone must be used inside <KeystoneProvider>");
  return ctx;
}

/** Convenience hook returning just the current user and loading state. */
export function useUser(): { user: KeystoneUser | null; loading: boolean } {
  const { user, loading } = useKeystone();
  return { user, loading };
}
