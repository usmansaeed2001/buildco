"""Profiles, team management, and the removed-user re-approval workflow."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import Forbidden, NotFound
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


# ── Sign-in provisioning ──────────────────────────────────────────────────────


async def resolve_profile(session: AsyncSession, identity: VerifiedIdentity) -> ResolvedSession:
    """Map a verified Firebase identity onto an application profile.

    Three cases, in order:

    1. **Known uid** — the normal path after the first sign-in.
    2. **Known email, no uid** — a user migrated from Supabase signing in for the
       first time, or one whose ``firebase_uid`` backfill missed them. The uid is
       recorded now, so case 1 applies from then on.
    3. **Unknown** — a genuinely new person. A profile is created. The very first
       profile in the system becomes the owner, which is the logic that used to live
       in the ``handle_new_user()`` Postgres trigger; that trigger fired on Supabase's
       ``auth.users`` table and does not survive the move to Firebase.

    Matching in case 2 is case-insensitive on email, because Firebase preserves the
    casing a user typed while the migrated rows carry whatever Supabase stored.
    """
    by_uid = await session.scalar(select(Profile).where(Profile.firebase_uid == identity.uid))
    if by_uid is not None:
        return ResolvedSession(profile=by_uid)

    if identity.email:
        by_email = await session.scalar(
            select(Profile).where(func.lower(Profile.email) == identity.email.lower())
        )
        if by_email is not None:
            by_email.firebase_uid = identity.uid
            await session.flush()
            log.info(
                "profile_linked_to_firebase",
                profile_id=str(by_email.id),
                email=by_email.email,
            )
            return ResolvedSession(profile=by_email, linked=True)

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
    await session.flush()

    if target.firebase_uid:
        await get_auth_provider().set_disabled(target.firebase_uid, True)

    log.info("user_banned", actor=str(actor.id), target=str(target.id))
    return target


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
