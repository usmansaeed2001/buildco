/**
 * Your own profile.
 *
 * Only `full_name` and `phone` are editable — `UserUpdate` accepts nothing else, and
 * deliberately: email is the Firebase identity and role is not something anyone grants
 * themselves. Both are shown read-only rather than hidden, because "why can't I change
 * this" is answered better by a disabled field than by an absent one.
 *
 * The avatar follows the same signed-upload dance as attachments: mint a URL, PUT
 * straight to storage, then record it. It is the one place a *public* URL is used —
 * avatars live in their own bucket and are served directly, unlike attachments which
 * always go through a signed link.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { UploadFailedError } from "@/api/queries/attachments";
import { useMe, useUpdateMe } from "@/api/queries/users";
import { apiFetch } from "@/api/client";
import type { AvatarUploadOut, UserOut } from "@/api/types";
import { useAuth } from "@/auth/useAuth";
import { Avatar } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { RoleBadge } from "@/components/Badge";
import { Alert, Card, ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import { AgentMemories } from "@/features/agent/AgentMemories";
import { Field, Input, TextField } from "@/components/form";
import { useToast } from "@/components/Toast";
import type { Role } from "@/domain/enums";
import { displayName } from "@/lib/format";

export function ProfilePage() {
  const { data: me, isPending, error, refetch } = useMe();

  if (isPending) return <LoadingState label="Loading your profile…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return <Profile key={me.id} me={me} />;
}

function Profile({ me }: { me: UserOut }) {
  const toast = useToast();
  const { refreshProfile } = useAuth();
  const update = useUpdateMe();

  const [fullName, setFullName] = useState(me.full_name);
  const [phone, setPhone] = useState(me.phone ?? "");
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const dirty = fullName !== me.full_name || phone !== (me.phone ?? "");

  async function save() {
    setFailure(null);
    try {
      await update.mutateAsync({ full_name: fullName.trim(), phone: phone.trim() || null });
      // The topbar reads its name from AuthProvider's copy, which is seeded once per
      // identity per page load — without this the header keeps the old name until a
      // reload.
      await refreshProfile();
      toast.success("Profile updated.");
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : "Your profile could not be saved.");
    }
  }

  async function uploadAvatar(file: File) {
    setFailure(null);
    setUploading(true);

    try {
      const ticket = await apiFetch<AvatarUploadOut>("/users/me/avatar-upload-url", {
        method: "POST",
        body: { file_name: file.name, content_type: file.type || "application/octet-stream" },
      });

      // Direct to storage: no Authorization header, or the V4 signature breaks.
      const response = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: ticket.required_headers,
        body: file,
      });
      if (!response.ok) throw new UploadFailedError(response.status);

      await apiFetch<UserOut>("/users/me/avatar", {
        method: "PUT",
        body: { storage_path: ticket.storage_path },
      });
      await refreshProfile();
      toast.success("Photo updated.");
    } catch (caught) {
      setFailure(
        caught instanceof UploadFailedError
          ? caught.message
          : caught instanceof ApiError && caught.isIntegrationUnavailable
            ? "File storage is not configured, so a photo cannot be uploaded. Everything else on this page still works."
            : caught instanceof ApiError
              ? caught.message
              : "The photo could not be uploaded.",
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Profile" />

      <Card className="flex flex-col gap-5 p-5">
        {failure && <Alert tone="danger">{failure}</Alert>}

        <div className="flex items-center gap-4">
          <Avatar url={me.avatar_url} name={displayName(me)} size="size-16" />
          <div>
            <label className="cursor-pointer text-sm text-brand-700 dark:text-brand-300 underline">
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Profile photo"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAvatar(file);
                  event.target.value = "";
                }}
              />
              {uploading ? "Uploading…" : me.avatar_url ? "Change photo" : "Add a photo"}
            </label>
            <p className="mt-0.5 text-xs text-gray-500">Square images look best.</p>
          </div>
        </div>

        <div className="grid gap-4 app-sm:grid-cols-2">
          <TextField
            label="Full name"
            value={fullName}
            autoComplete="name"
            onChange={(event) => setFullName(event.target.value)}
          />
          <TextField
            label="Phone"
            type="tel"
            value={phone}
            autoComplete="tel"
            placeholder="Optional"
            onChange={(event) => setPhone(event.target.value)}
          />

          <Field label="Email" hint="This is your sign-in identity and cannot be changed here.">
            {(props) => <Input {...props} value={me.email} readOnly />}
          </Field>

          <Field label="Role" hint="Only an owner or admin can change this.">
            {(props) => (
              <div {...props} className="pt-1.5">
                <RoleBadge role={me.role as Role} />
              </div>
            )}
          </Field>
        </div>

        <div>
          <Button
            variant="primary"
            busy={update.isPending}
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save changes
          </Button>
        </div>
      </Card>

      <AgentMemories />
    </div>
  );
}
