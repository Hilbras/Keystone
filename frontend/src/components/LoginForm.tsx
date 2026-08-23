import { useState } from "react";
import { Mail, Lock, Fingerprint, Link2 } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "../api.ts";
import { Card } from "./ui/Card.tsx";
import { Input } from "./ui/Input.tsx";
import { Label } from "./ui/Label.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";

interface LoginFormProps {
  onLogin: () => void;
}

const API_BASE = import.meta.env.VITE_KEYSTONE_API_URL || "http://localhost:4001";

function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" {...props}>
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function LoginForm({ onLogin }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await api.loginToken({ email, password });
      localStorage.setItem("keystone-access-token", result.accessToken);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleMagicLink = async () => {
    if (!email) {
      setError("Enter your email address first");
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await api.sendMagicLink(email);
      setMagicLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send sign-in link");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasskey = async () => {
    setError(null);
    setPasskeyLoading(true);
    try {
      const options = await api.webauthnAuthOptions(email || undefined);
      const assertion = await startAuthentication({ optionsJSON: options as never });
      const result = await api.webauthnAuthVerify(assertion);
      localStorage.setItem("keystone-access-token", result.accessToken);
      onLogin();
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey sign-in was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Passkey sign-in failed");
      }
    } finally {
      setPasskeyLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <Card variant="glass" className="w-full max-w-md p-6 md:p-8 shadow-xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl btn-gold flex items-center justify-center">
            <span className="text-lg font-bold">K</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold txt-head">Keystone Admin</h1>
            <p className="text-[13px] txt-muted">Sign in to manage your platform</p>
          </div>
        </div>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="owner@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              leftIcon={<Mail className="w-4 h-4" />}
              required
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              leftIcon={<Lock className="w-4 h-4" />}
              required
            />
          </div>

          <Button type="submit" className="w-full" isLoading={isLoading}>
            {isLoading ? "Signing in…" : "Sign In"}
          </Button>
        </form>

        <div className="mt-5">
          <div className="relative mb-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-theme/20" />
            </div>
            <div className="relative flex justify-center text-[11px] uppercase txt-muted">
              <span className="bg-background px-2">or continue with</span>
            </div>
          </div>

          <div className="space-y-2">
            {magicLinkSent ? (
              <Alert variant="success">
                Check your inbox — we sent a sign-in link to <strong>{email}</strong>.
              </Alert>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={handleMagicLink}
                isLoading={isLoading && !password}
              >
                <Link2 className="w-4 h-4 mr-2" />
                Email me a sign-in link
              </Button>
            )}

            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={handlePasskey}
              isLoading={passkeyLoading}
            >
              <Fingerprint className="w-4 h-4 mr-2" />
              Sign in with a passkey
            </Button>

            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                window.location.href = `${API_BASE}/federation/google/start`;
              }}
            >
              <GoogleIcon className="mr-2" />
              Sign in with Google
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
