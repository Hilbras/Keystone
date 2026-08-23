import { useEffect, useState } from "react";
import { UserCircle, Save } from "lucide-react";
import { api } from "../api.ts";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import { Input } from "./ui/Input.tsx";
import { Badge } from "./ui/Badge.tsx";
import { SectionCard } from "./ui/SectionCard.tsx";
import { FieldHelp } from "./ui/FieldHelp.tsx";
import { LoadingState } from "./ui/LoadingState.tsx";
import { useToastContext } from "./ui/ToastProvider.tsx";

interface Profile {
  id: string;
  email: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  metadata: Record<string, unknown>;
}

export function ProfilePanel() {
  const { addToast } = useToastContext();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const resendVerification = async () => {
    setResendState("sending");
    try {
      await api.sendEmailVerification();
      setResendState("sent");
      addToast("Verification email sent", "success");
    } catch (err) {
      setResendState("idle");
      addToast(err instanceof Error ? err.message : "Failed to send verification email", "error");
    }
  };

  useEffect(() => {
    api
      .getProfile()
      .then(({ user }) => {
        setProfile(user);
        setName(user.name ?? "");
        setAvatarUrl(user.avatarUrl ?? "");
        setPhoneNumber(user.phoneNumber ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const { user } = await api.updateProfile({
        name: name || undefined,
        avatarUrl: avatarUrl || null,
        phoneNumber: phoneNumber || null,
      });
      setProfile(user as Profile);
      addToast("Profile updated", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading profile…" />;

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <UserCircle className="w-4 h-4 text-gold" />
          Your Profile
        </span>
      }
      description="Manage your personal account details."
    >
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      {profile && (
        <div className="flex items-center gap-4 mb-6">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="w-14 h-14 rounded-full object-cover border border-theme/30" />
          ) : (
            <div className="w-14 h-14 rounded-full btn-gold flex items-center justify-center text-xl font-bold">
              {(profile.name || profile.email)[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[15px] font-semibold txt-head truncate">{profile.name || profile.username}</p>
            <p className="text-[12px] txt-muted truncate">{profile.email}</p>
            <div className="flex gap-2 mt-1 items-center flex-wrap">
              <Badge variant={profile.emailVerified ? "success" : "warning"}>
                {profile.emailVerified ? "Email verified" : "Email unverified"}
              </Badge>
              {!profile.emailVerified && (
                <Button size="sm" variant="secondary" onClick={resendVerification} disabled={resendState === "sent"}>
                  {resendState === "sent" ? "Email sent" : resendState === "sending" ? "Sending…" : "Resend verification email"}
                </Button>
              )}
              {profile.phoneNumber && (
                <Badge variant={profile.phoneVerified ? "success" : "warning"}>
                  {profile.phoneVerified ? "Phone verified" : "Phone unverified"}
                </Badge>
              )}
            </div>
          </div>
        </div>
      )}

      <form onSubmit={save} className="space-y-4 max-w-md">
        <FieldHelp label="Display name" help="Shown across the dashboard and in emails.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
        </FieldHelp>
        <FieldHelp label="Avatar URL" help="Link to your profile picture (https://…). Leave empty to use your initial.">
          <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://example.com/avatar.png" />
        </FieldHelp>
        <FieldHelp label="Phone number" help="Used for SMS sign-in codes. Changing it resets verification.">
          <Input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+1 555 123 4567" />
        </FieldHelp>
        <Button type="submit" size="sm" isLoading={saving}>
          <Save className="w-4 h-4 mr-1" />
          Save changes
        </Button>
      </form>
    </SectionCard>
  );
}
