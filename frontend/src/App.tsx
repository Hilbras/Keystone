import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "./api.ts";
import Wizard from "./Wizard.tsx";
import SimpleWizard from "./components/wizard/SimpleWizard.tsx";
import Dashboard from "./Dashboard.tsx";
import { Card } from "./components/ui/Card.tsx";
import { Alert } from "./components/ui/Alert.tsx";
import { Button } from "./components/ui/Button.tsx";
import { ErrorBoundary } from "./components/ui/ErrorBoundary.tsx";
import { ToastProvider } from "./components/ui/ToastProvider.tsx";
import { useHashRoute } from "./hooks/useHashRoute.ts";

function normalizeDashboardTab(path: string): string | null {
  const match = path.match(/^\/dashboard\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Extracts a magic-link token from the URL hash (`#magic-link=<token>`).
 * Magic link emails point here; the token is exchanged for an access token.
 */
function extractMagicLinkToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const match = hash.match(/^magic-link=(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Extracts an email-verification token from the URL hash (`#verify-email=<token>`).
 */
function extractVerificationToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const match = hash.match(/^verify-email=(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const { path, navigate } = useHashRoute();
  const [status, setStatus] = useState<{ needsSetup: boolean; setupToken: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkState, setMagicLinkState] = useState<"pending" | "done" | "error" | null>(null);
  const [verifyState, setVerifyState] = useState<"pending" | "done" | "error" | null>(null);

  // Handle email-verification links before anything else.
  useEffect(() => {
    const token = extractVerificationToken();
    if (!token) return;
    setVerifyState("pending");
    api
      .verifyEmail(token)
      .then(() => setVerifyState("done"))
      .catch(() => setVerifyState("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle magic-link sign-in before anything else.
  useEffect(() => {
    const token = extractMagicLinkToken();
    if (!token) return;
    setMagicLinkState("pending");
    api
      .verifyMagicLink(token)
      .then((result) => {
        localStorage.setItem("keystone-access-token", result.accessToken);
        window.location.hash = "#/dashboard/overview";
        setMagicLinkState("done");
        window.location.reload();
      })
      .catch((err) => {
        setMagicLinkState("error");
        setError(err instanceof Error ? err.message : "Invalid or expired sign-in link");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api
      .getStatus()
      .then((s) => {
        setStatus(s);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  // Redirect to a sensible default once status is known and no route is set.
  useEffect(() => {
    if (loading || error || path !== "/") return;

    if (status?.needsSetup) {
      navigate("/setup/simple");
    } else {
      navigate("/dashboard/overview");
    }
  }, [loading, error, status, path, navigate]);

  const dashboardTab = normalizeDashboardTab(path);

  if (verifyState) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <Card variant="glass" className="w-full max-w-lg p-6 md:p-8 shadow-xl text-center">
          {verifyState === "pending" && (
            <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-gold" />
              <p className="text-[14px]">Verifying your email…</p>
            </div>
          )}
          {verifyState === "done" && (
            <>
              <Alert variant="success" className="mb-4">Your email address has been verified.</Alert>
              <Button className="w-full" onClick={() => { window.location.hash = "#/dashboard/overview"; window.location.reload(); }}>
                Continue
              </Button>
            </>
          )}
          {verifyState === "error" && (
            <>
              <Alert variant="error" className="mb-4">This verification link is invalid or has expired.</Alert>
              <Button className="w-full" onClick={() => { window.location.hash = "#/dashboard/overview"; window.location.reload(); }}>
                Back to sign in
              </Button>
            </>
          )}
        </Card>
      </div>
    );
  }

  if (magicLinkState === "pending") {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <Card variant="glass" className="w-full max-w-lg p-6 md:p-8 shadow-xl">
          <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-7 h-7 animate-spin text-gold" />
            <p className="text-[14px]">Signing you in…</p>
          </div>
        </Card>
      </div>
    );
  }

  if (magicLinkState === "error") {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <Card variant="glass" className="w-full max-w-lg p-6 md:p-8 shadow-xl">
          <Alert variant="error" className="mb-4">
            {error || "Invalid or expired sign-in link"}
          </Alert>
          <Button
            className="w-full"
            onClick={() => {
              window.location.hash = "#/dashboard/overview";
              window.location.reload();
            }}
          >
            Back to sign in
          </Button>
        </Card>
      </div>
    );
  }

  if (!loading && !error && !status?.needsSetup) {
    return (
      <ErrorBoundary>
        <ToastProvider>
          <Dashboard initialTab={dashboardTab ?? "overview"} />
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  const isAdvancedSetup = path === "/setup/advanced";

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <Card variant="glass" className="w-full max-w-lg p-6 md:p-8 shadow-xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl btn-gold flex items-center justify-center">
            <span className="text-lg font-bold">K</span>
          </div>
          <h1 className="text-2xl font-semibold txt-head">Keystone Setup</h1>
        </div>

        {loading && (
          <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-7 h-7 animate-spin text-gold" />
            <p className="text-[14px]">Checking installation status…</p>
          </div>
        )}

        {!loading && error && (
          <div className="py-2">
            <Alert variant="error" className="mb-4">
              Unable to reach the Keystone API: {error}
            </Alert>
            <p className="text-[13px] txt-muted">
              Make sure the Keystone server is running and the API URL is configured correctly.
            </p>
          </div>
        )}

        {!loading && !error && status?.needsSetup && (
          isAdvancedSetup ? (
            <Wizard onUseSimple={() => navigate("/setup/simple")} />
          ) : (
            <SimpleWizard onSwitchAdvanced={() => navigate("/setup/advanced")} />
          )
        )}
      </Card>
    </div>
  );
}
