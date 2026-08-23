import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

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

export interface KeystoneState {
  user: Ref<KeystoneUser | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { username: string; email: string; password: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const KeystoneKey: InjectionKey<KeystoneState> = Symbol("keystone");

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

/**
 * Creates the Keystone auth state and provides it to the component tree.
 * Call once in your root component's setup().
 */
export function provideKeystone(config: KeystoneClientConfig): KeystoneState {
  const client = new KeystoneHttpClient(config);
  const user = ref<KeystoneUser | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);

  const refresh = async () => {
    try {
      const result = await client.me();
      user.value = result.user;
    } catch {
      user.value = null;
    }
  };

  const login = async (email: string, password: string) => {
    error.value = null;
    try {
      const result = await client.login(email, password, config.clientId);
      user.value = result.user;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Login failed";
      throw err;
    }
  };

  const register = async (input: { username: string; email: string; password: string; name?: string }) => {
    error.value = null;
    try {
      const result = await client.register(input, config.clientId);
      user.value = result.user;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Registration failed";
      throw err;
    }
  };

  const logout = async () => {
    try {
      await client.logout(config.clientId);
    } finally {
      user.value = null;
    }
  };

  const state: KeystoneState = { user, loading, error, login, register, logout, refresh };
  provide(KeystoneKey, state);

  refresh().finally(() => {
    loading.value = false;
  });

  return state;
}

/** Access the Keystone auth state provided by provideKeystone(). */
export function useKeystone(): KeystoneState {
  const state = inject(KeystoneKey);
  if (!state) throw new Error("useKeystone requires provideKeystone() in a parent component");
  return state;
}

/** Convenience composable returning just the current user and loading state. */
export function useUser(): { user: Ref<KeystoneUser | null>; loading: Ref<boolean> } {
  const { user, loading } = useKeystone();
  return { user, loading };
}
