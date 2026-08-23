const KEYSTONE_URL = import.meta.env.VITE_KEYSTONE_URL || "http://localhost:4001";

/**
 * Every request to Keystone must include credentials so the HTTP-only
 * session cookie is sent and received by the browser.
 */
const fetchWithCredentials = (path: string, options: RequestInit = {}) =>
  fetch(`${KEYSTONE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

export interface KeystoneUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  emailVerified: boolean;
}

export interface AuthResult {
  user: KeystoneUser;
}

/**
 * Log in with email and password.
 */
export async function loginWithPassword(
  email: string,
  password: string
): Promise<AuthResult> {
  const res = await fetchWithCredentials("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed (${res.status})`);
  }

  return res.json();
}

/**
 * Create a new account with email and password.
 */
export async function registerAccount(
  username: string,
  email: string,
  password: string,
  name?: string
): Promise<AuthResult> {
  const res = await fetchWithCredentials("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, email, password, name }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Registration failed (${res.status})`);
  }

  return res.json();
}

/**
 * Start "Login with Google". This performs a full browser redirect.
 */
export function loginWithGoogle(): void {
  window.location.href = `${KEYSTONE_URL}/auth/oauth/google`;
}

/**
 * Log out the current user.
 */
export async function logout(): Promise<void> {
  await fetchWithCredentials("/auth/logout", { method: "POST" });
}

/**
 * Fetch the currently logged-in user. Returns null if not logged in.
 */
export async function getCurrentUser(): Promise<KeystoneUser | null> {
  const res = await fetchWithCredentials("/auth/me");
  if (!res.ok) return null;
  const body = await res.json();
  return body.user;
}
