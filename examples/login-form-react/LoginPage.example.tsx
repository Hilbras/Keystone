import { useEffect, useState } from "react";
import {
  getCurrentUser,
  loginWithGoogle,
  loginWithPassword,
  logout,
  registerAccount,
  type KeystoneUser,
} from "./keystone-auth";

export default function LoginPage() {
  const [user, setUser] = useState<KeystoneUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLogin, setIsLogin] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      const result = isLogin
        ? await loginWithPassword(email, password)
        : await registerAccount(username, email, password, name || undefined);
      setUser(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  if (loading) return <p>Loading...</p>;

  if (user) {
    return (
      <div style={{ padding: 24, fontFamily: "sans-serif" }}>
        <h1>Welcome, {user.name || user.email}</h1>
        <p>Email: {user.email}</p>
        <p>Username: {user.username}</p>
        <button onClick={handleLogout}>Logout</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 360, margin: "48px auto", fontFamily: "sans-serif" }}>
      <h1>{isLogin ? "Login" : "Sign up"}</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        {!isLogin && (
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
        <button type="submit">{isLogin ? "Login" : "Create account"}</button>
      </form>

      <hr style={{ margin: "24px 0" }} />

      <button onClick={loginWithGoogle} style={{ width: "100%" }}>
        Login with Google
      </button>

      <p style={{ textAlign: "center", marginTop: 16 }}>
        {isLogin ? "No account? " : "Already have an account? "}
        <button
          type="button"
          onClick={() => setIsLogin(!isLogin)}
          style={{ background: "none", border: "none", color: "blue", cursor: "pointer" }}
        >
          {isLogin ? "Sign up" : "Login"}
        </button>
      </p>
    </div>
  );
}
