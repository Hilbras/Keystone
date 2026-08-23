/**
 * React drop-in component for Keystone auth.
 *
 * Usage:
 *
 *   import { KeystoneLoginForm } from "./keystone-react";
 *
 *   <KeystoneLoginForm
 *     mode="login"
 *     keystoneUrl="http://localhost:4001"
 *     afterLogin="/dashboard"
 *     showGoogle
 *   />
 */

import { useState, type FormEvent } from "react";

interface KeystoneLoginFormProps {
  /** "login" or "register" */
  mode?: "login" | "register";
  /** Keystone API base URL */
  keystoneUrl?: string;
  /** Where to redirect after successful login/register */
  afterLogin?: string;
  /** Show the Google login button */
  showGoogle?: boolean;
}

export function KeystoneLoginForm({
  mode = "login",
  keystoneUrl = "http://localhost:4001",
  afterLogin = "/",
  showGoogle = true,
}: KeystoneLoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const request = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${keystoneUrl}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      if (mode === "login") {
        await request("/auth/login", { email, password });
        setSuccess("Login successful! Redirecting…");
      } else {
        await request("/auth/register", { username, email, password, name });
        setSuccess("Account created! Redirecting…");
      }
      setTimeout(() => (window.location.href = afterLogin), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const googleLogin = () => {
    window.location.href = `${keystoneUrl}/auth/oauth/google`;
  };

  return (
    <div style={{ maxWidth: 360, fontFamily: "sans-serif" }}>
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
      {success && <p style={{ color: "#16a34a" }}>{success}</p>}

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        {mode === "register" && (
          <>
            <input
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <input
              placeholder="Full name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Login" : "Create account"}
        </button>
      </form>

      {showGoogle && (
        <button onClick={googleLogin} style={{ marginTop: 16, width: "100%" }}>
          Login with Google
        </button>
      )}
    </div>
  );
}
