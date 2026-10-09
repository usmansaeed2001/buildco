/**
 * Adding someone to the team.
 *
 * An admin gives an address and a role; the API creates the profile, emails an
 * invitation from BuildCo, and the person joins by following its link. Nothing here
 * creates a password or an account for them — they make their own.
 *
 * The role list is `invitableRoles(actor)`, a port of the backend's `can_invite_user`,
 * so it never offers a choice that comes back 403: an admin is not shown "owner" at
 * all, and is told why. What the server alone can know — that the address is already
 * on the team, already invited, or was removed — arrives as a 409 whose message is
 * shown as-is, because each of those has a different next step.
 */
import { useId, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { useInviteUser } from "@/api/queries/users";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { Field, Select, TextField } from "@/components/form";
import { useToast } from "@/components/Toast";
import type { Role } from "@/domain/enums";
import { invitableRoles, type UserSnapshot } from "@/domain/userRules";
import { isEmail, normaliseEmail } from "@/lib/email";

export function InviteMemberModal({
  open,
  actor,
  onClose,
}: {
  open: boolean;
  actor: UserSnapshot;
  onClose: () => void;
}) {
  const toast = useToast();
  const invite = useInviteUser();
  const formId = useId();

  const roles = invitableRoles(actor);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [failure, setFailure] = useState<string | null>(null);

  const address = normaliseEmail(email);
  const valid = isEmail(address);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setFailure(null);

    try {
      await invite.mutateAsync({ email: address, full_name: fullName.trim(), role });
      toast.success(`Invitation sent to ${address}.`);
      onClose();
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : "The invitation could not be sent.",
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a team member"
      description="They will get an email from BuildCo with a link to create their account."
      footer={
        <>
          <Button onClick={onClose} disabled={invite.isPending}>
            Cancel
          </Button>
          {/* Outside the <form> in the DOM — the modal renders its footer separately —
              so it is tied back to it by id, and Enter in a field still submits. */}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={invite.isPending}
            disabled={!valid}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {failure && <Alert tone="danger">{failure}</Alert>}

        <TextField
          label="Email"
          required
          type="email"
          autoComplete="off"
          placeholder="name@company.com"
          value={email}
          {...(email.trim() && !valid ? { error: "Enter a full email address." } : {})}
          onChange={(event) => setEmail(event.target.value)}
        />

        <TextField
          label="Full name"
          hint="Optional. Filled in from their sign-in if left blank."
          autoComplete="off"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
        />

        <Field
          label="Role"
          // Said rather than silently omitted: an admin looking for "owner" should learn
          // why it is not there, not wonder whether the list is broken.
          {...(roles.includes("owner") ? {} : { hint: "Only an owner can add another owner." })}
        >
          {(props) => (
            <Select
              {...props}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Modal>
  );
}
