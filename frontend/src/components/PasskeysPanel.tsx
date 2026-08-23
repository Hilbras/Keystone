import { useState } from "react";
import { Fingerprint, Plus } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "../api.ts";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";

/**
 * Passkey (WebAuthn) management for the signed-in admin user.
 * Registration uses the platform authenticator (Touch ID, Windows Hello,
 * security key) via the browser WebAuthn API.
 */
export function PasskeysPanel() {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  const supported =
    typeof window !== "undefined" &&
    window.PublicKeyCredential !== undefined &&
    typeof window.PublicKeyCredential === "function";

  const registerPasskey = async () => {
    setError(null);
    setSuccess(null);
    setIsRegistering(true);
    try {
      const options = await api.webauthnRegisterOptions();
      const attestation = await startRegistration({ optionsJSON: options as never });
      await api.webauthnRegisterVerify(attestation, navigator.userAgent.slice(0, 80));
      setSuccess("Passkey registered. You can now use it to sign in.");
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Registration was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Failed to register passkey");
      }
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-gold" />
          Passkeys
        </span>
      }
      description="Register a passkey (Touch ID, Windows Hello, or security key) to sign in without a password."
    >
      {success && <Alert variant="success" className="mb-4">{success}</Alert>}
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {!supported ? (
        <p className="text-[12px] txt-muted">
          This browser does not support passkeys (WebAuthn).
        </p>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-[12px] txt-muted">
            Passkeys are phishing-resistant credentials stored on your device.
          </p>
          <Button size="sm" onClick={registerPasskey} isLoading={isRegistering}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Register a passkey
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
