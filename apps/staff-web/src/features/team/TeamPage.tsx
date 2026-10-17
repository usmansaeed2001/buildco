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
 *
 * **Layout.** People who have joined are grouped by role — owners, admins, members — so
 * who can do what reads off the page. What needs someone's attention (access requests,
 * invitations not yet taken up) sits in a rail beside them, and the removed below it.
 * Each person appears exactly once: an invitee is in the rail, not in their role's group
 * as well, so there is one card carrying their controls.
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
import { Button } from "@/components/Button";
import { RoleBadge } from "@/components/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/feedback";
import { Select } from "@/components/form";
import { useToast } from "@/components/Toast";
import type { Role } from "@/domain/enums";
import {
  assignableRoles,
  canInviteUser,
  canRemoveUser,
  type UserSnapshot,
} from "@/domain/userRules";
import { cn } from "@/lib/cn";
import { displayName, formatRelative } from "@/lib/format";
import { InviteMemberModal } from "./InviteMemberModal";
import { PersonAvatar } from "./PersonAvatar";

/** The role groups, top to bottom, and what each role is for. */
const GROUPS: { role: Role; title: string; blurb: string }[] = [
  { role: "owner", title: "Owners", blurb: "Full control, including over other owners" },
  { role: "admin", title: "Admins", blurb: "Manage the team, settings and every project" },
  { role: "member", title: "Members", blurb: "Work on the projects they are assigned to" },
];

const SINCE = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

/** How many faces the banner shows before "+N". */
const FACES = 8;

type Variant = "spotlight" | "card" | "invite" | "removed";

export function TeamPage() {
  const actor = useActor();
  const { data: users, isPending, error, refetch } = useUsers();
  const { data: requests } = useApprovalRequests("pending");
  const [inviting, setInviting] = useState(false);

  if (!actor || isPending) return <LoadingState label="Loading the team…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const active = users.filter((user) => user.status === "active");
  const removed = users.filter((user) => user.status !== "active");
  const pending = active.filter((user) => user.invite_pending);
  const members = active.filter((user) => !user.invite_pending);
  const invited = pending.length;
  const joined = active.length - invited;
  const waiting = requests ?? [];
  const needsAttention = waiting.length > 0 || pending.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-6 rounded-3xl bg-ink px-6 py-6 text-white app-md:px-8 app-md:py-7">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Team</h1>
            {/* Someone who has not signed in yet is not "active" in any sense a reader means. */}
            <p className="mt-1 text-sm text-white/70">
              {invited > 0 ? `${joined} active · ${invited} invited` : `${joined} active`}
            </p>
          </div>
          <FaceStack users={active} />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <dl className="flex flex-wrap gap-2">
            {GROUPS.map((group) => (
              <div key={group.role} className="min-w-20 rounded-2xl bg-white/8 px-4 py-2.5">
                <dt className="text-xs text-white/65">{group.title}</dt>
                <dd className="text-2xl font-bold tnum">
                  {active.filter((user) => user.role === group.role).length}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-lime-300 px-6 text-sm font-bold text-ink transition hover:-translate-y-px hover:bg-lime-200 active:translate-y-0"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Add member
          </button>
        </div>
      </header>

      {/* Two columns from `app-lg`: the groups on the left across both rows, the rail on
          the right with the removed under it. Narrower, one column: what is waiting first
          (when anything is), then the groups, then the removed last. */}
      <div className="grid items-start gap-6 app-lg:grid-cols-[minmax(0,1fr)_22rem] app-lg:grid-rows-[auto_1fr]">
        <main className="flex min-w-0 flex-col gap-7 app-lg:col-start-1 app-lg:row-span-2 app-lg:row-start-1">
          {GROUPS.map((group) => {
            const people = members.filter((user) => user.role === group.role);
            // An empty owners or admins group is noise; an empty members group is worth
            // saying, because it is where everyone new lands.
            if (people.length === 0 && group.role !== "member") return null;
            const spotlight = group.role === "owner";
            return (
              <section key={group.role} aria-labelledby={`team-${group.role}`} className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id={`team-${group.role}`} className="text-lg font-semibold text-gray-900">
                    {group.title}
                  </h2>
                  <span className="text-sm font-medium text-gray-400 tnum">{people.length}</span>
                  <span className="text-sm text-gray-500">{group.blurb}</span>
                </div>
                {people.length === 0 ? (
                  <p className="rounded-3xl border border-dashed border-gray-200 px-5 py-6 text-sm text-gray-500">
                    Nobody here yet. People you add join as members unless you choose otherwise.
                  </p>
                ) : (
                  <ul
                    className={cn(
                      "grid gap-3.5",
                      spotlight
                        ? "grid-cols-1"
                        : "grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))]",
                    )}
                  >
                    {people.map((user) => (
                      <TeamRow
                        key={user.id}
                        user={user}
                        actor={actor}
                        variant={spotlight ? "spotlight" : "card"}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </main>

        {/* Ahead of the groups on a narrow screen when something is waiting, so a request
            is not left at the bottom of a long page. */}
        <aside
          aria-label="Needs attention"
          className={cn(
            "flex min-w-0 flex-col gap-4 app-lg:col-start-2 app-lg:row-start-1",
            needsAttention && "order-first app-lg:order-none",
          )}
        >
          {waiting.length > 0 && <AccessRequests requests={waiting} />}

          {pending.length > 0 && (
            <section className="flex flex-col gap-3 rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-base font-semibold text-gray-900">Invitations waiting</h2>
                <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600 tnum">
                  {pending.length}
                </span>
              </div>
              <ul className="flex flex-col gap-2.5">
                {pending.map((user) => (
                  <TeamRow key={user.id} user={user} actor={actor} variant="invite" />
                ))}
              </ul>
            </section>
          )}

          {!needsAttention && (
            <section className="flex items-center gap-3 rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80">
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-lime-300 text-ink">
                <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              </span>
              <p className="text-sm text-gray-600">
                Nothing waiting: no access requests, and every invitation has been taken up.
              </p>
            </section>
          )}

        </aside>

        {removed.length > 0 && (
          <section className="flex min-w-0 flex-col gap-2 rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80 app-lg:col-start-2 app-lg:row-start-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-base font-semibold text-gray-600">Removed</h2>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-500 tnum">
                {removed.length}
              </span>
            </div>
            <p className="px-1 text-xs text-gray-500">
              They cannot sign in. Their work stays where it was.
            </p>
            <ul className="flex flex-col">
              {removed.map((user) => (
                <TeamRow key={user.id} user={user} actor={actor} variant="removed" />
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Mounted only while open, so a second invitation starts from an empty form. */}
      {inviting && <InviteMemberModal open actor={actor} onClose={() => setInviting(false)} />}
    </div>
  );
}

/** The banner's row of faces: the team at a glance, decorative. */
function FaceStack({ users }: { users: UserOut[] }) {
  const shown = users.slice(0, FACES);
  const rest = users.length - shown.length;
  return (
    <div aria-hidden="true" className="flex items-center">
      {shown.map((user) => (
        <span key={user.id} className="-mr-2 rounded-full ring-3 ring-ink">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" className="size-10 rounded-full object-cover" />
          ) : (
            <PersonAvatar name={displayName(user)} seed={user.email} size="sm" className="size-10" />
          )}
        </span>
      ))}
      {rest > 0 && (
        <span className="grid size-10 place-items-center rounded-full bg-white/15 text-xs font-bold ring-3 ring-ink">
          +{rest}
        </span>
      )}
    </div>
  );
}

function TeamRow({
  user,
  actor,
  variant,
}: {
  user: UserOut;
  actor: UserSnapshot;
  variant: Variant;
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

  const name = displayName(user);
  const since = SINCE.format(new Date(user.created_at));

  const roleControl =
    roles.length === 0 ? (
      // Disabled with the reason beats a missing control: "You cannot change your
      // own role" is useful, an absent dropdown is a puzzle.
      <span title={assignRefusal(actor, target)} className="cursor-help">
        <RoleBadge role={user.role as Role} />
      </span>
    ) : (
      <Select
        aria-label={`Role for ${name}`}
        value={user.role}
        disabled={assign.isPending}
        onChange={(event) => void changeRole(event.target.value as Role)}
        // `!`, because `Select` already carries `w-full` and `rounded-md`, and `cn` joins
        // classes rather than resolving conflicts between them.
        className="w-auto! min-w-28 rounded-full! pl-3.5 capitalize"
      >
        {/* The current role is always listed so the control shows the state, even
            when re-selecting it would be a no-op. */}
        {[...new Set([user.role as Role, ...roles])].map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </Select>
    );

  const removeButton = (
    <Button
      size="sm"
      variant="ghost"
      className="rounded-full text-danger-600! hover:bg-danger-50 dark:text-danger-400!"
      disabled={!removal.allowed || ban.isPending}
      title={removal.allowed ? undefined : removal.reason}
      onClick={() => setConfirming(true)}
    >
      Remove
    </Button>
  );

  const identity = (
    <div className="min-w-0 flex-1">
      <p
        className={cn(
          "flex items-center gap-2 font-semibold text-gray-900",
          variant === "spotlight" ? "font-display text-xl" : "text-sm",
        )}
      >
        <span className="truncate">{name}</span>
        {isSelf &&
          (variant === "spotlight" ? (
            <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 font-sans text-[11px] font-bold text-lime-300 dark:bg-lime-300 dark:text-ink">
              (you)
            </span>
          ) : (
            <span className="shrink-0 text-xs font-normal text-gray-400">(you)</span>
          ))}
      </p>
      {/* An invitee with no name yet is already shown by address, so it is not repeated. */}
      {name !== user.email && <p className="truncate text-xs text-gray-500">{user.email}</p>}
    </div>
  );

  let body;
  if (variant === "removed") {
    body = (
      <div className="flex items-center gap-3 rounded-2xl px-1 py-2">
        <PersonAvatar name={name} seed={user.email} url={user.avatar_url} size="sm" muted />
        {identity}
        <span className="text-xs text-gray-500">Removed</span>
      </div>
    );
  } else if (variant === "invite") {
    body = (
      <div className="flex flex-col gap-3 rounded-2xl bg-gray-50 p-3 ring-1 ring-gray-100">
        <div className="flex items-center gap-3">
          <PersonAvatar name={name} seed={user.email} url={user.avatar_url} size="sm" />
          <div className="min-w-0 flex-1">
            {identity}
            <p className="text-xs text-gray-500">invited {formatRelative(user.invited_at)}</p>
          </div>
          <span className="shrink-0 rounded-full bg-warning-100 px-2 py-0.5 text-[11px] font-bold text-warning-600 dark:text-warning-400">
            Invited
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {roleControl}
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              className="rounded-full"
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
              className="rounded-full text-danger-600! hover:bg-danger-50 dark:text-danger-400!"
              disabled={!invitation.allowed || revoke.isPending || resend.isPending}
              title={invitation.allowed ? undefined : invitation.reason}
              onClick={() => setConfirmingRevoke(true)}
            >
              Revoke
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (variant === "spotlight") {
    body = (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-3xl bg-linear-to-r from-lime-100 to-surface p-5 ring-1 ring-lime-200 app-md:p-6 dark:from-lime-400/15 dark:ring-lime-400/20">
        <PersonAvatar name={name} seed={user.email} url={user.avatar_url} size="xl" className="ring-4 ring-surface" />
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
          {identity}
          <p className="text-xs text-gray-500 tnum">
            {user.phone ? `${user.phone} · ` : ""}on the team since {since}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {roleControl}
          {removeButton}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex h-full flex-col gap-4 rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80 transition hover:shadow-md hover:ring-gray-300/80">
        <div className="flex items-center gap-3">
          <PersonAvatar name={name} seed={user.email} url={user.avatar_url} size="md" />
          {identity}
        </div>
        <p className="text-xs text-gray-500 tnum">
          Since {since}
          {user.phone ? ` · ${user.phone}` : ""}
        </p>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
          {roleControl}
          {removeButton}
        </div>
      </div>
    );
  }

  return (
    <li>
      {body}

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

  // Only mounted while something is waiting, so there is no empty state to draw.
  return (
    <section className="flex flex-col gap-3 rounded-3xl bg-warning-50 p-4 ring-1 ring-warning-500/25">
      <div className="px-1">
        <h2 className="text-base font-semibold text-gray-900">Access requests</h2>
        <p className="text-xs text-gray-600">
          Filed automatically when someone who was removed tries to sign in.
        </p>
      </div>

      <ul className="flex flex-col gap-2.5">
        {requests.map((request) => (
          <li key={request.id} className="flex flex-col gap-3 rounded-2xl bg-surface p-3 ring-1 ring-warning-500/15">
            <div className="flex items-center gap-3">
              <PersonAvatar
                name={request.full_name || request.email}
                seed={request.email}
                size="sm"
                muted
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-900">
                  {request.full_name || request.email}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {request.email} · requested {formatRelative(request.requested_at)}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="success"
                className="flex-1 rounded-full"
                busy={review.isPending}
                onClick={() => void decide(request, "approve")}
              >
                Restore access
              </Button>
              <Button
                size="sm"
                className="rounded-full"
                disabled={review.isPending}
                onClick={() => void decide(request, "deny")}
              >
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
