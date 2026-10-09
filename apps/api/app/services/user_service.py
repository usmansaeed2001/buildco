"""Profiles, team management, and the removed-user re-approval workflow."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlencode

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import Conflict, Forbidden, NotFound
from app.logging import get_logger
from app.models.approval_request import ApprovalRequest
from app.models.enums import ApprovalRequestStatus, Role, UserStatus
from app.models.profile import Profile
from app.services.integrations.firebase import VerifiedIdentity, get_auth_provider
from app.services.rules import user_rules
from app.services.rules.user_rules import UserSnapshot

log = get_logger(__name__)


def snapshot(profile: Profile) -> UserSnapshot:
    return UserSnapshot(id=profile.id, role=Role(profile.role))


@dataclass(frozen=True, slots=True)
class ResolvedSession:
    profile: Profile
    #: The profile was created by this call.
    created: bool = False
    #: The profile already existed and was linked to its Firebase uid by this call.
    linked: bool = False
    #: The link above was someone accepting an invitation, not a migrated user returning.
    accepted_invite: bool = False


def _as_utc(value: datetime) -> datetime:
    """Attach UTC to a naive datetime. SQLite, which the tests default to, has no
    timezone type and hands back naive values for columns Postgres returns aware."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# ── Invitation tokens ─────────────────────────────────────────────────────────


def _hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _issue_invite_token(profile: Profile, actor: Profile) -> str:
    """Stamp a fresh invitation on ``profile`` and return the token to email.

    The raw token exists only in this return value and in the email it goes into.
    Issuing again replaces the hash, so an earlier link stops working — which is what
    "resend" has to mean if the first email went to the wrong place.
    """
    token = secrets.token_urlsafe(32)
    profile.invited_at = datetime.now(UTC)
    profile.invited_by = actor.id
    profile.invite_token_hash = _hash_invite_token(token)
    return token


def invitation_url(token: str, email: str) -> str:
    """The link an invitation email points at.

    It lands on the sign-up screen with the address filled in. The web app lifts
    ``invite`` out of the URL on load and sends it with ``POST /auth/session``.
    """
    query = urlencode({"invite": token, "email": email})
    return f"{get_settings().site_url}/signup?{query}"


def _require_invite_proof(
    profile: Profile, identity: VerifiedIdentity, invite_token: str | None
) -> None:
    """Refuse to hand a pending invitation to someone who has not proved the address.

    Linking by email alone is safe only when the email is known to be theirs. Firebase
    creates a password account for any address without confirming it, so without this an
    invitation could be claimed by whoever signed up with the invited address first —
    and an invitation carries a role.

    Two proofs are accepted: the identity provider vouches for the address
    (``email_verified``, which a Google sign-in always is), or the caller presents the
    token that was emailed to it.
    """
    if identity.email_verified:
        return

    stored = profile.invite_token_hash or ""
    presented = _hash_invite_token(invite_token) if invite_token else ""
    if presented and secrets.compare_digest(stored, presented):
        invited_at = _as_utc(profile.invited_at) if profile.invited_at else None
        if user_rules.invitation_is_live(invited_at, datetime.now(UTC)):
            return
        raise Forbidden(
            "This invitation has expired. Ask the person who invited you to send it again."
        )

    raise Forbidden(
        "This address has a pending BuildCo invitation. Open the link in your invitation "
        "email to finish joining, or continue with Google."
    )


# ── Sign-in provisioning ──────────────────────────────────────────────────────


async def resolve_profile(
    session: AsyncSession, identity: VerifiedIdentity, *, invite_token: str | None = None
) -> ResolvedSession:
    """Map a verified Firebase identity onto an application profile.

    Three cases, in order:

    1. **Known uid** — the normal path after the first sign-in.
    2. **Known email, no uid** — a user migrated from Supabase signing in for the
       first time, one whose ``firebase_uid`` backfill missed them, or someone an admin
       invited. The uid is recorded now, so case 1 applies from then on.
    3. **Unknown** — a genuinely new person. A profile is created. The very first
       profile in the system becomes the owner, which is the logic that used to live
       in the ``handle_new_user()`` Postgres trigger; that trigger fired on Supabase's
       ``auth.users`` table and does not survive the move to Firebase.

    Matching in case 2 is case-insensitive on email, because Firebase preserves the
    casing a user typed while the migrated rows carry whatever Supabase stored.

    A pending invitation is the one part of case 2 that asks for more than a matching
    address — see ``_require_invite_proof``. ``invite_token`` is only ever supplied by
    ``POST /auth/session``; a migrated user's profile has no invitation and links exactly
    as it always has.
    """
    by_uid = await session.scalar(select(Profile).where(Profile.firebase_uid == identity.uid))
    if by_uid is not None:
        return ResolvedSession(profile=by_uid)

    if identity.email:
        by_email = await session.scalar(
            select(Profile).where(func.lower(Profile.email) == identity.email.lower())
        )
        if by_email is not None:
            accepted_invite = by_email.invite_token_hash is not None
            if accepted_invite:
                _require_invite_proof(by_email, identity, invite_token)
                by_email.invite_token_hash = None
                # The admin may not have known their name, and never had their picture.
                if not by_email.full_name and identity.name:
                    by_email.full_name = identity.name
                if not by_email.avatar_url and identity.picture:
                    by_email.avatar_url = identity.picture

            by_email.firebase_uid = identity.uid
            await session.flush()
            log.info(
                "profile_linked_to_firebase",
                profile_id=str(by_email.id),
                email=by_email.email,
                accepted_invite=accepted_invite,
            )
            if accepted_invite:
                # Convenience only, as everywhere — the database stays authoritative.
                await get_auth_provider().set_role_claim(identity.uid, by_email.role)
            return ResolvedSession(profile=by_email, linked=True, accepted_invite=accepted_invite)

    if not identity.email:
        # Every profile is keyed by email; an identity without one cannot be
        # provisioned. In practice this only happens with providers we do not enable.
        raise Forbidden("This account has no email address and cannot be provisioned.")

    existing_count = await session.scalar(select(func.count()).select_from(Profile)) or 0
    role = user_rules.initial_role_for_new_user(is_first_user=existing_count == 0)

    profile = Profile(
        firebase_uid=identity.uid,
        email=identity.email,
        full_name=identity.name or "",
        avatar_url=identity.picture,
        role=role.value,
        status=UserStatus.ACTIVE.value,
    )
    session.add(profile)
    await session.flush()

    log.info("profile_created", profile_id=str(profile.id), email=profile.email, role=role.value)
    await get_auth_provider().set_role_claim(identity.uid, role.value)

    return ResolvedSession(profile=profile, created=True)


# ── Reads ─────────────────────────────────────────────────────────────────────


async def get_by_id(session: AsyncSession, user_id: uuid.UUID) -> Profile:
    profile = await session.get(Profile, user_id)
    if profile is None:
        raise NotFound("User not found.")
    return profile


async def list_team(session: AsyncSession) -> list[Profile]:
    """The full roster.

    Visible to every authenticated user, not just admins: the UI shows avatars and
    assignee names throughout, and a member needs to resolve those.
    """
    result = await session.scalars(select(Profile).order_by(Profile.created_at))
    return list(result)


# ── Self-service ──────────────────────────────────────────────────────────────


async def update_self(
    session: AsyncSession,
    profile: Profile,
    *,
    full_name: str | None = None,
    phone: str | None = None,
) -> Profile:
    if full_name is not None:
        profile.full_name = full_name
    if phone is not None:
        profile.phone = phone
    await session.flush()
    return profile


async def set_avatar(session: AsyncSession, profile: Profile, avatar_url: str) -> Profile:
    profile.avatar_url = avatar_url
    await session.flush()
    return profile


# ── Team management ───────────────────────────────────────────────────────────


async def assign_role(
    session: AsyncSession, actor: Profile, target_id: uuid.UUID, new_role: Role
) -> Profile:
    """Change another user's role, mirroring it to their Firebase custom claim."""
    target = await get_by_id(session, target_id)

    decision = user_rules.can_assign_role(snapshot(actor), snapshot(target), new_role)
    if not decision:
        raise Forbidden(decision.reason)

    target.role = new_role.value
    await session.flush()

    if target.firebase_uid:
        # Convenience only — the database remains authoritative for authorisation.
        await get_auth_provider().set_role_claim(target.firebase_uid, new_role.value)

    log.info(
        "role_assigned",
        actor=str(actor.id),
        target=str(target.id),
        role=new_role.value,
    )
    return target


async def ban_user(session: AsyncSession, actor: Profile, target_id: uuid.UUID) -> Profile:
    """Remove a user from the team.

    Both halves matter, and the order is deliberate. Disabling in Firebase stops them
    obtaining *new* tokens; setting ``status = banned`` stops an already-issued token
    from working, since the auth dependency rechecks status on every request. Doing
    only the first would leave a removed user with up to an hour of continued access.
    """
    target = await get_by_id(session, target_id)

    decision = user_rules.can_remove_user(snapshot(actor), snapshot(target))
    if not decision:
        raise Forbidden(decision.reason)

    target.status = UserStatus.BANNED.value
    target.removed_by = actor.id
    target.removed_at = datetime.now(UTC)
    # A removed person's invitation link must not outlive the removal.
    target.invite_token_hash = None
    await session.flush()

    if target.firebase_uid:
        await get_auth_provider().set_disabled(target.firebase_uid, True)

    log.info("user_banned", actor=str(actor.id), target=str(target.id))
    return target


# ── Invitations ───────────────────────────────────────────────────────────────


async def invite_user(
    session: AsyncSession,
    actor: Profile,
    *,
    email: str,
    role: Role,
    full_name: str = "",
) -> tuple[Profile, str]:
    """Add someone to the team before they have an account.

    Creates their profile now, with the role they will have, and returns it with the
    token to email them. Nothing is created in Firebase: they make their own account —
    password or Google — and ``resolve_profile`` links it to this row on first sign-in.

    The profile is ``active`` from this moment, not from when they join. That is
    deliberate: they appear in the roster straight away, so work can be assigned to them
    and they can be invited to meetings before they have signed in once.

    An address already on file is a 409 with the reason, never a silent second
    invitation — each of the three cases has a different next step for the admin.
    """
    decision = user_rules.can_invite_user(snapshot(actor), role)
    if not decision:
        raise Forbidden(decision.reason)

    address = email.strip().lower()
    existing = await session.scalar(select(Profile).where(func.lower(Profile.email) == address))
    if existing is not None:
        if existing.is_banned:
            raise Conflict(
                f"{address} was removed from the team. When they next try to sign in, an "
                "access request appears here for you to approve."
            )
        if existing.invite_pending:
            raise Conflict(f"{address} has already been invited. Resend the invitation instead.")
        raise Conflict(f"{address} is already on the team.")

    profile = Profile(
        email=address,
        full_name=full_name.strip(),
        role=role.value,
        status=UserStatus.ACTIVE.value,
    )
    token = _issue_invite_token(profile, actor)
    session.add(profile)
    await session.flush()

    log.info("user_invited", actor=str(actor.id), target=str(profile.id), role=role.value)
    return profile, token


async def _pending_invitation(
    session: AsyncSession, actor: Profile, target_id: uuid.UUID
) -> Profile:
    """Load a profile whose invitation ``actor`` may still act on."""
    target = await get_by_id(session, target_id)
    if not target.invite_pending:
        raise Conflict("There is no pending invitation for this person.")

    decision = user_rules.can_invite_user(snapshot(actor), Role(target.role))
    if not decision:
        raise Forbidden(decision.reason)
    return target


async def resend_invitation(
    session: AsyncSession, actor: Profile, target_id: uuid.UUID
) -> tuple[Profile, str]:
    """Issue a fresh token for a pending invitation. The previous link stops working."""
    target = await _pending_invitation(session, actor, target_id)
    if target.is_banned:
        # A fresh link would let them finish signing up straight into a 401.
        raise Conflict("This person was removed from the team, so they cannot be re-invited.")
    token = _issue_invite_token(target, actor)
    await session.flush()

    log.info("invitation_resent", actor=str(actor.id), target=str(target.id))
    return target, token


async def revoke_invitation(session: AsyncSession, actor: Profile, target_id: uuid.UUID) -> None:
    """Withdraw a pending invitation by deleting the profile it created.

    Deleted rather than banned, because nobody was ever behind it: a ban would leave a
    "removed" member who never existed, and would stop the same address being invited
    again once the typo is corrected. It is safe to delete — every foreign key to
    ``profiles`` is ``SET NULL`` or ``CASCADE``, so a project assigned to them in the
    meantime just becomes unassigned.

    Only reachable while the invitation is pending. Once they have signed in they are a
    member with history, and removal goes through ``ban_user``.
    """
    target = await _pending_invitation(session, actor, target_id)
    await session.delete(target)
    await session.flush()

    log.info("invitation_revoked", actor=str(actor.id), target=str(target_id))


# ── Access requests ───────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class AccountStatus:
    state: str  # "active" | "banned" | "not_found"
    request_filed: bool = False
    profile: Profile | None = None


async def check_account_status(session: AsyncSession, email: str) -> AccountStatus:
    """Pre-sign-in check for the login screen. Reachable without authentication.

    A removed user hitting this has an ``ApprovalRequest`` filed on their behalf, so an
    admin sees the attempt and can restore access — but only one open request at a
    time, so repeated sign-in attempts do not spam the review queue.

    The response deliberately reveals only the state. It does confirm whether an
    address is registered, which the sign-in screen needs in order to explain a
    rejection at all; nothing further is disclosed.
    """
    profile = await session.scalar(
        select(Profile).where(func.lower(Profile.email) == email.lower())
    )
    if profile is None:
        return AccountStatus(state="not_found")

    if profile.status != UserStatus.BANNED.value:
        return AccountStatus(state="active", profile=profile)

    existing = await session.scalar(
        select(ApprovalRequest).where(
            ApprovalRequest.user_id == profile.id,
            ApprovalRequest.status == ApprovalRequestStatus.PENDING.value,
        )
    )
    if existing is not None:
        return AccountStatus(state="banned", request_filed=False, profile=profile)

    session.add(
        ApprovalRequest(
            user_id=profile.id,
            email=profile.email,
            full_name=profile.full_name,
            status=ApprovalRequestStatus.PENDING.value,
            requested_at=datetime.now(UTC),
        )
    )
    await session.flush()
    log.info("approval_request_filed", profile_id=str(profile.id))
    return AccountStatus(state="banned", request_filed=True, profile=profile)


async def list_approval_requests(
    session: AsyncSession, *, status: ApprovalRequestStatus | None = None
) -> list[ApprovalRequest]:
    stmt = select(ApprovalRequest).order_by(ApprovalRequest.requested_at.desc())
    if status is not None:
        stmt = stmt.where(ApprovalRequest.status == status.value)
    return list(await session.scalars(stmt))


async def review_approval_request(
    session: AsyncSession,
    actor: Profile,
    request_id: uuid.UUID,
    *,
    approve: bool,
) -> tuple[ApprovalRequest, Profile]:
    """Approve or deny a removed user's request to return.

    Approving reverses both halves of the ban — the ``status`` flag and the Firebase
    disabled flag — so the user can sign in again immediately.
    """
    decision = user_rules.can_review_approval_requests(snapshot(actor))
    if not decision:
        raise Forbidden(decision.reason)

    request = await session.get(ApprovalRequest, request_id)
    if request is None:
        raise NotFound("Access request not found.")
    if request.status != ApprovalRequestStatus.PENDING.value:
        raise NotFound("This access request has already been reviewed.")

    request.status = (
        ApprovalRequestStatus.APPROVED.value if approve else ApprovalRequestStatus.DENIED.value
    )
    request.reviewed_by = actor.id
    request.reviewed_at = datetime.now(UTC)

    target = await get_by_id(session, request.user_id)
    if approve:
        target.status = UserStatus.ACTIVE.value
        target.removed_by = None
        target.removed_at = None
        if target.firebase_uid:
            await get_auth_provider().set_disabled(target.firebase_uid, False)

    await session.flush()
    log.info(
        "approval_request_reviewed",
        request_id=str(request_id),
        approved=approve,
        actor=str(actor.id),
    )
    return request, target
