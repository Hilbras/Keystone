import { useEffect, useState } from "react";
import {
  exchangeKeystoneCode,
  getKeystoneToken,
  logoutKeystone,
  startKeystoneLogin,
} from "./keystone-auth";

export default function App() {
  const [token, setToken] = useState<string | null>(getKeystoneToken());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      exchangeKeystoneCode(code)
        .then(() => {
          setToken(getKeystoneToken());
          window.history.replaceState({}, "", "/");
        })
        .catch((err) => setError(err.message));
    }
  }, []);

  const login = () => {
    setError(null);
    startKeystoneLogin();
  };

  const logout = () => {
    logoutKeystone();
    setToken(null);
  };

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Keystone SPA Example</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {token ? (
        <>
          <p>✅ Logged in</p>
          <p style={{ wordBreak: "break-all" }}>
            <strong>Access token:</strong> {token}
          </p>
          <button onClick={logout}>Logout</button>
        </>
      ) : (
        <button onClick={login}>Login with Keystone</button>
      )}
    </div>
  );
}
