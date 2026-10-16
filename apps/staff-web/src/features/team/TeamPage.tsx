/**
 * The team roster and the access-request queue.
 *
 * Every control is gated by `domain/userRules`, a port of the backend's own
 * `user_rules`. Where an action is refused, the control is **disabled with the reason**
 * rather than hidden: "The owner cannot be removed" is useful; a missing button is a
 * puzzle.
 *
 * Removing someone bans them and disables their Firebase user, and the backend rechecks
 * account status on every request — so it takes effect immediately rather than at token
 * expiry. The confirmation says so.
 *
 * **Adding someone** is an invitation: an address and a role, emailed from BuildCo. The
 * person is in the roster from that moment — marked "Invited" until they first sign in —
 * so work can be assigned to them straight away. While it is pending the row offers
 * Resend and Revoke instead of Remove, because the two are different acts: revoking
 * deletes an invitation nobody has taken up, removing bans a person who has history.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  useApprovalRequests,
  useAssignRole,
  useBanUser,
  useResendInvite,
  useReviewApprovalRequest,
  useRevokeInvite,
  useUsers,
} from "@/api/queries/users";
import type { ApprovalRequestOut, UserOut } from "@/api/types";
import { useActor } from "@/auth/useAuth";
import { Avatar } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { Badge, RoleBadge } from "@/components/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import { Select } from "@/components/form";
import { useToast } from "@/components/Toast";
import type { Role } from "@/domain/enums";
import {
  assignableRoles,
  canInviteUser,
  canRemoveUser,
  type UserSnapshot,
} from "@/domain/userRules";
import { displayName, formatRelative } from "@/lib/format";
import { InviteMemberModal } from "./InviteMemberModal";

export function TeamPage() {
  const actor = useActor();
  const { data: users, isPending, error, refetch } = useUsers();
  const { data: requests } = useApprovalRequests("pending");
  const [inviting, setInviting] = useState(false);

  if (!actor || isPending) return <LoadingState label="Loading the team…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const active = users.filter((user) => user.status === "active");
  const removed = users.filter((user) => user.status !== "active");
  const invited = active.filter((user) => user.invite_pending).length;
  const joined = active.length - invited;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Team"
        // Someone who has not signed in yet is not "active" in any sense a reader means.
        subtitle={invited > 0 ? `${joined} active · ${invited} invited` : `${joined} active`}
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            Add member
          </Button>
        }
      />

      {(requests ?? []).length > 0 && (
        <AccessRequests requests={requests ?? []} />
      )}

      <Roster title="Members" users={active} actor={actor} />

      {removed.length > 0 && <Roster title="Removed" users={removed} actor={actor} removed />}

      {/* Mounted only while open, so a second invitation starts from an empty form. */}
      {inviting && <InviteMemberModal open actor={actor} onClose={() => setInviting(false)} />}
    </div>
  );
}

function Roster({
  title,
  users,
  actor,
  removed = false,
}: {
  title: string;
  users: UserOut[];
  actor: UserSnapshot;
  removed?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1 p-5">
      <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">{title}</h2>

      {users.length === 0 ? (
        <p className="py-2 text-sm text-gray-500">Nobody here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {users.map((user) => (
            <TeamRow key={user.id} user={user} actor={actor} removed={removed} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function TeamRow({
  user,
  actor,
  removed,
}: {
  user: UserOut;
  actor: UserSnapshot;
  removed: boolean;
}) {
  const toast = useToast();
  const assign = useAssignRole();
  const ban = useBanUser();
  const resend = useResendInvite();
  const revoke = useRevokeInvite();
  const [confirming, setConfirming] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const target: UserSnapshot = { id: user.id, role: user.role as Role };
  const roles = assignableRoles(actor, target);
  const removal = canRemoveUser(actor, target);
  const isSelf = actor.id === user.id;
  const pending = user.invite_pending;
  // Resend and revoke answer to the same rule as inviting did, on the invitation's own
  // role — so an admin cannot manage an owner's invitation, and is told why.
  const invitation = canInviteUser(actor, target.role);

  async function resendInvite() {
    try {
      await resend.mutateAsync(user.id);
      toast.success(`Invitation sent again to ${user.email}.`);
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The invitation could not be sent again.",
      );
    }
  }

  async function confirmRevoke() {
    setConfirmingRevoke(false);
    try {
      await revoke.mutateAsync(user.id);
      toast.success(`The invitation for ${user.email} has been withdrawn.`);
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The invitation could not be withdrawn.",
      );
    }
  }

  async function changeRole(role: Role) {
    try {
      await assign.mutateAsync({ userId: user.id, role });
      toast.success(`${displayName(user)} is now ${role}.`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "The role could not be changed.");
    }
  }

  async function confirmRemove() {
    setConfirming(false);
    try {
      await ban.mutateAsync(user.id);
      toast.success(`${displayName(user)} has been removed.`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "The member could not be removed.");
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Avatar url={user.avatar_url} name={displayName(user)} size="size-9" viewable />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">
          {displayName(user)}
          {isSelf && <span className="ml-1.5 text-xs font-normal text-gray-400">(you)</span>}
        </p>
        <p className="truncate text-xs text-gray-500">
          {user.email}
          {pending && !removed && ` · invited ${formatRelative(user.invited_at)}`}
        </p>
      </div>

      {pending && !removed && <Badge tone="warning">Invited</Badge>}

      {removed ? (
        <span className="text-xs text-gray-500">Removed</span>
      ) : (
        <>
          {roles.length === 0 ? (
            // Disabled with the reason beats a missing control: "You cannot change your
            // own role" is useful, an absent dropdown is a puzzle.
            <span title={assignRefusal(actor, target)} className="cursor-help">
              <RoleBadge role={user.role as Role} />
            </span>
          ) : (
            <Select
              aria-label={`Role for ${displayName(user)}`}
              value={user.role}
              disabled={assign.isPending}
              onChange={(event) => void changeRole(event.target.value as Role)}
              className="w-auto"
            >
              {/* The current role is always listed so the control shows the state, even
                  when re-selecting it would be a no-op. */}
              {[...new Set([user.role as Role, ...roles])].map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          )}

          {pending ? (
            <>
              <Button
                size="sm"
                busy={resend.isPending}
                disabled={!invitation.allowed || revoke.isPending}
                title={invitation.allowed ? undefined : invitation.reason}
                onClick={() => void resendInvite()}
              >
                Resend
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger-600 dark:text-danger-400 hover:bg-danger-50"
                disabled={!invitation.allowed || revoke.isPending || resend.isPending}
                title={invitation.allowed ? undefined : invitation.reason}
                onClick={() => setConfirmingRevoke(true)}
              >
                Revoke
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger-600 dark:text-danger-400 hover:bg-danger-50"
              disabled={!removal.allowed || ban.isPending}
              title={removal.allowed ? undefined : removal.reason}
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmingRevoke}
        title={`Withdraw the invitation for ${user.email}?`}
        confirmLabel="Revoke"
        busy={revoke.isPending}
        onCancel={() => setConfirmingRevoke(false)}
        onConfirm={() => void confirmRevoke()}
      >
        <p>
          They come off the team list, and the link in their email no longer adds them with
          this role. Anything already assigned to them becomes unassigned.
        </p>
        <p className="mt-2">You can invite the same address again afterwards.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming}
        title={`Remove ${displayName(user)}?`}
        confirmLabel="Remove"
        busy={ban.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirmRemove()}
      >
        <p>
          They lose access immediately — their Firebase account is disabled and the API
          rechecks status on every request, so they are signed out at once rather than when
          their token expires.
        </p>
        <p className="mt-2">
          Their estimates and projects are untouched. If they try to sign in again, an access
          request appears here for review.
        </p>
      </ConfirmDialog>
    </li>
  );
}

/** The first refusal reason among the roles, for the tooltip. */
function assignRefusal(actor: UserSnapshot, target: UserSnapshot): string {
  return actor.id === target.id
    ? "You cannot change your own role."
    : "Only owners can change another owner's role.";
}

function AccessRequests({ requests }: { requests: ApprovalRequestOut[] }) {
  const toast = useToast();
  const review = useReviewApprovalRequest();

  async function decide(request: ApprovalRequestOut, decision: "approve" | "deny") {
    try {
      await review.mutateAsync({ id: request.id, decision });
      toast.success(
        decision === "approve"
          ? `${request.full_name || request.email} can sign in again.`
          : "Request denied.",
      );
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The request could not be reviewed.",
      );
    }
  }

  return (
    <Card className="flex flex-col gap-2 border-warning-500/20 p-5">
      <h2 className="text-xs font-medium tracking-wide text-warning-600 dark:text-warning-400 uppercase">
        Access requests
      </h2>
      <p className="text-sm text-gray-600">
        Filed automatically when someone who was removed tries to sign in.
      </p>

      {requests.length === 0 ? (
        <EmptyState title="Nothing waiting" />
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">
                  {request.full_name || request.email}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {request.email} · requested {formatRelative(request.requested_at)}
                </p>
              </div>

              <Button
                size="sm"
                variant="success"
                busy={review.isPending}
                onClick={() => void decide(request, "approve")}
              >
                Restore access
              </Button>
              <Button
                size="sm"
                disabled={review.isPending}
                onClick={() => void decide(request, "deny")}
              >
                Deny
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
