const ISSUER = import.meta.env.VITE_KEYSTONE_URL || "http://localhost:4001";
const CLIENT_ID = import.meta.env.VITE_KEYSTONE_CLIENT_ID || "";
const REDIRECT_URI = import.meta.env.VITE_KEYSTONE_REDIRECT_URI || "http://localhost:5174/callback";

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(plain: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function startKeystoneLogin() {
  const verifier = generateCodeVerifier();
  const challenge = await sha256(verifier);
  localStorage.setItem("keystone-code-verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    state: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${ISSUER}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeKeystoneCode(code: string) {
  const verifier = localStorage.getItem("keystone-code-verifier");
  if (!verifier) throw new Error("Missing PKCE verifier");

  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Token exchange failed: ${res.status}`);
  }

  const data = await res.json();
  localStorage.setItem("keystone-access-token", data.access_token);
  localStorage.setItem("keystone-refresh-token", data.refresh_token);
  return data;
}

export function getKeystoneToken(): string | null {
  return localStorage.getItem("keystone-access-token");
}

export function logoutKeystone() {
  localStorage.removeItem("keystone-access-token");
  localStorage.removeItem("keystone-refresh-token");
  localStorage.removeItem("keystone-code-verifier");
}
